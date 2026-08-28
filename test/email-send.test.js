#!/usr/bin/env node
/**
 * send-email in CLOUD mode: From override, envelope, Sent copy.
 *
 * No network. `nodemailer` (the transport) and the IMAP client are stubbed at
 * Module.prototype.require; MailComposer is real, so the MIME and the envelope
 * are exactly what would go on the wire.
 */

const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + ' -> ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error((msg || 'mismatch') + ': got ' + a + ', expected ' + b);
}

const SMTP_CLIENT = path.join(__dirname, '..', 'email', 'smtp-client.js');

/**
 * Load a fresh smtp-client with the given FROM / SAVE_TO_SENT config and an
 * IMAP append that either succeeds or throws. Returns the module plus what the
 * stubs recorded.
 */
function load({ from = {}, saveToSent = true, appendError = null } = {}) {
  const rec = { sent: null, appended: null };
  const realConfig = require('../config');
  const config = { ...realConfig, FROM: { ADDRESS: from.address, NAME: from.name }, SAVE_TO_SENT: saveToSent };
  const stubs = {
    '../config': config,
    '../auth': { getCredentials: () => ({ email: 'apple-id@icloud.com', password: 'pw' }) },
    './imap-client': {
      appendToFolder: async (message, folder) => {
        if (appendError) throw new Error(appendError);
        rec.appended = { message, folder };
        return true;
      }
    },
    nodemailer: {
      createTransport: () => ({
        sendMail: async (msg) => {
          rec.sent = msg;
          return { messageId: '<transport@x>', accepted: msg.envelope.to, rejected: [] };
        }
      })
    }
  };
  const realRequire = Module.prototype.require;
  Module.prototype.require = function (request) {
    if (this.filename === SMTP_CLIENT && Object.prototype.hasOwnProperty.call(stubs, request)) {
      return stubs[request];
    }
    return realRequire.apply(this, arguments);
  };
  try {
    delete require.cache[SMTP_CLIENT];
    const mod = require(SMTP_CLIENT);
    return { mod, rec, restore: () => { Module.prototype.require = realRequire; delete require.cache[SMTP_CLIENT]; } };
  } catch (e) {
    Module.prototype.require = realRequire;
    throw e;
  }
}

const header = (raw, name) => {
  const m = raw.toString().match(new RegExp('^' + name + ':\\s*(.*)$', 'im'));
  return m ? m[1].trim() : null;
};

(async () => {
  console.log('send-email (cloud) tests');

  await check('quoted display name containing a comma stays one recipient', async () => {
    const { mod, rec, restore } = load();
    try {
      await mod.sendEmail({ to: '"Doe, John" <j@x.com>, b@y.com', subject: 's', body: 'b' });
      eq(rec.sent.envelope.to, ['j@x.com', 'b@y.com']);
      assert(!rec.sent.envelope.to.some((a) => a.includes('"')), 'a fragment of the display name leaked into the envelope');
    } finally { restore(); }
  });

  await check('cc and bcc are in the envelope, bcc is not in the transmitted bytes', async () => {
    const { mod, rec, restore } = load();
    try {
      await mod.sendEmail({ to: 'a@x.com', cc: 'c@x.com', bcc: 'hidden@x.com', subject: 's', body: 'b' });
      eq(rec.sent.envelope.to, ['a@x.com', 'c@x.com', 'hidden@x.com']);
      assert(header(rec.sent.raw, 'Bcc') === null, 'Bcc header present in transmitted message');
      assert(!rec.sent.raw.toString().includes('hidden@x.com'), 'bcc address present in transmitted message');
    } finally { restore(); }
  });

  await check('From defaults to the Apple ID when no override is set', async () => {
    const { mod, rec, restore } = load();
    try {
      const res = await mod.sendEmail({ to: 'a@x.com', subject: 's', body: 'b' });
      eq(rec.sent.envelope.from, 'apple-id@icloud.com');
      assert(header(rec.sent.raw, 'From').includes('apple-id@icloud.com'), 'From header: ' + header(rec.sent.raw, 'From'));
      eq(res.from, 'apple-id@icloud.com');
    } finally { restore(); }
  });

  await check('ICLOUD_FROM_ADDRESS and ICLOUD_FROM_NAME reach the From header and envelope', async () => {
    const { mod, rec, restore } = load({ from: { address: 'me@my-domain.example', name: 'Me Myself' } });
    try {
      const res = await mod.sendEmail({ to: 'a@x.com', subject: 's', body: 'b' });
      const from = header(rec.sent.raw, 'From');
      assert(from.includes('Me Myself') && from.includes('<me@my-domain.example>'), 'From header: ' + from);
      eq(rec.sent.envelope.from, 'me@my-domain.example');
      eq(res.from, 'me@my-domain.example');
    } finally { restore(); }
  });

  await check('ICLOUD_FROM_ADDRESS alone (no name) sets a bare address', async () => {
    const { mod, rec, restore } = load({ from: { address: 'me@my-domain.example' } });
    try {
      await mod.sendEmail({ to: 'a@x.com', subject: 's', body: 'b' });
      assert(header(rec.sent.raw, 'From').includes('me@my-domain.example'), 'From header: ' + header(rec.sent.raw, 'From'));
    } finally { restore(); }
  });

  await check('the Sent copy is the transmitted message: same Message-ID and bytes without a bcc', async () => {
    const { mod, rec, restore } = load();
    try {
      const res = await mod.sendEmail({ to: 'a@x.com', subject: 's', body: 'b' });
      eq(rec.appended.folder, 'sent');
      assert(Buffer.compare(rec.appended.message, rec.sent.raw) === 0, 'Sent copy differs from the transmitted bytes');
      eq(res.messageId, header(rec.sent.raw, 'Message-ID'));
      eq(res.savedToSent, true);
    } finally { restore(); }
  });

  await check('with a bcc the Sent copy keeps Bcc: and shares Message-ID and Date', async () => {
    const { mod, rec, restore } = load();
    try {
      const res = await mod.sendEmail({ to: 'a@x.com', bcc: 'hidden@x.com', subject: 's', body: 'b' });
      assert(header(rec.sent.raw, 'Bcc') === null, 'transmitted message has a Bcc header');
      assert((header(rec.appended.message, 'Bcc') || '').includes('hidden@x.com'), 'Sent copy lost the Bcc header');
      eq(header(rec.appended.message, 'Message-ID'), header(rec.sent.raw, 'Message-ID'), 'Message-ID differs');
      eq(header(rec.appended.message, 'Date'), header(rec.sent.raw, 'Date'), 'Date differs');
      eq(res.messageId, header(rec.sent.raw, 'Message-ID'));
    } finally { restore(); }
  });

  await check('a failed APPEND is a warning, not a failed send', async () => {
    const { mod, rec, restore } = load({ appendError: 'Mailbox does not exist' });
    try {
      const res = await mod.sendEmail({ to: 'a@x.com', subject: 's', body: 'b' });
      assert(rec.sent, 'message was not sent');
      eq(res.success, true);
      eq(res.savedToSent, false);
      eq(res.saveToSentError, 'Mailbox does not exist');
    } finally { restore(); }
  });

  await check('ICLOUD_SAVE_TO_SENT=false skips the APPEND', async () => {
    const { mod, rec, restore } = load({ saveToSent: false });
    try {
      const res = await mod.sendEmail({ to: 'a@x.com', subject: 's', body: 'b' });
      eq(rec.appended, null);
      eq(res.success, true);
      eq(res.savedToSent, false);
      eq(res.saveToSentError, null);
    } finally { restore(); }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
