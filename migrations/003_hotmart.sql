-- Hotmart standalone: idempotência de eventos do produto ClipSeller.
CREATE TABLE IF NOT EXISTS hotmart_webhook_events (
  idempotency_key TEXT PRIMARY KEY,
  event           TEXT,
  product_id      TEXT,
  buyer_email     TEXT,
  payload         JSONB,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hotmart_webhook_events_buyer_idx
  ON hotmart_webhook_events (buyer_email, processed_at DESC);
