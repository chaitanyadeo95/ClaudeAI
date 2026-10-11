-- AiFinanceo Client Dashboard Portal — QuickBooks Integration

-- ── QuickBooks OAuth tokens (one per client) ──────────────────────────────────
-- realm_id is QuickBooks' company identifier, returned during OAuth callback.
-- environment: 'production' or 'sandbox' (use sandbox while testing)
CREATE TABLE qb_tokens (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  realm_id       TEXT NOT NULL,
  access_token   TEXT NOT NULL,
  refresh_token  TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  environment    TEXT NOT NULL DEFAULT 'production',
  connected_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (client_id)
);

ALTER TABLE qb_tokens ENABLE ROW LEVEL SECURITY;

-- ── Add source column to data tables ─────────────────────────────────────────
-- Lets the same tables hold data from QuickBooks and Zoho Books side by side.
ALTER TABLE accounts          ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'quickbooks';
ALTER TABLE account_balances  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'quickbooks';
ALTER TABLE ar_invoices       ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'quickbooks';
ALTER TABLE ap_bills          ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'quickbooks';
ALTER TABLE bank_accounts     ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'quickbooks';
ALTER TABLE sync_logs         ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'quickbooks';

-- Update existing Zoho records so the column is meaningful
UPDATE accounts         SET source = 'zoho' WHERE source = 'quickbooks';
UPDATE account_balances SET source = 'zoho' WHERE source = 'quickbooks';
UPDATE ar_invoices      SET source = 'zoho' WHERE source = 'quickbooks';
UPDATE ap_bills         SET source = 'zoho' WHERE source = 'quickbooks';
UPDATE bank_accounts    SET source = 'zoho' WHERE source = 'quickbooks';
UPDATE sync_logs        SET source = 'zoho' WHERE source = 'quickbooks';
