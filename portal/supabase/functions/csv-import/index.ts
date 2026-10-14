import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { client_id, type, records, replace } = await req.json();

    if (!client_id || !type || !Array.isArray(records)) {
      return new Response(JSON.stringify({ error: 'Missing client_id, type, or records' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const tableMap: Record<string, string> = {
      ar:   'ar_invoices',
      ap:   'ap_bills',
      bank: 'bank_accounts',
    };
    const table = tableMap[type];
    if (!table) {
      return new Response(JSON.stringify({ error: 'Invalid type' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const sb = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

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
        // Ensure unique external ID for each row
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
