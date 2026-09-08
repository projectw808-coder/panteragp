-- Unified schema. CRM tables are central; trading tables hang off the client record.
-- Apply with: psql "$DATABASE_URL" -f db/schema.sql   (destructive; dev only)

DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

-- ---------------------------------------------------------------- staff & auth

CREATE TABLE staff (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,          -- stored lowercased by the app
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('sales','support','compliance','admin')),
  password_hash text NOT NULL,
  active        bool NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------- CRM core

CREATE TABLE pipeline_stages (
  id          smallint PRIMARY KEY,
  name        text UNIQUE NOT NULL,
  sort_order  smallint NOT NULL,
  is_terminal bool NOT NULL DEFAULT false
);
INSERT INTO pipeline_stages (id, name, sort_order, is_terminal) VALUES
  (1,'New',1,false), (2,'Contacted',2,false), (3,'KYC Pending',3,false),
  (4,'Onboarded',4,false), (5,'Active',5,false), (6,'Dormant',6,false),
  (7,'Churned',7,true);

-- The system of record for the relationship. Everything else references this.
CREATE TABLE clients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text UNIQUE NOT NULL,
  password_hash  text,                       -- null until onboarded: a lead has no login
  name           text NOT NULL,
  phone          text,
  country        text,                       -- ISO 3166-1 alpha-2
  tier           text NOT NULL DEFAULT 'standard',
  stage_id       smallint NOT NULL REFERENCES pipeline_stages(id) DEFAULT 1,
  owner_staff_id uuid REFERENCES staff(id),
  kyc_status     text NOT NULL DEFAULT 'none'
                 CHECK (kyc_status IN ('none','pending','approved','rejected','expired')),
  risk_profile   text CHECK (risk_profile IN ('low','medium','high')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON clients (owner_staff_id);
CREATE INDEX ON clients (stage_id);

CREATE TABLE tags (
  id   smallserial PRIMARY KEY,
  name text UNIQUE NOT NULL
);
CREATE TABLE client_tags (
  client_id uuid REFERENCES clients(id) ON DELETE CASCADE,
  tag_id    smallint REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (client_id, tag_id)
);

-- The one chronological feed: trades, deposits, logins, tickets, notes.
-- Append-only (see immutability trigger below).
CREATE TABLE activity_log (
  id        bigserial PRIMARY KEY,
  client_id uuid NOT NULL REFERENCES clients(id),
  at        timestamptz NOT NULL DEFAULT now(),
  kind      text NOT NULL,        -- order.placed | order.filled | deposit | withdrawal | login | note | ticket | kyc | stage
  actor     text,                 -- staff uuid, client uuid, or 'system'
  summary   text NOT NULL,
  ref_table text,                 -- source row, for drill-through
  ref_id    text,
  data      jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX ON activity_log (client_id, at DESC);
CREATE INDEX ON activity_log (kind, at DESC);

CREATE TABLE tasks (
  id           bigserial PRIMARY KEY,
  client_id    uuid NOT NULL REFERENCES clients(id),
  assigned_to  uuid NOT NULL REFERENCES staff(id),
  title        text NOT NULL,
  due_at       timestamptz,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  created_by   uuid REFERENCES staff(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON tasks (assigned_to, status, due_at);

-- --------------------------------------------------------- compliance & risk

CREATE TABLE kyc_documents (
  id           bigserial PRIMARY KEY,
  client_id    uuid NOT NULL REFERENCES clients(id),
  kind         text NOT NULL,      -- id_front | id_back | proof_of_address | selfie
  storage_key  text NOT NULL,      -- object-store key, never a public URL
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by  uuid REFERENCES staff(id),
  reviewed_at  timestamptz,
  note         text,
  uploaded_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE flags (
  id         bigserial PRIMARY KEY,
  client_id  uuid NOT NULL REFERENCES clients(id),
  rule       text NOT NULL,        -- volume_spike | large_withdrawal | ...
  severity   text NOT NULL CHECK (severity IN ('low','medium','high')),
  status     text NOT NULL DEFAULT 'open' CHECK (status IN ('open','cleared','escalated')),
  details    jsonb NOT NULL DEFAULT '{}',
  raised_at  timestamptz NOT NULL DEFAULT now(),
  closed_by  uuid REFERENCES staff(id),
  closed_at  timestamptz
);
CREATE INDEX ON flags (status, severity);

-- ------------------------------------------- trading (extends the client record)

CREATE TABLE trading_accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES clients(id),
  mode       text NOT NULL CHECK (mode IN ('demo','live')),
  currency   char(3) NOT NULL DEFAULT 'USD',
  balance    numeric(20,8) NOT NULL DEFAULT 0,
  leverage   smallint NOT NULL DEFAULT 1 CHECK (leverage BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, mode, currency)
);

CREATE TABLE instruments (
  symbol       text PRIMARY KEY,
  display_name text NOT NULL,
  tick_size    numeric(20,8) NOT NULL,
  lot_size     numeric(20,8) NOT NULL DEFAULT 1
);
INSERT INTO instruments (symbol, display_name, tick_size, lot_size) VALUES
  ('EURUSD','Euro / US Dollar',      0.00001, 100000),
  ('GBPUSD','Pound / US Dollar',     0.00001, 100000),
  ('USDJPY','US Dollar / Yen',       0.001,   100000),
  ('XAUUSD','Gold / US Dollar',      0.01,    100),
  ('BTCUSD','Bitcoin / US Dollar',   0.01,    1),
  ('ETHUSD','Ethereum / US Dollar',  0.01,    1);

CREATE TABLE orders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES trading_accounts(id),
  client_id     uuid NOT NULL REFERENCES clients(id),  -- denormalised: CRM reads a timeline without joining
  symbol        text NOT NULL REFERENCES instruments(symbol),
  side          text NOT NULL CHECK (side IN ('buy','sell')),
  type          text NOT NULL CHECK (type IN ('market','limit','stop','stop_limit','trailing_stop')),
  qty           numeric(20,8) NOT NULL CHECK (qty > 0),
  limit_price   numeric(20,8),
  stop_price    numeric(20,8),
  trail_amount  numeric(20,8),
  take_profit   numeric(20,8),
  stop_loss     numeric(20,8),
  status        text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new','working','filled','partial','cancelled','rejected')),
  -- Take-profit and stop-loss orders point at the entry that created them, so filling
  -- one cancels its sibling instead of re-opening the position the other way.
  parent_order_id uuid REFERENCES orders(id),
  placed_at     timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- price fields each order type requires
  CHECK (type <> 'limit'                   OR limit_price IS NOT NULL),
  CHECK (type NOT IN ('stop','stop_limit') OR stop_price IS NOT NULL),
  CHECK (type <> 'stop_limit'              OR limit_price IS NOT NULL),
  CHECK (type <> 'trailing_stop'           OR trail_amount IS NOT NULL)
);
CREATE INDEX ON orders (client_id, placed_at DESC);
CREATE INDEX ON orders (account_id, status);
CREATE INDEX ON orders (parent_order_id);

CREATE TABLE fills (
  id         bigserial PRIMARY KEY,
  order_id   uuid NOT NULL REFERENCES orders(id),
  qty        numeric(20,8) NOT NULL CHECK (qty > 0),
  price      numeric(20,8) NOT NULL,
  fee        numeric(20,8) NOT NULL DEFAULT 0,
  filled_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE positions (
  account_id uuid REFERENCES trading_accounts(id),
  symbol     text REFERENCES instruments(symbol),
  qty        numeric(20,8) NOT NULL,      -- signed: negative is short
  avg_price  numeric(20,8) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, symbol)
);

CREATE TABLE cash_transactions (
  id          bigserial PRIMARY KEY,
  account_id  uuid NOT NULL REFERENCES trading_accounts(id),
  client_id   uuid NOT NULL REFERENCES clients(id),
  kind        text NOT NULL CHECK (kind IN ('deposit','withdrawal','fee','adjustment')),
  amount      numeric(20,8) NOT NULL,     -- signed
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','approved','rejected','settled')),
  approved_by uuid REFERENCES staff(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON cash_transactions (client_id, created_at DESC);

-- ------------------------------------------------------------------ audit log

CREATE TABLE audit_log (
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL DEFAULT now(),
  actor  text NOT NULL,          -- from app.actor, set per transaction
  tbl    text NOT NULL,
  row_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('INSERT','UPDATE','DELETE')),
  before jsonb,
  after  jsonb
);
CREATE INDEX ON audit_log (tbl, row_id, at DESC);
CREATE INDEX ON audit_log (actor, at DESC);

CREATE FUNCTION audit() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE b jsonb; a jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN b := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN a := to_jsonb(NEW); END IF;
  -- No-op update: nothing to record. updated_at is excluded because the BEFORE touch
  -- trigger has already bumped it by the time this AFTER trigger sees the row.
  IF TG_OP = 'UPDATE' AND (b - 'updated_at') = (a - 'updated_at') THEN RETURN NEW; END IF;
  b := b - 'password_hash'; a := a - 'password_hash';       -- never copy secrets into the log
  INSERT INTO audit_log (actor, tbl, row_id, action, before, after)
  VALUES (coalesce(current_setting('app.actor', true), 'system'),
          TG_TABLE_NAME,
          coalesce(a ->> 'id', b ->> 'id', ''),
          TG_OP, b, a);
  RETURN coalesce(NEW, OLD);
END $fn$;

CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $fn$;

CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN NEW.updated_at := now(); RETURN NEW; END $fn$;

-- Attach: audit on every mutable table, immutability on the two logs, touch on updated_at.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['staff','clients','client_tags','tasks','kyc_documents','flags',
                           'trading_accounts','orders','fills','positions','cash_transactions'] LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION audit()', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit_log','activity_log'] LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION append_only()', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['staff','clients','tasks','orders'] LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION touch()', t, t);
  END LOOP;
END $do$;
