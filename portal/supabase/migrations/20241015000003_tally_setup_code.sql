-- Add setup code columns to tally_agent_tokens (used by the desktop agent on first run)
ALTER TABLE tally_agent_tokens
  ADD COLUMN IF NOT EXISTS setup_code             TEXT,
  ADD COLUMN IF NOT EXISTS setup_code_expires_at  TIMESTAMPTZ;
