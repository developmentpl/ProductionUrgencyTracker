-- production-urgency-tracker schema
-- Use IF NOT EXISTS so init-db.js stays idempotent.

CREATE TABLE IF NOT EXISTS urgent_orders (
  id           SERIAL PRIMARY KEY,
  wo_number    VARCHAR(20) NOT NULL,
  material     TEXT NOT NULL DEFAULT '',
  customer     TEXT NOT NULL,
  priority     VARCHAR(20) NOT NULL DEFAULT 'High',
  deadline     TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  remarks      TEXT NOT NULL DEFAULT '',
  is_done      BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_urgent_orders_deadline    ON urgent_orders (deadline);
CREATE INDEX IF NOT EXISTS idx_urgent_orders_is_done     ON urgent_orders (is_done);
CREATE INDEX IF NOT EXISTS idx_urgent_orders_priority    ON urgent_orders (priority);

-- Auto-update updated_at on every row change
CREATE OR REPLACE FUNCTION urgent_orders_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_urgent_orders_updated_at ON urgent_orders;
CREATE TRIGGER trg_urgent_orders_updated_at
  BEFORE UPDATE ON urgent_orders
  FOR EACH ROW EXECUTE FUNCTION urgent_orders_set_updated_at();
