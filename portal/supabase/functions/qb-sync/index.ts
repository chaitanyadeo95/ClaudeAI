// Edge Function: /functions/v1/qb-sync
// Pulls financial data from QuickBooks Online for all connected clients.
// Triggered daily by pg_cron or called manually.
//
// Pulls per client:
//   • Chart of accounts (all account types)
//   • Trial balance for each of the 12 rolling months
//   • Open AR invoices (Balance > 0)
//   • Open AP bills   (Balance > 0)
//   • Bank / cash accounts with current balances

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  QBToken,
  QB_API_BASE,
  getValidToken,
  qbGet,
  corsHeaders,
} from "../_shared/quickbooks.ts";

const SUPABASE_URL          = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ── Entry point ───────────────────────────────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // Optional: scope to one client via POST { client_id: "uuid" }
  let targetClientId: string | null = null;
  if (req.method === "POST") {
    try { const b = await req.json(); targetClientId = b.client_id ?? null; } catch {}
  }

  let query = supabase.from("qb_tokens").select("*");
  if (targetClientId) query = query.eq("client_id", targetClientId);

  const { data: tokenRows, error } = await query;
  if (error) return jsonResp({ error: error.message }, 500);
  if (!tokenRows?.length) return jsonResp({ message: "No connected QuickBooks clients." }, 200);

  const results = [];
  for (const row of tokenRows) {
    results.push(await syncClient(supabase, row as QBToken));
  }

  return jsonResp({ synced: results.length, results }, 200);
});

// ── Per-client sync ───────────────────────────────────────────────────────────

async function syncClient(supabase: ReturnType<typeof createClient>, token: QBToken) {
  const { client_id: clientId, realm_id: realmId, environment } = token;
  const apiBase = QB_API_BASE[environment ?? "production"];
  const companyPath = `/v3/company/${realmId}`;

  const { data: syncLogRow } = await supabase
    .from("sync_logs")
    .insert({ client_id: clientId, source: "quickbooks" })
    .select("id").single();
  const syncLogId = syncLogRow?.id as string;
  const logCtx = { syncLogId, clientId };

  try {
    const accessToken = await getValidToken(supabase, token);

    const [accounts, , invoices, bills, banks] = await Promise.all([
      pullAccounts(supabase, apiBase, companyPath, accessToken, clientId, logCtx),
      pullMonthlyBalances(supabase, apiBase, companyPath, accessToken, realmId, clientId, logCtx),
      pullInvoices(supabase, apiBase, companyPath, accessToken, clientId, logCtx),
      pullBills(supabase, apiBase, companyPath, accessToken, clientId, logCtx),
      pullBankAccounts(supabase, apiBase, companyPath, accessToken, clientId, logCtx),
    ]);

    await supabase.from("sync_logs").update({
      finished_at:          new Date().toISOString(),
      status:               "success",
      accounts_pulled:      accounts,
      invoices_pulled:      invoices,
      bills_pulled:         bills,
      bank_accounts_pulled: banks,
    }).eq("id", syncLogId);

    return { clientId, status: "success", accounts, invoices, bills, banks };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await supabase.from("sync_logs").update({
      finished_at: new Date().toISOString(), status: "failed", error_message: msg,
    }).eq("id", syncLogId);
    return { clientId, status: "failed", error: msg };
  }
}

// ── 1. Chart of accounts ──────────────────────────────────────────────────────
// QB IDS query: SELECT * FROM Account MAXRESULTS 1000

async function pullAccounts(
  supabase: ReturnType<typeof createClient>,
  apiBase: string, companyPath: string,
  accessToken: string, clientId: string,
  logCtx: { syncLogId: string; clientId: string },
): Promise<number> {
  const data: any = await qbGet(
    supabase, apiBase, `${companyPath}/query`, accessToken,
    { query: "SELECT * FROM Account MAXRESULTS 1000" }, logCtx,
  );

  const accounts: any[] = data.QueryResponse?.Account ?? [];
  if (!accounts.length) return 0;

  const rows = accounts.map((a: any) => ({
    client_id:              clientId,
    zoho_account_id:        a.Id,          // reusing column; holds QB Account Id
    account_name:           a.Name,
    account_type:           a.AccountType,
    account_type_formatted: a.AccountSubType ?? a.AccountType,
    parent_account_id:      a.ParentRef?.value ?? null,
    currency_code:          a.CurrencyRef?.value ?? "USD",
    is_active:              a.Active ?? true,
    source:                 "quickbooks",
    synced_at:              new Date().toISOString(),
  }));

  await supabase.from("accounts")
    .upsert(rows, { onConflict: "client_id,zoho_account_id" });
  return rows.length;
}

// ── 2. Monthly balances (12 rolling months via TrialBalance report) ───────────

async function pullMonthlyBalances(
  supabase: ReturnType<typeof createClient>,
  apiBase: string, companyPath: string,
  accessToken: string, _realmId: string,
  clientId: string, logCtx: { syncLogId: string; clientId: string },
): Promise<void> {
  const now  = new Date();
  const rows: object[] = [];

  for (let i = 0; i < 12; i++) {
    const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const yr  = d.getFullYear();
    const mo  = d.getMonth() + 1;
    const pad = (n: number) => String(n).padStart(2, "0");
    const lastDay = new Date(yr, mo, 0).getDate();

    let data: any;
    try {
      data = await qbGet(
        supabase, apiBase, `${companyPath}/reports/TrialBalance`, accessToken,
        { start_date: `${yr}-${pad(mo)}-01`, end_date: `${yr}-${pad(mo)}-${lastDay}` },
        logCtx,
      );
    } catch { continue; }

    // QB TrialBalance response: data.Rows.Row[] each has ColData[]
    const rowsData: any[] = data?.Rows?.Row ?? [];
    for (const row of rowsData) {
      if (row.type === "Section" || !row.ColData) continue;
      const cols = row.ColData;
      // ColData[0] = account name+id, ColData[1] = debit, ColData[2] = credit
      const acctId = cols[0]?.id;
      if (!acctId) continue;

      rows.push({
        client_id:       clientId,
        zoho_account_id: acctId,
        period_year:     yr,
        period_month:    mo,
        debit_amount:    parseFloat(cols[1]?.value ?? "0"),
        credit_amount:   parseFloat(cols[2]?.value ?? "0"),
        closing_balance: parseFloat(cols[1]?.value ?? "0") - parseFloat(cols[2]?.value ?? "0"),
        currency_code:   "USD",
        source:          "quickbooks",
        synced_at:       new Date().toISOString(),
      });
    }
  }

  for (let i = 0; i < rows.length; i += 500) {
    await supabase.from("account_balances")
      .upsert(rows.slice(i, i + 500), { onConflict: "client_id,zoho_account_id,period_year,period_month" });
  }
}

// ── 3. Open AR invoices ───────────────────────────────────────────────────────

async function pullInvoices(
  supabase: ReturnType<typeof createClient>,
  apiBase: string, companyPath: string,
  accessToken: string, clientId: string,
  logCtx: { syncLogId: string; clientId: string },
): Promise<number> {
  const rows: object[] = [];
  let startPos = 1;

  while (true) {
    const data: any = await qbGet(
      supabase, apiBase, `${companyPath}/query`, accessToken,
      { query: `SELECT * FROM Invoice WHERE Balance > '0' STARTPOSITION ${startPos} MAXRESULTS 100` },
      logCtx,
    );

    const invoices: any[] = data.QueryResponse?.Invoice ?? [];
    for (const inv of invoices) {
      rows.push({
        client_id:       clientId,
        zoho_invoice_id: inv.Id,
        invoice_number:  inv.DocNumber ?? `INV-${inv.Id}`,
        customer_name:   inv.CustomerRef?.name ?? "—",
        invoice_date:    inv.TxnDate ?? null,
        due_date:        inv.DueDate ?? null,
        total:           parseFloat(inv.TotalAmt ?? "0"),
        balance:         parseFloat(inv.Balance ?? "0"),
        status:          inv.Balance > 0 ? "unpaid" : "paid",
        currency_code:   inv.CurrencyRef?.value ?? "USD",
        source:          "quickbooks",
        synced_at:       new Date().toISOString(),
      });
    }

    const totalCount: number = data.QueryResponse?.totalCount ?? 0;
    if (startPos + 100 > totalCount + 1) break;
    startPos += 100;
  }

  if (rows.length) {
    await supabase.from("ar_invoices")
      .upsert(rows, { onConflict: "client_id,zoho_invoice_id" });
  }
  return rows.length;
}

// ── 4. Open AP bills ──────────────────────────────────────────────────────────

async function pullBills(
  supabase: ReturnType<typeof createClient>,
  apiBase: string, companyPath: string,
  accessToken: string, clientId: string,
  logCtx: { syncLogId: string; clientId: string },
): Promise<number> {
  const rows: object[] = [];
  let startPos = 1;

  while (true) {
    const data: any = await qbGet(
      supabase, apiBase, `${companyPath}/query`, accessToken,
      { query: `SELECT * FROM Bill WHERE Balance > '0' STARTPOSITION ${startPos} MAXRESULTS 100` },
      logCtx,
    );

    const bills: any[] = data.QueryResponse?.Bill ?? [];
    for (const bill of bills) {
      rows.push({
        client_id:     clientId,
        zoho_bill_id:  bill.Id,
        bill_number:   bill.DocNumber ?? `BILL-${bill.Id}`,
        vendor_name:   bill.VendorRef?.name ?? "—",
        bill_date:     bill.TxnDate ?? null,
        due_date:      bill.DueDate ?? null,
        total:         parseFloat(bill.TotalAmt ?? "0"),
        balance:       parseFloat(bill.Balance ?? "0"),
        status:        bill.Balance > 0 ? "unpaid" : "paid",
        currency_code: bill.CurrencyRef?.value ?? "USD",
        source:        "quickbooks",
        synced_at:     new Date().toISOString(),
      });
    }

    const totalCount: number = data.QueryResponse?.totalCount ?? 0;
    if (startPos + 100 > totalCount + 1) break;
    startPos += 100;
  }

  if (rows.length) {
    await supabase.from("ap_bills")
      .upsert(rows, { onConflict: "client_id,zoho_bill_id" });
  }
  return rows.length;
}

// ── 5. Bank / cash accounts ───────────────────────────────────────────────────

async function pullBankAccounts(
  supabase: ReturnType<typeof createClient>,
  apiBase: string, companyPath: string,
  accessToken: string, clientId: string,
  logCtx: { syncLogId: string; clientId: string },
): Promise<number> {
  const data: any = await qbGet(
    supabase, apiBase, `${companyPath}/query`, accessToken,
    { query: "SELECT * FROM Account WHERE AccountType IN ('Bank', 'Other Current Asset') MAXRESULTS 200" },
    logCtx,
  );

  const accounts: any[] = data.QueryResponse?.Account ?? [];
  if (!accounts.length) return 0;

  const rows = accounts.map((a: any) => ({
    client_id:       clientId,
    zoho_account_id: a.Id,
    account_name:    a.Name,
    account_type:    a.AccountType,
    bank_name:       a.BankNum ? "Bank" : null,
    account_number:  a.AcctNum ?? null,
    balance:         parseFloat(a.CurrentBalance ?? "0"),
    currency_code:   a.CurrencyRef?.value ?? "USD",
    source:          "quickbooks",
    synced_at:       new Date().toISOString(),
  }));

  await supabase.from("bank_accounts")
    .upsert(rows, { onConflict: "client_id,zoho_account_id" });
  return rows.length;
}

// ── Helper ────────────────────────────────────────────────────────────────────

function jsonResp(body: object, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

