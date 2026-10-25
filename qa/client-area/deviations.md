# Client area against the Pixel-Fidelity Developer Kit (25 October 2026)

Built into the existing platform, so every figure is the signed-in account's real data. That is
the main reason for the deliberate deviations below. Screenshots in this folder were taken from
the local build at a 1440×900 viewport (stored at 800×500) and one at 390×844. They show the
local test account, whose figures are test data.

## Matched
- Shared frame: slim near-black icon rail with the Y mark, `Pantera GP ///` and `TRADING DESK`,
  orange-brown active row, orange-framed box at the foot. The 52px top bar carries live BTC, ETH
  and XAU, the bell, and an avatar with the person's name and a menu (Profile, Settings, theme, Sign out).
- Kit tokens: Inter, #080d10 ground, #0b1115 panels, #222a2e hairlines, #ff7518 / #18d889 /
  #ff4b4d, 10px cards, tabular numerals.
- Overview: Total Equity module with range pills and area chart, 2×2 tiles (Available Cash,
  Open P&L, Margin Used, Active Positions long/short), four quote cards, Portfolio Allocation
  donut with legend, Performance bar chart.
- Charts: timeframe and indicators toolbar with 1/2/4 layouts, four candle panels with volume and
  live headers, watchlist on the right with search and class pills.
- Auto Trader: title, RUNNING, ON switch, Stop All, six KPI tiles, strategies, bot equity chart,
  open positions, risk controls (and the engine log beneath).
- Portfolios: Create Pot, summary strip, pot rows with orange icon, Deposit / Withdraw /
  Show on balance / History, Earned and Balance, orange sparkline from the pot's own history.
- Staking: three KPIs, stake cards side by side with coin icon or term ring, Unstake.
- IPO Offerings: LIVE badge, segmented tabs, three cards across with the picture zone.
- Clients (staff only): Add Client, four KPI tiles, search with icon and filters, avatars,
  status chips, Manager and Joined columns.
- Documents, Support, Settings, Wallet and Profile use the same frame, headings and cards.
- No horizontal overflow at 390px on any client page.

## Deliberate deviations
- **No DEMO badges or "Demo mode" box.** The kit labels its illustrative data; here the data is
  each client's real account, so a DEMO label would be false. The rail's foot box shows the
  account number and verification state instead.
- **No rates on client staking and portfolio cards** (the kit shows APY badges). Rates were taken
  off client screens by decision on 17 September 2026; stake cards show Flexible / Locked.
- **IPO tabs are Upcoming / Running / Finished**, the platform's real groups, not Upcoming / Filed /
  Listed. Offerings, names and pictures are the desk's own, managed as before.
- **Clients KPIs**: Active means the client can sign in, Inactive means no login yet, Pending KYC
  is awaiting verification. There is no Portfolio Value column: holdings are fetched per row when
  it is opened, not for the whole list.
- **The balance strip is gone** as in the kit. A pot pinned with "Show on balance" now has no
  strip to appear on.
- **Overview chart** shows what the account has earned over the range (realised results, interest,
  rewards); the platform keeps no daily equity valuation to draw an equity curve from.
- Microtext and exact chart paths are not recoverable from the raster references.
