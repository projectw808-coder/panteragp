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
