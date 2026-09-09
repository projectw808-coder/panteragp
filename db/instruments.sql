-- Tradable instruments. Kept out of schema.sql because reference data has to reach
-- databases that already exist: db:init runs this on every deploy, and the upsert below
-- makes that safe to repeat. Adding a pair is a line here plus a base price in
-- src/market.ts — an instrument with no price would list but never quote.
--
-- tick_size is the smallest price increment, lot_size the contract multiple. FX trades in
-- 100k lots; metals in their own contract sizes; ETFs and crypto in units of one.

-- asset_class groups the list in the UI. Added here rather than in schema.sql so that
-- databases created before it existed pick it up on their next deploy.
ALTER TABLE instruments ADD COLUMN IF NOT EXISTS asset_class text;

INSERT INTO instruments (symbol, display_name, asset_class, tick_size, lot_size) VALUES
  -- Foreign exchange -------------------------------------------------------------
  ('EURUSD','Euro / US Dollar',              'fx', 0.00001, 100000),
  ('GBPUSD','Pound / US Dollar',             'fx', 0.00001, 100000),
  ('USDJPY','US Dollar / Yen',               'fx', 0.001,   100000),
  ('AUDUSD','Australian Dollar / US Dollar', 'fx', 0.00001, 100000),
  ('USDCAD','US Dollar / Canadian Dollar',   'fx', 0.00001, 100000),
  ('USDCHF','US Dollar / Swiss Franc',       'fx', 0.00001, 100000),
  ('NZDUSD','New Zealand Dollar / US Dollar','fx', 0.00001, 100000),
  ('EURGBP','Euro / Pound',                  'fx', 0.00001, 100000),

  -- Metals -----------------------------------------------------------------------
  ('XAUUSD','Gold / US Dollar',              'metals', 0.01,  100),
  ('XAGUSD','Silver / US Dollar',            'metals', 0.001, 5000),

  -- Crypto — majors --------------------------------------------------------------
  ('BTCUSD','Bitcoin / US Dollar',           'crypto', 0.01,    1),
  ('ETHUSD','Ethereum / US Dollar',          'crypto', 0.01,    1),
  ('BNBUSD','BNB / US Dollar',               'crypto', 0.01,    1),
  ('SOLUSD','Solana / US Dollar',            'crypto', 0.01,    1),
  ('XRPUSD','XRP / US Dollar',               'crypto', 0.0001,  1),
  ('ADAUSD','Cardano / US Dollar',           'crypto', 0.0001,  1),
  ('DOGEUSD','Dogecoin / US Dollar',         'crypto', 0.00001, 1),
  ('TRXUSD','TRON / US Dollar',              'crypto', 0.00001, 1),
  ('TONUSD','Toncoin / US Dollar',           'crypto', 0.001,   1),
  ('LTCUSD','Litecoin / US Dollar',          'crypto', 0.01,    1),
  ('BCHUSD','Bitcoin Cash / US Dollar',      'crypto', 0.01,    1),
  ('ETCUSD','Ethereum Classic / US Dollar',  'crypto', 0.001,   1),
  ('XLMUSD','Stellar / US Dollar',           'crypto', 0.00001, 1),
  ('HBARUSD','Hedera / US Dollar',           'crypto', 0.00001, 1),
  -- No XMRUSD pair: XMR is seeded in schema.sql as a holding with no price source,
  -- which is what proves the 'cannot value this' guard. Giving it a pair would remove
  -- the only asset that exercises it.
  ('ZECUSD','Zcash / US Dollar',             'crypto', 0.01,    1),
  ('DASHUSD','Dash / US Dollar',             'crypto', 0.01,    1),
  ('XTZUSD','Tezos / US Dollar',             'crypto', 0.001,   1),
  ('EOSUSD','EOS / US Dollar',               'crypto', 0.0001,  1),
  ('ALGOUSD','Algorand / US Dollar',         'crypto', 0.0001,  1),
  ('VETUSD','VeChain / US Dollar',           'crypto', 0.00001, 1),

  -- Crypto — smart contract platforms --------------------------------------------
  ('AVAXUSD','Avalanche / US Dollar',        'crypto', 0.01,    1),
  ('DOTUSD','Polkadot / US Dollar',          'crypto', 0.001,   1),
  ('POLUSD','Polygon / US Dollar',           'crypto', 0.0001,  1),
  ('NEARUSD','NEAR Protocol / US Dollar',    'crypto', 0.001,   1),
  ('APTUSD','Aptos / US Dollar',             'crypto', 0.001,   1),
  ('SUIUSD','Sui / US Dollar',               'crypto', 0.0001,  1),
  ('SEIUSD','Sei / US Dollar',               'crypto', 0.0001,  1),
  ('TIAUSD','Celestia / US Dollar',          'crypto', 0.001,   1),
  ('ATOMUSD','Cosmos / US Dollar',           'crypto', 0.001,   1),
  ('EGLDUSD','MultiversX / US Dollar',       'crypto', 0.01,    1),
  ('KASUSD','Kaspa / US Dollar',             'crypto', 0.00001, 1),
  ('STXUSD','Stacks / US Dollar',            'crypto', 0.0001,  1),
  ('MINAUSD','Mina / US Dollar',             'crypto', 0.0001,  1),
  ('FLOWUSD','Flow / US Dollar',             'crypto', 0.0001,  1),
  ('ICPUSD','Internet Computer / US Dollar', 'crypto', 0.001,   1),

  -- Crypto — layer 2 ---------------------------------------------------------------
  ('ARBUSD','Arbitrum / US Dollar',          'crypto', 0.0001,  1),
  ('OPUSD','Optimism / US Dollar',           'crypto', 0.0001,  1),
  ('IMXUSD','Immutable / US Dollar',         'crypto', 0.0001,  1),

  -- Crypto — DeFi ------------------------------------------------------------------
  ('UNIUSD','Uniswap / US Dollar',           'crypto', 0.001,   1),
  ('AAVEUSD','Aave / US Dollar',             'crypto', 0.01,    1),
  ('LINKUSD','Chainlink / US Dollar',        'crypto', 0.001,   1),
  ('MKRUSD','Maker / US Dollar',             'crypto', 0.01,    1),
  ('LDOUSD','Lido DAO / US Dollar',          'crypto', 0.0001,  1),
  ('CRVUSD','Curve DAO / US Dollar',         'crypto', 0.0001,  1),
  ('SNXUSD','Synthetix / US Dollar',         'crypto', 0.001,   1),
  ('COMPUSD','Compound / US Dollar',         'crypto', 0.01,    1),
  ('INJUSD','Injective / US Dollar',         'crypto', 0.001,   1),
  ('RUNEUSD','THORChain / US Dollar',        'crypto', 0.001,   1),
  ('DYDXUSD','dYdX / US Dollar',             'crypto', 0.0001,  1),
  ('JUPUSD','Jupiter / US Dollar',           'crypto', 0.0001,  1),
  ('PYTHUSD','Pyth Network / US Dollar',     'crypto', 0.0001,  1),
  ('GRTUSD','The Graph / US Dollar',         'crypto', 0.00001, 1),

  -- Crypto — infrastructure and AI --------------------------------------------------
  ('FILUSD','Filecoin / US Dollar',          'crypto', 0.001,   1),
  ('RNDRUSD','Render / US Dollar',           'crypto', 0.001,   1),
  ('FETUSD','Artificial Superintelligence / US Dollar', 'crypto', 0.0001, 1),
  ('THETAUSD','Theta Network / US Dollar',   'crypto', 0.0001,  1),
  ('ARUSD','Arweave / US Dollar',            'crypto', 0.001,   1),

  -- Crypto — gaming and metaverse ---------------------------------------------------
  ('SANDUSD','The Sandbox / US Dollar',      'crypto', 0.0001,  1),
  ('MANAUSD','Decentraland / US Dollar',     'crypto', 0.0001,  1),
  ('AXSUSD','Axie Infinity / US Dollar',     'crypto', 0.001,   1),
  ('GALAUSD','Gala / US Dollar',             'crypto', 0.00001, 1),
  ('CHZUSD','Chiliz / US Dollar',            'crypto', 0.00001, 1),
  ('ENSUSD','Ethereum Name Service / US Dollar', 'crypto', 0.001, 1),
  ('CAKEUSD','PancakeSwap / US Dollar',      'crypto', 0.0001,  1),

  -- Crypto — meme -------------------------------------------------------------------
  ('SHIBUSD','Shiba Inu / US Dollar',        'crypto', 0.00000001, 1),
  ('PEPEUSD','Pepe / US Dollar',             'crypto', 0.00000001, 1),
  ('WIFUSD','dogwifhat / US Dollar',         'crypto', 0.0001,  1),
  ('BONKUSD','Bonk / US Dollar',             'crypto', 0.00000001, 1),
  ('FLOKIUSD','Floki / US Dollar',           'crypto', 0.00000001, 1),

  -- ETFs — broad market ----------------------------------------------------------
  ('SPY','SPDR S&P 500 ETF',                 'etf', 0.01, 1),
  ('QQQ','Invesco QQQ Trust',                'etf', 0.01, 1),
  ('DIA','SPDR Dow Jones Industrial Average','etf', 0.01, 1),
  ('IWM','iShares Russell 2000 ETF',         'etf', 0.01, 1),
  ('VTI','Vanguard Total Stock Market ETF',  'etf', 0.01, 1),
  ('VOO','Vanguard S&P 500 ETF',             'etf', 0.01, 1),

  -- ETFs — international ---------------------------------------------------------
  ('EEM','iShares MSCI Emerging Markets ETF','etf', 0.01, 1),
  ('EFA','iShares MSCI EAFE ETF',            'etf', 0.01, 1),
  ('FXI','iShares China Large-Cap ETF',      'etf', 0.01, 1),

  -- ETFs — sector ----------------------------------------------------------------
  ('XLF','Financial Select Sector SPDR',     'etf', 0.01, 1),
  ('XLK','Technology Select Sector SPDR',    'etf', 0.01, 1),
  ('XLE','Energy Select Sector SPDR',        'etf', 0.01, 1),
  ('SMH','VanEck Semiconductor ETF',         'etf', 0.01, 1),
  ('ARKK','ARK Innovation ETF',              'etf', 0.01, 1),

  -- ETFs — commodity and fixed income --------------------------------------------
  ('GLD','SPDR Gold Shares',                 'etf', 0.01, 1),
  ('SLV','iShares Silver Trust',             'etf', 0.01, 1),
  ('USO','United States Oil Fund',           'etf', 0.01, 1),
  ('TLT','iShares 20+ Year Treasury Bond',   'etf', 0.01, 1),
  ('HYG','iShares High Yield Corporate Bond','etf', 0.01, 1),

  -- ETFs — digital asset ---------------------------------------------------------
  ('IBIT','iShares Bitcoin Trust',           'etf', 0.01, 1),
  ('FBTC','Fidelity Wise Origin Bitcoin Fund','etf', 0.01, 1),
  ('ETHA','iShares Ethereum Trust',          'etf', 0.01, 1)
-- Existing rows predate asset_class, so set it rather than skipping them. Everything else
-- is left alone: a symbol's tick size is not something a redeploy should quietly change.
ON CONFLICT (symbol) DO UPDATE SET asset_class = EXCLUDED.asset_class;
