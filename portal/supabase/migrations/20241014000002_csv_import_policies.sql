-- ── Allow authenticated users to insert / delete their own CSV-imported data ──
-- Required for the browser-side CSV import feature in the portal.
-- Run once in Supabase SQL Editor.

-- AR Invoices
CREATE POLICY "Users insert own ar_invoices"
  ON public.ar_invoices FOR INSERT
  WITH CHECK (client_id = auth.uid());

CREATE POLICY "Users delete own ar_invoices"
  ON public.ar_invoices FOR DELETE
  USING (client_id = auth.uid());

-- AP Bills
CREATE POLICY "Users insert own ap_bills"
  ON public.ap_bills FOR INSERT
  WITH CHECK (client_id = auth.uid());

CREATE POLICY "Users delete own ap_bills"
  ON public.ap_bills FOR DELETE
  USING (client_id = auth.uid());

-- Bank Accounts
CREATE POLICY "Users insert own bank_accounts"
  ON public.bank_accounts FOR INSERT
  WITH CHECK (client_id = auth.uid());

CREATE POLICY "Users delete own bank_accounts"
  ON public.bank_accounts FOR DELETE
  USING (client_id = auth.uid());
