#!/usr/bin/env node
/**
 * Local Mail.app scripts, run against a fake Mail object model.
 *
 * No osascript and no Mail.app: each generated JXA script is executed in a
 * Node vm with `Application('Mail')` stubbed. The fake mirrors what Mail does
 * on a real Mac (checked read-only on macOS 27):
 *   - `mail.messages` does not exist at application level (the -1728 bug);
 *   - `mailbox.messages.byId(n)` resolves by id alone, from any mailbox;
 *   - bulk reads (`messages.subject()`) are one event; index access is not
 *     modelled, so a script that walks messages by index fails here.
 * Every property read is counted, so the tests also pin the cost.
 */

const path = require('path');
const vm = require('vm');
const lc = require(path.join(__dirname, '..', 'email', 'local-client'));

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + ' -> ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function notFound() {
  const e = new Error("Can't get object.");
  e.errorNumber = -1728;
  return e;
}

/**
 * @param {Array} accounts - [{ name, mailboxes: [{ name, messages: [...] }] }],
 *   messages newest first: { id, subject, sender, date, read, content, to, cc }
 */
function fakeMail(accounts) {
  const stats = { events: 0, bulk: 0, byId: 0, whose: 0, bodies: 0 };
  const ev = (v) => { stats.events++; return v; };
  const all = [];
  const missing = { exists: () => ev(false) };

  function message(raw, mbObj) {
    // JXA reads with m.readStatus() and writes with m.readStatus = v.
    const target = {
      exists: () => ev(true),
      id: () => ev(raw.id),
      subject: () => ev(raw.subject),
      sender: () => ev(raw.sender),
      dateReceived: () => ev(new Date(raw.date)),
      readStatus: () => ev(raw.read),
      content: () => { stats.bodies++; return ev(raw.content || ''); },
      toRecipients: { address: () => ev(raw.to || []) },
      ccRecipients: { address: () => ev(raw.cc || []) },
      mailbox: () => mbObj
    };
    return new Proxy(target, {
      set(t, k, v) { if (k !== 'readStatus') throw new Error('unexpected write ' + String(k)); raw.read = v; return true; }
    });
  }

  function collection(list) {
    const bulk = (k) => () => { stats.bulk++; return ev(list.map(r => r[k])); };
    return {
      get length() { return ev(list.length); },
      id: bulk('id'),
      subject: bulk('subject'),
      sender: bulk('sender'),
      dateReceived: () => { stats.bulk++; return ev(list.map(r => new Date(r.date))); },
      byId(id) {
        stats.byId++;
        const hit = all.find(x => x.raw.id === id);
        return hit ? message(hit.raw, hit.mb) : { exists: () => ev(false), id: () => { throw notFound(); } };
      },
      whose(filter) {
        stats.whose++;
        const sub = list.filter(r => Object.keys(filter).every(k => (k === 'readStatus' ? r.read : r[k]) === filter[k]));
        const c = collection(sub);
        const f = () => sub.map(r => message(r, null));
        return Object.defineProperties(f, Object.getOwnPropertyDescriptors(c));
      }
    };
  }

  const accountObjs = accounts.map(a => {
    const acct = { name: () => ev(a.name), exists: () => ev(true) };
    const mbs = a.mailboxes.map(m => {
      const mbObj = { name: () => ev(m.name), exists: () => ev(true), account: () => acct, messages: collection(m.messages) };
      for (const raw of m.messages) all.push({ raw, mb: mbObj });
      return mbObj;
    });
    acct.mailboxes = Object.assign(() => mbs, { byName: (n) => mbs[a.mailboxes.findIndex(x => x.name === n)] || missing });
    return acct;
  });

  const mail = {
    accounts: Object.assign(() => accountObjs, {
      byName: (n) => accountObjs.find((x, i) => accounts[i].name === n) || missing
    }),
    delete: (m) => { stats.deleted = m.id(); }
  };
  return { mail, stats };
}

function runScript(script, accounts) {
  const { mail, stats } = fakeMail(accounts);
  const ctx = { Application: (name) => { if (name !== 'Mail') throw new Error('wrong app'); return mail; }, JSON, Set, Math, String, Date, Error };
  const out = vm.runInNewContext(script, ctx, { timeout: 2000 });
  return { result: JSON.parse(out), stats };
}

function inbox(n, start, extra = {}) {
  const list = [];
  for (let i = 0; i < n; i++) {
    list.push({
      id: start - i, subject: `Message ${i}`, sender: `Person ${i} <p${i}@example.com>`,
      date: new Date(Date.UTC(2026, 9, 26) - i * 3600e3).toISOString(), read: true, content: `body ${i}`, to: ['me@example.com']
    });
  }
  Object.assign(list[0], extra);
  return list;
}

const BIG = 7378;
function world() {
  const sig = inbox(BIG, 97293);
  sig[3].subject = 'Re: Spotlight venue';
  sig[500].subject = 'Spotlight sponsorship';
  sig[6000].subject = 'Old SPOTLIGHT thread';
  sig[7].content = 'see the spotlight deck';
  sig[40].content = 'spotlight in a body outside the window';
  sig[10].read = false;
  sig[3000].read = false;
  sig[3000].sender = 'GitHub <noreply@github.com>';
  sig[11].sender = 'GitHub <noreply@github.com>';
  const icloud = inbox(1990, 60000);
  icloud[0] = { id: 30372, subject: 'Test message', sender: 'Ada <ada@example.com>',
    date: '2026-10-22T16:50:19.000Z', read: true, content: 'x'.repeat(3876) + '\n\n', to: ['me@example.com'], cc: [] };
  return [
    { name: 'iCloud', mailboxes: [{ name: 'INBOX', messages: icloud }, { name: 'Archive', messages: inbox(3, 500) }] },
    { name: 'Work', mailboxes: [{ name: 'INBOX', messages: sig }] },
    { name: 'Google', mailboxes: [{ name: 'All Mail', messages: inbox(2, 300) }, { name: 'INBOX', messages: inbox(2884, 40000) }] }
  ];
}

console.log('\nread-email: resolves by id inside a mailbox');
check('reads 30372 with account, body intact, real account reported', () => {
  const { result, stats } = runScript(lc.buildReadScript('30372', 'inbox', 'iCloud'), world());
  assert(result.id === 30372 && result.account === 'iCloud' && result.mailbox === 'INBOX', JSON.stringify(result).slice(0, 200));
  assert(result.body.length === 3878, 'body length ' + result.body.length);
  assert(result.date === '2026-10-22T16:50:19.000Z', 'date ' + result.date);
  assert(stats.bulk === 0 && stats.whose === 0, 'read must not scan: ' + JSON.stringify(stats));
});
check('no account: found without scanning, still reports iCloud', () => {
  const { result, stats } = runScript(lc.buildReadScript(30372), world());
  assert(result.account === 'iCloud');
  assert(stats.bulk === 0 && stats.whose === 0, JSON.stringify(stats));
});
check('message in another mailbox (Archive) is found', () => {
  const { result } = runScript(lc.buildReadScript(499, 'inbox', 'iCloud'), world());
  assert(result.id === 499 && result.mailbox === 'Archive', JSON.stringify(result).slice(0, 120));
});
check('unknown id is an error, not an empty result', () => {
  let msg = '';
  try { runScript(lc.buildReadScript(1, 'inbox'), world()); } catch (e) { msg = e.message; }
  assert(msg.includes('Email not found: 1'), msg);
});
check('unknown account is an error naming it', () => {
  let msg = '';
  try { runScript(lc.buildReadScript(30372, 'inbox', 'Nope'), world()); } catch (e) { msg = e.message; }
  assert(msg.includes('No Mail account named "Nope"'), msg);
});
check('non-numeric id is rejected before any script is built', () => {
  let threw = false;
  try { lc.buildReadScript('1); mail.delete(x); (1'); } catch (e) { threw = true; }
  assert(threw);
});

console.log('\nscript arguments are data, never code');
const EXPLOITS = [
  'A" & (do shell script "id") & "',
  "x'); Application('Finder').delete(1); ('",
  'x"}); this.constructor.constructor("return process")(); ({"a":"',
  '  </script>${1+1}`',
  'line\nbreak\\'
];
check('account, folder and query values round-trip through ARGS unchanged', () => {
  for (const evil of EXPLOITS) {
    for (const script of [
      lc.buildListScript(evil, 5, evil),
      lc.buildReadScript(5, evil, evil),
      lc.buildSearchScript({ query: evil, from: evil, subject: evil, folder: evil, account: evil })
    ]) {
      const m = script.match(/const ARGS = ([^\n]*);\n/);
      assert(m, 'no ARGS line');
      const args = vm.runInNewContext('(' + m[1] + ')');
      const values = Object.values(args).map(String);
      assert(values.some(v => v === evil || v === evil.toLowerCase()), 'value changed: ' + m[1].slice(0, 120));
      let msg = '';
      try { runScript(script, world()); } catch (e) { msg = e.message; }
      assert(msg.startsWith('No Mail account named'), 'script did not treat the account as a name: ' + msg);
    }
  }
});

console.log('\nlist-emails: newest count, by id');
check('list 5 of a 7,378-message mailbox reads ids once and 5 summaries', () => {
  const { result, stats } = runScript(lc.buildListScript('inbox', 5, 'Work'), world());
  assert(result.length === 5 && result[0].id === 97293 && result[0].account === 'Work');
  assert(stats.bulk === 1 && stats.byId === 5, JSON.stringify(stats));
  assert(result[0].date.endsWith('Z'), 'dates are UTC ISO strings');
});
check('without account, accounts are merged newest first', () => {
  const accounts = world();
  accounts[2].mailboxes[1].messages[0].date = '2026-10-30T00:00:00.000Z';
  const { result } = runScript(lc.buildListScript('inbox', 3), accounts);
  assert(result.length === 3, result.length);
  assert(result[0].account === 'Google' && result[0].id === 40000, JSON.stringify(result[0]));
  assert(result.map(e => e.date).join() === result.map(e => e.date).sort().reverse().join(), 'not sorted');
});
check('search without account returns the newest hits across accounts', () => {
  const accounts = world();
  accounts[0].mailboxes[0].messages[5].subject = 'spotlight in iCloud';
  const { result } = runScript(lc.buildSearchScript({ subject: 'spotlight', count: 2 }), accounts);
  assert(result.items.length === 2 && result.scope.length === 3, JSON.stringify(result.scope));
  assert(result.items[0].id === 97293 - 3, JSON.stringify(result.items));
});
check('count is clamped to 1..50', () => {
  assert(lc.buildListScript('inbox', 999).includes('"count":50'));
  assert(lc.buildListScript('inbox', 0).includes('"count":1'));
});

console.log('\nsearch-emails: whole mailbox for headers, bounded bodies, scope reported');
check('subject search covers the whole mailbox, not 30 days', () => {
  const { result } = runScript(lc.buildSearchScript({ subject: 'spotlight', account: 'Work', count: 25 }), world());
  const ids = result.items.map(e => e.id);
  assert(ids.includes(97293 - 6000), 'missed a message 6,000 deep: ' + ids);
  assert(result.items.length === 3, ids);
  assert(result.scope[0].scanned === BIG && result.scope[0].messages === BIG && result.scope[0].bodyWindow === 0, JSON.stringify(result.scope));
});
check('search stops at count and reports how far it got', () => {
  const { result } = runScript(lc.buildSearchScript({ subject: 'spotlight', account: 'Work', count: 1 }), world());
  assert(result.items.length === 1 && result.scope[0].scanned === 4, JSON.stringify(result.scope));
});
check('query matches subjects everywhere and bodies only in the newest BODY_SCAN', () => {
  const { result, stats } = runScript(lc.buildSearchScript({ query: 'spotlight', account: 'Work', count: 25 }), world());
  const ids = result.items.map(e => e.id);
  assert(ids.includes(97293 - 7), 'body hit in window missed');
  assert(!ids.includes(97293 - 40), 'body outside the window was read');
  assert(ids.includes(97293 - 6000), 'subject hit outside the window missed');
  assert(stats.bodies <= lc.BODY_SCAN, 'bodies read: ' + stats.bodies);
  assert(result.scope[0].bodyWindow === lc.BODY_SCAN, JSON.stringify(result.scope));
});
check('body reads stop at the time budget and the scope says so', () => {
  const script = lc.buildSearchScript({ query: 'nomatch', account: 'Work' });
  const { mail } = fakeMail(world());
  // Each clock read is 4 s later: the deadline is set at 4 s (budget to 14 s),
  // bodies 0 and 1 start at 8 s and 12 s, and the check at 16 s stops.
  let now = 0;
  const FakeDate = Object.assign(function (...a) { return new Date(...a); }, { now: () => (now += 4000) });
  const out = JSON.parse(vm.runInNewContext(script, { Application: () => mail, JSON, Set, Math, String, Date: FakeDate, Error }));
  assert(out.scope[0].bodyWindow === 2, JSON.stringify(out.scope));
});
check('from and unread combine as AND across the whole mailbox', () => {
  const { result } = runScript(lc.buildSearchScript({ from: 'github', unreadOnly: true, account: 'Work' }), world());
  assert(result.items.length === 1 && result.items[0].id === 97293 - 3000, JSON.stringify(result.items));
});
check('unread only uses the read-status whose, no full scan', () => {
  const { result, stats } = runScript(lc.buildSearchScript({ unreadOnly: true, account: 'Work' }), world());
  assert(result.items.length === 2 && result.items.every(e => e.read === false));
  assert(stats.bulk === 1 && stats.whose === 1, JSON.stringify(stats));
});
check('a search in a mailbox no account has returns an empty scope', () => {
  const { result } = runScript(lc.buildSearchScript({ subject: 'x', folder: 'Nowhere' }), world());
  assert(result.items.length === 0 && result.scope.length === 0);
});
check('mail arriving between bulk reads is detected, not misreported', () => {
  const accounts = world();
  const sig = accounts[1].mailboxes[0].messages;
  const script = lc.buildSearchScript({ subject: 'spotlight', account: 'Work', count: 1 });
  const { mail } = fakeMail(accounts);
  const coll = mail.accounts.byName('Work').mailboxes.byName('INBOX').messages;
  const realIds = coll.id;
  let shifted = false;
  coll.id = () => {
    const r = realIds();
    if (!shifted) { shifted = true; sig.unshift({ id: 99999, subject: 'new', sender: 'n', date: '2026-10-27T00:00:00Z', read: false }); }
    return r;
  };
  const out = JSON.parse(vm.runInNewContext(script, { Application: () => mail, JSON, Set, Math, String, Date, Error }));
  assert(shifted, 'test did not shift the mailbox');
  assert(out.items.length === 1 && out.items[0].id === 97293 - 3 && /spotlight/i.test(out.items[0].subject), JSON.stringify(out.items));
});

console.log('\nmark-as-read and delete use the same lookup (fake Mail only)');
check('mark-as-read sets the flag on the resolved message', () => {
  const accounts = world();
  runScript(lc.buildMarkAsReadScript(30372, false, 'inbox', 'iCloud'), accounts);
  assert(accounts[0].mailboxes[0].messages[0].read === false);
});
check('delete targets the resolved message', () => {
  const { mail, stats } = fakeMail(world());
  vm.runInNewContext(lc.buildDeleteScript(30372), { Application: () => mail, JSON, Set, Math, String, Date, Error });
  assert(stats.deleted === 30372);
});

console.log('\n' + '='.repeat(56));
console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : 'PASS ' + pass + '  FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
