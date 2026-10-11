// Edge Function: /functions/v1/zoho-sync
// Pulls financial data from Zoho Books for all connected clients.
// Triggered daily by pg_cron (see migration) or called manually.
//
// Pulls per client:
//   • Chart of accounts
//   • Trial balance for each of the 12 rolling months (account-level balances)
//   • Open AR invoices (unpaid / partial)
//   • Open AP bills   (unpaid / partial)
//   • Bank / cash accounts

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  ZohoToken, DataCentre,
  DC_API_URLS,
  getValidToken,
  zohoGet,
  corsHeaders,
} from "../_shared/zoho.ts";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── Entry point ───────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Optionally scope to a single client: POST { client_id: "uuid" }
  let targetClientId: string | null = null;
  if (req.method === "POST") {
    try {
      const body = await req.json();
      targetClientId = body.client_id ?? null;
    } catch { /* no body */ }
  }

  // Fetch all connected clients (or just the one targeted)
  let query = supabase
    .from("zoho_tokens")
    .select("*, clients(id, name)");
  if (targetClientId) query = query.eq("client_id", targetClientId);

  const { data: tokenRows, error: tokenErr } = await query;
  if (tokenErr) {
    return jsonResponse({ error: tokenErr.message }, 500);
  }
  if (!tokenRows || tokenRows.length === 0) {
    return jsonResponse({ message: "No connected clients found." }, 200);
  }

  const results = [];
  for (const row of tokenRows) {
    const result = await syncClient(supabase, row as ZohoToken & { clients: { id: string; name: string } });
    results.push(result);
  }

  return jsonResponse({ synced: results.length, results }, 200);
});

// ── Per-client sync ───────────────────────────────────────────────────────────

async function syncClient(
  supabase: ReturnType<typeof createClient>,
  token: ZohoToken & { clients: { id: string; name: string } },
): Promise<object> {
  const clientId = token.client_id;
  const orgId    = token.zoho_org_id;
  const dc       = token.data_centre as DataCentre;
  const apiBase  = DC_API_URLS[dc];

  // Create sync log entry
  const { data: syncLogRow } = await supabase
    .from("sync_logs")
    .insert({ client_id: clientId })
    .select("id")
    .single();
  const syncLogId = syncLogRow?.id as string;

  const logCtx = { syncLogId, clientId };
  let pullCounts = { accounts: 0, invoices: 0, bills: 0, bankAccounts: 0 };

  try {
    const accessToken = await getValidToken(supabase, token);
    const baseParams  = { organization_id: orgId };

    // 1. Chart of accounts
    pullCounts.accounts = await pullAccounts(supabase, apiBase, accessToken, baseParams, clientId, logCtx);

    // 2. Account balances — 12 rolling months
    await pullMonthlyBalances(supabase, apiBase, accessToken, orgId, clientId, logCtx);

    // 3. Open AR invoices
    pullCounts.invoices = await pullInvoices(supabase, apiBase, accessToken, baseParams, clientId, logCtx);

    // 4. Open AP bills
    pullCounts.bills = await pullBills(supabase, apiBase, accessToken, baseParams, clientId, logCtx);

    // 5. Bank / cash accounts
    pullCounts.bankAccounts = await pullBankAccounts(supabase, apiBase, accessToken, baseParams, clientId, logCtx);

    await supabase.from("sync_logs").update({
      finished_at:          new Date().toISOString(),
      status:               "success",
      accounts_pulled:      pullCounts.accounts,
      invoices_pulled:      pullCounts.invoices,
      bills_pulled:         pullCounts.bills,
      bank_accounts_pulled: pullCounts.bankAccounts,
    }).eq("id", syncLogId);

    return { clientId, status: "success", ...pullCounts };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase.from("sync_logs").update({
      finished_at:    new Date().toISOString(),
      status:         "failed",
      error_message:  msg,
    }).eq("id", syncLogId);

    return { clientId, status: "failed", error: msg };
  }
}

// ── 1. Chart of accounts ──────────────────────────────────────────────────────

async function pullAccounts(
  supabase: ReturnType<typeof createClient>,
  apiBase: string, accessToken: string,
  baseParams: Record<string, string>,
  clientId: string, logCtx: { syncLogId: string; clientId: string },
): Promise<number> {
  const data: any = await zohoGet(supabase, apiBase, "/chartofaccounts", accessToken, baseParams, logCtx);
  const accounts: any[] = data.chartofaccounts ?? [];

  if (accounts.length === 0) return 0;

  const rows = accounts.map((a: any) => ({
    client_id:              clientId,
    zoho_account_id:        a.account_id,
    account_name:           a.account_name,
    account_type:           a.account_type,
    account_type_formatted: a.account_type_formatted,
    parent_account_id:      a.parent_account_id || null,
    currency_code:          a.currency_code ?? "INR",
    is_active:              a.is_active ?? true,
    synced_at:              new Date().toISOString(),
  }));

  await supabase.from("accounts").upsert(rows, { onConflict: "client_id,zoho_account_id" });
  return rows.length;
}

// ── 2. Monthly balances (12 rolling months via trial balance) ─────────────────

async function pullMonthlyBalances(
  supabase: ReturnType<typeof createClient>,
  apiBase: string, accessToken: string,
  orgId: string, clientId: string,
  logCtx: { syncLogId: string; clientId: string },
): Promise<void> {
  const now   = new Date();
  const rows: object[] = [];

  for (let i = 0; i < 12; i++) {
    const d    = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const mon  = d.getMonth() + 1; // 1-12

    const fromDate = `${year}-${String(mon).padStart(2, "0")}-01`;
    const lastDay  = new Date(year, mon, 0).getDate();
    const toDate   = `${year}-${String(mon).padStart(2, "0")}-${lastDay}`;

    let data: any;
    try {
      data = await zohoGet(supabase, apiBase, "/reports/trialbalance", accessToken, {
        organization_id: orgId,
        from_date:       fromDate,
        to_date:         toDate,
      }, logCtx);
    } catch {
      continue; // log already written by zohoGet; skip this month
    }

    const lines: any[] = data.trial_balance ?? [];
    for (const line of lines) {
      if (!line.account_id) continue;
      rows.push({
        client_id:       clientId,
        zoho_account_id: line.account_id,
        period_year:     year,
        period_month:    mon,
        debit_amount:    parseFloat(line.debit  ?? "0"),
        credit_amount:   parseFloat(line.credit ?? "0"),
        closing_balance: parseFloat(line.closing_balance ?? line.balance ?? "0"),
        currency_code:   "INR",
        synced_at:       new Date().toISOString(),
      });
    }
  }

  if (rows.length > 0) {
    // upsert in chunks of 500
    for (let i = 0; i < rows.length; i += 500) {
      await supabase
        .from("account_balances")
        .upsert(rows.slice(i, i + 500), { onConflict: "client_id,zoho_account_id,period_year,period_month" });
    }
  }
}

// ── 3. Open AR invoices ───────────────────────────────────────────────────────

async function pullInvoices(
  supabase: ReturnType<typeof createClient>,
  apiBase: string, accessToken: string,
  baseParams: Record<string, string>,
  clientId: string, logCtx: { syncLogId: string; clientId: string },
): Promise<number> {
  const rows: object[] = [];
  let page = 1;

  while (true) {
    const data: any = await zohoGet(supabase, apiBase, "/invoices", accessToken, {
      ...baseParams,
      status:   "unpaid",
      page:     String(page),
      per_page: "200",
    }, logCtx);

    const invoices: any[] = data.invoices ?? [];
    for (const inv of invoices) {
      rows.push({
        client_id:        clientId,
        zoho_invoice_id:  inv.invoice_id,
        invoice_number:   inv.invoice_number,
        customer_name:    inv.customer_name,
        invoice_date:     inv.date || null,
        due_date:         inv.due_date || null,
        total:            parseFloat(inv.total ?? "0"),
        balance:          parseFloat(inv.balance ?? "0"),
        status:           inv.status,
        currency_code:    inv.currency_code ?? "INR",
        synced_at:        new Date().toISOString(),
      });
    }

    if (!data.page_context?.has_more_page) break;
    page++;
  }

  // Also pull partially_paid
  page = 1;
  while (true) {
    const data: any = await zohoGet(supabase, apiBase, "/invoices", accessToken, {
      ...baseParams,
      status:   "partial",
      page:     String(page),
      per_page: "200",
    }, logCtx);

    const invoices: any[] = data.invoices ?? [];
    for (const inv of invoices) {
      rows.push({
        client_id:        clientId,
        zoho_invoice_id:  inv.invoice_id,
        invoice_number:   inv.invoice_number,
        customer_name:    inv.customer_name,
        invoice_date:     inv.date || null,
        due_date:         inv.due_date || null,
        total:            parseFloat(inv.total ?? "0"),
        balance:          parseFloat(inv.balance ?? "0"),
        status:           inv.status,
        currency_code:    inv.currency_code ?? "INR",
        synced_at:        new Date().toISOString(),
      });
    }

    if (!data.page_context?.has_more_page) break;
    page++;
  }

  if (rows.length > 0) {
    await supabase.from("ar_invoices").upsert(rows, { onConflict: "client_id,zoho_invoice_id" });
  }
  return rows.length;
}

// ── 4. Open AP bills ──────────────────────────────────────────────────────────

async function pullBills(
  supabase: ReturnType<typeof createClient>,
  apiBase: string, accessToken: string,
  baseParams: Record<string, string>,
  clientId: string, logCtx: { syncLogId: string; clientId: string },
): Promise<number> {
  const rows: object[] = [];

  for (const status of ["unpaid", "partial"]) {
    let page = 1;
    while (true) {
      const data: any = await zohoGet(supabase, apiBase, "/bills", accessToken, {
        ...baseParams,
        status,
        page:     String(page),
        per_page: "200",
      }, logCtx);

      const bills: any[] = data.bills ?? [];
      for (const bill of bills) {
        rows.push({
          client_id:     clientId,
          zoho_bill_id:  bill.bill_id,
          bill_number:   bill.bill_number,
          vendor_name:   bill.vendor_name,
          bill_date:     bill.date || null,
          due_date:      bill.due_date || null,
          total:         parseFloat(bill.total ?? "0"),
          balance:       parseFloat(bill.balance ?? "0"),
          status:        bill.status,
          currency_code: bill.currency_code ?? "INR",
          synced_at:     new Date().toISOString(),
        });
      }

      if (!data.page_context?.has_more_page) break;
      page++;
    }
  }

  if (rows.length > 0) {
    await supabase.from("ap_bills").upsert(rows, { onConflict: "client_id,zoho_bill_id" });
  }
  return rows.length;
}

// ── 5. Bank / cash accounts ───────────────────────────────────────────────────

async function pullBankAccounts(
  supabase: ReturnType<typeof createClient>,
  apiBase: string, accessToken: string,
  baseParams: Record<string, string>,
  clientId: string, logCtx: { syncLogId: string; clientId: string },
): Promise<number> {
  const data: any = await zohoGet(supabase, apiBase, "/bankaccounts", accessToken, baseParams, logCtx);
  const accounts: any[] = data.bankaccounts ?? [];

  if (accounts.length === 0) return 0;

  const rows = accounts.map((a: any) => ({
    client_id:       clientId,
    zoho_account_id: a.account_id,
    account_name:    a.account_name,
    account_type:    a.account_type,
    bank_name:       a.bank_name ?? null,
    account_number:  a.account_number ?? null,
    balance:         parseFloat(a.balance ?? "0"),
    currency_code:   a.currency_code ?? "INR",
    synced_at:       new Date().toISOString(),
  }));

  await supabase.from("bank_accounts").upsert(rows, { onConflict: "client_id,zoho_account_id" });
  return rows.length;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function jsonResponse(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
