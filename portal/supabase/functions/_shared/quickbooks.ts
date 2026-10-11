// Shared QuickBooks Online helpers: token refresh, rate-limit retry, API call logging

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ── Endpoints ─────────────────────────────────────────────────────────────────

export const QB_AUTH_URL  = "https://appcenter.intuit.com/connect/oauth2";
export const QB_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";

export const QB_API_BASE = {
  production: "https://quickbooks.api.intuit.com",
  sandbox:    "https://sandbox-quickbooks.api.intuit.com",
} as const;

// Minor version — pin so QB doesn't silently change response shapes
export const QB_MINOR_VERSION = "65";

// Scopes required
export const QB_SCOPES = "com.intuit.quickbooks.accounting";

// ── Token record ──────────────────────────────────────────────────────────────

export interface QBToken {
  client_id:     string;
  realm_id:      string;
  access_token:  string;
  refresh_token: string;
  expires_at:    string;
  environment:   "production" | "sandbox";
}

// ── Ensure a valid access token (refresh if within 5 min of expiry) ───────────
// QB access tokens last 1 hour; refresh tokens last 100 days.

export async function getValidToken(
  supabase: SupabaseClient,
  token: QBToken,
): Promise<string> {
  const expiresAt = new Date(token.expires_at).getTime();
  if (Date.now() < expiresAt - 5 * 60 * 1000) return token.access_token;

  const clientId     = Deno.env.get("QB_CLIENT_ID")!;
  const clientSecret = Deno.env.get("QB_CLIENT_SECRET")!;
  const credentials  = btoa(`${clientId}:${clientSecret}`);

  const res = await fetch(QB_TOKEN_URL, {
    method:  "POST",
    headers: {
      "Authorization": `Basic ${credentials}`,
      "Content-Type":  "application/x-www-form-urlencoded",
      "Accept":        "application/json",
    },
    body: new URLSearchParams({
      grant_type:    "refresh_token",
      refresh_token: token.refresh_token,
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`QB token refresh failed: ${data.error} — ${data.error_description ?? ""}`);

  const newExpiresAt = new Date(Date.now() + data.expires_in * 1000).toISOString();

  await supabase.from("qb_tokens").update({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? token.refresh_token, // QB rotates refresh tokens
    expires_at:   newExpiresAt,
    updated_at:   new Date().toISOString(),
  }).eq("client_id", token.client_id);

  return data.access_token;
}

// ── fetch with retry on 429 (exponential backoff, max 3 retries) ──────────────

export async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429) return res;
    if (attempt === maxRetries) break;
    const backoff = Math.pow(2, attempt) * 10_000; // 10s, 20s, 40s
    console.warn(`QB rate limit hit. Waiting ${backoff}ms (attempt ${attempt + 1})`);
    await new Promise((r) => setTimeout(r, backoff));
  }
  throw new Error(`QB rate limit: max retries exceeded`);
}

// ── Logged QB API call ────────────────────────────────────────────────────────
// QuickBooks uses Bearer auth + Accept: application/json on every call.

export async function qbGet(
  supabase: SupabaseClient,
  apiBase: string,
  path: string,
  accessToken: string,
  params: Record<string, string>,
  logCtx: { syncLogId: string; clientId: string },
): Promise<unknown> {
  const url = new URL(`${apiBase}${path}`);
  url.searchParams.set("minorversion", QB_MINOR_VERSION);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const start = Date.now();
  let statusCode = 0;

  try {
    const res = await fetchWithRetry(url.toString(), {
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Accept":        "application/json",
      },
    });

    statusCode = res.status;
    const responseTimeMs = Date.now() - start;

    if (!res.ok) {
      const body = await res.text();
      const msg  = `HTTP ${res.status}: ${body.slice(0, 300)}`;
      await logCall(supabase, logCtx, path, statusCode, responseTimeMs, msg);
      throw new Error(msg);
    }

    await logCall(supabase, logCtx, path, statusCode, responseTimeMs, null);
    return res.json();
  } catch (err) {
    if (statusCode !== 0) throw err; // already logged
    await logCall(supabase, logCtx, path, 0, Date.now() - start, String(err));
    throw err;
  }
}

async function logCall(
  supabase: SupabaseClient,
  ctx: { syncLogId: string; clientId: string },
  endpoint: string,
  statusCode: number,
  responseTimeMs: number,
  errorMessage: string | null,
) {
  await supabase.from("api_call_logs").insert({
    sync_log_id:      ctx.syncLogId,
    client_id:        ctx.clientId,
    endpoint,
    http_method:      "GET",
    status_code:      statusCode,
    response_time_ms: responseTimeMs,
    error_message:    errorMessage,
  });
}

// ── CORS headers ──────────────────────────────────────────────────────────────

export const corsHeaders = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
