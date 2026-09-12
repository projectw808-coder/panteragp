import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { easeOutExpo, frameValue } from '../web/src/count-up.ts';

/**
 * The hook itself needs a DOM to test; its arithmetic does not, and the arithmetic is where
 * a counting figure goes wrong — overshooting past the value, or never quite reaching it and
 * leaving somebody's balance a penny short on screen.
 */

describe('the easing curve', () => {
  it('starts at nothing and ends at everything', () => {
    assert.equal(easeOutExpo(0), 0);
    assert.equal(easeOutExpo(1), 1);
  });

  it('never overshoots, and never goes backwards', () => {
    let previous = -1;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const v = easeOutExpo(t);
      assert.ok(v >= previous, `went backwards at t=${t}`);
      assert.ok(v <= 1, `overshot at t=${t}: ${v}`);
      previous = v;
    }
  });

  it('is front-loaded — most of the distance is covered early', () => {
    // The point of this curve: it should look like it is arriving, not like it is counting.
    assert.ok(easeOutExpo(0.5) > 0.9, `half-way should be most of the way, was ${easeOutExpo(0.5)}`);
  });
});

describe('the figure on screen', () => {
  it('lands exactly on the value, not near it', () => {
    // A balance that settles at 1249.9997 is a bug somebody will screenshot.
    assert.equal(frameValue(0, 1250, 1), 1250);
    assert.equal(frameValue(0, 0, 1), 0);
  });

  it('clamps, so a late frame cannot run past the value', () => {
    assert.equal(frameValue(0, 500, 1.4), 500);
    assert.equal(frameValue(0, 500, -0.2), 0);
  });

  it('counts down as happily as up, for a figure that is negative', () => {
    // Open P&L is regularly below zero, and it should approach from zero, not from -∞.
    const mid = frameValue(0, -300, 0.5);
    assert.ok(mid < 0 && mid > -300, `midpoint out of range: ${mid}`);
    assert.equal(frameValue(0, -300, 1), -300);
  });

  it('stays within the span at every step', () => {
    for (let t = 0; t <= 1; t += 0.02) {
      const v = frameValue(0, 9_999.99, t);
      assert.ok(v >= 0 && v <= 9_999.99, `left the span at t=${t}: ${v}`);
    }
  });
});
