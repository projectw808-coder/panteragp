import { useEffect, useState } from 'react';

/**
 * Copy something to the clipboard, and say so.
 *
 * Silent success is the failure mode that matters here: a button that looks the same
 * before and after leaves the reader pressing it again and wondering, then pasting to find
 * out. So the label reports what happened and goes back on its own.
 *
 * It can also genuinely fail. The clipboard API needs a secure context, so it is there over
 * https and on localhost and missing anywhere else — and the browser can refuse the write.
 * Both are told rather than swallowed, because a client list quietly not copying is worse
 * than one that says it did not.
 */
export function CopyButton({ text, label = 'Copy', done = 'Copied', title, className = '' }: {
  text: string;
  label?: string;
  done?: string;
  title?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');

  // Back to idle on its own. Cleared on unmount so a row that closes mid-countdown does
  // not set state on a component that is gone.
  useEffect(() => {
    if (state === 'idle') return;
    const id = setTimeout(() => setState('idle'), 1600);
    return () => clearTimeout(id);
  }, [state]);

  async function copy(e: React.MouseEvent) {
    // Rows unfold when clicked, so copying from inside one must not also open it.
    e.stopPropagation();
    e.preventDefault();
    try {
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      setState('failed');
    }
  }

  return (
    <button type="button" onClick={copy} disabled={!text}
      title={state === 'failed' ? 'The browser refused the clipboard' : title ?? `Copy ${text}`}
      className={`rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase transition-colors disabled:opacity-40 ${
        state === 'done' ? 'border-ember text-ember-ink'
          : state === 'failed' ? 'border-down text-down'
          : 'border-pebble text-slate-ink hover:border-ember/50 hover:text-obsidian dark:border-white/10 dark:hover:text-vellum'
      } ${className}`}>
      {state === 'done' ? done : state === 'failed' ? 'Failed' : label}
    </button>
  );
}
