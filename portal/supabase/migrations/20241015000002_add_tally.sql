-- AiFinanceo — Tally Desktop Agent Integration

-- Agent auth tokens: one UUID per client, used by the desktop agent to authenticate
CREATE TABLE tally_agent_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id   UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  company     TEXT,        -- Tally company name, filled on first sync
  tally_port  INTEGER NOT NULL DEFAULT 9000,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  last_sync   TIMESTAMPTZ,
  UNIQUE (client_id)
);

ALTER TABLE tally_agent_tokens ENABLE ROW LEVEL SECURITY;
-- Service-role Edge Functions bypass RLS; no client-facing SELECT needed
