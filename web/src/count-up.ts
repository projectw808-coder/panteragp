import { useEffect, useRef, useState } from 'react';

/**
 * A figure that counts up to its value the first time it arrives.
 *
 * Two rules, and both are about not lying to the reader rather than about taste:
 *
 * It runs once. The figures on these screens refresh on a timer, and a balance that
 * re-animates every fifteen seconds is a balance nobody can read — you look down, it is
 * mid-flight, you look again, it is mid-flight. So the first real value animates and every
 * value after it is simply set.
 *
 * It is short. An intermediate frame of a count-up is a number that is not the balance, and
 * the only reason that is acceptable is that nobody reads it as one — the same way nobody
 * reads a progress bar as a measurement. Keeping it under a second is what holds that true.
 * Under prefers-reduced-motion it does not run at all.
 */

/** Fast out of the gate, long settle. The curve the rest of the system eases on. */
export const easeOutExpo = (t: number): number =>
  t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);

/** Where the figure sits at progress t. Pure, so the arithmetic can be checked. */
export const frameValue = (from: number, to: number, t: number): number =>
  from + (to - from) * easeOutExpo(Math.min(Math.max(t, 0), 1));

const still = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export function useCountUp(value: number | null, duration = 700): number | null {
  const [shown, setShown] = useState<number | null>(null);
  // Whether this figure has already had its one run. Survives re-renders, and is per
  // mounted figure rather than global, so a newly revealed panel still gets its entrance.
  const ran = useRef(false);
  const frame = useRef(0);

  useEffect(() => {
    if (value === null) return;
    if (ran.current || still()) { setShown(value); return; }

    ran.current = true;
    const from = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const t = (now - start) / duration;
      if (t >= 1) { setShown(value); return; }
      setShown(frameValue(from, value, t));
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(frame.current);
  }, [value, duration]);

  return shown;
}
