import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACHIEVEMENTS, type Facts, leagueFor, makeAlias, monthKey, movesFor, nextMonth, prevMonth, rankLeague, scoreOf,
} from '../src/arena.ts';

test('a client starts in the league their account size puts them in', () => {
  assert.equal(leagueFor(0), 'bronze');
  assert.equal(leagueFor(4_999), 'bronze');
  assert.equal(leagueFor(5_000), 'silver');
  assert.equal(leagueFor(76_000), 'gold');
  assert.equal(leagueFor(250_000), 'platinum');
  assert.equal(leagueFor(32_000_000), 'diamond');
});

test('the score rewards return earned with control', () => {
  assert.equal(scoreOf(0.03, 0), 300);
  assert.equal(scoreOf(0.035, 0.04), 150, 'a big losing day costs half of itself');
  assert.ok(scoreOf(0.03, 0) > scoreOf(0.035, 0.04));
  assert.equal(scoreOf(-0.01, 0), -100);
});

test('five move each way in a full league, fewer in a small one, none in a tiny one', () => {
  assert.equal(movesFor(30), 5);
  assert.equal(movesFor(10), 5);
  assert.equal(movesFor(8), 2);
  assert.equal(movesFor(3), 0);
});

test('ranking is stable and the ends of the ladder do not move off it', () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ client_id: `c${String(i).padStart(2, '0')}`, score: 100 - i * 10, ret: 0.01 }));
  const gold = rankLeague('gold', rows);
  assert.deepEqual(gold.slice(0, 5).map((r) => r.move), ['up', 'up', 'up', 'up', 'up']);
  assert.deepEqual(gold.slice(-5).map((r) => r.move), ['down', 'down', 'down', 'down', 'down']);
  assert.equal(gold[5]!.move, 'stay');
  assert.ok(rankLeague('diamond', rows).every((r) => r.move !== 'up'));
  assert.ok(rankLeague('bronze', rows).every((r) => r.move !== 'down'));
  const tie = rankLeague('gold', [{ client_id: 'b', score: 5, ret: 0.01 }, { client_id: 'a', score: 5, ret: 0.02 }]);
  assert.equal(tie[0]!.client_id, 'a', 'a tie goes to the higher return');
});

test('aliases and months', () => {
  assert.match(makeAlias(() => 0.5), /^[A-Z][a-z]+ \d{4}$/);
  assert.equal(monthKey(new Date('2026-10-29T12:00:00Z')), '2026-10');
  assert.equal(nextMonth('2026-12'), '2027-01');
  assert.equal(prevMonth('2026-01'), '2025-12');
});

test('no achievement can be earned by trading more', () => {
  const none: Facts = {
    kyc: 'none', profileFields: 0, stakesEver: 0, longestActiveStakeDays: 0, potsEver: 0, oldestFundedPotDays: 0,
    iposEver: 0, activeStake: false, fundedPot: false, activeIpo: false, autoTrader: false, walletsLinked: 0, daysAsClient: 0,
  };
  assert.ok(!Object.keys(none).some((k) => /trade|order|volume/i.test(k) && k !== 'autoTrader'), 'no trade counts in the facts');
  for (const a of ACHIEVEMENTS.filter((x) => x.check)) assert.equal(a.check!(none).done, false, a.code);
  const diversified = ACHIEVEMENTS.find((a) => a.code === 'diversified')!.check!;
  assert.deepEqual(diversified({ ...none, activeStake: true, fundedPot: true, activeIpo: true }), { done: false, have: 3, need: 4 });
});
