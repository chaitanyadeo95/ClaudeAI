// Edge Function: /functions/v1/qb-oauth-init
// Redirects the user to QuickBooks' OAuth consent page.
//
// Query params:
//   client_id   — AiFinanceo internal client UUID (from `clients` table)
//   environment — 'production' (default) or 'sandbox'
//
// Usage:
//   GET /functions/v1/qb-oauth-init?client_id=<uuid>
//   GET /functions/v1/qb-oauth-init?client_id=<uuid>&environment=sandbox

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { QB_AUTH_URL, QB_SCOPES, corsHeaders } from "../_shared/quickbooks.ts";

const QB_CLIENT_ID    = Deno.env.get("QB_CLIENT_ID")!;
const QB_REDIRECT_URI = Deno.env.get("QB_REDIRECT_URI")!;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (!QB_CLIENT_ID || !QB_REDIRECT_URI) {
    return new Response("Server misconfiguration: missing QB_CLIENT_ID or QB_REDIRECT_URI", { status: 500 });
  }

  const url         = new URL(req.url);
  const clientId    = url.searchParams.get("client_id");
  const environment = (url.searchParams.get("environment") ?? "production") as "production" | "sandbox";
  const portalUrl   = url.searchParams.get("portal_url") ?? undefined;

  if (!clientId) return new Response("Missing client_id", { status: 400 });

  // Encode clientId, environment, and portalUrl into state — recovered in the callback
  const state = btoa(JSON.stringify({ clientId, environment, portalUrl }));

  const params = new URLSearchParams({
    client_id:     QB_CLIENT_ID,
    redirect_uri:  QB_REDIRECT_URI,
    response_type: "code",
    scope:         QB_SCOPES,
    state,
  });

  return Response.redirect(`${QB_AUTH_URL}?${params}`, 302);
});
