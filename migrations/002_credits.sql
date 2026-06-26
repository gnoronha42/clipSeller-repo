-- ClipSeller standalone — schema de créditos + Mercado Pago.

-- Saldo do usuário (cache; verdade são as transactions)
ALTER TABLE users ADD COLUMN IF NOT EXISTS credits INTEGER NOT NULL DEFAULT 0;

-- Pacotes vendidos no checkout MP
CREATE TABLE IF NOT EXISTS credit_packages (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         TEXT UNIQUE NOT NULL,
  name         TEXT NOT NULL,
  credits      INTEGER NOT NULL CHECK (credits >= 0),
  price_cents  INTEGER NOT NULL CHECK (price_cents > 0),
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS credit_packages_set_updated_at ON credit_packages;
CREATE TRIGGER credit_packages_set_updated_at
BEFORE UPDATE ON credit_packages
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Tabela de custos por feature (consumo)
CREATE TABLE IF NOT EXISTS feature_costs (
  feature_key  TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  cost_credits INTEGER NOT NULL CHECK (cost_credits >= 0),
  category     TEXT NOT NULL DEFAULT 'clipseller',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS feature_costs_set_updated_at ON feature_costs;
CREATE TRIGGER feature_costs_set_updated_at
BEFORE UPDATE ON feature_costs
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Histórico de transações (compras, débitos por uso e reembolsos)
CREATE TABLE IF NOT EXISTS credit_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('purchase','debit','refund','adjust','bonus')),
  credits         INTEGER NOT NULL,
  balance_after   INTEGER NOT NULL,
  feature_key     TEXT,
  description     TEXT,
  payment_provider TEXT,
  payment_id      TEXT,
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_transactions_user_idx ON credit_transactions (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_payment_uidx
  ON credit_transactions (payment_provider, payment_id)
  WHERE payment_provider IS NOT NULL AND payment_id IS NOT NULL;

-- Seed pacotes default (idempotente via slug)
INSERT INTO credit_packages (slug, name, credits, price_cents, sort_order, active)
VALUES
  ('pack_1k',  '1.000 créditos',  1000,  9999, 1, true),
  ('pack_5k',  '5.000 créditos',  5000, 45700, 2, true),
  ('pack_10k', '10.000 créditos',10000, 69700, 3, true)
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name,
    credits = EXCLUDED.credits,
    price_cents = EXCLUDED.price_cents,
    sort_order = EXCLUDED.sort_order;

-- Seed feature_costs ClipSeller novo (v31)
INSERT INTO feature_costs (feature_key, label, cost_credits, category) VALUES
  ('clipseller.novo.img-premium',  'Foto (premium)',           12, 'imagem'),
  ('clipseller.novo.img-basico',   'Foto (básico)',             8, 'imagem'),
  ('clipseller.novo.inspirada',    'Foto Inspirada',           15, 'imagem'),
  ('clipseller.novo.titulo',       'Título & SEO',             10, 'texto'),
  ('clipseller.novo.moda-look',    'Look de Moda (por look)',  14, 'moda'),
  ('clipseller.novo.provador',     'Moda — Provador',          20, 'moda'),
  ('clipseller.novo.vid-prod-5s',  'Vídeo Produto 5s',         60, 'video'),
  ('clipseller.novo.vid-prod-10s', 'Vídeo Produto 10s',       100, 'video'),
  ('clipseller.novo.ugc-5s',       'Vídeo UGC 5s',             70, 'video'),
  ('clipseller.novo.ugc-10s',      'Vídeo UGC 10s',           130, 'video'),
  ('clipseller.novo.montagem',     'Montagem do Comercial',    30, 'video'),
  ('clipseller.novo.regen',        'Regenerar Foto',            5, 'imagem'),
  ('clipseller.novo.edicao-livre', 'Edição Livre',              5, 'imagem')
ON CONFLICT (feature_key) DO UPDATE
SET label = EXCLUDED.label,
    cost_credits = EXCLUDED.cost_credits,
    category = EXCLUDED.category;
