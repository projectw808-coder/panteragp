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

-- ------------------------------------------------------- currencies & rates

-- Reference data. `decimals` is the currency's minor unit (ISO 4217 for fiat), and it is
-- what the UI formats to — getting it wrong misprices a balance, so the zero- and
-- three-decimal currencies below are not oversights.
CREATE TABLE currencies (
  code     text PRIMARY KEY,
  name     text NOT NULL,
  kind     text NOT NULL CHECK (kind IN ('fiat','crypto')),
  decimals smallint NOT NULL CHECK (decimals BETWEEN 0 AND 18),
  active   bool NOT NULL DEFAULT true
);

INSERT INTO currencies (code, name, kind, decimals) VALUES
  -- majors
  ('USD','US Dollar','fiat',2), ('EUR','Euro','fiat',2), ('GBP','Pound Sterling','fiat',2),
  ('JPY','Yen','fiat',0), ('CHF','Swiss Franc','fiat',2), ('CAD','Canadian Dollar','fiat',2),
  ('AUD','Australian Dollar','fiat',2), ('NZD','New Zealand Dollar','fiat',2),
  ('CNY','Yuan Renminbi','fiat',2), ('HKD','Hong Kong Dollar','fiat',2),
  ('SGD','Singapore Dollar','fiat',2),
  -- europe
  ('SEK','Swedish Krona','fiat',2), ('NOK','Norwegian Krone','fiat',2),
  ('DKK','Danish Krone','fiat',2), ('ISK','Iceland Krona','fiat',0),
  ('PLN','Zloty','fiat',2), ('CZK','Czech Koruna','fiat',2), ('HUF','Forint','fiat',2),
  ('RON','Romanian Leu','fiat',2), ('BGN','Bulgarian Lev','fiat',2),
  ('RSD','Serbian Dinar','fiat',2), ('MKD','Denar','fiat',2), ('ALL','Lek','fiat',2),
  ('BAM','Convertible Mark','fiat',2), ('MDL','Moldovan Leu','fiat',2),
  ('UAH','Hryvnia','fiat',2), ('BYN','Belarusian Ruble','fiat',2), ('RUB','Russian Ruble','fiat',2),
  ('TRY','Turkish Lira','fiat',2), ('GEL','Lari','fiat',2), ('AMD','Armenian Dram','fiat',2),
  ('AZN','Azerbaijan Manat','fiat',2), ('GIP','Gibraltar Pound','fiat',2),
  ('FKP','Falkland Islands Pound','fiat',2), ('SHP','Saint Helena Pound','fiat',2),
  -- middle east
  ('AED','UAE Dirham','fiat',2), ('SAR','Saudi Riyal','fiat',2), ('QAR','Qatari Rial','fiat',2),
  ('KWD','Kuwaiti Dinar','fiat',3), ('BHD','Bahraini Dinar','fiat',3),
  ('OMR','Rial Omani','fiat',3), ('JOD','Jordanian Dinar','fiat',3),
  ('IQD','Iraqi Dinar','fiat',3), ('ILS','New Israeli Sheqel','fiat',2),
  ('LBP','Lebanese Pound','fiat',2), ('SYP','Syrian Pound','fiat',2),
  ('IRR','Iranian Rial','fiat',2), ('YER','Yemeni Rial','fiat',2),
  -- africa
  ('ZAR','Rand','fiat',2), ('NGN','Naira','fiat',2), ('KES','Kenyan Shilling','fiat',2),
  ('GHS','Ghana Cedi','fiat',2), ('EGP','Egyptian Pound','fiat',2),
  ('MAD','Moroccan Dirham','fiat',2), ('TND','Tunisian Dinar','fiat',3),
  ('DZD','Algerian Dinar','fiat',2), ('LYD','Libyan Dinar','fiat',3),
  ('ETB','Ethiopian Birr','fiat',2), ('UGX','Uganda Shilling','fiat',0),
  ('TZS','Tanzanian Shilling','fiat',2), ('RWF','Rwanda Franc','fiat',0),
  ('BIF','Burundi Franc','fiat',0), ('DJF','Djibouti Franc','fiat',0),
  ('SOS','Somali Shilling','fiat',2), ('SDG','Sudanese Pound','fiat',2),
  ('SSP','South Sudanese Pound','fiat',2), ('ERN','Nakfa','fiat',2),
  ('XAF','CFA Franc BEAC','fiat',0), ('XOF','CFA Franc BCEAO','fiat',0),
  ('XPF','CFP Franc','fiat',0), ('GNF','Guinean Franc','fiat',0),
  ('KMF','Comorian Franc','fiat',0), ('CVE','Cabo Verde Escudo','fiat',2),
  ('GMD','Dalasi','fiat',2), ('LRD','Liberian Dollar','fiat',2), ('SLE','Leone','fiat',2),
  ('MRU','Ouguiya','fiat',2), ('MGA','Malagasy Ariary','fiat',2),
  ('MUR','Mauritius Rupee','fiat',2), ('SCR','Seychelles Rupee','fiat',2),
  ('BWP','Pula','fiat',2), ('NAD','Namibia Dollar','fiat',2), ('LSL','Loti','fiat',2),
  ('SZL','Lilangeni','fiat',2), ('ZMW','Zambian Kwacha','fiat',2),
  ('MWK','Malawi Kwacha','fiat',2), ('MZN','Mozambique Metical','fiat',2),
  ('AOA','Kwanza','fiat',2), ('CDF','Congolese Franc','fiat',2),
  ('STN','Dobra','fiat',2), ('ZWG','Zimbabwe Gold','fiat',2),
  -- asia pacific
  ('INR','Indian Rupee','fiat',2), ('PKR','Pakistan Rupee','fiat',2),
  ('BDT','Taka','fiat',2), ('LKR','Sri Lanka Rupee','fiat',2), ('NPR','Nepalese Rupee','fiat',2),
  ('BTN','Ngultrum','fiat',2), ('MVR','Rufiyaa','fiat',2), ('AFN','Afghani','fiat',2),
  ('KRW','Won','fiat',0), ('TWD','New Taiwan Dollar','fiat',2), ('MOP','Pataca','fiat',2),
  ('THB','Baht','fiat',2), ('MYR','Malaysian Ringgit','fiat',2), ('IDR','Rupiah','fiat',2),
  ('PHP','Philippine Peso','fiat',2), ('VND','Dong','fiat',0), ('KHR','Riel','fiat',2),
  ('LAK','Lao Kip','fiat',2), ('MMK','Kyat','fiat',2), ('BND','Brunei Dollar','fiat',2),
  ('MNT','Tugrik','fiat',2), ('KPW','North Korean Won','fiat',2),
  ('KZT','Tenge','fiat',2), ('UZS','Uzbekistan Sum','fiat',2), ('KGS','Som','fiat',2),
  ('TJS','Somoni','fiat',2), ('TMT','Turkmenistan New Manat','fiat',2),
  ('PGK','Kina','fiat',2), ('FJD','Fiji Dollar','fiat',2), ('SBD','Solomon Islands Dollar','fiat',2),
  ('VUV','Vatu','fiat',0), ('WST','Tala','fiat',2), ('TOP','Pa''anga','fiat',2),
  -- americas
  ('MXN','Mexican Peso','fiat',2), ('BRL','Brazilian Real','fiat',2),
  ('ARS','Argentine Peso','fiat',2), ('CLP','Chilean Peso','fiat',0),
  ('COP','Colombian Peso','fiat',2), ('PEN','Sol','fiat',2), ('UYU','Peso Uruguayo','fiat',2),
  ('PYG','Guarani','fiat',0), ('BOB','Boliviano','fiat',2), ('VES','Bolivar Soberano','fiat',2),
  ('GYD','Guyana Dollar','fiat',2), ('SRD','Surinam Dollar','fiat',2),
  ('TTD','Trinidad and Tobago Dollar','fiat',2), ('JMD','Jamaican Dollar','fiat',2),
  ('BBD','Barbados Dollar','fiat',2), ('BSD','Bahamian Dollar','fiat',2),
  ('BZD','Belize Dollar','fiat',2), ('BMD','Bermudian Dollar','fiat',2),
  ('KYD','Cayman Islands Dollar','fiat',2), ('XCD','East Caribbean Dollar','fiat',2),
  ('AWG','Aruban Florin','fiat',2), ('ANG','Netherlands Antillean Guilder','fiat',2),
  ('CUP','Cuban Peso','fiat',2), ('DOP','Dominican Peso','fiat',2),
  ('HTG','Gourde','fiat',2), ('GTQ','Quetzal','fiat',2), ('HNL','Lempira','fiat',2),
  ('NIO','Cordoba Oro','fiat',2), ('CRC','Costa Rican Colon','fiat',2),
  ('PAB','Balboa','fiat',2), ('SVC','El Salvador Colon','fiat',2),
  -- crypto
  ('BTC','Bitcoin','crypto',8), ('ETH','Ethereum','crypto',18),
  ('USDT','Tether','crypto',6), ('USDC','USD Coin','crypto',6),
  ('SOL','Solana','crypto',9), ('XRP','XRP','crypto',6),
  ('ADA','Cardano','crypto',6), ('DOGE','Dogecoin','crypto',8),
  ('LTC','Litecoin','crypto',8), ('BNB','BNB','crypto',18),
  ('DOT','Polkadot','crypto',10), ('AVAX','Avalanche','crypto',18);

-- Units of `code` per 1 USD. Seed values only: a real deployment refreshes these from an
-- FX provider, and crypto rates come from the price feed instead (see fxToUsd in server.ts).
CREATE TABLE fx_rates (
  code    text PRIMARY KEY REFERENCES currencies(code),
  per_usd numeric(30,12) NOT NULL CHECK (per_usd > 0),
  as_of   timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fx_rates (code, per_usd) VALUES
  ('USD',1), ('EUR',0.92), ('GBP',0.79), ('JPY',151.4), ('CHF',0.90), ('CAD',1.36),
  ('AUD',1.52), ('NZD',1.64), ('CNY',7.24), ('HKD',7.82), ('SGD',1.34), ('SEK',10.6),
  ('NOK',10.7), ('DKK',6.87), ('ISK',137.0), ('PLN',3.97), ('CZK',23.2), ('HUF',360.0),
  ('RON',4.58), ('BGN',1.80), ('TRY',32.3), ('RUB',92.0), ('UAH',39.5), ('INR',83.3),
  ('PKR',278.0), ('BDT',110.0), ('LKR',300.0), ('KRW',1340.0), ('TWD',32.2), ('THB',36.5),
  ('MYR',4.72), ('IDR',15800.0), ('PHP',56.2), ('VND',24800.0), ('AED',3.67), ('SAR',3.75),
  ('QAR',3.64), ('KWD',0.307), ('BHD',0.376), ('OMR',0.385), ('JOD',0.709), ('ILS',3.70),
  ('EGP',47.5), ('ZAR',18.7), ('NGN',1480.0), ('KES',131.0), ('GHS',14.5), ('MAD',9.95),
  ('TND',3.12), ('XAF',602.0), ('XOF',602.0), ('MXN',17.0), ('BRL',5.15), ('ARS',870.0),
  ('CLP',960.0), ('COP',3900.0), ('PEN',3.72), ('UYU',38.5),
  -- Dollar-pegged stablecoins: a seed rate of 1 is honest reference data. The other
  -- crypto assets have no rate here on purpose — they are priced from the feed, and
  -- anything the feed does not carry is reported unpriced rather than guessed at.
  ('USDT',1.0), ('USDC',1.0)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE trading_accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES clients(id),
  mode       text NOT NULL CHECK (mode IN ('demo','live')),
  currency   text NOT NULL DEFAULT 'USD' REFERENCES currencies(code),
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

-- --------------------------------------------------------------- wallets

/*
 * SIMULATED wallets. There is no key material here and nothing touches a chain: a wallet
 * is a balance plus an address-shaped label, and every address is prefixed DEMO- so it can
 * never be mistaken for a real one and funded by accident. Making these real means key
 * custody, and that is a different product with different obligations — see the README.
 */
CREATE TABLE wallets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES clients(id),
  asset      text NOT NULL REFERENCES currencies(code),
  address    text UNIQUE NOT NULL CHECK (address LIKE 'DEMO-%'),
  balance    numeric(38,18) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, asset)
);
CREATE INDEX ON wallets (client_id);

CREATE TABLE wallet_transactions (
  id          bigserial PRIMARY KEY,
  wallet_id   uuid NOT NULL REFERENCES wallets(id),
  client_id   uuid NOT NULL REFERENCES clients(id),
  kind        text NOT NULL CHECK (kind IN ('deposit','withdrawal','credit','fee')),
  amount      numeric(38,18) NOT NULL,      -- signed: withdrawals are negative
  to_address  text,                         -- where a withdrawal was sent
  tx_ref      text,                         -- simulated on-chain reference
  status      text NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','confirmed','rejected')),
  decided_by  uuid REFERENCES staff(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON wallet_transactions (client_id, created_at DESC);
CREATE INDEX ON wallet_transactions (status);
-- Every exchange between a client's own balances, kept as its own record so a
-- conversion is legible without reading two balance movements and inferring the link.
CREATE TABLE conversions (
  id          bigserial PRIMARY KEY,
  client_id   uuid NOT NULL REFERENCES clients(id),
  from_code   text NOT NULL REFERENCES currencies(code),
  from_amount numeric(38,18) NOT NULL CHECK (from_amount > 0),
  to_code     text NOT NULL REFERENCES currencies(code),
  to_amount   numeric(38,18) NOT NULL CHECK (to_amount > 0),
  rate        numeric(38,18) NOT NULL CHECK (rate > 0),
  at          timestamptz NOT NULL DEFAULT now(),
  CHECK (from_code <> to_code)
);
CREATE INDEX ON conversions (client_id, at DESC);
-- ------------------------------------------------------------- portfolios

-- The product catalogue. Reference data, so adding "Trust" or "Junior ISA" is an INSERT
-- rather than a deploy. `indicative_rate` is a headline annual rate for display and
-- projection only — nothing accrues it (see the ponytail note in server.ts).
CREATE TABLE portfolio_types (
  code            text PRIMARY KEY,
  name            text NOT NULL,
  description     text NOT NULL,
  indicative_rate numeric(6,4),
  sort_order      smallint NOT NULL DEFAULT 0
);
INSERT INTO portfolio_types (code, name, description, indicative_rate, sort_order) VALUES
  ('retirement','Retirement plan','Long-term savings intended to be drawn down in retirement.',0.0500,1),
  ('savings','Savings account','Set money aside and earn a headline rate on the balance.',0.0350,2),
  ('education','Education fund','Earmarked for tuition or study costs.',0.0300,3),
  ('emergency','Emergency fund','Readily available cash for the unexpected.',0.0200,4),
  ('property','Property deposit','Saving towards a deposit on a home.',0.0250,5),
  ('general','General investment','An unrestricted pot with no particular purpose.',NULL,6);

CREATE TABLE portfolios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id),
  type_code     text NOT NULL REFERENCES portfolio_types(code),
  name          text NOT NULL,
  currency      text NOT NULL REFERENCES currencies(code),
  -- A pot cannot go negative: money reaches it only by being moved in from a balance.
  balance       numeric(38,18) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  target_amount numeric(38,18) CHECK (target_amount IS NULL OR target_amount > 0),
  target_date   date,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, name)
);
CREATE INDEX ON portfolios (client_id, status);

CREATE TABLE portfolio_transactions (
  id           bigserial PRIMARY KEY,
  portfolio_id uuid NOT NULL REFERENCES portfolios(id),
  client_id    uuid NOT NULL REFERENCES clients(id),
  kind         text NOT NULL CHECK (kind IN ('contribution','withdrawal','interest','adjustment')),
  amount       numeric(38,18) NOT NULL,     -- signed: withdrawals are negative
  note         text,
  at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON portfolio_transactions (client_id, at DESC);
CREATE INDEX ON portfolio_transactions (portfolio_id, at DESC);



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
                           'trading_accounts','orders','fills','positions','cash_transactions',
                           'wallets','wallet_transactions','conversions',
                           'portfolios','portfolio_transactions'] LOOP
    EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION audit()', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['audit_log','activity_log'] LOOP
    EXECUTE format('CREATE TRIGGER %I_immutable BEFORE UPDATE OR DELETE ON %I
                    FOR EACH ROW EXECUTE FUNCTION append_only()', t, t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['staff','clients','tasks','orders','portfolios'] LOOP
    EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON %I
                    FOR EACH ROW EXECUTE FUNCTION touch()', t, t);
  END LOOP;
END $do$;
