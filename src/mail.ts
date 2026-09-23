import nodemailer, { type Transporter } from 'nodemailer';

/**
 * Sending mail to clients.
 *
 * Kept apart from the routes because the risky part of email is not the HTTP: it is that a
 * message, once handed to a server, cannot be recalled, and that a loop over a client list
 * is a loop over real people's inboxes. Everything here is built so the mistakes that are
 * cheap in the app are also cheap here.
 *
 * Configuration is environment only — SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
 * SMTP_FROM, and PUBLIC_URL for the links inside a message. Credentials never reach the
 * database, an API or a screen; `configured()` reports whether they are present without
 * revealing any of them.
 */

export type MailConfig = {
  host: string; port: number; secure: boolean;
  user: string | null; pass: string | null;
  from: string; publicUrl: string;
  messageStream: string | null;
};

/** What is set, read once at the point of use so a restart is all a change needs. */
export function mailConfig(env = process.env): MailConfig | null {
  const host = env.SMTP_HOST?.trim();
  const from = env.SMTP_FROM?.trim();
  if (!host || !from) return null;
  const port = Number(env.SMTP_PORT ?? 587);
  return {
    host,
    port,
    // 465 is implicit TLS; 587 and 25 start plain and upgrade with STARTTLS. Getting this
    // backwards is the most common reason a working mailbox refuses a connection.
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === 'true' : port === 465,
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
  };
}

/** Whether mail can be sent at all, for a screen that would otherwise offer a dead button. */
export const mailReady = (env = process.env) => mailConfig(env) !== null;

let cached: { key: string; transport: Transporter } | null = null;

/**
 * One transport, reused.
 *
 * A fresh connection per message is a TLS handshake per message, and a provider that sees a
 * hundred of them in a minute treats it as what it looks like. The pool holds a small number
 * of connections and paces itself under the rate most providers actually enforce.
 */
export function transport(env = process.env): Transporter | null {
  const cfg = mailConfig(env);
  if (!cfg) return null;
  const key = JSON.stringify([cfg.host, cfg.port, cfg.secure, cfg.user]);
  if (cached?.key === key) return cached.transport;
  cached = {
    key,
    transport: nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass ?? '' } : undefined,
      pool: true,
      maxConnections: 3,
      maxMessages: 50,
      rateDelta: 1000,
      rateLimit: 8,
    }),
  };
  return cached.transport;
}

/** Ask the server whether it would accept us, without sending anything to anybody. */
export async function verify(env = process.env): Promise<{ ok: true } | { ok: false; error: string }> {
  const t = transport(env);
  if (!t) return { ok: false, error: 'SMTP is not configured: set SMTP_HOST and SMTP_FROM' };
  try {
    await t.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
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
 * Send one message.
 *
 * Returns rather than throws, because the caller is in a loop over a client list and one
 * address that no longer exists must not end the run for everybody after it.
 *
 * List-Unsubscribe is a real header, not decoration: mail clients surface it as a button,
 * and a reader who can unsubscribe in one click does that instead of reporting the message
 * as spam — which is the thing that damages a sending domain for everybody else on it.
 */
export async function send(a: {
  to: string; subject: string; text: string; html: string; unsubscribeUrl?: string | null;
}, env = process.env): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const cfg = mailConfig(env);
  const t = transport(env);
  if (!cfg || !t) return { ok: false, error: 'SMTP is not configured' };
  try {
    const info = await t.sendMail({
      from: cfg.from,
      to: a.to,
      subject: a.subject,
      text: a.text,
      html: a.html,
      headers: {
        // Set only for list mail. On a one-to-one message it would render as an Unsubscribe
        // button in the reader's mail client that leaves nothing, because there is no list.
        ...(a.unsubscribeUrl ? {
          'List-Unsubscribe': `<${a.unsubscribeUrl}>`,
          'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        } : {}),
        ...(cfg.messageStream ? { 'X-PM-Message-Stream': cfg.messageStream } : {}),
      },
    });
    return { ok: true, id: String(info.messageId ?? '') };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
