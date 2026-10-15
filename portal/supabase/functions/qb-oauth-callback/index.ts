// Edge Function: /functions/v1/qb-oauth-callback
// Receives QuickBooks' redirect after user consent, exchanges code for tokens,
// captures realmId, and persists everything to Supabase.
//
// Register this URL exactly as the Redirect URI in your Intuit app settings.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { QB_TOKEN_URL, corsHeaders } from "../_shared/quickbooks.ts";

const QB_CLIENT_ID     = Deno.env.get("QB_CLIENT_ID")!;
const QB_CLIENT_SECRET = Deno.env.get("QB_CLIENT_SECRET")!;
const QB_REDIRECT_URI  = Deno.env.get("QB_REDIRECT_URI")!;
const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url        = new URL(req.url);
  const code       = url.searchParams.get("code");
  const realmId    = url.searchParams.get("realmId");  // QB passes this directly
  const stateRaw   = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    return htmlPage("Connection Failed", `<p>QuickBooks returned: <code>${oauthError}</code></p>`, 400);
  }

  if (!code || !realmId || !stateRaw) {
    return htmlPage("Missing Parameters", "<p>Expected <code>code</code>, <code>realmId</code> and <code>state</code>.</p>", 400);
  }

  let state: { clientId: string; environment: "production" | "sandbox"; portalUrl?: string };
  try {
    state = JSON.parse(atob(stateRaw));
  } catch {
    return htmlPage("Invalid State", "<p>Could not parse OAuth state parameter.</p>", 400);
  }

  const { clientId, environment, portalUrl } = state;
  const credentials = btoa(`${QB_CLIENT_ID}:${QB_CLIENT_SECRET}`);

  // 1. Exchange auth code for tokens
  const tokenRes = await fetch(QB_TOKEN_URL, {
    method:  "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type":  "application/x-www-form-urlencoded",
      "Accept":        "application/json",
    },
    body: new URLSearchParams({
      grant_type:   "authorization_code",
      code,
      redirect_uri: QB_REDIRECT_URI,
    }),
  });

  const tokens = await tokenRes.json();
  if (tokens.error) {
    return htmlPage("Token Error", `<p>${tokens.error}: ${tokens.error_description ?? ""}</p>`, 400);
  }

  // 2. Persist to Supabase
  const supabase   = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const expiresAt  = new Date(Date.now() + (tokens.expires_in ?? 3600) * 1000).toISOString();

  const { error: dbError } = await supabase.from("qb_tokens").upsert({
    client_id:     clientId,
    realm_id:      realmId,
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    expiresAt,
    environment,
    updated_at:    new Date().toISOString(),
  }, { onConflict: "client_id" });

  if (dbError) {
    console.error("DB upsert failed:", dbError);
    return htmlPage("Database Error", `<p>Could not save tokens: ${dbError.message}</p>`, 500);
  }

  // HTTP redirect back to portal — works in all cases (popup or full tab)
  const safePortalUrl = portalUrl ?? "https://chaitanyadeo95.github.io/ClaudeAI/portal/";
  const redirectTarget = new URL(safePortalUrl);
  redirectTarget.searchParams.set("qb", "connected");
  return Response.redirect(redirectTarget.toString(), 302);
});

function htmlPage(title: string, body: string, status: number): Response {
  return new Response(
    `<!DOCTYPE html><html><head><title>${title}</title>
    <style>body{font-family:sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#1C3054}
    h2{color:#0B1728}p{line-height:1.6}code{background:#f3f4f6;padding:2px 6px;border-radius:4px}</style>
    </head><body><h2>${title}</h2>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html" } },
  );
}
