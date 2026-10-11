// Edge Function: /functions/v1/zoho-oauth-init
// Redirects the user to Zoho's OAuth consent page.
//
// Query params:
//   dc        — data centre (in | com | eu | au | jp | ca); default "in"
//   client_id — AiFinanceo internal client UUID (from `clients` table)
//
// Usage:
//   GET /functions/v1/zoho-oauth-init?dc=in&client_id=<uuid>

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { DC_AUTH_URLS, DataCentre, corsHeaders } from "../_shared/zoho.ts";

const ZOHO_CLIENT_ID    = Deno.env.get("ZOHO_CLIENT_ID")!;
const ZOHO_REDIRECT_URI = Deno.env.get("ZOHO_REDIRECT_URI")!;

const SCOPES = [
  "ZohoBooks.accountants.READ",
  "ZohoBooks.reports.READ",
  "ZohoBooks.invoices.READ",
  "ZohoBooks.bills.READ",
  "ZohoBooks.banking.READ",
].join(",");

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!ZOHO_CLIENT_ID || !ZOHO_REDIRECT_URI) {
    return new Response("Server misconfiguration: missing env vars", { status: 500 });
  }

  const url    = new URL(req.url);
  const dc     = (url.searchParams.get("dc") ?? "in") as DataCentre;
  const clientId = url.searchParams.get("client_id");

  if (!clientId) {
    return new Response("Missing client_id", { status: 400 });
  }

  const authUrl = DC_AUTH_URLS[dc];
  if (!authUrl) {
    return new Response(`Unknown data centre: ${dc}`, { status: 400 });
  }

  // Encode dc + clientId into state so the callback can recover them
  const state = btoa(JSON.stringify({ dc, clientId }));

  const params = new URLSearchParams({
    client_id:     ZOHO_CLIENT_ID,
    redirect_uri:  ZOHO_REDIRECT_URI,
    response_type: "code",
    scope:         SCOPES,
    access_type:   "offline",  // ensures we get a refresh_token
    state,
    prompt:        "consent",
  });

  return Response.redirect(`${authUrl}?${params}`, 302);
});
