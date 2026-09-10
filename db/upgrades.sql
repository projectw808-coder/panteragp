-- Changes to a schema that is already live.
--
-- db/schema.sql builds an empty database; it is never re-run against one that has data,
-- so anything added after go-live has to arrive here instead. Applied on every boot by
-- both scripts/db-init.mjs and src/devdb.ts, which means every statement in this file
-- must be safe to run again on a database that already has it.
--
-- ponytail: idempotent DDL, not a migration tool — no ordering, no down, no record of
-- what ran. Fine while changes are additive. The first one that has to rewrite existing
-- rows is the one that needs a real migration runner.

-- ---------------------------------------------------- staff notifications

-- Notifications used to be a thing only clients received. Staff get them too now — a flag
-- raised, a document to check, a client waiting on a reply — so the subject of a row is
-- either a client or a staff member, and exactly one of the two.
ALTER TABLE notifications ALTER COLUMN client_id DROP NOT NULL;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS staff_id uuid REFERENCES staff(id);

DO $$ BEGIN
  ALTER TABLE notifications ADD CONSTRAINT notifications_one_subject
    CHECK (num_nonnulls(client_id, staff_id) = 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS notifications_staff_recent ON notifications (staff_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_staff_unread ON notifications (staff_id) WHERE read_at IS NULL;

-- ------------------------------------------------- notification preferences

-- Which kinds of notification somebody wants. Absent means on: a kind added later reaches
-- everyone by default rather than silently going nowhere until each person opts in, and
-- the table stays small because it only records the exceptions.
--
-- subject_id is not a foreign key because it points at one of two tables depending on
-- subject_kind. The rows are preferences, not records — an orphan is noise, not a
-- correctness problem, and deleting a person is not something this system does anyway.
CREATE TABLE IF NOT EXISTS notification_prefs (
  subject_kind text NOT NULL CHECK (subject_kind IN ('client', 'staff')),
  subject_id   uuid NOT NULL,
  kind         text NOT NULL,
  enabled      boolean NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subject_kind, subject_id, kind)
);

-- ------------------------------------------------------- client personal details

-- The record a desk actually keeps on a person: enough to match them to their
-- identification, which is the point of holding it at all. Nullable throughout — a lead
-- who has given a name and an email is still a client record, and demanding a birth date
-- before anyone has asked for one is how you end up storing guesses.
--
-- These reach the audit log like every other client column. That is deliberate: a change
-- to someone's date of birth or address is exactly the change worth being able to see
-- afterwards. Only password_hash is stripped, by the audit trigger itself.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS date_of_birth date;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS address text;

-- ------------------------------------------------------------- task states

-- Tasks were open, done or cancelled — a checklist. A board needs the middle: what is
-- being worked on now, and what is stuck waiting on somebody else. Both existing values
-- keep their meaning, so nothing has to be rewritten; the check just admits two more.
DO $$ BEGIN
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
  ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
    CHECK (status IN ('open', 'in_progress', 'blocked', 'done', 'cancelled'));
END $$;

-- ------------------------------------------------- negotiated portfolio rates

-- The rate a pot earns came from its product type, the same for everybody holding that
-- product. A desk negotiates: this is the rate agreed with one client on one pot, and it
-- wins over the product's when it is set. Null means "whatever the product pays", which is
-- what every existing pot means today, so nothing has to be backfilled.
--
-- Bounded in the column rather than only in the handler. It is the multiplier on somebody
-- else's money: a typo of 35 for 3.5 is a hundredfold, and the place to stop that is the
-- one thing every path has to go through.
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS rate_override numeric(6,4);
DO $$ BEGIN
  ALTER TABLE portfolios ADD CONSTRAINT portfolios_rate_override_sane
    CHECK (rate_override IS NULL OR (rate_override >= 0 AND rate_override <= 1));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------- linked wallets

-- An address a client has proved they control, by signing a challenge with it.
--
-- Identification, not custody: the platform holds no keys and this table is never a
-- destination for anything. It exists so the desk can tell whose address is whose, which
-- is the prerequisite for ever paying one — an address nobody proved is an address that
-- could belong to anybody.
--
-- Unique globally, not per client: one address belonging to two accounts is either a
-- mistake or somebody borrowing a wallet, and both are worth refusing at the column.
CREATE TABLE IF NOT EXISTS linked_wallets (
  id         bigserial PRIMARY KEY,
  client_id  uuid NOT NULL REFERENCES clients(id),
  address    text NOT NULL UNIQUE,
  label      text,
  linked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS linked_wallets_by_client ON linked_wallets (client_id);

-- ------------------------------------------------------- per-client trading terms

-- What a client pays to trade: a commission on the notional of each fill, and a spread
-- markup that moves the executed price against them. Both in basis points, both null
-- meaning "the desk default", so nothing existing changes until somebody sets one.
--
-- Bounded in the column, not only in the handler. These multiply every trade the client
-- ever makes, and 500 typed for 5.00 is a hundredfold on money that is not the desk's.
--
-- Note what these deliberately cannot do. Commission is charged on the size of a trade,
-- not on its outcome, and spread always moves the fill against the client. Neither can
-- turn a losing trade into a winning one, or a winning one into a loss it was not — they
-- change the cost of trading, which is a term of the account, and they are shown to the
-- client on every fill and on their own profile.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS commission_bps numeric(6,2);
ALTER TABLE clients ADD COLUMN IF NOT EXISTS spread_bps numeric(6,2);
DO $$ BEGIN
  ALTER TABLE clients ADD CONSTRAINT clients_trading_terms_sane
    CHECK (
      (commission_bps IS NULL OR (commission_bps >= 0 AND commission_bps <= 500))
      AND (spread_bps IS NULL OR (spread_bps >= 0 AND spread_bps <= 500))
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ------------------------------------------------------------- crypto staking

-- Locking crypto for a term and earning a yield in the same asset. The shape follows
-- portfolios deliberately: a catalogue of products the desk offers, positions a client
-- opens against them, and a rate the desk can negotiate on one position without touching
-- the product everybody else holds.
--
-- What makes it not a portfolio: it is denominated in a crypto asset rather than a
-- currency, the money comes out of a wallet rather than a cash account, and it can be
-- locked until a date instead of being available on demand.
CREATE TABLE IF NOT EXISTS staking_products (
  code        text PRIMARY KEY,
  name        text NOT NULL,
  asset       text NOT NULL REFERENCES currencies(code),
  description text NOT NULL,
  -- A fraction, so 0.0450 is 4.5% a year. Bounded for the same reason every other rate in
  -- this schema is: it multiplies somebody else's money.
  apy         numeric(6,4) NOT NULL CHECK (apy >= 0 AND apy <= 1),
  -- 0 means flexible: unstake whenever, no lock and no penalty.
  lock_days   smallint NOT NULL DEFAULT 0 CHECK (lock_days >= 0 AND lock_days <= 3650),
  min_amount  numeric(38,18) NOT NULL DEFAULT 0 CHECK (min_amount >= 0),
  active      boolean NOT NULL DEFAULT true,
  sort_order  smallint NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stakes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id),
  product_code  text NOT NULL REFERENCES staking_products(code),
  asset         text NOT NULL REFERENCES currencies(code),
  -- Never negative: the asset only reaches a stake by leaving a wallet the client holds.
  amount        numeric(38,18) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  rewards       numeric(38,18) NOT NULL DEFAULT 0 CHECK (rewards >= 0),
  -- The rate agreed on this one stake. Null means the product's, which is what every
  -- stake means until the desk says otherwise.
  apy_override  numeric(6,4) CHECK (apy_override IS NULL OR (apy_override >= 0 AND apy_override <= 1)),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  staked_at     timestamptz NOT NULL DEFAULT now(),
  unlocks_at    timestamptz,      -- null on a flexible product
  closed_at     timestamptz,
  -- Rewards are posted per whole day elapsed since this date, which is what makes the
  -- accrual safe to run twice, to retry, or to catch up after an outage.
  last_accrued_on date NOT NULL DEFAULT current_date
);
CREATE INDEX IF NOT EXISTS stakes_by_client ON stakes (client_id, status);

INSERT INTO staking_products (code, name, asset, description, apy, lock_days, min_amount, sort_order) VALUES
  ('eth_flexible', 'Ethereum flexible', 'ETH', 'Earn on ETH with nothing locked — unstake whenever you like.', 0.0320, 0,  0.01, 1),
  ('eth_90',       'Ethereum 90-day',   'ETH', 'Locked for 90 days for a higher rate.',                          0.0575, 90, 0.10, 2),
  ('btc_flexible', 'Bitcoin flexible',  'BTC', 'Earn on BTC with nothing locked.',                               0.0210, 0,  0.001, 3),
  ('btc_180',      'Bitcoin 180-day',   'BTC', 'Locked for 180 days, the highest BTC rate on the desk.',         0.0450, 180, 0.01, 4),
  ('sol_60',       'Solana 60-day',     'SOL', 'Locked for 60 days.',                                            0.0680, 60, 1,    5),
  ('usdc_flexible','USDC flexible',     'USDC','A stable balance that earns, with nothing locked.',              0.0505, 0,  10,   6)
ON CONFLICT (code) DO UPDATE SET
  name = excluded.name, asset = excluded.asset, description = excluded.description,
  apy = excluded.apy, lock_days = excluded.lock_days, min_amount = excluded.min_amount,
  sort_order = excluded.sort_order;

-- --------------------------------------------- staking catalogue, second pass

-- Three assets, and the same ladder of terms on each so they can be compared: flexible,
-- then 30, 60 and 180 days. The longer the money is locked the more it pays, which is the
-- only reason a client would accept a lock.
--
-- The first catalogue is retired rather than deleted: stakes point at these rows, and a
-- product that vanishes takes the meaning of every stake on it with it. Retired products
-- stop being offered and keep paying what is already staked.
UPDATE staking_products SET active = false
 WHERE code IN ('eth_flexible', 'eth_90', 'btc_flexible', 'btc_180', 'sol_60', 'usdc_flexible');

INSERT INTO staking_products (code, name, asset, description, apy, lock_days, min_amount, sort_order) VALUES
  ('btc_flex',  'Bitcoin flexible',  'BTC',  'Earn on BTC with nothing locked — unstake whenever you like.', 0.0180, 0,   0.001, 10),
  ('btc_30',    'Bitcoin 30-day',    'BTC',  'Locked for 30 days.',                                           0.0260, 30,  0.005, 11),
  ('btc_60',    'Bitcoin 60-day',    'BTC',  'Locked for 60 days.',                                           0.0340, 60,  0.005, 12),
  ('btc_180',   'Bitcoin 180-day',   'BTC',  'Locked for 180 days, the highest BTC rate on the desk.',        0.0480, 180, 0.010, 13),
  ('usdt_flex', 'Tether flexible',   'USDT', 'A stable balance that earns, with nothing locked.',             0.0420, 0,   50,    20),
  ('usdt_30',   'Tether 30-day',     'USDT', 'Locked for 30 days.',                                           0.0560, 30,  100,   21),
  ('usdt_60',   'Tether 60-day',     'USDT', 'Locked for 60 days.',                                           0.0680, 60,  100,   22),
  ('usdt_180',  'Tether 180-day',    'USDT', 'Locked for 180 days, the highest USDT rate on the desk.',       0.0850, 180, 250,   23),
  ('usdc_flex', 'USD Coin flexible', 'USDC', 'A stable balance that earns, with nothing locked.',             0.0410, 0,   50,    30),
  ('usdc_30',   'USD Coin 30-day',   'USDC', 'Locked for 30 days.',                                           0.0550, 30,  100,   31),
  ('usdc_60',   'USD Coin 60-day',   'USDC', 'Locked for 60 days.',                                           0.0670, 60,  100,   32),
  ('usdc_180',  'USD Coin 180-day',  'USDC', 'Locked for 180 days, the highest USDC rate on the desk.',       0.0840, 180, 250,   33)
ON CONFLICT (code) DO UPDATE SET
  name = excluded.name, asset = excluded.asset, description = excluded.description,
  apy = excluded.apy, lock_days = excluded.lock_days, min_amount = excluded.min_amount,
  sort_order = excluded.sort_order, active = true;

-- ------------------------------------------------- portfolio withdrawal requests

-- Taking money out of a pot is asked for, not done. The client raises a request and the
-- desk decides; nothing moves until it is approved, and the row records who decided and
-- when either way.
CREATE TABLE IF NOT EXISTS portfolio_requests (
  id           bigserial PRIMARY KEY,
  portfolio_id uuid NOT NULL REFERENCES portfolios(id),
  client_id    uuid NOT NULL REFERENCES clients(id),
  amount       numeric(38,18) NOT NULL CHECK (amount > 0),
  note         text,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by   uuid REFERENCES staff(id),
  decided_at   timestamptz,
  decision_note text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portfolio_requests_pending ON portfolio_requests (status, created_at);
CREATE INDEX IF NOT EXISTS portfolio_requests_by_client ON portfolio_requests (client_id, created_at DESC);

-- Which pot the client wants on the balance strip. At most one, enforced rather than
-- trusted: two "featured" pots would leave the strip picking one arbitrarily.
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS featured boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS portfolios_one_featured
  ON portfolios (client_id) WHERE featured;

-- Whether the client has the auto trader switched on.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS auto_trader boolean NOT NULL DEFAULT false;
