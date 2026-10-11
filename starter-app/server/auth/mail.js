import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';

export function createAuthMail({ config, env, sendMail }) {
  const messages = [];
  let transport;
  if (config.mailMode === 'custom' && typeof sendMail !== 'function') throw new Error('AUTH_MAIL_MODE=custom requires the application sendMail adapter');
  if (config.mailMode === 'smtp') {
    if (!env.AUTH_SMTP_HOST || !env.AUTH_SMTP_USER || !env.AUTH_SMTP_PASSWORD || !env.AUTH_MAIL_FROM) {
      throw new Error('SMTP auth mail requires AUTH_SMTP_HOST, AUTH_SMTP_USER, AUTH_SMTP_PASSWORD, and AUTH_MAIL_FROM');
    }
    const port = Number(env.AUTH_SMTP_PORT || 465);
    if (![465, 587].includes(port)) throw new Error('AUTH_SMTP_PORT must be 465 (TLS) or 587 (STARTTLS)');
    transport = nodemailer.createTransport({ host: env.AUTH_SMTP_HOST, port, secure: port === 465,
      requireTLS: true, tls: { rejectUnauthorized: true }, auth: { user: env.AUTH_SMTP_USER, pass: env.AUTH_SMTP_PASSWORD },
      disableFileAccess: true, disableUrlAccess: true, logger: false, debug: false,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
  }
  function prune() {
    const cutoff = Date.now() - 15 * 60 * 1000;
    while (messages.length && (messages[0].createdAt < cutoff || messages.length > 50)) messages.shift();
  }
  return {
    list() { prune(); return messages.map((message) => ({ ...message })); },
    async send({ user, token, type }) {
      // Fragments are not sent to HTTP servers or in Referer. The web client
      // consumes and removes this one-use token before rendering anything else.
      const url = `${config.frontendURL}/#auth=${type}&token=${encodeURIComponent(token)}`;
      const message = { to: user.email, subject: type === 'verify' ? 'Verify your email' : 'Reset your password',
        text: `${type === 'verify' ? 'Verify your email address' : 'Reset your password'}: ${url}\nThis link expires in 15 minutes. If you did not request it, ignore this message.` };
      if (config.mailMode === 'capture') {
        messages.push({ id: randomUUID(), to: user.email, type, url, createdAt: Date.now() }); prune(); return;
      }
      if (config.mailMode === 'custom') return sendMail(message);
      await transport.sendMail({ ...message, from: env.AUTH_MAIL_FROM });
    },
  };
}
