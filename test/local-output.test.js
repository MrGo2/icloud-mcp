#!/usr/bin/env node
/**
 * Proves the LOCAL (AppleScript) paths satisfy the same outputSchema contract
 * as the cloud paths.
 *
 * The SDK fails any call whose structuredContent does not match the tool's
 * declared outputSchema, and the local paths were previously unreachable, so
 * "the cloud path conforms" says nothing about them.
 *
 * osascript and the imsg CLI are stubbed at the module boundary: no Mail.app,
 * Calendar.app, Contacts.app or message database is touched, and none of
 * Carlos's real data is read.
 *
 * Run: npm run test:local
 */

const path = require('path');
const Module = require('module');
const { z } = require('zod');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + ' -> ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const soon = new Date(Date.now() + 3600 * 1000).toISOString();
const later = new Date(Date.now() + 7200 * 1000).toISOString();

/** Canned osascript results, chosen by what the script is clearly asking for. */
function fakeOsascript(script) {
  const has = (s) => script.includes(s);

  if (has("Application('Contacts')")) {
    if (has('accounts()') && has('groupCount')) {
      return JSON.stringify([{ id: 'acct-1', name: 'iCloud', groupCount: 2 }]);
    }
    if (has('group.name()') || has('contactCount')) {
      return JSON.stringify([{ id: 'grp-1', name: 'Family', accountId: 'acct-1', accountName: 'iCloud', contactCount: 3 }]);
    }
    return JSON.stringify([{
      id: 'person-1', name: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace',
      organization: 'Analytical Engines', jobTitle: 'Mathematician',
      emails: ['ada@example.com'], phones: ['+34600000000'],
      email: 'ada@example.com', phone: '+34600000000'
    }]);
  }

  if (has("Application('Calendar')")) {
    if (has('writable()')) {
      return JSON.stringify([{ name: 'Work', id: 'Work', writable: true }]);
    }
    return JSON.stringify([{
      id: 'evt-1', summary: 'Standup', startDate: soon, endDate: later,
      location: 'Madrid', calendar: 'Work'
    }]);
  }

  if (has("Application('Mail')")) {
    if (has('mailboxes') && !has('dateReceived')) {
      return JSON.stringify([{ name: 'INBOX', account: 'iCloud' }]);
    }
    return JSON.stringify([{
      id: '12345', subject: 'Hello', from: 'someone@example.com',
      date: new Date().toISOString(), read: false
    }]);
  }

  if (has("Application('Reminders')")) {
    if (has('lists()') && !has('reminders()')) {
      return JSON.stringify([{ id: 'list-1', name: 'Groceries' }]);
    }
    return JSON.stringify([{
      id: 'rem-1', name: 'Buy milk', body: '', completed: false,
      dueDate: soon, priority: 0, list: 'Groceries'
    }]);
  }

  if (has("Application('Notes')")) {
    if (has('noteCount')) return JSON.stringify([{ id: 'fold-1', name: 'Notes', noteCount: 1 }]);
    return JSON.stringify([{
      id: 'note-1', name: 'Ideas', creationDate: soon, modificationDate: soon, folder: 'Notes'
    }]);
  }

  if (has("Application('Safari')")) {
    return JSON.stringify([{ windowIndex: 0, tabIndex: 0, name: 'Example', url: 'https://example.com', isCurrent: true }]);
  }

  return JSON.stringify([]);
}

// Install the seam before any client module is loaded.
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../utils/applescript') {
    const real = realRequire.apply(this, arguments);
    return {
      ...real,
      runJXA: async (script) => fakeOsascript(script),
      runAppleScript: async (script) => fakeOsascript(script),
      runJXAWithJSON: async (script) => JSON.parse(fakeOsascript(script))
    };
  }
  if (id === 'child_process') {
    return {
      ...realRequire.apply(this, arguments),
      execFileSync: () => JSON.stringify({ service: 'iMessage', id: 1, identifier: '+34600000000', name: 'Someone', last_message_at: soon })
    };
  }
  return realRequire.apply(this, arguments);
};

const mode = require(path.join(ROOT, 'mode'));
const DIRS = ['email', 'calendar', 'contacts', 'reminders', 'notes', 'messages', 'safari'];
const tools = [];
for (const d of DIRS) {
  const mod = require(path.join(ROOT, d));
  const key = Object.keys(mod).find(k => k.endsWith('Tools'));
  tools.push(...mod[key]);
}

const LIST_TOOLS = tools.filter(t => t.outputSchema).map(t => t.name);

(async () => {
  mode.setMode('local');

  console.log('\nLOCAL mode: every list-* tool conforms to its own outputSchema');
  console.log('(osascript and imsg stubbed - no real app or data touched)\n');

  // Arguments a tool genuinely requires; without them it correctly refuses,
  // which would be a fault in the test rather than in the tool.
  const REQUIRED_ARGS = {
    'search-contacts': { query: 'ada' },
    'search-emails': { query: 'hello' },
    'search-reminders': { query: 'milk' },
    'search-notes': { query: 'ideas' }
  };

  for (const name of LIST_TOOLS) {
    const tool = tools.find(t => t.name === name);
    let result;
    try {
      result = await tool.handler(REQUIRED_ARGS[name] || {});
    } catch (e) {
      check(name, () => { throw new Error('handler threw: ' + e.message); });
      continue;
    }

    check(name, () => {
      assert(!result.isError, 'returned isError: ' + (result.content?.[0]?.text || '').slice(0, 100));
      assert(result.structuredContent !== undefined,
        'no structuredContent - the SDK fails this call when outputSchema is declared');
      const parsed = z.object(tool.outputSchema).safeParse(result.structuredContent);
      assert(parsed.success, 'structuredContent violates outputSchema: ' +
        JSON.stringify(parsed.error?.issues?.[0] || {}).slice(0, 140));
      assert(Array.isArray(result.content) && result.content[0]?.type === 'text',
        'no accompanying text block');
    });
  }

  console.log('\n' + '='.repeat(56));
  console.log('local list-* tools checked: ' + LIST_TOOLS.length);
  console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : 'PASS ' + pass + '  FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
