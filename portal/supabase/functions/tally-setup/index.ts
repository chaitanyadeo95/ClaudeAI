// Edge Function: /functions/v1/tally-setup
// POST — generates (or refreshes) a Tally setup code for the authenticated client.
// Returns a 6-char one-time code the desktop agent redeems on first run.
//
// Authorization: Bearer <supabase-session-token>

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/quickbooks.ts";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY    = Deno.env.get("SUPABASE_ANON_KEY")!;

// Unambiguous characters (no 0/O, 1/I/L)
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Verify caller's Supabase JWT
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Missing authorization" }, 401);
  const token = authHeader.slice(7);

  const anonSb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: { user }, error: authErr } = await anonSb.auth.getUser(token);
  if (authErr || !user) return json({ error: "Invalid or expired token" }, 401);

  const supabase  = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const code      = generateCode();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 min

  // Upsert: create or update the token row, always refresh the code
  const { data, error } = await supabase
    .from("tally_agent_tokens")
    .upsert({
      client_id:              user.id,
      setup_code:             code,
      setup_code_expires_at:  expiresAt,
    }, { onConflict: "client_id" })
    .select("id, last_sync, company, setup_code, setup_code_expires_at")
    .single();

  if (error) return json({ error: "Database error: " + error.message }, 500);

  return json({
    setup_code:  data.setup_code,
    expires_at:  data.setup_code_expires_at,
    last_sync:   data.last_sync,
    company:     data.company,
    connected:   !!data.last_sync,
  });
});

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
