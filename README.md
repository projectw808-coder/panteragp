# Trading platform — CRM core

CRM is the system of record. `clients` is the hub; `orders`, `fills`, `cash_transactions`
all carry `client_id`, so reading a client's timeline never joins through trading tables.

## Run it

    npm start

That is the whole thing. It installs anything missing, writes a `.env` with a generated
`JWT_SECRET` on first run, starts the database, the API and the web app, waits until each
one actually answers, and seeds a demo client if the database is empty. Ctrl-C stops all
three. No Postgres install is needed: the dev database is a real PostgreSQL 18 server on
port 5432, whose binaries arrive with `npm install` (`embedded-postgres`) and run as an
ordinary user process — no installer, no service, no admin rights.

Then open **http://localhost:5173**:

| | | |
|---|---|---|
| Staff | `admin@local.test` | `devpassword` |
| Client | `demo.client@local.test` | `devpassword` — pick **Trader** |

Checks:

    npm test         # unit and schema tests, no server needed
    npm run test:e2e # 131 acceptance checks against the running stack

`test:e2e` reads `.env`, so it signs its forged tokens with the same secret the API is
verifying with — without that the auth checks would pass for the wrong reason.

Running the pieces by hand, if you want them in separate terminals:

    npm run dev:db                      # database on 5432
    npm run dev                         # API on 3000 (needs DATABASE_URL, JWT_SECRET)
    cd web && npm run dev               # web on 5173

The API runs under `--watch` either way, so an edit to it applies by itself; the database
is a separate process and is left alone.

Set `DEV_DB_DIR` to keep the data between restarts. Without it the cluster lives in
`.pgdata-ephemeral`, which is wiped on every boot so the database starts clean — which is
what the acceptance run wants. Against a Postgres you host yourself: point `DATABASE_URL`
at it, `npm run db:reset`, then `src/seed.ts <email> <password> [role]` for the first staff
account.

## Enforced by the database, not the app
- `audit_log` is written by an AFTER trigger on all 13 mutable tables, with `password_hash`
  stripped and the actor taken from `app.actor` (set per transaction by `tx()`).
- `audit_log` and `activity_log` reject UPDATE and DELETE.
- Order type/price coherence, demo-vs-live account mode, KYC and pipeline values: CHECK constraints.

## API
CRM: `GET|POST /clients` · `GET /clients/:id/holdings` (staff, read-only)
`GET|POST /staff` · `PATCH /staff/:id` (admin) · `GET|PATCH /clients/:id` · `GET /clients/:id/timeline`
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
Accrual: `POST /admin/accrue` · `POST /admin/accrue-ipos` (idempotent; both also run hourly)
IPO offerings: `GET /ipos` · `GET /ipos/:id` · `POST /ipos/:id/subscribe` · `GET /me/ipo-subscriptions`
`GET|POST /admin/ipos` · `PATCH /admin/ipos/:id` · `POST /admin/ipos/:id/image`
`GET /admin/ipos/:id/subscriptions` · `PATCH /admin/ipo-subscriptions/:id`
`POST /admin/ipos/:id/cancel` · `POST /admin/ipos/:id/settle`
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


## IPO offerings

A deal the desk publishes, a window clients subscribe through, and a fixed return accrued
daily until it matures. `POST /admin/ipos` · `PATCH /admin/ipos/:id` · `GET /ipos` ·
`POST /ipos/:id/subscribe` · `POST /admin/ipos/:id/cancel` · `POST /admin/ipos/:id/settle`

**It pays an ROI, not a share price.** A subscription is not equity, carries no interest in
any company an offering names, and is not transferable. What a subscriber receives is
`roi_rate` accrued over `term_days` — so an offering yielding 7.25% over 180 days pays about
3.5%, whatever the underlying stock did on its first day. Quoting a listing's day-one move
as the return would describe a product this desk is not selling.

### The lifecycle is the dates

**draft → upcoming → open → closed → active → completed**, with **cancelled** reachable from
any state before `active`.

Only the desk's own decisions are stored: `draft` is unpublished, `cancelled` is withdrawn,
`closed` is the desk holding the book while it settles allocation, and `completed` is a
settlement. Everything else is computed on read from `opens_at`, `closes_at` and
`matures_at` — a status that changes only when somebody clicks is a status that is wrong
every weekend. An offering missing any of its three dates reads as a draft however it is
stored, which is what keeps a half-prepared one off the client page without anybody
remembering to hide it.

The client page groups these: **incoming** is `upcoming` + `open`, **finished** is
`completed` + `cancelled`, and `active` sits between them as **running**. A client with
money working in an offering needs it prominent, not filed under history.

### Money

**Subscribing debits immediately**, in one transaction that takes two locks. The client's
holding, because a balance check and a debit that are not one atomic step let two concurrent
subscriptions both pass a check only one can afford. And the offering row, because the cap is
a shared resource: two clients racing for the last of a target must not both get it. The
acceptance run fires ten simultaneous subscriptions at a book with room for three and
asserts that three are taken and the book finishes exactly full.

A refusal names what is actually left. Somebody told "only 400 USD is left in this offering"
can subscribe for 400; somebody told "that did not work" tries the same number again. An
exact fill is allowed — refusing the amount that lands precisely on the target would leave
every book a penny short.

**Allocation placed elsewhere** is `raised_baseline`, the part of a book the desk covered
away from this platform before it opened here. It exists because the alternative was writing
subscription rows against real client accounts to make a bar look right — inventing money in
a ledger to fix a picture.

It counts in the raise **and** against the cap. That second half is the whole point: a
baseline that moved the progress bar but not the allocation would show a book 61% full while
still letting clients take the entire target, and the refusal would name an amount that was
never available. It is bounded against the target by a CHECK, so a baseline larger than the
book is a readable refusal rather than a negative remainder. It is not client money and never
becomes any — nothing settles it, nothing refunds it, it is in no client's position, and it
is not counted as a subscriber.

**The estimated return is this term's, not a year's.** `estimated_return_pct` is what a
subscription earns over `term_days`: 7.25% a year across 180 days is 3.52%, and printing the
annual figure beside a 180-day term is how somebody ends up expecting twice what they get. It
is computed by `accrue()` on a unit balance — the same function the daily job credits with,
rather than the formula written out a second time, so the number on the card and the number
in the ledger cannot drift. A test holds them together at money precision. "Estimated"
because the desk can change the rate on a live offering, not because the arithmetic is
uncertain.

Allocation is first come, first served. There is no pro-rata scale-back: the overflow is
refused rather than trimmed.

**Refunds are the amount originally debited**, never recomputed from a rate. Cancelling
refunds every active subscription, each in its own transaction so a failure on one cannot
leave another client's money in neither place.

**Maturity pays principal plus accrued**, floored to the currency's minor unit with the dust
reported rather than hidden — rounding up across many settlements is money created from
nothing.

### The ROI accrual

The same mechanism as portfolio interest, not a second one. Each day is claimed by moving
`last_accrued_on` inside the transaction that credits it, so running twice in a day pays
once, a rolled-back transaction leaves the day unclaimed, and a week lost to an outage is
paid as one compounded step equal to seven daily ones. Compounded at the 365th root of the
annual rate, so a full year lands on the headline figure rather than overshooting it the way
`rate/365` would.

Accrual runs from the later of what has already been paid and the offering's close, read
fresh each time — so a subscription taken mid-window earns from the close rather than from
the day it was taken, and moving a close date does not strand an offering that never starts
paying. It stops at `matures_at`: settling a week late pays the term, not the delay.

It rides the same hourly sweep as portfolio interest and staking, and
`POST /admin/accrue-ipos` re-runs it by hand. Being idempotent, a double-click costs nothing.

### The shelf it starts with

The 2026 calendar ships seeded, the way `instruments.sql` does: reference data has to reach
deployments that already exist, so it runs on every start and does nothing the second time.
It is `ON CONFLICT DO NOTHING` rather than `DO UPDATE` deliberately — once the desk has
edited an offering, a deploy must not quietly put its own numbers back.

Because the lifecycle is computed from the dates, these move through the groups on their
own: what is incoming today is running in a month and finished after that, with no deploy
and nobody clicking. Company facts and valuations are from public reporting; the ROI, term,
minimum and allocation are the desk's own terms and are not claimed to be anybody else's.

Every field is editable from the desk afterwards, including the picture and the valuation —
free text, because a valuation is reported as a range or an approximation (`$165-175bn`,
`$1tn+`) as often as a number, and forcing it into one would mean choosing a figure the
reporting did not.

**The cover art ships with the code.** `assets/ipo-covers/<asset>.png`, installed by `db:init`
on deploy so every environment has it without anybody uploading eight files by hand. It is
drawn, not photographed and not anybody's logo: `scripts/make-ipo-covers.mjs` computes each
one from the same motif its card falls back to, so they are reproducible rather than eight
unexplained binaries in the tree. Real company logos are deliberately not used — they are
trademarks, and an offering here is not equity in the company it names, so putting its mark
on one would assert a relationship this product spends a paragraph disclaiming.

It applies **at most once per offering**, gated on `cover_seeded_at` rather than on the
picture being absent. The difference matters: a rule based on emptiness would put back a
cover the desk had deliberately removed, every time anybody deployed. After the first install
every decision about that picture is the desk's, including the decision to have none.

### Pictures live in the row

An offering's picture is a `bytea` on `ipos`, not a file, for the reason the profile photo
moved there first: this deploys to a container whose filesystem is replaced on every
release, so a file written at upload is gone by the next one and the card silently loses its
picture. Nobody finds out until a client is looking at it. In the row it is as permanent as
the offering, it reaches every instance without shared storage, and it is in whatever backs
the database up.

The cost is a column a careless `SELECT *` would put into every list, so `ipoSelect` names
its columns instead and the list carries `has_image`, a boolean. There is an acceptance check
for exactly that, because five megabytes on each of a dozen cards is the failure this invites.

`image_key` survives as the cache-busting token the page keys its fetch on — it changes on
every upload, which is what makes a browser holding the old picture go and ask for the new
one — and to find the handful of pictures written to disk before the move, which are still
served from there if the deploy that replaced the filesystem has not got to them first.

### Who may do what

| | trader | sales / support | compliance | admin |
|---|---|---|---|---|
| See published offerings | ✓ | ✓ | ✓ | ✓ |
| Subscribe | ✓ | | | ✓ |
| See any client's book | | ✓ | ✓ | ✓ |
| Create, edit, set the ROI | | | | ✓ |
| Per-client ROI override | | | | ✓ |

Rate changes sit behind `admin` rather than ordinary `crm:write`: changing the ROI on a live
offering changes what every subscriber is paid, which is the same shape of power as
`funds:credit` and should not sit with sales. The edit form says how many subscribers a
change affects and from when, because a number that silently changes what people are paid
deserves a sentence of friction.

**The rate is not on the client page.** It was, on the argument that an offering's ROI is its
public pitch rather than an agreed rate like a portfolio's or a stake's. The desk decided
otherwise, so it now sits with those two: a client sees the term, what they hold, what it has
earned and when it matures. Finished offerings still print a rate, because there it is a
record of what was paid rather than an offer being made. A per-client `roi_override` was
always desk-side and stays there.

**There is no upper bound on the rate.** A 100% ceiling is reasonable for a bond and wrong
here: a 30-day offering at 15% over its term is about 440% annualised, and the cap made
ordinary short-dated deals unenterable. What is still enforced is what is not a matter of
taste — the rate cannot be negative, because the accrual takes the 365th root of
(1 + rate) and there is no real root below -1, and it has to fit `numeric(12,4)` so that too
large is a refusal somebody can read rather than a driver error. `accrue()` also returns zero
rather than NaN for a rate it cannot compound, which nothing can currently reach; it is
guarded because a NaN written onto a balance would not throw, would not be caught, and would
be money silently destroyed.

### Verification, and what gets recorded

**Subscription requires approved KYC.** Taking investment money from an unverified client is
the single most obvious compliance failure this feature could ship with. The refusal points
at verification rather than being a bare 403, and the attempt raises a flag even though it
was refused — an attempt is what compliance wants to see, and a refusal nobody records is a
refusal nobody can count. An unusually large subscription is flagged against the client's own
history, the way the daily-volume rule works.

Subscription, refund, settlement, ROI credited and every desk-side rate change land on the
client's timeline as `ipo`. Notifications follow the rule the rest of the app follows: things
done *to* a client generate one, things they did themselves do not — so their own act of
subscribing is silent, and a rate change, a cancellation, a settlement or money the desk
moved for them is not. Staff are told when an offering fills its cap. A compliance flag is
never disclosed to the client.

An allocation is money the client holds, so it counts in `/accounts`, in the desk-side
`/clients/:id/holdings`, and in the USD valuation — with anything unpriced named rather than
quietly valued at zero.

### Demo money, and the line this does not cross

Offerings move the same simulated balances everything else here moves. Nothing in this
feature is a securities offering, a prospectus, a transferable instrument, or an interest in
any company named. A tokenised offering that took real client money would be a regulated
securities issue carrying obligations — prospectus, suitability, custody, licensing — that no
amount of application code satisfies. The mechanism is here; the claim is deliberately
unmade, and the client-facing screens say so.


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


## The client workspace

One page per client, for staff: identity and contact details, pipeline stage, owner, risk
and KYC across the header, then tabs for **assets** (cash in every currency, crypto
wallets, portfolios), **trading** (positions with live P&L, orders, fills), **funding**
(deposits and withdrawals, approved or rejected in place), **documents**, **tickets**,
**activity** and **audit**. `GET /clients/:id/holdings` assembles the money side in one
call so the page is not a dozen round trips.

**Read-only where it should be.** Sales, support and compliance can all see what a client
holds and has traded — the brief's "trading data, read-only" — but no staff role can place
an order or convert a balance. The only money a staff member moves is through the audited
credit and cash-decision routes, and crediting needs `funds:credit`, which only admin has.

**A KYC override is not the same as a decision.** Setting `kyc_status` by hand skips the
document workflow entirely, so it needs `kyc:review` rather than ordinary CRM write access,
and it lands on the timeline marked `override: true` — distinguishable from an approval
that a reviewed document stands behind.

**Staff accounts.** Admins create colleagues, change roles and deactivate them. The
database row is the authority on both `active` and `role`, checked on every request rather
than trusted from the token: switching someone off ends their session immediately instead
of leaving them with client records and the audit log until their token expires, and a
promotion applies without making them sign in again. An admin cannot deactivate or demote
themselves, since that can leave nobody able to put it right.


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
KYC: a client uploads JPEG/PNG/PDF (10 MB cap, anything else refused). The document is
stored in its row, not on a disk — see **Uploads live in the database** — and is served only
through an authenticated endpoint that requires `kyc:review`, never as a static path, with
`cache-control: no-store` so identification does not sit in anything in between.
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

## Client email

An article the desk writes once and sends to everyone who has not opted out.
`GET|POST /admin/campaigns` · `PATCH /admin/campaigns/:id` · `POST /admin/campaigns/:id/test` ·
`POST /admin/campaigns/:id/send` · `GET /admin/email/status` · `POST /admin/email/verify` ·
`GET /unsubscribe`

Configuration is environment only: `SMTP_HOST`, `SMTP_PORT` (587 by default), `SMTP_USER`,
`SMTP_PASS`, `SMTP_FROM`, and `PUBLIC_URL` for the links inside a message. `SMTP_SECURE`
overrides the guess, which is implicit TLS on 465 and STARTTLS otherwise. `SMTP_MESSAGE_STREAM`
names a provider stream where one is required: Postmark separates transactional mail from
broadcasts and treats a newsletter on the transactional stream as a terms violation, which
suspends the account rather than bouncing the message. Set it to the broadcast stream’s id.
The header is ignored by providers that do not use streams, and omitted when unset. With no host and no
sender the feature reports itself unconfigured and offers no button, rather than presenting
one that fails. The status endpoint says what is set and never what it is set to — a password
has no business leaving the process that reads it.

**Everything here is shaped by one fact: a message cannot be recalled.**

*Writing and sending are separate calls.* Compose, read it back, send it to yourself, then
release it. One endpoint that composed and delivered would make a typo permanent for a
thousand people at once. The screen puts the test above the send because that is the order it
should happen in.

*The send is guarded by a count.* The caller states how many people it expects to reach and
the server refuses if that is not the number it computes — a stale screen, a list that grew,
or a click on the wrong campaign all fail closed, having sent nothing. The desk screen makes
you type the number; the server checks it independently, so neither is load-bearing alone.

*Every recipient is recorded before the message leaves*, with `UNIQUE (campaign_id, client_id)`
and the campaign claimed out of `draft` inside a transaction. A double-click, a retry after a
crash, or two admins pressing at once cannot deliver twice. It is also the answer to "did they
get it?", which support will ask.

*One failure is one failure.* A refused address is written down with its reason and the loop
carries on, because the alternative is that client 4 of 900 decides the other 896 hear nothing.

**Consent is the client's, and lives on the client.** A weekly update is marketing however
useful it is, so it goes only to people who have not said no, and every message carries a link
that opts them out without signing in — a link that leads to a login screen is a link that
gets the message reported as spam instead. The token is random, per client and unique; it is
not the client's id, because an id in a public link is an invitation to enumerate the client
list, and it is stripped from every CRM payload because whoever holds it can act with it. An
unknown token gets the identical page a real one does, or this becomes a way to test which
tokens are live. `List-Unsubscribe` is set too, so mail clients offer their own button.

The draft is written from what the database actually holds — what opened, what is closing,
what matured. It contains no market commentary, no outlook and no suggestion about what
anybody should do with their money: this desk is simulated and the author is a program. The
desk edits every word before it goes anywhere.

**Writing to one client** is a different thing and is built as one. It sits on the client's own
record, below their open tasks, because that is where somebody is when they decide to write —
they have just read the timeline and seen the outstanding document.
`POST /clients/:id/email` · `GET /clients/:id/emails` ·
`GET|POST /admin/email-templates` · `PATCH|DELETE /admin/email-templates/:id`

There is no recipient count to confirm, because the recipient is on the screen; no unsubscribe
link, because one message from an account manager is not a list anybody joined; and the
marketing opt-out does not silence it, because somebody who declined the weekly update still
needs to hear that their document expired. Their opt-out state is shown next to the compose
box so the person writing can judge whether this particular message is one of those — a
judgement a person should make, not a filter.

Templates fill the box and then stop mattering: the text is the sender's to change, and what
is stored against the client is what was actually sent. A template edited next month must not
silently rewrite what somebody was told last month, which is also why deleting one keeps the
messages and drops only the link back. Every send lands on the client's timeline, because the
next person to pick up the account needs to see what they were told.

Tested against a real SMTP conversation rather than a mock: a local sink that speaks RFC 5321
accepts the mail, refuses one address on purpose, and the assertions are about what actually
arrived — both MIME parts, the per-recipient token, the unsubscribe round trip, and that a
second send delivers nothing.

## Uploads live in the database

Every file this application accepts — KYC documents, the profile photo, an offering's
picture — is stored as `bytea` on the row it belongs to. None of them touch the filesystem.

This is not the textbook answer, and it was not the first one here. It is the answer because
of where this runs: the container's disk is replaced on every release, so a file written at
upload is gone by the next deploy. For a profile photo that is a blank circle. For a
passport it means asking a client to send identification a second time and having no record
of what was actually reviewed. A volume would also solve it, but it is a thing that has to
be attached, stay attached, and be backed up separately — and when it is missed, nothing
fails loudly. The row cannot be forgotten, reaches every instance, and is in the database
backup already.

`/health` reports which it is, proven rather than assumed: the boot leaves a marker under
`UPLOAD_DIR` and looks for it next time. `persisted` means the disk survives restarts;
`fresh` means it did not; `ephemeral` means `UPLOAD_DIR` was never set. It is still reported
because the disk is still *read* — documents uploaded before this change live only there —
and it is the thing that says whether they are still readable. When it says `fresh`, they
are not, and asking for one returns **410 with a sentence saying so** rather than a stream
that fails halfway through the response.

The cost of a blob in a row is that a careless `SELECT *` reads it. Every query that touches
these tables names its columns instead, lists carry a boolean (`has_image`) rather than
bytes, and the acceptance run asserts that no list, upload receipt or review decision comes
back carrying a file. A ten-megabyte scan on each of a dozen rows is the failure this invites.

**Every one of these is behind the API's auth, which means no screen may point an `<img src>`
at one.** A browser sends no `Authorization` header for an image and there is no way to give
it one, so the request comes back 401. The offering cards shipped that way and the bug hid
itself perfectly: the 401 fired the `onError` fallback, the card quietly drew its own mark,
and a picture that had been uploaded looked exactly like one that never had. They are fetched
with the token and handed to the `<img>` as an object URL — `useAuthedImage` in
`web/src/authed-image.ts`, which is the profile photo's original code made shared rather than
copied a third time. Anything new that displays an uploaded file uses it.

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

## Deploying to Railway

One service runs the whole thing: the API serves the built front end from `web/dist`, so
there is a single origin, no CORS, and the WebSocket feed shares the host. The browser
always calls `/api/...` — Vite proxies that away in development, and `rewriteUrl` in
`src/server.ts` strips it in production.

1. **New project → Deploy from GitHub repo**, pointing at this repository. `railway.json`
   supplies the build and start commands; `engines.node` pins Node 22, which the API needs
   for `--experimental-strip-types`.
2. **Add the Postgres plugin** to the same project. Railway injects `DATABASE_URL`.
   Use the **internal** host it provides — traffic stays on the private network, so no TLS
   is needed. Only if you connect over the public host, set `DATABASE_SSL=require`.
3. **Set `JWT_SECRET`** to at least 32 random characters. The API refuses to sign or verify
   without it, so this is not optional:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
4. **No volume is needed.** Uploads are stored in the database, so nothing written by this
   application depends on the container filesystem. `UPLOAD_DIR` is still read, and is worth
   pointing at a volume only if you have documents from before that change that you want to
   keep reading — `/health` tells you whether they are still there.
5. **Deploy.** The start command runs `db:init` first, which creates the schema on an empty
   database and does nothing on one that already has it.
6. **Create the first staff account** once, from the Railway shell. There is no default
   admin in production on purpose:
   `node --experimental-strip-types src/seed.ts you@example.com 'a-long-password' admin`
7. **Point pntgp.xyz at it.** In Railway → service → Settings → Networking → Custom Domain,
   add `www.pntgp.xyz`. Railway shows a target ending `.up.railway.app` — copy it, it is
   specific to the service. Then at GoDaddy → Domains → pntgp.xyz → DNS → Manage Zones:

   | Type | Name | Value | TTL |
   |---|---|---|---|
   | CNAME | `www` | the `*.up.railway.app` target Railway gave you | 600 |

   Edit the existing `www` record rather than adding a second one — a new domain ships with
   `www` already pointing at GoDaddy's parking page, and two records fight.

   The apex, `pntgp.xyz` with no `www`, cannot be a CNAME: DNS forbids it at the zone apex
   and GoDaddy has no ALIAS record. DNS therefore moves to Cloudflare, which flattens a
   CNAME at the apex so the bare domain serves the app directly. The domain stays
   registered with GoDaddy; only the nameservers change.

### Moving DNS to Cloudflare

1. Add `pntgp.xyz` as a site on Cloudflare (the free plan is enough). It scans the existing
   zone first — **check what it imported before continuing**. Anything it misses stops
   working the moment the nameservers change, and mail is the usual casualty: if the domain
   has MX records, or TXT records for SPF/DKIM/domain verification, confirm each one is
   present in Cloudflare now.
2. Cloudflare gives two nameservers. At GoDaddy → Domains → pntgp.xyz → Nameservers →
   Change → "I'll use my own nameservers", enter both, save. Propagation is usually under
   an hour; Cloudflare emails you when the zone goes active.
3. In Cloudflare → DNS → Records, add both, pointing at the Railway target:

   | Type | Name | Target | Proxy |
   |---|---|---|---|
   | CNAME | `@` | the `*.up.railway.app` target | **DNS only** (grey cloud) |
   | CNAME | `www` | the same target | **DNS only** (grey cloud) |

   Delete GoDaddy's leftover parking records for `@` and `www` if the scan carried them
   over — two records for one name fight.
4. Add **both** `pntgp.xyz` and `www.pntgp.xyz` as custom domains in Railway, so it issues
   a certificate for each.
5. Leave the proxy off (grey cloud) until Railway shows both domains active with a valid
   certificate. Proxying during setup blocks Railway's certificate validation and produces
   a redirect loop instead — the failure looks like a Cloudflare error page, not a Railway
   one, which sends you hunting in the wrong place.
6. Only then, if you want Cloudflare's CDN and DDoS protection, switch the records to
   proxied (orange cloud) **and set SSL/TLS mode to Full (strict)** in the same dashboard.
   The default "Flexible" talks HTTP to the origin, which Railway redirects back to HTTPS —
   an infinite loop. WebSockets are enabled by default on the free plan, so the price feed
   keeps working when proxied.

   If you would rather not move DNS at all, the fallback is GoDaddy → Forwarding →
   `pntgp.xyz` to `https://www.pntgp.xyz`, permanent (301), **masking off** — but then the
   apex is a redirect rather than the site.

   GoDaddy's *hosting* plans (Web Hosting Basic and similar) are cPanel shared hosting and
   cannot run this: no Node runtime, no PostgreSQL, no WebSockets. Only the domain is used.

**Two things that will bite if ignored.** Uploaded KYC documents live on local disk, so
without the volume in step 4 every deploy loses them — this is the `storage_key` note in
the pre-production list, and object storage is the real answer. And `db:init` is not a
migration tool: it creates the schema once and cannot carry an existing database forward
to a changed one, so the first schema change after go-live needs real migrations.

## Before this touches production
1. Run `db:reset` against a Postgres you host and back up (`src/devdb.ts` runs a real
   server, but it is an unmanaged local cluster wiped on boot — dev only).
2. Add migration tooling — there is none, and the schema is applied by dropping it.
3. Move uploads out of the database to object storage once they are big enough to be worth
   it; `storage_key` is still the handle that would name them.
4. Set `JWT_SECRET` from a secrets manager, not the environment inline.

## What is deliberately not here
- Live money. No live code path exists; see Paper trading above.
- Margin calls, partial fills, slippage, spread, commission.
- Editable flag thresholds, PDF generation (the reports page prints), Redis, an ORM and
  migrations, per-symbol feed subscriptions.

Each is marked in the code where it would go. Styling stays plain pending the design spec.
