import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoShowcase, DEMO_START, DEMO_SINCE } from '../src/showcase-demo.ts';

const NOW = DEMO_SINCE + 30 * 86_400_000 + 9 * 3_600_000;

test('the demo record is labelled as a demo and is repeatable', () => {
  const a = demoShowcase(NOW);
  assert.equal(a.demo, true);
  assert.equal(a.configured, true);
  const b = demoShowcase(NOW + 25_000);
  assert.ok(b.kpis.total_trades >= a.kpis.total_trades, 'the record only grows');
  assert.deepEqual(demoShowcase(NOW).kpis, demoShowcase(NOW).kpis);
});

test('every demo trade adds up from its own side, prices and result', () => {
  const d = demoShowcase(NOW);
  assert.equal(d.trades.length, 5);
  for (const t of d.trades) {
    const moved = t.side === 'long' ? t.exit - t.entry : t.entry - t.exit;
    assert.equal(Math.sign(moved), Math.sign(t.net), `${t.symbol} ${t.side}: a win moves its way, a loss against it`);
    assert.ok(Date.parse(t.closed_at) <= NOW, 'nothing closes in the future');
  }
});

test('the demo figures stay in a believable range over time', () => {
  for (const days of [30, 90, 365]) {
    const k = demoShowcase(DEMO_SINCE + days * 86_400_000).kpis;
    assert.ok(k.win_rate! > 0.45 && k.win_rate! < 0.7, `win rate ${k.win_rate} at day ${days}`);
    assert.ok(k.max_drawdown < 0.15, `drawdown ${k.max_drawdown} at day ${days}`);
    assert.ok(k.equity > DEMO_START * 0.9, `equity ${k.equity} at day ${days}`);
    assert.ok(k.profit_factor! > 1 && k.profit_factor! < 2, `profit factor ${k.profit_factor} at day ${days}`);
  }
});

test('the demo record grows over time', () => {
  const D = 86_400_000;
  const at = (days: number) => demoShowcase(NOW + days * D).kpis.equity;
  assert.ok(at(30) > at(0), 'a month on it stands higher');
  assert.ok(at(90) > at(30), 'and higher again after three');
  assert.ok(at(90) < at(0) * 1.6, 'at a believable pace');
});
