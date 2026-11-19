-- Game Deals D1 schema
CREATE TABLE IF NOT EXISTS deals (
  deal_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  store_id TEXT NOT NULL,
  store_name TEXT NOT NULL,
  sale_price REAL NOT NULL,
  normal_price REAL NOT NULL,
  savings REAL NOT NULL,
  is_free INTEGER NOT NULL DEFAULT 0,
  platform TEXT,
  thumb TEXT,
  deal_url TEXT,
  deal_rating REAL DEFAULT 0,
  metacritic_score INTEGER DEFAULT 0,
  steam_rating_percent INTEGER DEFAULT 0,
  steam_rating_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_deals_store ON deals(store_id);
CREATE INDEX IF NOT EXISTS idx_deals_savings ON deals(savings DESC);

CREATE TABLE IF NOT EXISTS epic_free (
  epic_key TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  image_url TEXT,
  store_url TEXT,
  original_price REAL DEFAULT 0,
  status TEXT NOT NULL,
  starts_at TEXT,
  ends_at TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS watchlist (
  device_id TEXT NOT NULL,
  deal_key TEXT NOT NULL,
  saved_at TEXT NOT NULL,
  PRIMARY KEY (device_id, deal_key)
);
