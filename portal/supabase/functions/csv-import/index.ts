import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const TABLE_MAP: Record<string, string> = {
  ar:   'ar_invoices',
  ap:   'ap_bills',
  bank: 'bank_accounts',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const fail = (msg: string, status = 400) =>
    new Response(JSON.stringify({ error: msg }), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const body = await req.json();
    const { client_id, type, action } = body;

    if (!client_id || !type) return fail('Missing client_id or type');
    const table = TABLE_MAP[type];
    if (!table) return fail('Invalid type — must be ar, ap, or bank');

    // ── Auth: verify the caller owns this client_id ─────────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return fail('Missing authorization', 401);
    const token = authHeader.slice(7);

    const anonSb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
    );
    const { data: { user }, error: authErr } = await anonSb.auth.getUser(token);
    if (authErr || !user) return fail('Invalid or expired token', 401);
    if (user.id !== client_id) return fail('Forbidden', 403);
    // ───────────────────────────────────────────────────────────────────────────

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    // ── Clear action: delete all CSV-imported records for this type ───────────
    if (action === 'clear') {
      const { error } = await sb.from(table)
        .delete().eq('client_id', client_id).eq('source', 'csv');
      if (error) throw new Error(error.message);
      return new Response(JSON.stringify({ cleared: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // ── Import action ─────────────────────────────────────────────────────────
    const { records, replace } = body;
    if (!Array.isArray(records)) return fail('Missing records array');

    if (replace) {
      const { error: delErr } = await sb.from(table)
        .delete().eq('client_id', client_id).eq('source', 'csv');
      if (delErr) throw new Error('Delete failed: ' + delErr.message);
    }

    const BATCH = 50;
    let imported = 0;
    for (let i = 0; i < records.length; i += BATCH) {
      const batch = records.slice(i, i + BATCH).map((r: Record<string, unknown>, idx: number) => ({
        ...r,
        client_id,
        source: 'csv',
        synced_at: new Date().toISOString(),
        ...(type === 'ar'   && { zoho_invoice_id: `csv_${Date.now()}_${i + idx}` }),
        ...(type === 'ap'   && { zoho_bill_id:    `csv_${Date.now()}_${i + idx}` }),
        ...(type === 'bank' && { zoho_account_id: `csv_${Date.now()}_${i + idx}` }),
      }));
      const { error } = await sb.from(table).insert(batch);
      if (error) throw new Error(error.message);
      imported += batch.length;
    }

    return new Response(JSON.stringify({ imported }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
