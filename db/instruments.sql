-- Tradable instruments. Kept out of schema.sql because reference data has to reach
-- databases that already exist: db:init runs this on every deploy, and ON CONFLICT makes
-- that safe to repeat. Adding a pair is a line here plus a base price in src/market.ts —
-- an instrument with no price would list but never quote.
--
-- tick_size is the smallest price increment, lot_size the contract multiple. FX trades in
-- 100k lots; equities, ETFs and crypto in units of one.

INSERT INTO instruments (symbol, display_name, tick_size, lot_size) VALUES
  -- Foreign exchange -------------------------------------------------------------
  ('EURUSD','Euro / US Dollar',              0.00001, 100000),
  ('GBPUSD','Pound / US Dollar',             0.00001, 100000),
  ('USDJPY','US Dollar / Yen',               0.001,   100000),
  ('AUDUSD','Australian Dollar / US Dollar', 0.00001, 100000),
  ('USDCAD','US Dollar / Canadian Dollar',   0.00001, 100000),
  ('USDCHF','US Dollar / Swiss Franc',       0.00001, 100000),
  ('NZDUSD','New Zealand Dollar / US Dollar',0.00001, 100000),
  ('EURGBP','Euro / Pound',                  0.00001, 100000),

  -- Metals -----------------------------------------------------------------------
  ('XAUUSD','Gold / US Dollar',              0.01,    100),
  ('XAGUSD','Silver / US Dollar',            0.001,   5000),

  -- Crypto -----------------------------------------------------------------------
  ('BTCUSD','Bitcoin / US Dollar',           0.01,    1),
  ('ETHUSD','Ethereum / US Dollar',          0.01,    1),
  ('SOLUSD','Solana / US Dollar',            0.01,    1),
  ('XRPUSD','XRP / US Dollar',               0.0001,  1),
  ('ADAUSD','Cardano / US Dollar',           0.0001,  1),
  ('DOGEUSD','Dogecoin / US Dollar',         0.00001, 1),
  ('AVAXUSD','Avalanche / US Dollar',        0.01,    1),
  ('DOTUSD','Polkadot / US Dollar',          0.001,   1),
  ('LINKUSD','Chainlink / US Dollar',        0.001,   1),
  ('POLUSD','Polygon / US Dollar',           0.0001,  1),
  ('LTCUSD','Litecoin / US Dollar',          0.01,    1),
  ('BCHUSD','Bitcoin Cash / US Dollar',      0.01,    1),
  ('ATOMUSD','Cosmos / US Dollar',           0.001,   1),
  ('UNIUSD','Uniswap / US Dollar',           0.001,   1),
  ('AAVEUSD','Aave / US Dollar',             0.01,    1),
  ('ARBUSD','Arbitrum / US Dollar',          0.0001,  1),
  ('OPUSD','Optimism / US Dollar',           0.0001,  1),
  ('NEARUSD','NEAR Protocol / US Dollar',    0.001,   1),
  ('APTUSD','Aptos / US Dollar',             0.001,   1),
  ('SUIUSD','Sui / US Dollar',               0.0001,  1),
  ('TONUSD','Toncoin / US Dollar',           0.001,   1),
  ('TRXUSD','TRON / US Dollar',              0.00001, 1),
  ('XLMUSD','Stellar / US Dollar',           0.00001, 1),
  ('FILUSD','Filecoin / US Dollar',          0.001,   1),
  ('ICPUSD','Internet Computer / US Dollar', 0.001,   1),
  ('INJUSD','Injective / US Dollar',         0.001,   1),
  ('ETCUSD','Ethereum Classic / US Dollar',  0.001,   1),
  ('BNBUSD','BNB / US Dollar',               0.01,    1),
  ('SHIBUSD','Shiba Inu / US Dollar',        0.00000001, 1),
  ('PEPEUSD','Pepe / US Dollar',             0.00000001, 1),

  -- ETFs — broad market ----------------------------------------------------------
  ('SPY','SPDR S&P 500 ETF',                 0.01,    1),
  ('QQQ','Invesco QQQ Trust',                0.01,    1),
  ('DIA','SPDR Dow Jones Industrial Average',0.01,    1),
  ('IWM','iShares Russell 2000 ETF',         0.01,    1),
  ('VTI','Vanguard Total Stock Market ETF',  0.01,    1),
  ('VOO','Vanguard S&P 500 ETF',             0.01,    1),

  -- ETFs — international ---------------------------------------------------------
  ('EEM','iShares MSCI Emerging Markets ETF',0.01,    1),
  ('EFA','iShares MSCI EAFE ETF',            0.01,    1),
  ('FXI','iShares China Large-Cap ETF',      0.01,    1),

  -- ETFs — sector ----------------------------------------------------------------
  ('XLF','Financial Select Sector SPDR',     0.01,    1),
  ('XLK','Technology Select Sector SPDR',    0.01,    1),
  ('XLE','Energy Select Sector SPDR',        0.01,    1),
  ('SMH','VanEck Semiconductor ETF',         0.01,    1),
  ('ARKK','ARK Innovation ETF',              0.01,    1),

  -- ETFs — commodity and fixed income --------------------------------------------
  ('GLD','SPDR Gold Shares',                 0.01,    1),
  ('SLV','iShares Silver Trust',             0.01,    1),
  ('USO','United States Oil Fund',           0.01,    1),
  ('TLT','iShares 20+ Year Treasury Bond',   0.01,    1),
  ('HYG','iShares High Yield Corporate Bond',0.01,    1),

  -- ETFs — digital asset ---------------------------------------------------------
  ('IBIT','iShares Bitcoin Trust',           0.01,    1),
  ('FBTC','Fidelity Wise Origin Bitcoin Fund',0.01,   1),
  ('ETHA','iShares Ethereum Trust',          0.01,    1)
ON CONFLICT (symbol) DO NOTHING;
