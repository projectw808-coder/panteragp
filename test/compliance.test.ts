import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { RULES, toCSV, volumeFlags, withdrawalFlags } from '../src/compliance.ts';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const rules = (fs: { rule: string }[]) => fs.map((f) => f.rule).sort();

describe('withdrawal flags', () => {
  const approved = { kycStatus: 'approved', recentDeposits: [] };

  test('a small withdrawal from an approved client raises nothing', () => {
    assert.deepEqual(withdrawalFlags({ amount: 500, ...approved }), []);
  });

  test('escalates with size', () => {
    assert.deepEqual(withdrawalFlags({ amount: 9_999, ...approved }), []);
    const medium = withdrawalFlags({ amount: RULES.largeWithdrawal, ...approved });
    assert.equal(medium[0]!.severity, 'medium');
    const high = withdrawalFlags({ amount: RULES.hugeWithdrawal, ...approved });
    assert.equal(high[0]!.severity, 'high');
    assert.equal(high.length, 1, 'one large_withdrawal flag, not two');
  });

  test('flags any withdrawal before KYC is approved', () => {
    for (const kycStatus of ['none', 'pending', 'rejected', 'expired']) {
      assert.deepEqual(rules(withdrawalFlags({ amount: 10, kycStatus, recentDeposits: [] })),
        ['withdrawal_without_kyc'], `kyc ${kycStatus} should flag`);
    }
  });

  test('flags money that arrives and leaves again within a day', () => {
    const f = withdrawalFlags({
      amount: 9_000, ...approved,
      recentDeposits: [{ amount: 10_000, at: hoursAgo(3) }],
    });
    assert.deepEqual(rules(f), ['rapid_withdrawal_after_deposit']);
    assert.equal(f[0]!.severity, 'high');
  });

  test('does not flag a return that is old, or only a small slice of the deposit', () => {
    assert.deepEqual(withdrawalFlags({
      amount: 9_000, ...approved, recentDeposits: [{ amount: 10_000, at: hoursAgo(30) }],
    }), [], 'outside the 24h window');
    assert.deepEqual(withdrawalFlags({
      amount: 1_000, ...approved, recentDeposits: [{ amount: 10_000, at: hoursAgo(1) }],
    }), [], 'only 10% of the deposit');
  });

  test('stacks every rule that applies', () => {
    const f = withdrawalFlags({
      amount: 60_000, kycStatus: 'pending',
      recentDeposits: [{ amount: 60_000, at: hoursAgo(2) }],
    });
    assert.deepEqual(rules(f),
      ['large_withdrawal', 'rapid_withdrawal_after_deposit', 'withdrawal_without_kyc']);
  });
});

describe('volume flags', () => {
  test('ignores small accounts however spiky', () => {
    assert.deepEqual(volumeFlags({ today: 5_000, avgDaily: 10 }), []);
  });

  test('ignores a busy day that is normal for this client', () => {
    assert.deepEqual(volumeFlags({ today: 100_000, avgDaily: 90_000 }), []);
  });

  test('flags a real spike, harder when it is extreme', () => {
    const medium = volumeFlags({ today: 100_000, avgDaily: 15_000 });
    assert.equal(medium[0]!.rule, 'volume_spike');
    assert.equal(medium[0]!.severity, 'medium');
    assert.equal(volumeFlags({ today: 200_000, avgDaily: 15_000 })[0]!.severity, 'high');
  });

  test('a client with no history is not divided by zero', () => {
    assert.deepEqual(volumeFlags({ today: 100_000, avgDaily: 0 }), []);
  });

  test('falls back to an absolute threshold when there is no baseline', () => {
    // A brand new account trading heavily on day one has no average to be 5x of.
    const f = volumeFlags({ today: RULES.noBaselineVolume, avgDaily: 0 });
    assert.deepEqual(f.map((x) => x.rule), ['volume_no_baseline']);
    assert.deepEqual(volumeFlags({ today: RULES.noBaselineVolume - 1, avgDaily: 0 }), []);
  });
});

describe('toCSV', () => {
  test('writes a header and rows', () => {
    assert.equal(toCSV([{ a: 1, b: 'x' }, { a: 2, b: 'y' }]), 'a,b\r\n1,x\r\n2,y');
  });

  test('quotes commas, quotes and newlines', () => {
    assert.equal(toCSV([{ note: 'a,b' }]), 'note\r\n"a,b"');
    assert.equal(toCSV([{ note: 'say "hi"' }]), 'note\r\n"say ""hi"""');
    assert.equal(toCSV([{ note: 'one\ntwo' }]), 'note\r\n"one\ntwo"');
  });

  test('defuses spreadsheet formulas in client-supplied text', () => {
    // A client named =cmd|'/c calc'!A1 must not execute when compliance opens the export.
    assert.equal(toCSV([{ name: '=1+1' }]), "name\r\n'=1+1");
    assert.equal(toCSV([{ name: '@SUM(A1)' }]), "name\r\n'@SUM(A1)");
    assert.equal(toCSV([{ name: '-2+3' }]), "name\r\n'-2+3");
    assert.ok(toCSV([{ name: '=HYPERLINK("http://evil","x")' }]).includes("'=HYPERLINK"));
  });

  test('renders empties and dates predictably', () => {
    assert.equal(toCSV([{ a: null, b: undefined, c: new Date('2026-01-02T03:04:05Z') }]),
      'a,b,c\r\n,,2026-01-02T03:04:05.000Z');
  });

  test('honours an explicit column order and ignores extra keys', () => {
    assert.equal(toCSV([{ a: 1, b: 2, c: 3 }], ['c', 'a']), 'c,a\r\n3,1');
  });
});
