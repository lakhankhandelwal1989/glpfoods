-- ────────────────────────────────────────────
-- GLP — Database Schema (PostgreSQL)
-- ────────────────────────────────────────────
-- The server creates these tables idempotently on boot.
-- This file is provided for reference and manual migrations.

CREATE TABLE IF NOT EXISTS customers (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,
  phone       VARCHAR(20)  NOT NULL,
  location    VARCHAR(200),
  language    VARCHAR(10)  DEFAULT 'en',
  source      VARCHAR(50)  DEFAULT 'chatbot',
  created_at  TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customers_created_at ON customers(created_at DESC);

CREATE TABLE IF NOT EXISTS admins (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(100) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Default admin is seeded by the application on first boot:
--   username: Lakhan
--   password: Lakhan
-- This default is overwritten the moment you change credentials in /admin.
