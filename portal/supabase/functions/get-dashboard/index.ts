// Edge Function: /functions/v1/get-dashboard
// Returns live financial summary for a client from synced QuickBooks data.
//
// GET /functions/v1/get-dashboard?client_id=<uuid>

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/quickbooks.ts";

const SUPABASE_URL        = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url      = new URL(req.url);
  const clientId = url.searchParams.get("client_id");
  if (!clientId) return json({ error: "Missing client_id" }, 400);

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const now      = new Date();

  const [arRes, apRes, bankRes, syncRes] = await Promise.all([
    supabase.from("ar_invoices")
      .select("balance, due_date, customer_name, invoice_number, total")
      .eq("client_id", clientId),

    supabase.from("ap_bills")
      .select("balance, due_date, vendor_name, bill_number, total")
      .eq("client_id", clientId),

    supabase.from("bank_accounts")
      .select("account_name, account_type, balance")
      .eq("client_id", clientId)
      .order("balance", { ascending: false }),

    supabase.from("sync_logs")
      .select("finished_at, status, accounts_pulled, invoices_pulled, bills_pulled, bank_accounts_pulled")
      .eq("client_id", clientId)
      .eq("status", "success")
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const invoices = arRes.data ?? [];
  const bills    = apRes.data ?? [];
  const banks    = bankRes.data ?? [];
  const lastSync = syncRes.data;

  const totalAR   = invoices.reduce((s, r) => s + (parseFloat(r.balance) || 0), 0);
  const totalAP   = bills.reduce((s, r) => s + (parseFloat(r.balance) || 0), 0);
  const totalBank = banks.reduce((s, r) => s + (parseFloat(r.balance) || 0), 0);

  const overdueInvoices = invoices.filter(
    (r) => r.due_date && new Date(r.due_date) < now
  );
  const overdueBills = bills.filter(
    (r) => r.due_date && new Date(r.due_date) < now
  );

  // Top 5 invoices by balance (largest first)
  const topInvoices = [...invoices]
    .sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance))
    .slice(0, 5);

  return json({
    ar: {
      total:   totalAR,
      count:   invoices.length,
      overdue: overdueInvoices.length,
      top:     topInvoices,
    },
    ap: {
      total:   totalAP,
      count:   bills.length,
      overdue: overdueBills.length,
    },
    bank: {
      total:    totalBank,
      accounts: banks,
    },
    lastSync: lastSync
      ? {
          at:      lastSync.finished_at,
          accounts: lastSync.accounts_pulled,
          invoices: lastSync.invoices_pulled,
          bills:    lastSync.bills_pulled,
          banks:    lastSync.bank_accounts_pulled,
        }
      : null,
  });
});

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
