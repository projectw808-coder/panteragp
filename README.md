# Trading platform — CRM core

CRM is the system of record. `clients` is the hub; `orders`, `fills`, `cash_transactions`
all carry `client_id`, so reading a client's timeline never joins through trading tables.

## Run it

Two terminals, no Postgres install needed — `dev:db` is an in-process Postgres (PGlite)
on port 5432, seeded with `admin@local.test` / `devpassword`.

    npm install && (cd web && npm install)
    npm run dev:db
    DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
      JWT_SECRET=dev-secret-that-is-long-enough-32ch PG_POOL_MAX=1 npm run dev
    cd web && npm run dev        # http://localhost:5173

Against a real Postgres: `npm run db:reset`, then `src/seed.ts <email> <password> [role]`
to create the first staff account, and drop `PG_POOL_MAX`.

    npm test         # unit tests + schema tests against a real Postgres engine (no server needed)
    npm run test:e2e # 31 acceptance checks across all seven phases (needs the stack up)

## Enforced by the database, not the app
- `audit_log` is written by an AFTER trigger on all 11 mutable tables, with `password_hash`
  stripped and the actor taken from `app.actor` (set per transaction by `tx()`).
- `audit_log` and `activity_log` reject UPDATE and DELETE.
- Order type/price coherence, demo-vs-live account mode, KYC and pipeline values: CHECK constraints.

## API
CRM: `GET|POST /clients` · `GET|PATCH /clients/:id` · `GET /clients/:id/timeline`
`POST /clients/:id/notes` · `GET /pipeline-stages` · `GET /staff` · `GET|POST /tasks`
`PATCH /tasks/:id` · `GET /audit`
Market data (any authenticated principal): `GET /instruments` · `GET /candles` · `GET /quotes`
Live feed: `WS /feed` — the client authenticates in its first message, then receives
`{type:'tick', ticks:[{symbol, price}]}` once a second, plus `order` and `fill` events
for its own account (staff with `trade:read` see them too).
Currencies and wallets: `GET /currencies` · `GET /accounts` · `GET|POST /wallets`
`POST /wallets/:id/withdraw` · `GET /wallet-transactions` · `POST /wallet-transactions/:id/decide`
`POST /clients/:id/credit` · `POST /clients/:id/wallet-credit` (both admin-only)
Trading (account holders only): `GET /account` · `GET|POST /orders` · `DELETE /orders/:id`
`GET /positions` · `GET /trades` · `GET|POST /cash`
Compliance: `POST|GET /clients/:id/kyc` · `GET /kyc/pending` · `GET /kyc/:id/file`
`POST /kyc/:id/review` · `POST /cash/:id/decide` · `GET /flags` · `PATCH /flags/:id`
Reports: `GET /reports/clients` · `GET /reports/team` (add `.csv` to download)
Admin: `GET /admin/overview` · `GET /admin/config` · `GET /activity` (firm-wide timeline)
Auth: `POST /auth/login` (`as: staff | client`) · `GET /me`

## Charting
Candlestick / line / bar, 7 timeframes, 1-2-4 chart grid, light and dark themes.
Indicators (MA, EMA, Bollinger on price; RSI and MACD in their own panes) are computed in
`web/src/indicators.ts` — no indicator library. Trendline, horizontal level and Fibonacci
retracement are an SVG overlay positioned from chart coordinates, since Lightweight Charts
ships no drawing tools.

OHLC comes from `src/market.ts`: deterministic value noise, not a real feed. A given bar
keeps its values however much history you request, so panning is stable. `spot()` walks
through the bar currently forming and meets that bar's open and close exactly at its
boundaries, so the live price and the candle history never disagree.

Ticks drive the watchlist and extend the last candle on every open chart, rolling to a
new bar when the timeframe's bucket advances. One socket serves the whole page
(`web/src/feed.ts`), opened by the first subscriber and closed after the last leaves.

## Permissions
| | crm:read | crm:write | trade:read | trade:own | kyc:review | audit:read |
|---|---|---|---|---|---|---|
| trader | | | | ✓ | | |
| sales / support | ✓ | ✓ | ✓ | | | |
| compliance | ✓ | | ✓ | | ✓ | ✓ |
| admin | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

## Paper trading
Demo accounts only — `trading_accounts.mode` is CHECK-constrained to `demo`/`live`, the
engine reads only `demo` rows, and `POST /orders` refuses anything else. There is no live
code path to enable by accident.

All five order types work. The engine runs once a second off the same tick that drives the
feed: it ratchets trailing stops, fills whatever the price triggers, moves the position,
realises P&L onto the balance, and writes the CRM timeline — all in one transaction, so a
fill the timeline never saw cannot happen. Market orders fill in the request instead of
waiting for the tick.

Take-profit and stop-loss on an entry become two resting exit orders linked by
`parent_order_id`; whichever fills cancels its sibling, so a position can't be closed and
re-opened the other way. The money maths (`src/trading.ts`) is pure and tested, and the
position sizing tool is the same function on both sides of the wire.

Not enforced: margin calls, partial fills, slippage, spread, commission, and a resting
limit left behind after a stop-limit triggers. Each is marked in the code.

## Currencies, credits and wallets

`currencies` carries 167 codes — the worldwide ISO 4217 fiat list plus twelve crypto
assets — each with its minor unit, because that is what every balance is formatted to.
The zero-decimal (JPY, KRW, CLP, the CFA francs) and three-decimal (KWD, BHD, OMR, JOD,
TND, LYD, IQD) entries are correct, not oversights; formatting yen to two places would
misstate a balance by a factor of a hundred.

A client holds one `trading_accounts` row per currency — the schema's
`UNIQUE (client_id, mode, currency)` always allowed this — created on first credit.

**Credits** put money on an account out of nothing, so they sit behind a dedicated
`funds:credit` permission held only by admin: deliberately not part of ordinary CRM write
access, so sales and support cannot mint funds. Every credit is audited and written to the
client's timeline with its stated reason.

**Wallets are simulated.** There is no key material anywhere in this codebase and nothing
touches a chain. A wallet is a balance plus an address-shaped label, and every address is
prefixed `DEMO-` — enforced by a CHECK constraint, not just convention — so it can never
be mistaken for a real address and funded with coin that nothing here could recover or
return. Wallet withdrawals follow the same rule as fiat: debited on request, refunded on
rejection.

Making these real is a different product, not a feature flag: key custody or a custodian
integration, HSM or KMS for signing, chain reorg and confirmation handling, hot/cold
separation, and the licensing and travel-rule obligations that come with holding client
crypto.

**Valuation.** `rateToUsd` prices crypto from the live feed where an instrument exists
(BTC, ETH), dollar-pegged stablecoins from a seeded rate of 1, and fiat from the seeded
`fx_rates` table — which a real deployment refreshes from an FX provider. Anything with no
price source is reported as unpriced and excluded from the total, and the UI names it,
rather than being silently valued at zero and understating the client's holdings.


## Compliance
KYC: a client uploads JPEG/PNG/PDF (10 MB cap, anything else refused). The stored filename
is generated — an uploaded name never reaches the filesystem — and documents are served
only through an authenticated endpoint that requires `kyc:review`, never as a static path.
A client goes to `approved` once every required document is (`id_front` and
`proof_of_address`); one rejection rejects them.

Money moves at opposite ends of the two funding flows. A **withdrawal debits the balance
the moment it is requested** and is refunded only if compliance rejects it — approval moves
nothing, because the money already left. A **deposit** is credited only on approval, since
money that has not arrived cannot be spent. The balance check and the debit happen in one
transaction behind `SELECT … FOR UPDATE` on the account, so concurrent withdrawals cannot
both pass a check neither can afford.

That leaves money that has been debited but not yet paid out, so the client report shows
`withdrawals` (approved or settled — actually paid) apart from `withdrawals_pending`
(debited, awaiting a decision), and `net_deposits` counts only the former.

Flag rules live in `src/compliance.ts` with every threshold in one `RULES` object:
large withdrawal (two severities), any withdrawal before KYC approval, a withdrawal that
returns most of a deposit within 24 hours, a daily volume spike against the client's own
30-day average, and an absolute fallback for clients with no baseline yet. Flags are raised
inside the transaction that causes them and land on the client's timeline.

Reports export as RFC 4180 CSV. Cells starting with `=`, `+`, `-` or `@` are prefixed
with an apostrophe: client names and notes reach these files, and a spreadsheet would
otherwise execute them. PDF is the browser's print dialogue on the on-screen report rather
than a PDF library.

## Admin dashboard
One screen across all three pillars: headline tiles that link into the area they describe,
the pipeline as a bar per stage, live trading and funds (client exposure and open P&L are
computed from current prices, not stored), the firm-wide activity feed, and the system
configuration.

Configuration is read-only on purpose: thresholds are code constants, so changing one is a
deploy and therefore reviewable and revertable. Making them editable needs a settings table
and a way to pass them into the pure rule functions — a deliberate next step, not an
oversight.

## Verification
`npm test` covers the pure logic — position and P&L maths, order triggers, trailing stops,
position sizing, indicators, mock-candle invariants, flag rules, CSV escaping, password
hashing, JWT forgery, the RBAC matrix — plus `db/schema.sql` applied to a real Postgres
engine to prove the audit triggers, append-only logs and CHECK constraints behave.

`npm run test:e2e` walks the whole product against a running stack: RBAC, the CRM timeline
and audit trail, candles on every timeframe, the WebSocket handshake and moving prices, a
market fill whose realised P&L is checked against the balance to 1e-6, linked TP/SL exits,
cancellation, KYC upload rules and the two-document approval gate, the withdrawal flag
rules, CSV export, and the dashboard's numbers cross-checked against the endpoints they
summarise. It is repeatable — counts are asserted as deltas, not absolutes.

## Deliberate shortcuts
Every one is marked `ponytail:` in the code, so `grep -rn "ponytail:" src web/src` is the
live list. At the time of writing:

| Where | Shortcut | Upgrade when |
|---|---|---|
| `src/market.ts` | Prices are value noise, not a market. Still the only price source. | Integrating a broker or exchange — this file is the whole seam. |
| `src/trading.ts` | Floats rounded to 8dp for money. | Before real funds: integer minor units. |
| `src/trading.ts` | Stop-limit fills only if the stop is breached *and* the limit still holds. | A real book leaves a resting limit behind. |
| `src/server.ts` | `numeric`/`bigint` parsed as JS numbers. | Same as the float note above. |
| `src/server.ts` | Client search is `ILIKE '%x%'` — a sequential scan. | When the client list gets long: pg_trgm index. |
| `src/server.ts` | One process, one broadcast interval, in-memory socket set. | More than one API instance: Redis pub/sub, same message shape. |
| `web/src/App.tsx` | Hash routing, five flat routes. | When routes nest: react-router. |
| `web/src/chart.tsx` | Resizing a chart re-fits and so resets zoom. | When someone complains. |

## Before this touches production
1. Run `db:reset` against a real Postgres (`src/devdb.ts` is in-memory PGlite, dev only).
2. Add migration tooling — there is none, and the schema is applied by dropping it.
3. Move KYC uploads off local disk to object storage; `storage_key` already assumes it.
4. Set `JWT_SECRET` from a secrets manager, not the environment inline.

## What is deliberately not here
- Live money. No live code path exists; see Paper trading above.
- Margin calls, partial fills, slippage, spread, commission.
- Editable flag thresholds, PDF generation (the reports page prints), Redis, an ORM and
  migrations, per-symbol feed subscriptions.

Each is marked in the code where it would go. Styling stays plain pending the design spec.
