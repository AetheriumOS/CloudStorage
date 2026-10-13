-- Cloudflare D1 schema for pay-as-you-go pre-paid storage
-- Users table
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL UNIQUE,
  balance REAL NOT NULL DEFAULT 0.0,                -- Pre-paid credit in USD (minimum top-up $5.00)
  current_storage_bytes BIGINT NOT NULL DEFAULT 0,  -- Current total storage in bytes
  last_updated_timestamp INTEGER NOT NULL DEFAULT 0, -- Unix timestamp in seconds (UTC)
  is_frozen INTEGER NOT NULL DEFAULT 0,             -- 0 = active, 1 = frozen (balance <= 0 or insufficient)
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

-- Billing audit events (optional but recommended)
CREATE TABLE IF NOT EXISTS storage_billing_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  action_type TEXT NOT NULL CHECK(action_type IN ('upload','delete','set','init')),
  delta_bytes BIGINT NOT NULL,
  storage_bytes_before BIGINT NOT NULL,
  storage_bytes_after BIGINT NOT NULL,
  hours_passed REAL NOT NULL,
  cost_usd REAL NOT NULL,
  rate_usd_per_gb_monthly REAL NOT NULL,
  occurred_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);
