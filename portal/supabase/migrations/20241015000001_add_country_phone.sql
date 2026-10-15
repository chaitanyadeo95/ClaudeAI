-- Add country and phone to client profiles
-- country: ISO 2-letter code ('IN', 'US', 'AE') — NULL means onboarding not yet completed
-- phone: E.164 or local format, optional

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS country TEXT,
  ADD COLUMN IF NOT EXISTS phone   TEXT;
