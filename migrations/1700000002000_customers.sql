-- Up Migration

CREATE TABLE customers (
  customer_id     TEXT PRIMARY KEY,
  customer_name   TEXT NOT NULL,
  customer_code   TEXT UNIQUE,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      TEXT NOT NULL REFERENCES users(user_id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX customers_name_idx ON customers (customer_name);

-- Down Migration

DROP TABLE IF EXISTS customers;
