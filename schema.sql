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

-- ── Multi-user auth ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,           -- scrypt "salt:hash"
  role          VARCHAR(10) NOT NULL DEFAULT 'user',  -- 'admin' | 'user'
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- ── Activity log: who did what, when ─────────────────────────────

CREATE TABLE IF NOT EXISTS activity_log (
  id         SERIAL PRIMARY KEY,
  username   TEXT NOT NULL,
  action     VARCHAR(30) NOT NULL,       -- 'add' | 'edit' | 'delete' | 'login' | 'add-user' | ...
  order_id   INTEGER,
  wo_number  TEXT,
  details    TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_created ON activity_log (created_at DESC);

-- Track who created / last edited each order
ALTER TABLE urgent_orders ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT '';
ALTER TABLE urgent_orders ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT '';
