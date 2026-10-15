// Edge Function: /functions/v1/qb-disconnect
// DELETE — removes QuickBooks tokens and all QB-sourced data for the caller.
//
// Authorization: Bearer <supabase-session-token>

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/quickbooks.ts";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY    = Deno.env.get("SUPABASE_ANON_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "DELETE" && req.method !== "POST")
    return json({ error: "Method not allowed" }, 405);

  // Verify caller's Supabase JWT
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Missing authorization" }, 401);
  const token = authHeader.slice(7);

  const anonSb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: { user }, error: authErr } = await anonSb.auth.getUser(token);
  if (authErr || !user) return json({ error: "Invalid or expired token" }, 401);

  const supabase   = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const clientId   = user.id;

  // Remove QB token (revokes the connection)
  await supabase.from("qb_tokens").delete().eq("client_id", clientId);

  // Remove all QB-sourced data so dashboard starts fresh on reconnect
  await Promise.all([
    supabase.from("ar_invoices")   .delete().eq("client_id", clientId).eq("source", "quickbooks"),
    supabase.from("ap_bills")      .delete().eq("client_id", clientId).eq("source", "quickbooks"),
    supabase.from("bank_accounts") .delete().eq("client_id", clientId).eq("source", "quickbooks"),
    supabase.from("sync_logs")     .delete().eq("client_id", clientId).eq("source", "quickbooks"),
  ]);

  return json({ ok: true });
});

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
