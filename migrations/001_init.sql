-- ClipSeller standalone — schema mínimo (usuários + ativação).
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL,
  name            TEXT NOT NULL DEFAULT '',
  password_hash   TEXT,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  has_access      BOOLEAN NOT NULL DEFAULT FALSE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  activation_token        TEXT,
  activation_token_expires TIMESTAMPTZ,
  hotmart_subscriber_code TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS users_activation_token_idx
  ON users (activation_token)
  WHERE activation_token IS NOT NULL;

CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
