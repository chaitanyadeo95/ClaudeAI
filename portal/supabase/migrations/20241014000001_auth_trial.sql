-- ── Add trial & subscription fields to clients ───────────────────────────────
ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS trial_started_at  TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS trial_ends_at     TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '14 days'),
  ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'trial';  -- trial | active | expired

-- ── Auto-create client record when a user signs up ────────────────────────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.clients (id, email, name, trial_started_at, trial_ends_at, subscription_status)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'name', split_part(NEW.email, '@', 1)),
    NOW(),
    NOW() + INTERVAL '14 days',
    'trial'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- ── RLS: each user sees only their own client record ─────────────────────────
DROP POLICY IF EXISTS "Users read own client" ON public.clients;
CREATE POLICY "Users read own client"
  ON public.clients FOR SELECT
  USING (id = auth.uid());

-- ── RLS: each user sees only their own financial data ────────────────────────
DROP POLICY IF EXISTS "Users see own ar_invoices"    ON public.ar_invoices;
DROP POLICY IF EXISTS "Users see own ap_bills"       ON public.ap_bills;
DROP POLICY IF EXISTS "Users see own bank_accounts"  ON public.bank_accounts;
DROP POLICY IF EXISTS "Users see own accounts"       ON public.accounts;
DROP POLICY IF EXISTS "Users see own account_balances" ON public.account_balances;
DROP POLICY IF EXISTS "Users see own sync_logs"      ON public.sync_logs;

CREATE POLICY "Users see own ar_invoices"      ON public.ar_invoices      FOR SELECT USING (client_id = auth.uid());
CREATE POLICY "Users see own ap_bills"         ON public.ap_bills         FOR SELECT USING (client_id = auth.uid());
CREATE POLICY "Users see own bank_accounts"    ON public.bank_accounts    FOR SELECT USING (client_id = auth.uid());
CREATE POLICY "Users see own accounts"         ON public.accounts         FOR SELECT USING (client_id = auth.uid());
CREATE POLICY "Users see own account_balances" ON public.account_balances FOR SELECT USING (client_id = auth.uid());
CREATE POLICY "Users see own sync_logs"        ON public.sync_logs        FOR SELECT USING (client_id = auth.uid());
