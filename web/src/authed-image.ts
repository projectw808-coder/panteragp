import { useEffect, useState } from 'react';
import { token } from './api.ts';

/**
 * An image that lives behind the API's auth.
 *
 * A browser's `<img src="/api/…">` sends no Authorization header — there is no way to give
 * it one — so pointing one at an authenticated route gets a 401 and renders as a broken
 * image, or, if the component has a fallback, as nothing at all. That is exactly how this
 * went unnoticed on the offering cards: the 401 fired `onError`, the card quietly showed its
 * drawn mark, and an uploaded picture looked like a picture that had never been uploaded.
 *
 * So it is fetched like any other authenticated request and handed to the `<img>` as an
 * object URL. The same shape the profile photo already used; this is that code, made shared
 * rather than copied a third time.
 *
 * `key` is any value that changes when the picture does — `image_key` for an offering,
 * `avatar_key` for a client. It is what makes this refetch after an upload; without it the
 * effect would not re-run and the old picture would stay on screen.
 *
 * It must also be IN `path`, as a query parameter. Re-running the effect is not enough on
 * its own: the response carries `max-age`, so a refetch of the same URL is answered from the
 * browser's cache with the picture that was just replaced. That shipped — a replaced picture
 * kept showing the old one for a day, which reads exactly like an upload that did not work.
 * The key in the URL is what makes it a different request.
 */
export function useAuthedImage(path: string | null, key: string | null | undefined) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!path || !key) { setSrc(null); setFailed(false); return; }
    let url: string | null = null;
    let dropped = false;
    setFailed(false);

    fetch(path, { headers: { authorization: `Bearer ${token.get()}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (dropped) return;
        url = URL.createObjectURL(b);
        setSrc(url);
      })
      .catch(() => { if (!dropped) { setSrc(null); setFailed(true); } });

    // Revoked on the way out, or every change leaks the one before it.
    return () => { dropped = true; if (url) URL.revokeObjectURL(url); };
  }, [path, key]);

  return { src, failed };
}
