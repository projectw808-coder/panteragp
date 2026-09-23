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

-- A photo of the account holder. The stored name is generated, and the file is served from
-- behind auth rather than a guessable path — it is a picture of a person, not an asset.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS avatar_key text;

-- The photo itself, in the database rather than on a disk.
--
-- It was a file under UPLOAD_DIR, which is only as permanent as whatever is mounted there
-- — and a client whose photo vanished had no way to tell that from never having uploaded
-- one. A photo is capped at 2 MB and there is at most one per client, so it is small
-- enough to live with the record it belongs to and be exactly as permanent as the account.
-- avatar_key stays: it is the cache-busting token the client keys its fetch on, and for
-- rows written before this it is still the name of a file on disk (see the read path).
ALTER TABLE clients ADD COLUMN IF NOT EXISTS avatar_image bytea;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS avatar_type  text;

-- ------------------------------------------------------------- IPO offerings

-- Tokenised IPO offerings: the desk publishes a deal, clients subscribe with money they
-- already hold, and the subscription pays a fixed ROI accrued daily until it matures.
--
-- The shape follows portfolios and staking on purpose — a catalogue the desk offers,
-- positions clients open against it, and a rate the desk can negotiate on one position
-- without touching the product everybody else holds. What makes it not a staking product:
-- it has a window that opens and closes, a cap that the whole book shares, and a maturity
-- date after which nothing accrues however late settlement happens.
--
-- The return is the ROI, not the share price. A subscription is not equity and confers no
-- interest in the company named: see the README section for why that line matters.
CREATE TABLE IF NOT EXISTS ipos (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text UNIQUE NOT NULL,
  name             text NOT NULL,
  summary          text NOT NULL,
  description      text,
  -- What is being issued, as a label. Deliberately not a currencies FK: an offering can be
  -- announced before any instrument exists to reference.
  asset            text NOT NULL,
  -- What subscriptions are paid in, which is a real currency and must exist.
  currency         text NOT NULL REFERENCES currencies(code),
  target_amount    numeric(38,18) NOT NULL CHECK (target_amount > 0),
  min_subscription numeric(38,18) NOT NULL DEFAULT 0 CHECK (min_subscription >= 0),
  max_subscription numeric(38,18)
                   CHECK (max_subscription IS NULL OR max_subscription >= min_subscription),
  -- A fraction, so 0.0725 is 7.25% a year — the same convention as portfolios and staking.
  -- Bounded for the same reason every other rate here is: it multiplies somebody's money.
  roi_rate         numeric(6,4) NOT NULL CHECK (roi_rate >= 0 AND roi_rate <= 1),
  term_days        smallint NOT NULL CHECK (term_days > 0 AND term_days <= 3650),
  opens_at         timestamptz,
  closes_at        timestamptz,
  matures_at       timestamptz,
  -- Stored status carries only what cannot be computed: the desk's explicit decisions.
  -- Everything else is derived from the timestamps on read — see effectiveStatus in
  -- src/server.ts. A status that changes only when a human clicks is wrong every weekend.
  status           text NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','upcoming','open','closed','active','completed','cancelled')),
  image_key        text,
  sort_order       smallint NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  -- Time has to run forwards. A window that closes before it opens, or matures before it
  -- closes, is not a deal anybody can price, and the database is the right place to say so.
  CONSTRAINT ipos_window   CHECK (opens_at IS NULL OR closes_at IS NULL OR closes_at > opens_at),
  CONSTRAINT ipos_maturity CHECK (closes_at IS NULL OR matures_at IS NULL OR matures_at > closes_at)
);

-- Lets a subscription reference the offering AND its currency as one foreign key, so the
-- two can never disagree. A CHECK cannot see another table; this can.
DO $do$ BEGIN
  ALTER TABLE ipos ADD CONSTRAINT ipos_id_currency UNIQUE (id, currency);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $do$;

CREATE TABLE IF NOT EXISTS ipo_subscriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ipo_id          uuid NOT NULL REFERENCES ipos(id),
  client_id       uuid NOT NULL REFERENCES clients(id),
  amount          numeric(38,18) NOT NULL CHECK (amount > 0),
  currency        text NOT NULL REFERENCES currencies(code),
  -- The rate agreed on this one subscription. Null means the offering's, which is what
  -- every subscription means until the desk says otherwise.
  roi_override    numeric(6,4) CHECK (roi_override IS NULL OR (roi_override >= 0 AND roi_override <= 1)),
  -- Never negative: ROI is credited, never clawed back.
  accrued         numeric(38,18) NOT NULL DEFAULT 0 CHECK (accrued >= 0),
  -- ROI is posted per whole day elapsed since this date, which is what makes the accrual
  -- safe to run twice, to retry, or to catch up after an outage.
  last_accrued_on date NOT NULL DEFAULT current_date,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','refunded','settled')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- Paid in the offering's own currency, enforced rather than trusted.
  CONSTRAINT ipo_subscriptions_currency_matches
    FOREIGN KEY (ipo_id, currency) REFERENCES ipos (id, currency)
);
-- The client's page and the desk's book are the two reads that matter.
CREATE INDEX IF NOT EXISTS ipo_subscriptions_by_client ON ipo_subscriptions (client_id);
CREATE INDEX IF NOT EXISTS ipo_subscriptions_by_ipo    ON ipo_subscriptions (ipo_id);

-- Covered by the audit trigger like every other mutable table, and ipos takes touch() so
-- updated_at means something. Guarded on pg_trigger because this file runs every start.
-- ponytail: staking_products, stakes and portfolio_requests were added in this file
-- without their audit triggers and are still uncovered. Same three lines would fix it.
DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ipos','ipo_subscriptions'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_audit') THEN
      EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                      FOR EACH ROW EXECUTE FUNCTION audit()', t, t);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'ipos_touch') THEN
    EXECUTE 'CREATE TRIGGER ipos_touch BEFORE UPDATE ON ipos
             FOR EACH ROW EXECUTE FUNCTION touch()';
  END IF;
END $do$;

-- The valuation the deal is being talked about at — "$2tn", "$165-175bn". Text rather than a
-- number because that is how it is reported and how the desk wants to print it: a range, an
-- "above", an "up to". Nothing computes with it, so nothing needs it parsed.
ALTER TABLE ipos ADD COLUMN IF NOT EXISTS valuation text;

-- The offering's picture, in the row rather than on the filesystem, for the reason the
-- avatar moved there: this deploys to a container whose disk is replaced on every release,
-- so a file written at upload is gone by the next one. A picture that vanishes when the desk
-- ships is worse than no picture, because nobody finds out until a client is looking at it.
-- Capped at 5 MB and one per offering, so it is small enough to live with the record.
-- image_key stays as the cache-busting token the page keys its fetch on, and to find the
-- handful of pictures uploaded to disk before this.
ALTER TABLE ipos ADD COLUMN IF NOT EXISTS image_data bytea;
ALTER TABLE ipos ADD COLUMN IF NOT EXISTS image_type text;

-- The 2026 calendar, seeded the way instruments are: reference data that has to reach
-- deployments which already exist, so it runs every start and does nothing the second time.
-- ON CONFLICT DO NOTHING rather than DO UPDATE on purpose — once the desk has edited an
-- offering, a deploy must not quietly put its own numbers back.
--
-- Dates are absolute and the lifecycle is computed from them, so these move through the
-- groups on their own: what is incoming today is running in a month and finished after that,
-- with no deploy and nobody clicking. Company facts and valuations are from public reporting
-- on the 2026 calendar; the ROI, term, minimum and allocation are the desk's own terms.
INSERT INTO ipos (slug, name, asset, currency, summary, description, valuation,
                  target_amount, min_subscription, roi_rate, term_days,
                  opens_at, closes_at, matures_at, status, sort_order)
VALUES
  ('anthropic-2026', 'Anthropic', 'ANTH', 'USD',
   'Filed confidentially on 1 June 2026; listing has shifted to mid-October on Nasdaq. Bankers are floating up to $2tn, which would top SpaceX.',
   'Revenue run-rate has grown from roughly $9bn at the end of 2025 to about $47-65bn by mid-2026. Lead underwriters are reported as Morgan Stanley, Goldman Sachs and JPMorgan.',
   '$2tn', 10000000, 500, 0.0725, 180,
   '2026-09-11T09:00:00Z', '2026-10-09T16:00:00Z', '2027-04-07T16:00:00Z', 'upcoming', 1),

  ('nscale-2026', 'Nscale', 'NSCL', 'USD',
   'London-founded GPU data-centre operator leasing compute on multi-year contracts, flagship campus in Narvik. The most imminent of the group.',
   'A March 2026 Series C valued it at $14.6bn; a later convertible round carried a $30bn conversion cap. Contracted backlog has swelled to $103bn.',
   '$30bn', 3000000, 250, 0.0910, 90,
   '2026-09-15T09:00:00Z', '2026-09-26T16:00:00Z', '2026-12-25T16:00:00Z', 'upcoming', 2),

  ('openai-2026', 'OpenAI', 'OAI', 'USD',
   'S-1 submitted confidentially around 22 May 2026 and confirmed publicly on 8 June, seeking above $1tn. A September window was targeted.',
   'Reports point to a possible slip into 2027. Goldman Sachs, Morgan Stanley and JPMorgan are lead underwriters.',
   '$1tn+', 25000000, 1000, 0.0640, 365,
   '2026-09-29T09:00:00Z', '2026-10-27T16:00:00Z', '2027-10-27T16:00:00Z', 'upcoming', 3),

  ('databricks-2026', 'Databricks', 'DBX', 'USD',
   'Lakehouse data platform with newer AI products in Lakebase and Genie. Valued $134bn in February 2026, with fresh talks at $165-175bn.',
   'No S-1 has been filed. The CEO has called 2026 a terrible year to go public, pointing instead at 2027.',
   '$175bn', 12000000, 1000, 0.0580, 365,
   '2026-11-02T09:00:00Z', '2026-12-02T16:00:00Z', '2027-12-02T16:00:00Z', 'upcoming', 4),

  ('spacex-2026', 'SpaceX', 'SPCX', 'USD',
   'The largest IPO in history: priced at $135 on 11 June 2026 and listed on Nasdaq the next day, raising $86bn with the greenshoe at a $1.77tn valuation.',
   'The listing values Starlink and Starship together. The raise topped Saudi Aramco''s 2019 record.',
   '$1.77tn', 20000000, 500, 0.0725, 180,
   '2026-06-01T09:00:00Z', '2026-06-12T16:00:00Z', '2026-12-09T16:00:00Z', 'upcoming', 5),

  ('crne-2026', 'China Resources New Energy', 'CRNE', 'USD',
   'Asia''s biggest IPO of 2026 and the largest ever on Shenzhen: a wind and solar developer spun out of China Resources Power, raising 24.5bn yuan.',
   'Listed on the Shenzhen exchange on 3 July 2026 after a book covered many times over.',
   'CNY 24.5bn raise', 8000000, 500, 0.0610, 90,
   '2026-06-22T09:00:00Z', '2026-07-03T16:00:00Z', '2026-10-01T16:00:00Z', 'upcoming', 6),

  ('sk-hynix-2026', 'SK hynix', 'SKHY', 'USD',
   'The largest US listing ever by a non-American company, topping Alibaba''s 2014 raise. 177.9m ADSs at $149 on 10 July 2026, raising $26.5bn.',
   'The book was reported seven times oversubscribed, driven by HBM memory demand.',
   '$26.5bn raise', 6000000, 500, 0.0540, 60,
   '2026-07-01T09:00:00Z', '2026-07-10T16:00:00Z', '2026-09-08T16:00:00Z', 'completed', 7),

  ('cerebras-2026', 'Cerebras Systems', 'CBRS', 'USD',
   'The year''s first blockbuster tech listing: wafer-scale AI inference chips, 2025 revenue $510m and a swing to profit. Priced at $185 on 14 May 2026.',
   'The range was raised twice before pricing. The stock opened at $385 against the $185 offer.',
   '$8.1bn', 4000000, 500, 0.0840, 90,
   '2026-05-05T09:00:00Z', '2026-05-14T16:00:00Z', '2026-08-12T16:00:00Z', 'completed', 8)
ON CONFLICT (slug) DO NOTHING;

-- KYC documents in the row, for the same reason the offering picture and the profile photo
-- are: this deploys to a container whose disk is replaced on every release, so a file
-- written at upload does not survive it. /health has been reporting "fresh" rather than
-- "persisted" on consecutive deploys, which is that marker saying so out loud.
--
-- These are passports and proofs of address, so losing them is worse than losing a picture:
-- the client is asked to send identification a second time, and the record of what was
-- actually reviewed is gone. Capped by the upload route at 10 MB.
--
-- storage_key stays. It is what the review screens key on, and it is how the documents
-- written to disk before this are still found.
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS file_data bytea;
ALTER TABLE kyc_documents ADD COLUMN IF NOT EXISTS file_type text;

-- The ROI ceiling comes off. It was one year's rate capped at 100%, which is a reasonable
-- bound for a bond and a wrong one for this desk: short-dated offerings are quoted at rates
-- that read absurd annualised — a 30-day deal at 15% over the term is about 440% a year —
-- and the cap made those unenterable. What is left is the part that is not a matter of
-- taste: the rate must not be negative, because the accrual takes the 365th root of
-- (1 + rate) and a rate below -1 has no real root, and it must fit the column.
--
-- The column widens with it. numeric(6,4) tops out at 99.9999 as a fraction, so without
-- this a rate the validation now allows would fail as a numeric overflow from the driver
-- rather than as a refusal anybody can read.
ALTER TABLE ipos             ALTER COLUMN roi_rate     TYPE numeric(12,4);
ALTER TABLE ipo_subscriptions ALTER COLUMN roi_override TYPE numeric(12,4);

DO $do$ BEGIN
  ALTER TABLE ipos DROP CONSTRAINT IF EXISTS ipos_roi_rate_check;
  ALTER TABLE ipo_subscriptions DROP CONSTRAINT IF EXISTS ipo_subscriptions_roi_override_check;
END $do$;

DO $do$ BEGIN
  ALTER TABLE ipos ADD CONSTRAINT ipos_roi_rate_check CHECK (roi_rate >= 0);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $do$;

DO $do$ BEGIN
  ALTER TABLE ipo_subscriptions ADD CONSTRAINT ipo_subscriptions_roi_override_check
    CHECK (roi_override IS NULL OR roi_override >= 0);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $do$;

-- When an offering's shipped cover art was installed, if it ever was.
--
-- The covers under assets/ipo-covers are applied by db-init on deploy, the way instruments
-- and the offerings themselves are. This column is what stops that being a nuisance: without
-- it the rule would have to be "fill any offering that has no picture", and the next deploy
-- would put back a cover the desk had deliberately removed. Stamped once, checked forever,
-- so the seed happens exactly one time per offering and every later decision is the desk's.
ALTER TABLE ipos ADD COLUMN IF NOT EXISTS cover_seeded_at timestamptz;

-- Allocation the desk placed outside this platform, before the book opened here.
--
-- The raise shown on an offering was purely the sum of subscriptions taken through this
-- system, which reads as zero on a deal that is genuinely most of the way covered — the desk
-- needs to say "6.1m of this 10m is already placed" without inventing subscription rows
-- against real client accounts to do it.
--
-- It is added to the real subscriptions wherever the raise is shown AND wherever the cap is
-- enforced. That second half is the part that matters: a baseline that moved the progress bar
-- but not the allocation would show a book 61% full while still letting clients take the
-- whole target, which is a bar that lies. Money placed here genuinely reduces what is left.
--
-- It is not client money and never becomes any: nothing settles it, nothing refunds it, and
-- it appears in no client's position. A cancellation refunds the subscriptions and leaves
-- this untouched, because there is nothing of ours to give back.
ALTER TABLE ipos ADD COLUMN IF NOT EXISTS raised_baseline numeric(38,18) NOT NULL DEFAULT 0;

DO $do$ BEGIN
  ALTER TABLE ipos ADD CONSTRAINT ipos_raised_baseline_check
    CHECK (raised_baseline >= 0 AND raised_baseline <= target_amount);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $do$;

-- ---------------------------------------------------------------- email to clients
--
-- Sending to a client list is not the same as writing a notification into the app. A
-- notification is read by somebody who chose to open the product; an email arrives whether
-- they wanted it or not, at an address that belongs to them, and there is no unsending it.
-- The three tables below exist for the three things that follow from that: consent, a record
-- of what was actually sent, and an identity for the send so that clicking twice does not
-- deliver twice.

-- Consent. Kept per client because it is the client's decision, not a setting on the send.
-- A weekly update is marketing however useful it is, so it goes only to people who have not
-- said no, and every one of them can say no from the message itself without signing in —
-- which is what the token is for. It is not the client's id: an id in a public link is an
-- invitation to enumerate the client list.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_opt_out    boolean NOT NULL DEFAULT false;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS email_opt_out_at timestamptz;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS unsubscribe_token text;
-- A DEFAULT, not just a backfill. Backfilling alone gave every client created afterwards a
-- null token, so their unsubscribe link read ?token=null — the same dead link for all of
-- them, and the one part of a marketing email that is not optional. It failed silently,
-- because a dead link looks exactly like a live one until somebody clicks it.
ALTER TABLE clients ALTER COLUMN unsubscribe_token
  SET DEFAULT replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
-- gen_random_uuid() is built in; gen_random_bytes() is pgcrypto, which is not installed
-- here and must not become a deploy-time dependency for one column. Two uuids stripped of
-- their dashes is 64 hex characters of the same randomness.
UPDATE clients
   SET unsubscribe_token = replace(gen_random_uuid()::text, '-', '')
                        || replace(gen_random_uuid()::text, '-', '')
 WHERE unsubscribe_token IS NULL;
DO $do$ BEGIN
  ALTER TABLE clients ADD CONSTRAINT clients_unsubscribe_token_key UNIQUE (unsubscribe_token);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL;
END $do$;

-- One article, written and reviewed before it goes anywhere. Drafting and sending are
-- deliberately two steps: an admin writes or generates a draft, looks at it, sends a test to
-- themselves, and only then releases it. A single endpoint that composed and delivered in one
-- call would make "oops" unrecoverable for a thousand people at once.
CREATE TABLE IF NOT EXISTS email_campaigns (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL DEFAULT 'weekly_update',
  subject     text NOT NULL,
  body        text NOT NULL,              -- the article, as plain text with blank-line paragraphs
  status      text NOT NULL DEFAULT 'draft'
              CHECK (status IN ('draft','sending','sent','failed')),
  created_by  uuid REFERENCES staff(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz,
  recipients  integer NOT NULL DEFAULT 0, -- how many it went to, once it has gone
  failures    integer NOT NULL DEFAULT 0
);

-- One row per client per campaign, written before the message is handed to the server.
--
-- The UNIQUE is the idempotency: a second send skips anybody already recorded, so a
-- double-click, a retry after a crash, or two admins pressing at once cannot deliver twice.
-- It is also the answer to "did they get it?", which support will ask.
CREATE TABLE IF NOT EXISTS email_deliveries (
  id          bigserial PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  client_id   uuid NOT NULL REFERENCES clients(id),
  email       text NOT NULL,              -- as addressed, so a later change to the client is visible
  status      text NOT NULL CHECK (status IN ('sent','failed')),
  error       text,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, client_id)
);
CREATE INDEX IF NOT EXISTS email_deliveries_by_client ON email_deliveries (client_id, sent_at DESC);

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_campaigns'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_audit') THEN
      EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                      FOR EACH ROW EXECUTE FUNCTION audit()', t, t);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'email_campaigns_touch') THEN
    EXECUTE 'CREATE TRIGGER email_campaigns_touch BEFORE UPDATE ON email_campaigns
             FOR EACH ROW EXECUTE FUNCTION touch()';
  END IF;
END $do$;

-- ---------------------------------------------- writing to one client, from their record
--
-- A weekly update goes to a list; this is one person, from the member of staff who looks
-- after them, composed on their record where the context is. Different enough from a
-- campaign to be its own thing: no consent list, no recipient count to confirm, and no
-- unsubscribe link, because a reply to an account manager is not a mailing list somebody
-- joined. The marketing opt-out does not silence it for the same reason — the client who
-- asked not to receive updates still needs to hear that their document expired.

CREATE TABLE IF NOT EXISTS email_templates (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE,
  subject    text NOT NULL,
  body       text NOT NULL,
  created_by uuid REFERENCES staff(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every message to a client, kept whether it left or not. Support will be asked "did you
-- email them?" and the honest answer needs the text that was sent, not the template it came
-- from — a template edited next month must not silently rewrite what was said last month.
CREATE TABLE IF NOT EXISTS client_emails (
  id          bigserial PRIMARY KEY,
  client_id   uuid NOT NULL REFERENCES clients(id),
  email       text NOT NULL,
  subject     text NOT NULL,
  body        text NOT NULL,
  template_id uuid REFERENCES email_templates(id) ON DELETE SET NULL,
  sent_by     uuid REFERENCES staff(id),
  status      text NOT NULL CHECK (status IN ('sent','failed')),
  error       text,
  sent_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS client_emails_by_client ON client_emails (client_id, sent_at DESC);

-- Starter templates. Reference data like instruments, so they reach deployments that already
-- exist; ON CONFLICT DO NOTHING so an edited one is never overwritten by a deploy.
-- {{name}} and {{email}} are filled per recipient.
INSERT INTO email_templates (name, subject, body) VALUES
  ('Document needed',
   'We need one more document for your account',
   E'We are reviewing your account and need one more document before we can finish.\n\nPlease sign in and upload it from the Documents page. If you are not sure which document is outstanding, reply to this message and we will tell you.\n\nThank you,\nThe desk'),
  ('Welcome',
   'Welcome to Pantera GP',
   E'Your account is open and ready to use.\n\nYou can sign in to see your balances, portfolios and any offerings that are open for subscription. If anything looks wrong or you have a question, reply to this message — it reaches your account manager directly.\n\nWelcome aboard,\nThe desk'),
  ('Checking in',
   'Checking in on your account',
   E'I wanted to check in and see how things are going with your account.\n\nIf there is anything you would like to talk through — a position, a portfolio, or something you are considering — reply here and we will find a time.\n\nBest regards,\nThe desk')
ON CONFLICT (name) DO NOTHING;

DO $do$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_templates'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = t || '_audit') THEN
      EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                      FOR EACH ROW EXECUTE FUNCTION audit()', t, t);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'email_templates_touch') THEN
    EXECUTE 'CREATE TRIGGER email_templates_touch BEFORE UPDATE ON email_templates
             FOR EACH ROW EXECUTE FUNCTION touch()';
  END IF;
END $do$;

-- Who a campaign goes to. 'all' is everyone who has not opted out. 'selected' is a list the
-- desk picked by hand — still filtered by opt-out at send time, because a name on a list is
-- not consent, and the list is kept on the row so the record says who it was meant for.
ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS audience      text NOT NULL DEFAULT 'all';
ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS recipient_ids uuid[];
DO $do$ BEGIN
  ALTER TABLE email_campaigns
    ADD CONSTRAINT email_campaigns_audience_check CHECK (audience IN ('all','selected'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $do$;
