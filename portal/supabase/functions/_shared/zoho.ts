// Shared Zoho Books helpers: token refresh, rate-limit retry, API call logging

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Data-centre routing ───────────────────────────────────────────────────────

export type DataCentre = "in" | "com" | "eu" | "au" | "jp" | "ca";

const DC_TOKEN_URLS: Record<DataCentre, string> = {
  in:  "https://accounts.zoho.in/oauth/v2/token",
  com: "https://accounts.zoho.com/oauth/v2/token",
  eu:  "https://accounts.zoho.eu/oauth/v2/token",
  au:  "https://accounts.zoho.com.au/oauth/v2/token",
  jp:  "https://accounts.zoho.jp/oauth/v2/token",
  ca:  "https://accounts.zohocloud.ca/oauth/v2/token",
};

export const DC_AUTH_URLS: Record<DataCentre, string> = {
  in:  "https://accounts.zoho.in/oauth/v2/auth",
  com: "https://accounts.zoho.com/oauth/v2/auth",
  eu:  "https://accounts.zoho.eu/oauth/v2/auth",
  au:  "https://accounts.zoho.com.au/oauth/v2/auth",
  jp:  "https://accounts.zoho.jp/oauth/v2/auth",
  ca:  "https://accounts.zohocloud.ca/oauth/v2/auth",
};

export const DC_API_URLS: Record<DataCentre, string> = {
  in:  "https://www.zohoapis.in/books/v3",
  com: "https://www.zohoapis.com/books/v3",
  eu:  "https://www.zohoapis.eu/books/v3",
  au:  "https://www.zohoapis.com.au/books/v3",
  jp:  "https://www.zohoapis.jp/books/v3",
  ca:  "https://www.zohoapis.ca/books/v3",
};

// ── Token record ──────────────────────────────────────────────────────────────

export interface ZohoToken {
  client_id:     string;
  data_centre:   DataCentre;
  access_token:  string;
  refresh_token: string;
  expires_at:    string;
  zoho_org_id:   string;
}

// ── Ensure a valid access token (refresh if within 5 min of expiry) ───────────

export async function getValidToken(
  supabase: SupabaseClient,
  token: ZohoToken,
): Promise<string> {
  const expiresAt = new Date(token.expires_at).getTime();
  const fiveMinMs = 5 * 60 * 1000;

  if (Date.now() < expiresAt - fiveMinMs) {
    return token.access_token;
  }

  // Refresh
  const tokenUrl = DC_TOKEN_URLS[token.data_centre];
  const res = await fetch(tokenUrl, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: token.refresh_token,
      client_id:     Deno.env.get("ZOHO_CLIENT_ID")!,
      client_secret: Deno.env.get("ZOHO_CLIENT_SECRET")!,
      grant_type:    "refresh_token",
    }),
  });

  const data = await res.json();
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error}`);
  }

  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  await supabase.from("zoho_tokens").update({
    access_token: data.access_token,
    expires_at:   newExpiresAt,
    updated_at:   new Date().toISOString(),
  }).eq("client_id", token.client_id);

  return data.access_token;
}

// ── fetch with retry on 429 (exponential back-off, max 3 retries) ─────────────

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;

    if (attempt === maxRetries) break;

    const retryAfter = parseInt(res.headers.get("Retry-After") ?? "60", 10);
    const backoff = Math.min(retryAfter * 1000, Math.pow(2, attempt) * 10_000);
    console.warn(`Rate limited. Waiting ${backoff}ms before retry ${attempt + 1}`);
    await new Promise((r) => setTimeout(r, backoff));
  }
  throw new Error(`Max retries exceeded for ${url}`);
}

// ── Logged API call helper ────────────────────────────────────────────────────

export async function zohoGet(
  supabase: SupabaseClient,
  apiBase: string,
  path: string,
  accessToken: string,
  params: Record<string, string>,
  logCtx: { syncLogId: string; clientId: string },
): Promise<unknown> {
  const url = new URL(`${apiBase}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const start = Date.now();
  let statusCode = 0;
  let errorMessage: string | null = null;

  try {
    const res = await fetchWithRetry(url.toString(), {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });

    statusCode = res.status;
    const responseTimeMs = Date.now() - start;

    if (!res.ok) {
      const body = await res.text();
      errorMessage = `HTTP ${res.status}: ${body.slice(0, 200)}`;
      throw new Error(errorMessage);
    }

    await supabase.from("api_call_logs").insert({
      sync_log_id:      logCtx.syncLogId,
      client_id:        logCtx.clientId,
      endpoint:         path,
      http_method:      "GET",
      status_code:      statusCode,
      response_time_ms: responseTimeMs,
    });

    return res.json();
  } catch (err) {
    await supabase.from("api_call_logs").insert({
      sync_log_id:      logCtx.syncLogId,
      client_id:        logCtx.clientId,
      endpoint:         path,
      http_method:      "GET",
      status_code:      statusCode || 0,
      response_time_ms: Date.now() - start,
      error_message:    err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

// ── CORS headers for local dev ────────────────────────────────────────────────

export const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
