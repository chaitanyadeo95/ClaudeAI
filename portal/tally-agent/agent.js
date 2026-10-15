/**
 * AiFinanceo — Tally Sync Agent
 * Single-file, zero-dependency Windows desktop agent.
 *
 * First run: asks for a 6-char setup code from the AiFinanceo dashboard.
 * Subsequent runs: reads saved config and syncs automatically.
 */

'use strict';

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const os       = require('os');
const readline = require('readline');

// ── Constants (hardcoded public URL) ─────────────────────────────────────────
const SUPABASE_URL = 'https://keiladscsohyzfgbzidn.supabase.co';
const APP_DIR      = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'AiFinanceo');
const CONFIG_PATH  = path.join(APP_DIR, 'tally-config.json');

// ── Config ────────────────────────────────────────────────────────────────────
let cfg = {};

function loadConfig() {
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    return true;
  } catch {
    return false;
  }
}

function saveConfig(data) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const u    = new URL(url);
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req  = https.request({
      hostname: u.hostname,
      port:     443,
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
      timeout:  20000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${text}`));
        try { resolve(JSON.parse(text)); } catch { resolve(text); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(data);
    req.end();
  });
}

function httpPost(host, port, xmlBody) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.from(xmlBody, 'utf-8');
    const req = http.request({
      host, port, path: '/', method: 'POST',
      headers: { 'Content-Type': 'text/xml;charset=UTF-8', 'Content-Length': buf.length },
      timeout: 30000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Tally did not respond (is it open?)')); });
    req.write(xmlBody);
    req.end();
  });
}

// ── Setup: redeem 6-char code ─────────────────────────────────────────────────
async function redeemCode(code) {
  const result = await httpsPost(`${SUPABASE_URL}/functions/v1/tally-redeem`, { code: code.trim().toUpperCase() });
  if (!result.agent_token) throw new Error(result.error || 'Invalid code');
  return result;
}

async function firstTimeSetup() {
  console.log('');
  console.log('  ╔═════════════════════════════════════════╗');
  console.log('  ║      AiFinanceo — Tally Sync Agent      ║');
  console.log('  ║         First Time Setup                ║');
  console.log('  ╚═════════════════════════════════════════╝');
  console.log('');
  console.log('  1. Open your AiFinanceo dashboard');
  console.log('  2. Go to Dashboard → Connect Tally');
  console.log('  3. Copy the 6-character setup code shown there');
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise((resolve) => {
    rl.question('  Enter setup code: ', (ans) => { rl.close(); resolve(ans); });
  });

  if (!code || code.trim().length < 6) {
    console.log('\n  Invalid code. Please try again.\n');
    process.exit(1);
  }

  console.log('\n  Connecting to AiFinanceo…');
  const result = await redeemCode(code);

  saveConfig({
    agent_token:           result.agent_token,
    sync_url:              result.sync_url,
    tally_host:            result.tally_host || 'localhost',
    tally_port:            result.tally_port || 9000,
    sync_interval_minutes: result.sync_interval_minutes || 30,
    financial_year_start:  result.financial_year_start || currentFYStart(),
    financial_year_end:    result.financial_year_end   || currentFYEnd(),
  });

  console.log('\n  ✓ Connected! Starting sync…\n');
}

// ── XML helpers (no dependencies) ─────────────────────────────────────────────
function xmlTags(xml, tag) {
  const items = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi');
  let m;
  while ((m = re.exec(xml)) !== null) items.push(m[0]);
  return items;
}

function xmlVal(fragment, tag) {
  const m = fragment.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function toNum(v) {
  return Math.abs(parseFloat(String(v).replace(/,/g, '')) || 0);
}

function tallyDate(s) {
  if (!s || s.length !== 8) return null;
  return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;
}

// ── Tally XML requests ─────────────────────────────────────────────────────────
function tallyRequest(reportName) {
  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><EXPORTDATA><REQUESTDESC>
    <REPORTNAME>${reportName}</REPORTNAME>
    <STATICVARIABLES>
      <SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>
      <SVFROMDATE>${cfg.financial_year_start}</SVFROMDATE>
      <SVTODATE>${cfg.financial_year_end}</SVTODATE>
    </STATICVARIABLES>
  </REQUESTDESC></EXPORTDATA></BODY>
</ENVELOPE>`;
}

async function tallyQuery(reportName) {
  return httpPost(cfg.tally_host || 'localhost', cfg.tally_port || 9000, tallyRequest(reportName));
}

async function getReceivables() {
  const xml   = await tallyQuery('Bills Receivable');
  return xmlTags(xml, 'BILL').map(b => ({
    ref:      xmlVal(b, 'VOUCHERNUMBER') || xmlVal(b, 'NAME'),
    party:    xmlVal(b, 'BASICBUYERNAME') || xmlVal(b, 'PARTYLEDGERNAME'),
    date:     tallyDate(xmlVal(b, 'DATE')),
    due_date: tallyDate(xmlVal(b, 'DUEDATE')),
    amount:   toNum(xmlVal(b, 'AMOUNT') || xmlVal(b, 'TOTAL')),
    pending:  toNum(xmlVal(b, 'PENDINGAMOUNT') || xmlVal(b, 'AMOUNT')),
  })).filter(r => r.ref && r.pending > 0);
}

async function getPayables() {
  const xml = await tallyQuery('Bills Payable');
  return xmlTags(xml, 'BILL').map(b => ({
    ref:      xmlVal(b, 'VOUCHERNUMBER') || xmlVal(b, 'NAME'),
    party:    xmlVal(b, 'BASICBUYERNAME') || xmlVal(b, 'PARTYLEDGERNAME'),
    date:     tallyDate(xmlVal(b, 'DATE')),
    due_date: tallyDate(xmlVal(b, 'DUEDATE')),
    amount:   toNum(xmlVal(b, 'AMOUNT') || xmlVal(b, 'TOTAL')),
    pending:  toNum(xmlVal(b, 'PENDINGAMOUNT') || xmlVal(b, 'AMOUNT')),
  })).filter(p => p.ref && p.pending > 0);
}

const BANK_GROUPS = ['bank accounts', 'bank od account', 'cash-in-hand', 'cash in hand'];

async function getBankAccounts() {
  const xml     = await tallyQuery('List of Ledgers');
  return xmlTags(xml, 'LEDGER')
    .filter(l => BANK_GROUPS.includes((xmlVal(l, 'PARENT') || '').toLowerCase()))
    .map(l => ({
      name:    xmlVal(l, 'NAME'),
      type:    xmlVal(l, 'PARENT') || 'Bank Accounts',
      balance: toNum(xmlVal(l, 'CLOSINGBALANCE') || xmlVal(l, 'OPENINGBALANCE')),
    })).filter(b => b.name);
}

async function getCompanyName() {
  try {
    const xml = await httpPost(
      cfg.tally_host || 'localhost',
      cfg.tally_port || 9000,
      `<ENVELOPE><HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
      <BODY><EXPORTDATA><REQUESTDESC><REPORTNAME>List of Companies</REPORTNAME>
      <STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES>
      </REQUESTDESC></EXPORTDATA></BODY></ENVELOPE>`
    );
    return xmlVal(xmlTags(xml, 'COMPANY')[0] || '', 'NAME') || null;
  } catch { return null; }
}

// ── Push to cloud ─────────────────────────────────────────────────────────────
async function pushToCloud(payload) {
  return httpsPost(cfg.sync_url || `${SUPABASE_URL}/functions/v1/tally-sync`, payload, {
    Authorization: `Bearer ${cfg.agent_token}`,
  });
}

// ── Main sync ─────────────────────────────────────────────────────────────────
async function sync() {
  log('Syncing…');
  const [rec, pay, bank, company] = await Promise.allSettled([
    getReceivables(), getPayables(), getBankAccounts(), getCompanyName(),
  ]);
  const payload = {
    company:     company.status === 'fulfilled' ? company.value : null,
    receivables: rec.status  === 'fulfilled' ? rec.value  : [],
    payables:    pay.status  === 'fulfilled' ? pay.value  : [],
    bank:        bank.status === 'fulfilled' ? bank.value : [],
  };
  const result = await pushToCloud(payload);
  log(`✓ Done — ${result.invoices} receivables · ${result.bills} payables · ${result.banks} bank accounts`);
}

// ── Loop ──────────────────────────────────────────────────────────────────────
async function run() {
  const hasConfig = loadConfig();

  if (!hasConfig) {
    await firstTimeSetup();
    loadConfig();
  } else {
    console.log('\n  AiFinanceo Tally Agent  |  press Ctrl+C to stop\n');
  }

  try { await sync(); } catch (e) {
    logError(e.message);
    logError('Make sure Tally is open on port ' + (cfg.tally_port || 9000));
  }

  const interval = (cfg.sync_interval_minutes || 30) * 60 * 1000;
  setInterval(async () => {
    try { await sync(); } catch (e) { logError(e.message); }
  }, interval);

  log('Next sync in ' + (cfg.sync_interval_minutes || 30) + ' minutes');
}

function currentFYStart() {
  const y = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1;
  return `${y}0401`;
}
function currentFYEnd() {
  const y = new Date().getMonth() >= 3 ? new Date().getFullYear() + 1 : new Date().getFullYear();
  return `${y}0331`;
}
function log(msg) { console.log(`  [${new Date().toLocaleTimeString()}] ${msg}`); }
function logError(msg) { console.error(`  [${new Date().toLocaleTimeString()}] ERROR: ${msg}`); }

run().catch(e => { console.error('\n  Fatal:', e.message); process.exit(1); });
