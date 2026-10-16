// Edge Function: /functions/v1/get-dashboard
// Returns full financial intelligence for the client dashboard.
//
// GET /functions/v1/get-dashboard?client_id=<uuid>
// Requires: Authorization: Bearer <supabase-session-token>

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/quickbooks.ts";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY    = Deno.env.get("SUPABASE_ANON_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const url      = new URL(req.url);
  const clientId = url.searchParams.get("client_id");
  if (!clientId) return json({ error: "Missing client_id" }, 400);

  // ── Auth ───────────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Missing authorization" }, 401);
  const token = authHeader.slice(7);

  const anonSb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  const { data: { user }, error: authErr } = await anonSb.auth.getUser(token);
  if (authErr || !user) return json({ error: "Invalid or expired token" }, 401);
  if (user.id !== clientId) return json({ error: "Forbidden" }, 403);
  // ──────────────────────────────────────────────────────────────────────────

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const now      = new Date();
  const nowMs    = now.getTime();
  const MS_DAY   = 86_400_000;

  const [arRes, apRes, bankRes, syncRes, qbTokenRes, tallyTokenRes] = await Promise.all([
    supabase.from("ar_invoices")
      .select("balance, due_date, customer_name, invoice_number, total, invoice_date, status")
      .eq("client_id", clientId),

    supabase.from("ap_bills")
      .select("balance, due_date, vendor_name, bill_number, total, bill_date, status")
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

    supabase.from("qb_tokens")
      .select("realm_id, updated_at")
      .eq("client_id", clientId)
      .maybeSingle(),

    supabase.from("tally_agent_tokens")
      .select("id, last_sync, company")
      .eq("client_id", clientId)
      .maybeSingle(),
  ]);

  const invoices       = arRes.data  ?? [];
  const bills          = apRes.data  ?? [];
  const banks          = bankRes.data ?? [];
  const lastSync       = syncRes.data;
  const qbConnected    = !!qbTokenRes.data?.realm_id;
  const tallyConnected = !!tallyTokenRes.data?.id;

  // ── Base totals ────────────────────────────────────────────────────────────
  const totalAR   = invoices.reduce((s, r) => s + (parseFloat(r.balance) || 0), 0);
  const totalAP   = bills.reduce((s,   r) => s + (parseFloat(r.balance) || 0), 0);
  const totalBank = banks.reduce((s,   r) => s + (parseFloat(r.balance) || 0), 0);

  const overdueInvoices = invoices.filter(r => r.due_date && new Date(r.due_date) < now);
  const overdueBills    = bills.filter(r =>   r.due_date && new Date(r.due_date) < now);

  const topInvoices = [...invoices]
    .sort((a, b) => parseFloat(b.balance) - parseFloat(a.balance))
    .slice(0, 5);

  // ── AR aging buckets ───────────────────────────────────────────────────────
  const arAging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  for (const inv of invoices) {
    const bal = parseFloat(inv.balance) || 0;
    if (bal <= 0) continue;
    if (!inv.due_date || new Date(inv.due_date) >= now) {
      arAging.current += bal;
    } else {
      const days = Math.floor((nowMs - new Date(inv.due_date).getTime()) / MS_DAY);
      if      (days <= 30) arAging.d1_30  += bal;
      else if (days <= 60) arAging.d31_60 += bal;
      else if (days <= 90) arAging.d61_90 += bal;
      else                 arAging.d90plus += bal;
    }
  }

  // ── DSO / Best Possible DSO / ADD ──────────────────────────────────────────
  const days90Ago    = new Date(nowMs - 90 * MS_DAY);
  const sales90d     = invoices
    .filter(i => i.invoice_date && new Date(i.invoice_date) >= days90Ago)
    .reduce((s, i) => s + (parseFloat(i.total) || 0), 0);
  const dso             = sales90d > 0 ? Math.round((totalAR         / sales90d) * 90) : null;
  const bestPossibleDso = sales90d > 0 ? Math.round((arAging.current / sales90d) * 90) : null;
  const avgDaysDelinquent = (dso !== null && bestPossibleDso !== null) ? dso - bestPossibleDso : null;

  // ── Bad-debt provision (standard aging reserve rates) ─────────────────────
  const badDebtProvision = Math.round(
    arAging.d1_30  * 0.05 +
    arAging.d31_60 * 0.10 +
    arAging.d61_90 * 0.25 +
    arAging.d90plus * 0.50
  );

  // ── Customer concentration (top 10 by open balance) ───────────────────────
  const byCustomer: Record<string, number> = {};
  for (const inv of invoices) {
    const n = inv.customer_name || "Unknown";
    byCustomer[n] = (byCustomer[n] || 0) + (parseFloat(inv.balance) || 0);
  }
  const customerConcentration = Object.entries(byCustomer)
    .map(([name, balance]) => ({
      name, balance,
      pct: totalAR > 0 ? Math.round((balance / totalAR) * 100) : 0,
    }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10);

  // ── AR cash-in forecast by week (next 13 weeks based on due dates) ─────────
  const arForecast = Array.from({ length: 13 }, (_, w) => {
    const wStart = new Date(nowMs + w * 7 * MS_DAY);
    const wEnd   = new Date(nowMs + (w + 1) * 7 * MS_DAY);
    return {
      week:       w + 1,
      week_start: wStart.toISOString().slice(0, 10),
      amount:     invoices
        .filter(i => i.due_date && new Date(i.due_date) >= wStart && new Date(i.due_date) < wEnd)
        .reduce((s, i) => s + (parseFloat(i.balance) || 0), 0),
    };
  });

  // ── AP aging buckets + payment calendar ───────────────────────────────────
  const apAging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
  let apOverdue = 0, apDue7 = 0, apDue14 = 0, apDue30 = 0;
  const day7  = new Date(nowMs + 7  * MS_DAY);
  const day14 = new Date(nowMs + 14 * MS_DAY);
  const day30 = new Date(nowMs + 30 * MS_DAY);

  for (const bill of bills) {
    const bal = parseFloat(bill.balance) || 0;
    if (bal <= 0) continue;
    if (!bill.due_date || new Date(bill.due_date) >= now) {
      apAging.current += bal;
      const due = bill.due_date ? new Date(bill.due_date) : null;
      if      (!due || due > day30) { /* beyond 30d, no bucket */ }
      else if (due <= day7)  apDue7  += bal;
      else if (due <= day14) apDue14 += bal;
      else if (due <= day30) apDue30 += bal;
    } else {
      apOverdue += bal;
      const days = Math.floor((nowMs - new Date(bill.due_date).getTime()) / MS_DAY);
      if      (days <= 30) apAging.d1_30  += bal;
      else if (days <= 60) apAging.d31_60 += bal;
      else if (days <= 90) apAging.d61_90 += bal;
      else                 apAging.d90plus += bal;
    }
  }

  // ── DPO / CCC ──────────────────────────────────────────────────────────────
  const purchases90d = bills
    .filter(b => b.bill_date && new Date(b.bill_date) >= days90Ago)
    .reduce((s, b) => s + (parseFloat(b.total) || 0), 0);
  const dpo = purchases90d > 0 ? Math.round((totalAP / purchases90d) * 90) : null;
  const ccc = (dso !== null && dpo !== null) ? dso - dpo : null;

  // ── Vendor concentration (top 10) ─────────────────────────────────────────
  const byVendor: Record<string, number> = {};
  for (const bill of bills) {
    const n = bill.vendor_name || "Unknown";
    byVendor[n] = (byVendor[n] || 0) + (parseFloat(bill.balance) || 0);
  }
  const vendorConcentration = Object.entries(byVendor)
    .map(([name, balance]) => ({
      name, balance,
      pct: totalAP > 0 ? Math.round((balance / totalAP) * 100) : 0,
    }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 10);

  // ── Duplicate bill detection (same vendor + same amount + ≤30 days apart) ──
  const duplicates: Array<{ bill1: string; bill2: string; vendor: string; amount: number; days_apart: number }> = [];
  for (let i = 0; i < bills.length; i++) {
    for (let j = i + 1; j < bills.length; j++) {
      const amtI = parseFloat(bills[i].total) || 0;
      const amtJ = parseFloat(bills[j].total) || 0;
      if (bills[i].vendor_name !== bills[j].vendor_name) continue;
      if (Math.abs(amtI - amtJ) >= 0.01 || amtI <= 0) continue;
      const dI = bills[i].bill_date ? new Date(bills[i].bill_date).getTime() : null;
      const dJ = bills[j].bill_date ? new Date(bills[j].bill_date).getTime() : null;
      if (!dI || !dJ) continue;
      const daysApart = Math.round(Math.abs(dI - dJ) / MS_DAY);
      if (daysApart <= 30) {
        duplicates.push({
          bill1:      bills[i].bill_number || "—",
          bill2:      bills[j].bill_number || "—",
          vendor:     bills[i].vendor_name || "Unknown",
          amount:     amtI,
          days_apart: daysApart,
        });
      }
    }
  }

  // ── 13-week combined cash forecast ─────────────────────────────────────────
  let runningBalance = totalBank;
  const forecast13w = Array.from({ length: 13 }, (_, w) => {
    const wStart = new Date(nowMs + w * 7 * MS_DAY);
    const wEnd   = new Date(nowMs + (w + 1) * 7 * MS_DAY);
    const inflows  = invoices
      .filter(i => i.due_date && new Date(i.due_date) >= wStart && new Date(i.due_date) < wEnd)
      .reduce((s, i) => s + (parseFloat(i.balance) || 0), 0);
    const outflows = bills
      .filter(b => b.due_date && new Date(b.due_date) >= wStart && new Date(b.due_date) < wEnd)
      .reduce((s, b) => s + (parseFloat(b.balance) || 0), 0);
    const opening = runningBalance;
    runningBalance += inflows - outflows;
    return {
      week:       w + 1,
      week_start: wStart.toISOString().slice(0, 10),
      opening,
      inflows,
      outflows,
      net:     inflows - outflows,
      closing: runningBalance,
    };
  });

  // ── Response ────────────────────────────────────────────────────────────────
  return json({
    qbConnected,
    tallyConnected,
    lastSync: lastSync ? {
      at:       lastSync.finished_at,
      accounts: lastSync.accounts_pulled,
      invoices: lastSync.invoices_pulled,
      bills:    lastSync.bills_pulled,
      banks:    lastSync.bank_accounts_pulled,
    } : null,

    // Core totals (Overview tab)
    ar: {
      total:   totalAR,
      count:   invoices.length,
      overdue: overdueInvoices.length,
      top:     topInvoices,
      // Intelligence metrics
      aging:                arAging,
      dso,
      best_possible_dso:    bestPossibleDso,
      avg_days_delinquent:  avgDaysDelinquent,
      bad_debt_provision:   badDebtProvision,
      customer_concentration: customerConcentration,
      cash_forecast:        arForecast,
    },
    ap: {
      total:   totalAP,
      count:   bills.length,
      overdue: overdueBills.length,
      // Intelligence metrics
      aging:                apAging,
      dpo,
      ccc,
      overdue_total:        apOverdue,
      due_7d:               apDue7,
      due_14d:              apDue14,
      due_30d:              apDue30,
      vendor_concentration: vendorConcentration,
      duplicates,
    },
    bank: {
      total:    totalBank,
      accounts: banks,
    },
    forecast_13w: forecast13w,
  });
});

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
