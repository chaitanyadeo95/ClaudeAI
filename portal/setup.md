# AiFinanceo Portal — Setup Guide

## Architecture

```
Supabase (database + auth + edge functions)
    │
    ├── qb-oauth-init     → starts QuickBooks login
    ├── qb-oauth-callback → stores QB tokens
    └── qb-sync           → daily data pull (pg_cron)
```

---

## Step 1 — Create a free Supabase project

1. Go to [supabase.com](https://supabase.com) → **Start your project**
2. Create organisation: `aifinanceo`, project: `portal`
3. Region: choose closest to your clients (US East for global; Mumbai for India-only)
4. Note your **Project URL** and **service_role key** from Settings → API

---

## Step 2 — Run both database migrations

In Supabase dashboard → **SQL Editor**, run these in order:

1. Paste contents of `supabase/migrations/20241011000001_initial_schema.sql` → Run
2. Paste contents of `supabase/migrations/20241011000002_add_quickbooks.sql` → Run

---

## Step 3 — Register a QuickBooks app on Intuit Developer

1. Go to [developer.intuit.com](https://developer.intuit.com) → Sign in → **Dashboard**
2. Click **Create an app** → select **QuickBooks Online and Payments**
3. Fill in:
   - **App Name**: AiFinanceo Portal
   - **Scopes**: tick **Accounting**
4. Go to **Keys & OAuth** → copy **Client ID** and **Client Secret**
5. Under **Redirect URIs**, add:
   ```
   https://<your-project-ref>.supabase.co/functions/v1/qb-oauth-callback
   ```
6. Save

> **Sandbox vs Production**: Intuit gives you a free sandbox with test company data.
> Use `environment=sandbox` in the OAuth init URL while testing. Switch to
> `environment=production` when onboarding real clients.

---

## Step 4 — Install Supabase CLI and deploy functions

```bash
# Install Supabase CLI
npm install -g supabase

# Login and link project
supabase login
supabase link --project-ref <your-project-ref>

# Set secrets
supabase secrets set QB_CLIENT_ID="<your-intuit-client-id>"
supabase secrets set QB_CLIENT_SECRET="<your-intuit-client-secret>"
supabase secrets set QB_REDIRECT_URI="https://<your-project-ref>.supabase.co/functions/v1/qb-oauth-callback"

# Deploy QuickBooks functions
supabase functions deploy qb-oauth-init     --no-verify-jwt
supabase functions deploy qb-oauth-callback --no-verify-jwt
supabase functions deploy qb-sync
```

---

## Step 5 — Add your first client and connect QuickBooks

**1. Insert a client row:**
```sql
INSERT INTO clients (name, email) VALUES ('Acme Ltd', 'accounts@acme.com');
SELECT id FROM clients WHERE email = 'accounts@acme.com';
-- copy the UUID
```

**2. Start the OAuth flow** (open in browser):
```
https://<project-ref>.supabase.co/functions/v1/qb-oauth-init?client_id=<uuid>

# For sandbox testing:
https://<project-ref>.supabase.co/functions/v1/qb-oauth-init?client_id=<uuid>&environment=sandbox
```

**3. Log in with QuickBooks** and authorise access.

**4. You should see:** "QuickBooks Connected. Company ID (RealmID): 123456789"

**5. Verify in SQL Editor:**
```sql
SELECT client_id, realm_id, environment, expires_at FROM qb_tokens;
```

---

## Step 6 — Run first sync manually

```bash
curl -X POST \
  "https://<project-ref>.supabase.co/functions/v1/qb-sync" \
  -H "Authorization: Bearer <service-role-key>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected response:
```json
{
  "synced": 1,
  "results": [{
    "clientId": "...",
    "status": "success",
    "accounts": 45,
    "invoices": 12,
    "bills": 8,
    "banks": 3
  }]
}
```

Check logs:
```sql
SELECT * FROM sync_logs  ORDER BY started_at   DESC LIMIT 5;
SELECT * FROM api_call_logs ORDER BY called_at DESC LIMIT 20;
```

---

## Step 7 — Enable daily schedule

1. Supabase dashboard → **Database → Extensions** → enable **pg_cron** and **pg_net**
2. SQL Editor:
```sql
SELECT cron.schedule('qb-daily-sync', '0 2 * * *', $$
  SELECT net.http_post(
    url    := 'https://<project-ref>.supabase.co/functions/v1/qb-sync',
    headers := '{"Authorization":"Bearer <service-role-key>","Content-Type":"application/json"}'::jsonb,
    body   := '{}'::jsonb
  );
$$);
```
This runs at **2:00 AM UTC** every day.

---

## What gets pulled each sync

| Table | Contents |
|---|---|
| `accounts` | Full QuickBooks chart of accounts |
| `account_balances` | Debit / credit / net per account for 12 rolling months (Trial Balance) |
| `ar_invoices` | All open invoices (Balance > 0) with pagination |
| `ap_bills` | All open bills (Balance > 0) with pagination |
| `bank_accounts` | All Bank + Other Current Asset accounts with balances |
| `sync_logs` | One row per run — status, counts, errors |
| `api_call_logs` | One row per QB API call — endpoint, HTTP status, response time |

---

## Secrets reference

| Secret | Where to find it |
|---|---|
| `QB_CLIENT_ID` | Intuit Developer → Keys & OAuth |
| `QB_CLIENT_SECRET` | Intuit Developer → Keys & OAuth |
| `QB_REDIRECT_URI` | Your Supabase function URL (set by you) |
| `SUPABASE_URL` | Supabase → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API |
