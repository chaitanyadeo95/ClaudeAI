// Edge Function: /functions/v1/tally-sync
// POST — receives data pushed by the Tally desktop agent, writes it to AR/AP/bank tables.
//
// Authorization: Bearer <tally-agent-token-uuid>
//
// Body JSON:
// {
//   company: "Acme Pvt Ltd",
//   receivables: [{ ref, party, date, due_date, amount, pending }],
//   payables:    [{ ref, party, date, due_date, amount, pending }],
//   bank:        [{ name, type, balance }],
//   pl:          { revenue, expenses, net }   // optional
// }

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/quickbooks.ts";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Auth: Bearer <tally_agent_tokens.id>
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Missing authorization" }, 401);
  const agentToken = authHeader.slice(7).trim();

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Resolve token → client_id
  const { data: tokenRow, error: tokenErr } = await supabase
    .from("tally_agent_tokens")
    .select("id, client_id, company")
    .eq("id", agentToken)
    .maybeSingle();

  if (tokenErr || !tokenRow) return json({ error: "Invalid agent token" }, 401);
  const clientId = tokenRow.client_id;

  // Parse body
  let body: {
    company?: string;
    receivables?: Array<{ ref: string; party: string; date?: string; due_date?: string; amount: number; pending: number }>;
    payables?:    Array<{ ref: string; party: string; date?: string; due_date?: string; amount: number; pending: number }>;
    bank?:        Array<{ name: string; type: string; balance: number }>;
    pl?:          { revenue?: number; expenses?: number; net?: number };
  };

  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const now = new Date().toISOString();

  // ── Create sync log ──────────────────────────────────────────────────────────
  const { data: syncLog } = await supabase.from("sync_logs").insert({
    client_id:  clientId,
    started_at: now,
    status:     "running",
    source:     "tally",
  }).select("id").single();

  const syncLogId = syncLog?.id;
  let invoicesPulled = 0, billsPulled = 0, banksPulled = 0;
  let errorMessage: string | null = null;

  try {
    // ── AR Invoices (receivables) ────────────────────────────────────────────
    if (body.receivables?.length) {
      // Delete existing tally AR rows, then insert fresh (avoids stale data)
      await supabase.from("ar_invoices")
        .delete()
        .eq("client_id", clientId)
        .eq("source", "tally");

      const arRows = body.receivables.map((r) => ({
        client_id:       clientId,
        zoho_invoice_id: `tally_${r.ref}`,
        invoice_number:  r.ref,
        customer_name:   r.party,
        invoice_date:    r.date || null,
        due_date:        r.due_date || null,
        total:           r.amount,
        balance:         r.pending,
        status:          r.pending > 0 ? "open" : "paid",
        currency_code:   "INR",
        source:          "tally",
        synced_at:       now,
      }));

      const { error: arErr } = await supabase.from("ar_invoices").insert(arRows);
      if (arErr) throw new Error("AR insert failed: " + arErr.message);
      invoicesPulled = arRows.length;
    }

    // ── AP Bills (payables) ──────────────────────────────────────────────────
    if (body.payables?.length) {
      await supabase.from("ap_bills")
        .delete()
        .eq("client_id", clientId)
        .eq("source", "tally");

      const apRows = body.payables.map((p) => ({
        client_id:    clientId,
        zoho_bill_id: `tally_${p.ref}`,
        bill_number:  p.ref,
        vendor_name:  p.party,
        bill_date:    p.date || null,
        due_date:     p.due_date || null,
        total:        p.amount,
        balance:      p.pending,
        status:       p.pending > 0 ? "open" : "paid",
        currency_code:"INR",
        source:       "tally",
        synced_at:    now,
      }));

      const { error: apErr } = await supabase.from("ap_bills").insert(apRows);
      if (apErr) throw new Error("AP insert failed: " + apErr.message);
      billsPulled = apRows.length;
    }

    // ── Bank / Cash accounts ─────────────────────────────────────────────────
    if (body.bank?.length) {
      await supabase.from("bank_accounts")
        .delete()
        .eq("client_id", clientId)
        .eq("source", "tally");

      const bankRows = body.bank.map((b) => ({
        client_id:      clientId,
        zoho_account_id:`tally_${b.name}`,
        account_name:   b.name,
        account_type:   b.type,
        balance:        b.balance,
        currency_code:  "INR",
        source:         "tally",
        synced_at:      now,
      }));

      const { error: bankErr } = await supabase.from("bank_accounts").insert(bankRows);
      if (bankErr) throw new Error("Bank insert failed: " + bankErr.message);
      banksPulled = bankRows.length;
    }

    // ── Update tally_agent_tokens ────────────────────────────────────────────
    await supabase.from("tally_agent_tokens").update({
      last_sync: now,
      company:   body.company ?? tokenRow.company,
    }).eq("id", agentToken);

    // ── Finalise sync log (success) ──────────────────────────────────────────
    await supabase.from("sync_logs").update({
      finished_at:         now,
      status:              "success",
      invoices_pulled:     invoicesPulled,
      bills_pulled:        billsPulled,
      bank_accounts_pulled:banksPulled,
    }).eq("id", syncLogId);

    return json({
      ok: true,
      invoices: invoicesPulled,
      bills:    billsPulled,
      banks:    banksPulled,
    });

  } catch (err) {
    errorMessage = String(err);
    await supabase.from("sync_logs").update({
      finished_at:   now,
      status:        "failed",
      error_message: errorMessage,
    }).eq("id", syncLogId);

    console.error("tally-sync error:", errorMessage);
    return json({ error: errorMessage }, 500);
  }
});

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
