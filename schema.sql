CREATE TABLE IF NOT EXISTS migration_wallets (
  address TEXT PRIMARY KEY,
  first_tx TEXT NOT NULL,
  first_at TEXT NOT NULL,
  second_tx TEXT,
  second_at TEXT,
  event_count INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  last_tx TEXT
);

CREATE INDEX IF NOT EXISTS idx_wallets_second_at
ON migration_wallets(second_at);

CREATE TABLE IF NOT EXISTS recent_migrations (
  address TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  amount_pi REAL NOT NULL DEFAULT 0,
  balance_count INTEGER NOT NULL DEFAULT 1,
  migration_number INTEGER,
  PRIMARY KEY(address, transaction_hash)
);

CREATE INDEX IF NOT EXISTS idx_recent_created_at
ON recent_migrations(created_at);

CREATE TABLE IF NOT EXISTS sync_state (
  name TEXT PRIMARY KEY,
  cursor TEXT,
  updated_at TEXT
);
