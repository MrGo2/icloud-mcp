#!/usr/bin/env node
/**
 * read-email, mark-as-read and delete in LOCAL mode (issue #15).
 *
 * The generated JXA runs in a Node vm against a fake Mail that, like the real
 * one, has no application-level `messages` and resolves `mailbox.messages.byId`.
 * osascript is never called.
 */

const path = require('path');
const vm = require('vm');
const Module = require('module');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + ' -> ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function fakeMail() {
  const store = [
    { id: 30372, subject: 'Test message', sender: 'Ada <ada@example.com>', read: true, mailbox: 'INBOX' },
    { id: 499, subject: 'Old', sender: 'a@example.com', read: true, mailbox: 'Archive' }
  ];
  const state = { deleted: null };
  let byId;
  const message = (raw) => new Proxy({
    mailbox: () => ({ messages: { byId: (id) => byId(id) } }),
    exists: () => true, id: () => raw.id, subject: () => raw.subject, sender: () => raw.sender,
    toRecipients: () => [{ address: () => 'me@example.com' }], ccRecipients: () => [],
    dateReceived: () => new Date('2026-10-22T16:50:19Z'), content: () => 'body', readStatus: () => raw.read
  }, { set(t, k, v) { assert(k === 'readStatus'); raw.read = v; return true; } });
  byId = (id) => { const raw = store.find(m => m.id === id); return raw ? message(raw) : { exists: () => false }; };
  const mailbox = (name) => ({
    exists: () => name !== 'Missing',
    messages: { byId: (id) => { const raw = store.find(m => m.id === id); return raw ? message(raw) : { exists: () => false }; } }
  });
  const account = {
    mailboxes: Object.assign(() => [mailbox('INBOX'), mailbox('Archive')], { byName: (n) => mailbox(n) })
  };
  const mail = {
    // No `messages` here: mail.messages.byId(...) throws, as on a real Mac.
    accounts: () => [account],
    delete: (m) => { state.deleted = m.id(); }
  };
  return { mail, store, state };
}

let fake;
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../utils/applescript') {
    const real = realRequire.apply(this, arguments);
    const run = async (script) => {
      const out = vm.runInNewContext(script, { Application: () => fake.mail, JSON, Date, Error });
      return typeof out === 'string' ? out : String(out);
    };
    return { ...real, runJXA: run, runAppleScript: async () => { throw new Error('AppleScript not expected'); } };
  }
  return realRequire.apply(this, arguments);
};
const local = require(path.join(__dirname, '..', 'email', 'local-client'));

(async () => {
  console.log('\nLOCAL read-email resolves the message inside a mailbox');
  await check('reads a message by the id list-emails returns', async () => {
    fake = fakeMail();
    const email = await local.readEmail('30372');
    assert(email.id === 30372 && email.subject === 'Test message', JSON.stringify(email));
    assert(email.date === '2026-10-22T16:50:19.000Z');
  });
  await check('finds a message outside the requested folder', async () => {
    fake = fakeMail();
    const email = await local.readEmail('499', 'inbox');
    assert(email.id === 499);
  });
  await check('an unknown id is an error', async () => {
    fake = fakeMail();
    let msg = '';
    try { await local.readEmail('1'); } catch (e) { msg = e.message; }
    assert(msg.includes('Email not found: 1'), msg);
  });
  await check('mark-as-read sets the flag on the resolved message', async () => {
    fake = fakeMail();
    await local.markAsRead('30372', false);
    assert(fake.store[0].read === false);
  });
  await check('delete targets the resolved message', async () => {
    fake = fakeMail();
    await local.deleteEmail('499');
    assert(fake.state.deleted === 499);
  });
  await check('a non-numeric id never reaches the script', async () => {
    fake = fakeMail();
    let threw = false;
    try { await local.readEmail('1); mail.delete(x); (1'); } catch (e) { threw = true; }
    assert(threw && fake.state.deleted === null);
  });

  console.log('\n' + '='.repeat(56));
  console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : 'PASS ' + pass + '  FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
