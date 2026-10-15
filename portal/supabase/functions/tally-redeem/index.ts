// Edge Function: /functions/v1/tally-redeem
// POST { code: "A3K7F2" }
// Called by the desktop exe on first setup — returns agent token + sync config.
// The code is single-use and expires in 15 minutes.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/quickbooks.ts";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: { ...corsHeaders, "Access-Control-Allow-Methods": "POST, OPTIONS" },
  });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: { code?: string };
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  const code = (body.code ?? "").trim().toUpperCase();
  if (!code || code.length !== 6) return json({ error: "Invalid code format" }, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: row, error } = await supabase
    .from("tally_agent_tokens")
    .select("id, client_id, setup_code, setup_code_expires_at")
    .eq("setup_code", code)
    .maybeSingle();

  if (error || !row) return json({ error: "Code not found or already used" }, 404);

  if (new Date(row.setup_code_expires_at) < new Date()) {
    return json({ error: "Code expired — generate a new one from the dashboard" }, 410);
  }

  // Consume the code (single-use)
  await supabase.from("tally_agent_tokens")
    .update({ setup_code: null, setup_code_expires_at: null })
    .eq("id", row.id);

  return json({
    agent_token:           row.id,
    sync_url:              `${SUPABASE_URL}/functions/v1/tally-sync`,
    tally_host:            "localhost",
    tally_port:            9000,
    sync_interval_minutes: 30,
  });
});

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
