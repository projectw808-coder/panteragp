import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Sending mail to clients.
 *
 * Kept apart from the routes because the risky part of email is not the HTTP: it is that a
 * message, once handed to a server, cannot be recalled, and that a loop over a client list
 * is a loop over real people's inboxes. Everything here is built so the mistakes that are
 * cheap in the app are also cheap here.
 *
 * Two ways out, chosen by what is set:
 *
 *   POSTMARK_SERVER_TOKEN  → Postmark's HTTPS API. Preferred when present, because the host
 *                            this runs on may not allow outbound SMTP at all: Railway blocks
 *                            ports 25, 465 and 587 below its Pro plan, and a blocked port does
 *                            not refuse, it hangs. HTTPS is never blocked.
 *   SMTP_HOST              → any SMTP server, over STARTTLS or implicit TLS.
 *
 * SMTP_FROM is required for both, PUBLIC_URL is what the links inside a message point at,
 * and SMTP_MESSAGE_STREAM names the provider's stream where one is required. Credentials
 * never reach the database, an API or a screen; the status route reports whether they are
 * present without revealing any of them.
 */

export type MailConfig = {
  transport: 'postmark-api' | 'smtp';
  host: string | null; port: number | null; secure: boolean | null;
  user: string | null; pass: string | null;
  from: string; publicUrl: string;
  messageStream: string | null;
  /** Never copied anywhere: not into a response, a log line or an error message. */
  postmarkToken: string | null;
  postmarkApi: string;
};

/** What is set, read once at the point of use so a restart is all a change needs. */
export function mailConfig(env = process.env): MailConfig | null {
  const from = env.SMTP_FROM?.trim();
  const host = env.SMTP_HOST?.trim() || null;
  const token = env.POSTMARK_SERVER_TOKEN?.trim() || null;
  if (!from || (!host && !token)) return null;
  const port = Number(env.SMTP_PORT ?? 587);
  return {
    transport: token ? 'postmark-api' : 'smtp',
    host,
    port: host ? port : null,
    // 465 is implicit TLS; 587 and 25 start plain and upgrade with STARTTLS. Getting this
    // backwards is the most common reason a working mailbox refuses a connection.
    secure: host ? (env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465) : null,
    user: env.SMTP_USER?.trim() || null,
    pass: env.SMTP_PASS || null,
    from,
    publicUrl: (env.PUBLIC_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
    // Some providers route by a named stream and treat the choice as a rule rather than a
    // preference. Postmark separates transactional mail from broadcasts, and a newsletter
    // sent on the transactional stream is a terms violation that suspends the sending
    // account — the one failure here that costs more than a bounced message. The header is
    // theirs, is ignored by everyone else, and is omitted entirely when unset.
    messageStream: env.SMTP_MESSAGE_STREAM?.trim() || null,
    postmarkToken: token,
    // Overridable so a test can stand in for Postmark on localhost. Nothing else sets it.
    postmarkApi: (env.POSTMARK_API_URL ?? 'https://api.postmarkapp.com').replace(/\/+$/, ''),
  };
}

/** Whether mail can be sent at all, for a screen that would otherwise offer a dead button. */
export const mailReady = (env = process.env) => mailConfig(env) !== null;

let cached: { key: string; transport: Transporter } | null = null;

/**
 * One SMTP transport, reused.
 *
 * A fresh connection per message is a TLS handshake per message, and a provider that sees a
 * hundred of them in a minute treats it as what it looks like. The pool holds a small number
 * of connections and paces itself under the rate most providers actually enforce.
 *
 * The timeouts are short on purpose. nodemailer's defaults wait two minutes to connect, and
 * a host that silently drops outbound SMTP — which is what a blocked port looks like — would
 * leave an admin staring at a spinner for that long and then reading a generic error. These
 * bound each phase; `within` bounds the whole attempt, because the phases add up.
 */
export function transport(env = process.env): Transporter | null {
  const cfg = mailConfig(env);
  if (!cfg || cfg.transport !== 'smtp' || !cfg.host) return null;
  const key = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user]);
  if (cached?.key === key) return cached.transport;
  cached = {
    key,
    transport: nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port ?? 587,
      secure: cfg.secure ?? false,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? '' } : undefined,
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
      rateDelta: 1000,
      rateLimit: 8,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
    }),
  };
  return cached.transport;
}

/**
 * A hard stop around an SMTP attempt.
 *
 * nodemailer's connection, greeting and socket timeouts each bound one phase, and a host that
 * drops packets can spend all three in turn: measured on Railway, a "10 second" verify took
 * thirty. The person waiting was told one number and given another. This bounds the whole
 * attempt, so the sentence they read is true.
 */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      reject(Object.assign(new Error(`no answer in ${ms / 1000}s`), { code: 'ETIMEDOUT' }));
    }, ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

const SMTP_VERIFY_MS = 12_000;
const SMTP_SEND_MS = 45_000;

/** A fetch that gives up, because a request to a provider that never answers must not hang the route. */
async function timed(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Postmark's error shape, and a sentence that says what it means without repeating the token. */
function postmarkError(status: number, body: unknown): string {
  const b = body as { ErrorCode?: number; Message?: string } | null;
  if (status === 401) return 'Postmark rejected the server token (401). Check POSTMARK_SERVER_TOKEN.';
  if (b?.Message) return `Postmark refused it (${b.ErrorCode ?? status}): ${b.Message}`;
  return `Postmark answered ${status} with no explanation`;
}

/** Ask the provider whether it would accept us, without sending anything to anybody. */
export async function verify(env = process.env): Promise<{ ok: true } | { ok: false; error: string }> {
  const cfg = mailConfig(env);
  if (!cfg) return { ok: false, error: 'Email is not configured: set SMTP_FROM and either POSTMARK_SERVER_TOKEN or SMTP_HOST' };

  if (cfg.transport === 'postmark-api') {
    // GET /server is the cheapest authenticated call Postmark has. Its body lists the
    // server's API tokens, so only the status code is read — the body is never parsed,
    // logged or returned.
    try {
      const r = await timed(`${cfg.postmarkApi}/server`, {
        headers: { Accept: 'application/json', 'X-Postmark-Server-Token': cfg.postmarkToken! },
      }, 10_000);
      if (r.ok) return { ok: true };
      return { ok: false, error: postmarkError(r.status, null) };
    } catch (err) {
      return { ok: false, error: `Could not reach Postmark: ${(err as Error).name === 'AbortError' ? 'no answer in 10s' : (err as Error).message}` };
    }
  }

  const t = transport(env);
  if (!t) return { ok: false, error: 'SMTP is not configured: set SMTP_HOST and SMTP_FROM' };
  const t0 = Date.now();
  try {
    await within(t.verify(), SMTP_VERIFY_MS);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: smtpError(err as Error & { code?: string }, t0) };
  }
}

/**
 * nodemailer's errors name the mechanism. The person reading them is deciding what to change
 * in a settings screen, so the sentence names that instead. A timeout, in particular, is the
 * signature of a host that drops outbound SMTP rather than a server that is slow.
 */
function smtpError(err: Error & { code?: string }, startedAt: number): string {
  if (err.code === 'ETIMEDOUT' || (err.code === 'ESOCKET' && /timed? ?out/i.test(err.message))) {
    return `The SMTP server did not answer in ${Math.round((Date.now() - startedAt) / 1000)}s. On a host that blocks outbound SMTP — Railway does below its Pro plan — this is what a blocked port looks like; set POSTMARK_SERVER_TOKEN to send over HTTPS instead.`;
  }
  if (err.code === 'EAUTH') return 'The SMTP server rejected the username or password.';
  return err.message;
}

const escapeHtml = (s: string) => s
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/**
 * The article, as both halves of the message.
 *
 * Text and HTML rather than HTML alone: a text part is what a client reading in a terminal,
 * a watch or a screen reader gets, and its absence is one of the things spam filters count
 * against a sender. The two say the same thing — the text is the article, and the HTML is
 * the article with paragraphs.
 *
 * Paragraphs are blank-line separated and every line is escaped. The body is written by a
 * member of staff, but "written by staff" is not the same as "safe to interpolate": a stray
 * angle bracket would otherwise eat the rest of the message.
 */
export function render(a: {
  subject: string; body: string; name: string; unsubscribeUrl?: string | null; publicUrl: string;
}) {
  const paragraphs = a.body.replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  const text = [
    `Hello ${a.name},`,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    '—',
    'This is a simulated trading platform. Nothing in this message is investment advice,',
    'and every balance it refers to is simulated.',
    // Only where there is something to unsubscribe FROM. A message written to one client by
    // the desk that holds their account is not a list they joined, and offering to leave one
    // that does not exist is a button that does nothing — which is worse than no button.
    ...(a.unsubscribeUrl ? ['', `Stop receiving these: ${a.unsubscribeUrl}`] : []),
  ].join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(a.subject)}</title></head>
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
<table role="presentation" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;">
<tr><td style="padding:28px 28px 8px;">
  <div style="font-size:18px;letter-spacing:-0.01em;">Pantera GP <span style="color:#ff7817;">///</span></div>
  <h1 style="margin:18px 0 0;font-size:21px;font-weight:600;line-height:1.3;">${escapeHtml(a.subject)}</h1>
</td></tr>
<tr><td style="padding:12px 28px 4px;font-size:15px;line-height:1.6;">
  <p style="margin:0 0 14px;">Hello ${escapeHtml(a.name)},</p>
  ${paragraphs.map((p) => `<p style="margin:0 0 14px;">${escapeHtml(p).replaceAll('\n', '<br>')}</p>`).join('\n  ')}
</td></tr>
<tr><td style="padding:8px 28px 26px;border-top:1px solid #e5e7eb;font-size:12px;line-height:1.6;color:#66666e;">
  <p style="margin:14px 0 8px;">
    This is a simulated trading platform. Nothing in this message is investment advice, and
    every balance it refers to is simulated.
  </p>
  <p style="margin:0;">
    <a href="${escapeHtml(a.publicUrl)}" style="color:#9a4000;">Open your account</a>${a.unsubscribeUrl ? `
    &nbsp;·&nbsp;
    <a href="${escapeHtml(a.unsubscribeUrl)}" style="color:#66666e;">Stop receiving these</a>` : ''}
  </p>
</td></tr>
</table>
</body></html>`;

  return { text, html };
}

/**
 * The headers a message carries, the same for either transport.
 *
 * List-Unsubscribe is a real header, not decoration: mail clients surface it as a button,
 * and a reader who can unsubscribe in one click does that instead of reporting the message
 * as spam — which is the thing that damages a sending domain for everybody else on it. It is
 * set only for list mail. On a one-to-one message it would render as an Unsubscribe button
 * in the reader's mail client that leaves nothing, because there is no list.
 */
function headersFor(a: { unsubscribeUrl?: string | null }, cfg: MailConfig): Record<string, string> {
  return {
    ...(a.unsubscribeUrl ? {
      'List-Unsubscribe': `<${a.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    } : {}),
    // Over SMTP the stream travels as a header; over the API it is a field of its own, and
    // sending both is harmless, so the header is kept for the sake of one code path.
    ...(cfg.messageStream && cfg.transport === 'smtp' ? { 'X-PM-Message-Stream': cfg.messageStream } : {}),
  };
}

/**
 * Send one message.
 *
 * Returns rather than throws, because the caller is in a loop over a client list and one
 * address that no longer exists must not end the run for everybody after it.
 */
export async function send(a: {
  to: string; subject: string; text: string; html: string; unsubscribeUrl?: string | null;
}, env = process.env): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const cfg = mailConfig(env);
  if (!cfg) return { ok: false, error: 'Email is not configured' };

  if (cfg.transport === 'postmark-api') {
    try {
      const r = await timed(`${cfg.postmarkApi}/email`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': cfg.postmarkToken!,
        },
        body: JSON.stringify({
          From: cfg.from,
          To: a.to,
          Subject: a.subject,
          TextBody: a.text,
          HtmlBody: a.html,
          ...(cfg.messageStream ? { MessageStream: cfg.messageStream } : {}),
          Headers: Object.entries(headersFor(a, cfg)).map(([Name, Value]) => ({ Name, Value })),
        }),
      }, 15_000);
      const body = await r.json().catch(() => null) as { ErrorCode?: number; Message?: string; MessageID?: string } | null;
      if (r.ok && body && body.ErrorCode === 0) return { ok: true, id: String(body.MessageID ?? '') };
      return { ok: false, error: postmarkError(r.status, body) };
    } catch (err) {
      return { ok: false, error: `Could not reach Postmark: ${(err as Error).name === 'AbortError' ? 'no answer in 15s' : (err as Error).message}` };
    }
  }

  const t = transport(env);
  if (!t) return { ok: false, error: 'SMTP is not configured' };
  const t0 = Date.now();
  try {
    const info = await within(t.sendMail({
      from: cfg.from,
      to: a.to,
      subject: a.subject,
      text: a.text,
      html: a.html,
      headers: headersFor(a, cfg),
    }), SMTP_SEND_MS);
    return { ok: true, id: String(info.messageId ?? '') };
  } catch (err) {
    return { ok: false, error: smtpError(err as Error & { code?: string }, t0) };
  }
}
