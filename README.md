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
Converter: `GET /convert/quote` · `POST /convert` · `GET /conversions`
Tickets: `GET|POST /tickets` · `GET /tickets/:id` · `POST /tickets/:id/messages`
`PATCH /tickets/:id` (staff triage)
Notifications: `GET /notifications` · `GET /notifications/unread-count`
`POST /notifications/:id/read` · `POST /notifications/read-all` · `POST /clients/:id/notify` (staff)
Accrual: `POST /admin/accrue` (idempotent; also runs hourly)
Portfolios: `GET /portfolio-types` · `GET|POST /portfolios` · `PATCH /portfolios/:id`
`POST /portfolios/:id/contribute` · `POST /portfolios/:id/withdraw`
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

**Converting between balances.** Clients exchange their own holdings at the same rates used
for valuation, fiat or crypto in either direction. The credited amount is floored to the
destination's minor unit and never rounded up: rounding up hands out a fraction the rate
did not earn, which across many conversions is money created from nothing. The dust is
reported rather than hidden. Both sides move inside one transaction, locking the two
holdings in a fixed order so that `GBP->USD` and `USD->GBP` running concurrently cannot
each hold what the other waits for. An optional `min_receive` refuses the exchange if the
rate moved against the quote, which matters most for crypto pairs that reprice every second.

`floorTo` caps at 15 decimal places. Above that, `n * 10**decimals` passes
`Number.MAX_SAFE_INTEGER` and `Math.floor` stops truncating — it can even return more than
it was given — so ETH's declared 18 decimals is truncated at 15. That is the float
limitation already noted for money, made explicit rather than left to quietly break the
no-rounding-up guarantee.


**Valuation.** `rateToUsd` prices crypto from the live feed where an instrument exists
(BTC, ETH), dollar-pegged stablecoins from a seeded rate of 1, and fiat from the seeded
`fx_rates` table — which a real deployment refreshes from an FX provider. Anything with no
price source is reported as unpriced and excluded from the total, and the UI names it,
rather than being silently valued at zero and understating the client's holdings.


## Portfolios

A portfolio is a labelled pot: a named container with a product type, a currency, an
optional target amount and date. Money reaches it only by being moved out of a balance the
client already holds, and both sides move in one transaction — money is never in neither
place, or in both.

`portfolio_types` is seeded reference data (Retirement plan, Savings account, Education
fund, Emergency fund, Property deposit, General investment), so adding "Junior ISA" or
"Trust" is an INSERT rather than a deploy.

**Interest accrues.** Portfolios whose type carries an `indicative_rate` are paid interest
for each whole day elapsed, compounded daily at the 365th root of the annual rate — so a
full year lands on the headline rate rather than overshooting it the way `rate/365` would,
and the accrual agrees with the projection shown to the client. There is a test asserting
those two code paths cannot disagree.

The job is **idempotent by date**. Each portfolio is claimed by moving `last_accrued_on` to
today inside the same transaction that credits it, so running the accrual twice in a day
pays once, a rolled-back transaction leaves the days unclaimed for the next run, and a week
missed to an outage is paid as one compounded step equal to seven daily ones. That matters
because in production this is driven by cron, and cron double-fires, retries and runs late.

It runs shortly after boot and hourly thereafter, so the day rollover is caught wherever
the server happens to be. `POST /admin/accrue` triggers it by hand for an ops re-run; being
idempotent, an accidental double-click costs nothing.

Interest is credited at full precision rather than rounded to the currency's minor unit:
a small pot earns well under a penny a day, and flooring daily would mean it never grew at
all. The fraction stays in the balance (`numeric(38,18)`) and the display rounds.

A pot cannot go negative (a CHECK constraint, not just a guard), and closing one that still
holds money is refused rather than stranding it — take the balance out first.


## Notifications

A client's inbox, deliberately not a mirror of `activity_log`: the timeline is the firm's
record of everything, this is the subset a client should see.

What generates one is things done **to** the client — a staff credit, a KYC decision, a
cash decision, interest credited overnight, a message from their account manager, and an
order the *engine* filled. What does not is things the client just did themselves: placing
a market order, converting currency, paying into a portfolio. They were there.

**Compliance flags are never notified.** Telling a client they have been flagged for
suspicious activity is tipping-off, a criminal offence in most jurisdictions. Flags reach
staff through the CRM and stop there, and there is an acceptance check asserting no
notification ever mentions one.

Rows are written inside the transaction that causes them, so a notification cannot outlive
the event it describes, and pushed over the existing WebSocket only after that transaction
commits — a client told about a fill that then rolled back would be looking at money that
never moved. The bell keeps the socket open on every page, so notifications arrive away
from the charts too.

`POST /clients/:id/notify` lets staff message a client directly, which is the CRM and the
client-facing side sharing one inbox.


## Support tickets

A client raises a ticket with a subject, a category and a first message; staff triage it
from a queue ordered by priority. Every message and status change lands on the client's CRM
timeline, so support sits in the same record as their trades and their KYC.

**Status says whose turn it is.** `open` is waiting on us and `pending` on the client, so a
staff reply moves a ticket to `pending` and a client reply moves it back to `open`. A reply
to a `resolved` ticket reopens it and clears the resolution rather than stranding the
client with a closed conversation.

**Internal notes are a privacy boundary, not a display hint.** Staff can attach a note to a
ticket that the client must never see. Every client-facing read filters on
`internal = false` — the thread, and the message *count* in the list, which would otherwise
disclose that a note exists at all. A client passing `internal: true` has it stored as
false; the flag is staff-only. There are acceptance checks for each of those, because this
is exactly the kind of constraint an innocent refactor breaks.

Staff replies notify the client through the notification system; internal notes do not.


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
| `src/server.ts` | Accrual runs on an in-process hourly timer, so every API instance would run it. | Harmless while it stays idempotent; move to one scheduled job when you scale out. |
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
