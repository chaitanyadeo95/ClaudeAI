// Edge Function: /functions/v1/tally-setup
// POST — generates (or retrieves) a Tally agent token for the authenticated client.
// The returned token UUID goes into the desktop agent's config.json.
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
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Verify caller's Supabase JWT
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Missing authorization" }, 401);
  const token = authHeader.slice(7);

  const anonSb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: { user }, error: authErr } = await anonSb.auth.getUser(token);
  if (authErr || !user) return json({ error: "Invalid or expired token" }, 401);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Upsert: insert a new row (new UUID) or return existing
  const { data, error } = await supabase
    .from("tally_agent_tokens")
    .upsert({ client_id: user.id }, { onConflict: "client_id", ignoreDuplicates: true })
    .select("id, created_at, last_sync, company")
    .single();

  if (error) {
    // Row already exists — fetch it
    const { data: existing, error: fetchErr } = await supabase
      .from("tally_agent_tokens")
      .select("id, created_at, last_sync, company")
      .eq("client_id", user.id)
      .single();

    if (fetchErr) return json({ error: "Database error: " + fetchErr.message }, 500);
    return json({ token: existing.id, created: false, last_sync: existing.last_sync, company: existing.company });
  }

  return json({ token: data.id, created: true, last_sync: null, company: null });
});

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
