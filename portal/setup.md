# AiFinanceo Portal — Phase 1 Setup Guide

## What was built

Three Supabase Edge Functions:

| Function | URL path | Purpose |
|---|---|---|
| `zoho-oauth-init` | `/functions/v1/zoho-oauth-init` | Starts OAuth — redirects client to Zoho login |
| `zoho-oauth-callback` | `/functions/v1/zoho-oauth-callback` | Receives Zoho's redirect, stores tokens |
| `zoho-sync` | `/functions/v1/zoho-sync` | Pulls all financial data (run daily) |

---

## Step 1 — Create a free Supabase project

1. Go to [supabase.com](https://supabase.com) → **Start your project** (free)
2. Create a new organisation called `aifinanceo`
3. Create a project called `portal`
4. Choose region: **South Asia (Mumbai)**
5. Note your **Project URL** and **anon/service_role keys** from Settings → API

---

## Step 2 — Run the database migration

1. In Supabase dashboard → **SQL Editor**
2. Paste the entire contents of `supabase/migrations/20241011000001_initial_schema.sql`
3. Click **Run**

---

## Step 3 — Register a Zoho API application

1. Go to [api-console.zoho.in](https://api-console.zoho.in)  
   _(Use `.in` console because your Zoho Books is on the India data centre)_
2. Click **Get Started** → **Server-based Applications**
3. Fill in:
   - **Client Name**: AiFinanceo Portal
   - **Homepage URL**: `https://aifinanceo.com`
   - **Authorized Redirect URIs**: `https://<your-project-ref>.supabase.co/functions/v1/zoho-oauth-callback`
4. Copy the **Client ID** and **Client Secret**

---

## Step 4 — Install Supabase CLI and deploy functions

```bash
# Install Supabase CLI (macOS)
brew install supabase/tap/supabase

# Or via npm
npm install -g supabase

# Login
supabase login

# Link to your project
supabase link --project-ref <your-project-ref>

# Set secrets (do this before deploying)
supabase secrets set ZOHO_CLIENT_ID="1000.XXX"
supabase secrets set ZOHO_CLIENT_SECRET="XXX"
supabase secrets set ZOHO_REDIRECT_URI="https://<your-project-ref>.supabase.co/functions/v1/zoho-oauth-callback"

# Deploy all three functions
supabase functions deploy zoho-oauth-init    --no-verify-jwt
supabase functions deploy zoho-oauth-callback --no-verify-jwt
supabase functions deploy zoho-sync
```

> `--no-verify-jwt` on the OAuth functions is needed because Zoho's redirect
> doesn't carry a Supabase JWT. The sync function is called internally so it
> keeps JWT verification on.

---

## Step 5 — Add your first client and test the OAuth flow

1. In Supabase SQL Editor, insert a test client:
   ```sql
   INSERT INTO clients (name, email) VALUES ('Test Client Ltd', 'test@example.com');
   SELECT id FROM clients WHERE email = 'test@example.com';
   -- copy the UUID
   ```

2. Open this URL in your browser (replace values):
   ```
   https://<your-project-ref>.supabase.co/functions/v1/zoho-oauth-init?dc=in&client_id=<uuid>
   ```

3. Log in with your Zoho Books credentials and grant access.

4. You should be redirected back and see **"Zoho Books Connected successfully"**.

5. Verify in SQL Editor:
   ```sql
   SELECT client_id, data_centre, zoho_org_id, expires_at FROM zoho_tokens;
   ```

---

## Step 6 — Run the first sync manually

```bash
curl -X POST \
  "https://<your-project-ref>.supabase.co/functions/v1/zoho-sync" \
  -H "Authorization: Bearer <service-role-key>" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected response:
```json
{ "synced": 1, "results": [{ "clientId": "...", "status": "success", "accounts": 42, "invoices": 5, ... }] }
```

Check logs:
```sql
SELECT * FROM sync_logs ORDER BY started_at DESC LIMIT 5;
SELECT * FROM api_call_logs ORDER BY called_at DESC LIMIT 20;
```

---

## Step 7 — Enable the daily schedule

1. In Supabase dashboard → **Database → Extensions**, enable **pg_cron**
2. In SQL Editor, run the cron job (uncomment the block at the bottom of the migration SQL):
   ```sql
   SELECT cron.schedule('zoho-daily-sync', '0 21 * * *', $$
     SELECT net.http_post(
       url := 'https://<your-project-ref>.supabase.co/functions/v1/zoho-sync',
       headers := '{"Authorization": "Bearer <service-role-key>", "Content-Type": "application/json"}'::jsonb,
       body := '{}'::jsonb
     );
   $$);
   ```
   This runs at **02:30 IST** every day (21:00 UTC).

---

## Data pulled each sync

| Table | Contents |
|---|---|
| `accounts` | Full chart of accounts |
| `account_balances` | Monthly debit / credit / closing balance for 12 rolling months |
| `ar_invoices` | All unpaid + partially paid invoices |
| `ap_bills` | All unpaid + partially paid bills |
| `bank_accounts` | All bank and cash accounts with current balance |
| `sync_logs` | One row per sync run with status and counts |
| `api_call_logs` | One row per API call with endpoint, status code, response time |
