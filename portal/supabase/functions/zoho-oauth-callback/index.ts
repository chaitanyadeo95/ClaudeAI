// Edge Function: /functions/v1/zoho-oauth-callback
// Receives Zoho's redirect, exchanges the auth code for tokens, stores them.
// This URL must be registered as the Redirect URI in your Zoho API console.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { DC_API_URLS, DataCentre, corsHeaders } from "../_shared/zoho.ts";

const ZOHO_CLIENT_ID     = Deno.env.get("ZOHO_CLIENT_ID")!;
const ZOHO_CLIENT_SECRET = Deno.env.get("ZOHO_CLIENT_SECRET")!;
const ZOHO_REDIRECT_URI  = Deno.env.get("ZOHO_REDIRECT_URI")!;
const SUPABASE_URL        = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const DC_TOKEN_URLS: Record<DataCentre, string> = {
  in:  "https://accounts.zoho.in/oauth/v2/token",
  com: "https://accounts.zoho.com/oauth/v2/token",
  eu:  "https://accounts.zoho.eu/oauth/v2/token",
  au:  "https://accounts.zoho.com.au/oauth/v2/token",
  jp:  "https://accounts.zoho.jp/oauth/v2/token",
  ca:  "https://accounts.zohocloud.ca/oauth/v2/token",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url   = new URL(req.url);
  const code  = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return htmlPage("Connection failed", `<p>Zoho returned an error: <code>${oauthError}</code></p>`, 400);
  }

  if (!code || !state) {
    return htmlPage("Missing parameters", "<p>No code or state returned by Zoho.</p>", 400);
  }

  let parsed: { dc: DataCentre; clientId: string };
  try {
    parsed = JSON.parse(atob(state));
  } catch {
    return htmlPage("Invalid state", "<p>Could not parse OAuth state.</p>", 400);
  }

  const { dc, clientId } = parsed;
  const tokenUrl = DC_TOKEN_URLS[dc];

  // 1. Exchange code for tokens
  const tokenRes = await fetch(tokenUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id:     ZOHO_CLIENT_ID,
      client_secret: ZOHO_CLIENT_SECRET,
      redirect_uri:  ZOHO_REDIRECT_URI,
      grant_type:    "authorization_code",
    }),
  });

  const tokens = await tokenRes.json();
  if (tokens.error) {
    return htmlPage("Token error", `<p>${tokens.error}: ${tokens.error_description ?? ""}</p>`, 400);
  }

  // 2. Discover the Zoho Books organisation ID
  const apiBase = DC_API_URLS[dc];
  const orgsRes = await fetch(`${apiBase}/organizations`, {
    headers: { Authorization: `Zoho-oauthtoken ${tokens.access_token}` },
  });
  const orgsData = await orgsRes.json();
  const orgId = orgsData.organizations?.[0]?.organization_id ?? null;

  // 3. Persist tokens in Supabase
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const expiresAt = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();

  const { error: dbError } = await supabase.from("zoho_tokens").upsert({
    client_id:     clientId,
    data_centre:   dc,
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    expiresAt,
    zoho_org_id:   orgId,
    updated_at:    new Date().toISOString(),
  }, { onConflict: "client_id" });

  if (dbError) {
    console.error("DB upsert failed:", dbError);
    return htmlPage("Database error", `<p>Could not save tokens: ${dbError.message}</p>`, 500);
  }

  return htmlPage(
    "Zoho Books Connected",
    `<p>Your Zoho Books account has been connected successfully.</p>
     <p>Organisation ID: <strong>${orgId ?? "—"}</strong></p>
     <p>You can close this window.</p>`,
    200,
  );
});

function htmlPage(title: string, body: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html><html><head><title>${title}</title>
    <style>body{font-family:sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#1C3054}
    h2{color:#0B1728}p{line-height:1.6}</style></head>
    <body><h2>${title}</h2>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html" } },
  );
}
