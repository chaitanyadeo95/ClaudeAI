-- AiFinanceo Client Dashboard Portal — Phase 1 Schema

-- ── Clients (tenants) ─────────────────────────────────────────────────────────
CREATE TABLE clients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  email       TEXT UNIQUE NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── Zoho Books OAuth tokens (one per client) ──────────────────────────────────
-- data_centre: in | com | eu | au | jp | ca
CREATE TABLE zoho_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  data_centre   TEXT NOT NULL DEFAULT 'in',
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  zoho_org_id   TEXT,
  connected_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id)
);

-- ── Chart of accounts ─────────────────────────────────────────────────────────
CREATE TABLE accounts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id           UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  zoho_account_id     TEXT NOT NULL,
  account_name        TEXT NOT NULL,
  account_type        TEXT,
  account_type_formatted TEXT,
  parent_account_id   TEXT,
  currency_code       TEXT DEFAULT 'INR',
  is_active           BOOLEAN DEFAULT TRUE,
  synced_at           TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, zoho_account_id)
);

-- ── Monthly account balances (rolling 12 months) ──────────────────────────────
CREATE TABLE account_balances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  zoho_account_id TEXT NOT NULL,
  period_year     INT NOT NULL,
  period_month    INT NOT NULL CHECK (period_month BETWEEN 1 AND 12),
  debit_amount    NUMERIC(18,2) DEFAULT 0,
  credit_amount   NUMERIC(18,2) DEFAULT 0,
  closing_balance NUMERIC(18,2) DEFAULT 0,
  currency_code   TEXT DEFAULT 'INR',
  synced_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, zoho_account_id, period_year, period_month)
);

-- ── Open AR invoices ──────────────────────────────────────────────────────────
CREATE TABLE ar_invoices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  zoho_invoice_id TEXT NOT NULL,
  invoice_number  TEXT,
  customer_name   TEXT,
  invoice_date    DATE,
  due_date        DATE,
  total           NUMERIC(18,2),
  balance         NUMERIC(18,2),
  status          TEXT,
  currency_code   TEXT DEFAULT 'INR',
  synced_at       TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, zoho_invoice_id)
);

-- ── Open AP bills ─────────────────────────────────────────────────────────────
CREATE TABLE ap_bills (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  zoho_bill_id  TEXT NOT NULL,
  bill_number   TEXT,
  vendor_name   TEXT,
  bill_date     DATE,
  due_date      DATE,
  total         NUMERIC(18,2),
  balance       NUMERIC(18,2),
  status        TEXT,
  currency_code TEXT DEFAULT 'INR',
  synced_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, zoho_bill_id)
);

-- ── Bank / cash accounts ──────────────────────────────────────────────────────
CREATE TABLE bank_accounts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id         UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  zoho_account_id   TEXT NOT NULL,
  account_name      TEXT,
  account_type      TEXT,
  bank_name         TEXT,
  account_number    TEXT,
  balance           NUMERIC(18,2),
  currency_code     TEXT DEFAULT 'INR',
  synced_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id, zoho_account_id)
);

-- ── Sync job runs ─────────────────────────────────────────────────────────────
CREATE TABLE sync_logs (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id            UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  started_at           TIMESTAMPTZ DEFAULT NOW(),
  finished_at          TIMESTAMPTZ,
  status               TEXT DEFAULT 'running', -- running | success | partial | failed
  error_message        TEXT,
  accounts_pulled      INT DEFAULT 0,
  invoices_pulled      INT DEFAULT 0,
  bills_pulled         INT DEFAULT 0,
  bank_accounts_pulled INT DEFAULT 0
);

-- ── Per-API-call log ──────────────────────────────────────────────────────────
CREATE TABLE api_call_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_log_id      UUID REFERENCES sync_logs(id) ON DELETE CASCADE,
  client_id        UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  endpoint         TEXT NOT NULL,
  http_method      TEXT DEFAULT 'GET',
  status_code      INT,
  response_time_ms INT,
  error_message    TEXT,
  called_at        TIMESTAMPTZ DEFAULT NOW()
);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Edge Functions run as service role (bypasses RLS).
-- Per-client RLS will be wired in Phase 3 when user auth is added.
ALTER TABLE clients       ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoho_tokens   ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts      ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE ar_invoices   ENABLE ROW LEVEL SECURITY;
ALTER TABLE ap_bills      ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_logs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_call_logs ENABLE ROW LEVEL SECURITY;

-- ── Daily sync schedule (pg_cron) ─────────────────────────────────────────────
-- Runs at 02:30 IST (21:00 UTC) every day.
-- Enable the pg_cron extension in Supabase dashboard first (Database → Extensions).
-- SELECT cron.schedule('zoho-daily-sync', '0 21 * * *', $$
--   SELECT net.http_post(
--     url := current_setting('app.supabase_url') || '/functions/v1/zoho-sync',
--     headers := jsonb_build_object(
--       'Authorization', 'Bearer ' || current_setting('app.service_role_key'),
--       'Content-Type', 'application/json'
--     ),
--     body := '{}'::jsonb
--   );
-- $$);
-- (Uncomment and run in SQL Editor after deploying functions.)
