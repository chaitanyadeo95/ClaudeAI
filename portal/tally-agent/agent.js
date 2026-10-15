/**
 * AiFinanceo — Tally Desktop Sync Agent
 *
 * Prerequisites:
 *   1. node >= 18
 *   2. npm install
 *   3. Copy config.example.json → config.json and fill in your token
 *   4. Tally ERP 9 / TallyPrime must be open with the company loaded
 *   5. Tally Gateway of Tally must be running (usually on port 9000)
 *
 * Run:  node agent.js
 */

'use strict';

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const { XMLParser } = require('fast-xml-parser');

// ── Config ────────────────────────────────────────────────────────────────────

const configPath = path.join(__dirname, 'config.json');
if (!fs.existsSync(configPath)) {
  console.error('[AiFinanceo] config.json not found.');
  console.error('  Copy config.example.json → config.json and fill in your token.');
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
const {
  AGENT_TOKEN,
  AIFINANCEO_URL,
  TALLY_HOST             = 'localhost',
  TALLY_PORT             = 9000,
  SYNC_INTERVAL_MINUTES  = 30,
  FINANCIAL_YEAR_START   = currentFYStart(),
  FINANCIAL_YEAR_END     = currentFYEnd(),
} = cfg;

if (!AGENT_TOKEN || AGENT_TOKEN === 'paste-your-token-from-aifinanceo-here') {
  console.error('[AiFinanceo] AGENT_TOKEN is not set in config.json. Get it from AiFinanceo → Connect Tally.');
  process.exit(1);
}

if (!AIFINANCEO_URL) {
  console.error('[AiFinanceo] AIFINANCEO_URL is not set in config.json.');
  process.exit(1);
}

// ── XML helpers ───────────────────────────────────────────────────────────────

const xmlParser = new XMLParser({
  ignoreAttributes:    false,
  attributeNamePrefix: '@_',
  parseTagValue:       true,
  trimValues:          true,
  isArray: (name) => ['BILL', 'LEDGER', 'GROUP', 'TALLYMESSAGE'].includes(name),
});

function tallyXml(reportName, extraVars = '') {
  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>${reportName}</REPORTNAME>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      <SVFROMDATE>${FINANCIAL_YEAR_START}</SVFROMDATE>
      <SVTODATE>${FINANCIAL_YEAR_END}</SVTODATE>
      ${extraVars}
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
}

// ── Tally HTTP request ────────────────────────────────────────────────────────

async function queryTally(xmlBody) {
  return new Promise((resolve, reject) => {
    const bodyBuf = Buffer.from(xmlBody, 'utf-8');
    const req = http.request({
      host:   TALLY_HOST,
      port:   Number(TALLY_PORT),
      path:   '/',
      method: 'POST',
      headers: {
        'Content-Type':   'text/xml;charset=UTF-8',
        'Content-Length': bodyBuf.length,
      },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve(xmlParser.parse(raw));
        } catch (e) {
          reject(new Error('XML parse error: ' + e.message + '\nRaw: ' + raw.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tally request timed out')); });
    req.write(xmlBody);
    req.end();
  });
}

// ── Extract helpers ───────────────────────────────────────────────────────────

function getCollection(parsed) {
  try {
    const body = parsed.ENVELOPE?.BODY ?? parsed.ENVELOPE?.body;
    const data = body?.DATA ?? body?.EXPORTDATA?.REQUESTDATA;
    const msgs = data?.TALLYMESSAGE ?? [];
    const msg  = Array.isArray(msgs) ? msgs[0] : msgs;
    return msg?.COLLECTION ?? {};
  } catch {
    return {};
  }
}

function tallyDate(str) {
  if (!str || typeof str !== 'string' || str.length !== 8) return null;
  return `${str.slice(0,4)}-${str.slice(4,6)}-${str.slice(6,8)}`;
}

function positiveAmount(v) {
  const n = parseFloat(String(v).replace(/,/g, '')) || 0;
  return Math.abs(n);
}

// ── Receivables ───────────────────────────────────────────────────────────────

async function getReceivables() {
  log('Querying Bills Receivable…');
  const parsed = await queryTally(tallyXml('Bills Receivable'));
  const col    = getCollection(parsed);
  const bills  = toArray(col.BILL);

  return bills.map((b) => ({
    ref:      String(b.VOUCHERNUMBER ?? b.NAME ?? '').trim(),
    party:    String(b.BASICBUYERNAME ?? b.PARTYLEDGERNAME ?? b.PARTY ?? '').trim(),
    date:     tallyDate(String(b.DATE ?? '')),
    due_date: tallyDate(String(b.DUEDATE ?? '')),
    amount:   positiveAmount(b.AMOUNT ?? b.TOTAL ?? 0),
    pending:  positiveAmount(b.PENDINGAMOUNT ?? b.AMOUNT ?? 0),
  })).filter((r) => r.ref && r.pending > 0);
}

// ── Payables ──────────────────────────────────────────────────────────────────

async function getPayables() {
  log('Querying Bills Payable…');
  const parsed = await queryTally(tallyXml('Bills Payable'));
  const col    = getCollection(parsed);
  const bills  = toArray(col.BILL);

  return bills.map((b) => ({
    ref:      String(b.VOUCHERNUMBER ?? b.NAME ?? '').trim(),
    party:    String(b.BASICBUYERNAME ?? b.PARTYLEDGERNAME ?? b.PARTY ?? '').trim(),
    date:     tallyDate(String(b.DATE ?? '')),
    due_date: tallyDate(String(b.DUEDATE ?? '')),
    amount:   positiveAmount(b.AMOUNT ?? b.TOTAL ?? 0),
    pending:  positiveAmount(b.PENDINGAMOUNT ?? b.AMOUNT ?? 0),
  })).filter((p) => p.ref && p.pending > 0);
}

// ── Bank / Cash ledgers ───────────────────────────────────────────────────────

const BANK_GROUPS = new Set([
  'bank accounts', 'bank od account', 'bank od accounts',
  'cash-in-hand', 'cash in hand',
]);

async function getBankAccounts() {
  log('Querying List of Ledgers…');
  const parsed  = await queryTally(tallyXml('List of Ledgers'));
  const col     = getCollection(parsed);
  const ledgers = toArray(col.LEDGER);

  return ledgers
    .filter((l) => {
      const parent = String(l.PARENT ?? '').toLowerCase().trim();
      return BANK_GROUPS.has(parent);
    })
    .map((l) => ({
      name:    String(l.NAME ?? '').trim(),
      type:    String(l.PARENT ?? 'Bank Accounts').trim(),
      balance: positiveAmount(l.CLOSINGBALANCE ?? l.OPENINGBALANCE ?? 0),
    }))
    .filter((b) => b.name);
}

// ── P&L ───────────────────────────────────────────────────────────────────────

async function getProfitLoss() {
  log('Querying Profit and Loss…');
  try {
    const parsed = await queryTally(tallyXml('Profit and Loss'));
    const col    = getCollection(parsed);
    const groups = toArray(col.GROUP ?? col.LEDGER ?? []);

    let revenue = 0, expenses = 0;
    for (const g of groups) {
      const name = String(g.NAME ?? '').toLowerCase();
      const amt  = positiveAmount(g.CLOSINGBALANCE ?? g.AMOUNT ?? 0);
      if (name.includes('income') || name.includes('sales') || name.includes('revenue')) revenue += amt;
      if (name.includes('expense') || name.includes('purchase') || name.includes('cost')) expenses += amt;
    }
    return { revenue, expenses, net: revenue - expenses };
  } catch (e) {
    log('P&L query failed (non-fatal): ' + e.message);
    return null;
  }
}

// ── Company name ──────────────────────────────────────────────────────────────

async function getCompanyName() {
  try {
    const parsed = await queryTally(`<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>List of Companies</REPORTNAME>
    <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`);
    const col = getCollection(parsed);
    const co  = toArray(col.COMPANY ?? [])[0];
    return String(co?.NAME ?? co?.BASICCOMPANYNAME ?? '').trim() || null;
  } catch {
    return null;
  }
}

// ── Push to AiFinanceo ────────────────────────────────────────────────────────

async function pushToCloud(payload) {
  const body = JSON.stringify(payload);
  const url  = new URL(AIFINANCEO_URL);
  const isHttps = url.protocol === 'https:';
  const mod  = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = mod.request({
      host:   url.hostname,
      port:   url.port || (isHttps ? 443 : 80),
      path:   url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Bearer ${AGENT_TOKEN}`,
      },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) {
          reject(new Error(`Cloud returned ${res.statusCode}: ${text}`));
        } else {
          resolve(JSON.parse(text));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Cloud push timed out')); });
    req.write(body);
    req.end();
  });
}

// ── Main sync ─────────────────────────────────────────────────────────────────

async function sync() {
  log('─── Starting sync ───────────────────────────────');

  const [receivables, payables, bank, pl, company] = await Promise.allSettled([
    getReceivables(),
    getPayables(),
    getBankAccounts(),
    getProfitLoss(),
    getCompanyName(),
  ]);

  const payload = {
    company:     settled(company),
    receivables: settled(receivables) ?? [],
    payables:    settled(payables)    ?? [],
    bank:        settled(bank)        ?? [],
    pl:          settled(pl),
  };

  log(`Collected: ${payload.receivables.length} receivables, ${payload.payables.length} payables, ${payload.bank.length} bank accounts`);

  const result = await pushToCloud(payload);
  log(`Sync complete ✓ — invoices: ${result.invoices}, bills: ${result.bills}, banks: ${result.banks}`);
}

// ── Loop ──────────────────────────────────────────────────────────────────────

async function run() {
  log(`AiFinanceo Tally Agent started`);
  log(`  Tally:    http://${TALLY_HOST}:${TALLY_PORT}`);
  log(`  Interval: every ${SYNC_INTERVAL_MINUTES} minutes`);
  log(`  FY:       ${FINANCIAL_YEAR_START} → ${FINANCIAL_YEAR_END}`);

  // First sync immediately
  try {
    await sync();
  } catch (e) {
    logError('Sync failed: ' + e.message);
    logError('Is Tally open and the Gateway server running on port ' + TALLY_PORT + '?');
  }

  // Then on interval
  setInterval(async () => {
    try {
      await sync();
    } catch (e) {
      logError('Sync failed: ' + e.message);
    }
  }, SYNC_INTERVAL_MINUTES * 60 * 1000);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function toArray(v) {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function settled(result) {
  return result?.status === 'fulfilled' ? result.value : null;
}

function currentFYStart() {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}0401`;
}

function currentFYEnd() {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() + 1 : now.getFullYear();
  return `${year}0331`;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function logError(msg) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`);
}

// ── Start ─────────────────────────────────────────────────────────────────────

run().catch((e) => {
  logError('Fatal: ' + e.message);
  process.exit(1);
});
