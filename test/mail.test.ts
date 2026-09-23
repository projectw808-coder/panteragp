import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { mailConfig, send, verify } from '../src/mail.ts';

/**
 * The HTTPS way out, against a stand-in for Postmark on localhost.
 *
 * What is asserted is what Postmark would receive — the token in its header, the fields by
 * their exact names, the stream, and which headers ride along — because the difference
 * between "sent" and "silently dropped" at a provider is spelling. The stand-in also
 * answers the way Postmark answers when it refuses, so the message the desk reads is the
 * provider's reason and not a stack trace.
 */

type Seen = { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: any };

let server: Server;
let base: string;
let seen: Seen[] = [];
let reply: { status: number; body: unknown } = { status: 200, body: { ErrorCode: 0, Message: 'OK', MessageID: 'pm-1' } };

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => server.close());

const env = (extra: Record<string, string | undefined> = {}) => ({
  SMTP_FROM: 'Pantera GP <desk@example.test>',
  POSTMARK_SERVER_TOKEN: 'tok-secret-123',
  POSTMARK_API_URL: base,
  PUBLIC_URL: 'https://app.example.test',
  ...extra,
} as NodeJS.ProcessEnv);

describe('choosing the way out', () => {
  it('prefers the Postmark token when both are set, because SMTP may be blocked where this runs', () => {
    const cfg = mailConfig(env({ SMTP_HOST: 'smtp.example.test' }));
    assert.equal(cfg?.transport, 'postmark-api');
  });
  it('falls back to SMTP when there is no token', () => {
    const cfg = mailConfig(env({ POSTMARK_SERVER_TOKEN: undefined, SMTP_HOST: 'smtp.example.test' }));
    assert.equal(cfg?.transport, 'smtp');
    assert.equal(cfg?.port, 587);
    assert.equal(cfg?.secure, false);
  });
  it('is unconfigured with a sender but no way out, and with a way out but no sender', () => {
    assert.equal(mailConfig(env({ POSTMARK_SERVER_TOKEN: undefined })), null);
    assert.equal(mailConfig(env({ SMTP_FROM: undefined })), null);
    assert.equal(mailConfig(env({ SMTP_FROM: '   ' })), null);
  });
});

describe('sending through the Postmark API', () => {
  it('posts the message with the fields Postmark names, and the token only in its header', async () => {
    seen = [];
    reply = { status: 200, body: { ErrorCode: 0, Message: 'OK', MessageID: 'pm-42' } };
    const out = await send({
      to: 'ada@example.test', subject: 'Weekly update', text: 'Hello Ada', html: '<p>Hello Ada</p>',
      unsubscribeUrl: 'https://app.example.test/unsubscribe?token=abc',
    }, env({ SMTP_MESSAGE_STREAM: 'broadcast' }));

    assert.deepEqual(out, { ok: true, id: 'pm-42' });
    assert.equal(seen.length, 1);
    const [req] = seen;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/email');
    assert.equal(req.headers['x-postmark-server-token'], 'tok-secret-123');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.body.From, 'Pantera GP <desk@example.test>');
    assert.equal(req.body.To, 'ada@example.test');
    assert.equal(req.body.Subject, 'Weekly update');
    assert.equal(req.body.TextBody, 'Hello Ada');
    assert.equal(req.body.HtmlBody, '<p>Hello Ada</p>');
    assert.equal(req.body.MessageStream, 'broadcast');
    // The token belongs in the header and nowhere else.
    assert.ok(!JSON.stringify(req.body).includes('tok-secret-123'));

    const names = req.body.Headers.map((h: { Name: string }) => h.Name);
    assert.deepEqual(names, ['List-Unsubscribe', 'List-Unsubscribe-Post']);
    assert.equal(req.body.Headers[0].Value, '<https://app.example.test/unsubscribe?token=abc>');
    // The stream is a field of its own over the API, not a header as well.
    assert.ok(!names.includes('X-PM-Message-Stream'));
  });

  it('carries no unsubscribe header on a one-to-one message, and no stream when none is set', async () => {
    seen = [];
    reply = { status: 200, body: { ErrorCode: 0, Message: 'OK', MessageID: 'pm-43' } };
    const out = await send({ to: 'ada@example.test', subject: 'Your document', text: 't', html: '<p>t</p>' }, env());
    assert.equal(out.ok, true);
    assert.deepEqual(seen[0].body.Headers, []);
    assert.equal('MessageStream' in seen[0].body, false);
  });

  it("returns Postmark's own reason when it refuses, without the token", async () => {
    seen = [];
    reply = { status: 422, body: { ErrorCode: 300, Message: "Invalid 'To' address: 'nobody'." } };
    const out = await send({ to: 'nobody', subject: 's', text: 't', html: 'h' }, env());
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.error, /Invalid 'To' address/);
    assert.match(out.error, /300/);
    assert.ok(!out.error.includes('tok-secret-123'));
  });

  it('names the token when Postmark says 401, so the fix is obvious', async () => {
    reply = { status: 401, body: { ErrorCode: 10, Message: 'No Account or Server token' } };
    const out = await send({ to: 'ada@example.test', subject: 's', text: 't', html: 'h' }, env());
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.error, /POSTMARK_SERVER_TOKEN/);
    assert.match(out.error, /401/);
  });

  it('returns rather than throws when the provider cannot be reached', async () => {
    const out = await send({ to: 'ada@example.test', subject: 's', text: 't', html: 'h' },
      env({ POSTMARK_API_URL: 'http://127.0.0.1:9' }));
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.error, /Could not reach Postmark/);
  });
});

describe('verifying the Postmark token', () => {
  it('asks for the server record and reads only the status', async () => {
    seen = [];
    reply = { status: 200, body: { ID: 1, Name: 'Pantera', ApiTokens: ['tok-secret-123'] } };
    const out = await verify(env());
    assert.deepEqual(out, { ok: true });
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].url, '/server');
    assert.equal(seen[0].headers['x-postmark-server-token'], 'tok-secret-123');
  });

  it('says the token is wrong on a 401, and says nothing else about it', async () => {
    reply = { status: 401, body: { ErrorCode: 10, Message: 'No Account or Server token' } };
    const out = await verify(env());
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.error, /POSTMARK_SERVER_TOKEN/);
    assert.ok(!out.error.includes('tok-secret-123'));
  });

  it('explains what is missing when nothing is configured', async () => {
    const out = await verify({} as NodeJS.ProcessEnv);
    assert.equal(out.ok, false);
    if (out.ok) return;
    assert.match(out.error, /POSTMARK_SERVER_TOKEN or SMTP_HOST/);
  });
});
