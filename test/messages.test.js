#!/usr/bin/env node
/**
 * list-chats / read-messages in LOCAL mode (issue #17).
 *
 * The imsg CLI is stubbed at child_process.execFile: no chat.db is read.
 */

const path = require('path');
const Module = require('module');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + ' -> ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const DAY = 24 * 3600 * 1000;
const now = Date.now();
// 300 chats, newest first, one per 6 hours (as imsg returns them).
const CHATS = Array.from({ length: 300 }, (_, i) => ({
  id: i + 1, service: 'iMessage', identifier: '+3460000' + i, name: 'Chat ' + i,
  last_message_at: new Date(now - i * DAY / 4).toISOString()
}));

let calls = [];
let delayMs = 0;
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'child_process') {
    return {
      ...realRequire.apply(this, arguments),
      execFile: (cmd, args, opts, cb) => {
        calls.push(args);
        const limit = Number(args[args.indexOf('--limit') + 1]);
        const out = args[0] === 'chats'
          ? CHATS.slice(0, limit).map(c => JSON.stringify(c)).join('\n')
          : JSON.stringify({ id: 1, text: 'x' });
        setTimeout(() => cb(null, out, ''), delayMs);
      }
    };
  }
  return realRequire.apply(this, arguments);
};

const mode = require(path.join(__dirname, '..', 'mode'));
const { messagesTools } = require(path.join(__dirname, '..', 'messages'));
const tool = (name) => messagesTools.find(t => t.name === name);

(async () => {
  mode.setMode('local');
  console.log('\nLOCAL list-chats / read-messages');

  await check('list-chats without since keeps the old behaviour', async () => {
    calls = [];
    const r = await tool('list-chats').handler({ limit: 20 });
    assert(r.structuredContent.items.length === 20, JSON.stringify(r.structuredContent).slice(0, 80));
    assert(calls[0].includes('20'));
  });

  await check('since returns every chat active in the window, beyond 200', async () => {
    const since = new Date(now - 60 * DAY).toISOString(); // 240 chats in window
    const r = await tool('list-chats').handler({ limit: 1000, since });
    const items = r.structuredContent.items;
    assert(items.length === 241, 'got ' + items.length);
    assert(items.every(c => Date.parse(c.last_message_at) >= Date.parse(since)));
  });

  await check('since still honours limit', async () => {
    const r = await tool('list-chats').handler({ limit: 5, since: new Date(now - 7 * DAY).toISOString() });
    assert(r.structuredContent.items.length === 5);
  });

  await check('an invalid since is rejected by the schema', async () => {
    const { z } = require('zod');
    const schema = z.object(tool('list-chats').inputSchema);
    assert(!schema.safeParse({ since: 'last week' }).success);
    assert(schema.safeParse({ since: '2026-11-01T00:00:00Z' }).success);
  });

  await check('imsg calls run concurrently (no blocking exec)', async () => {
    delayMs = 200;
    const t = Date.now();
    await Promise.all([1, 2, 3, 4, 5].map(id => tool('read-messages').handler({ chatId: id })));
    const elapsed = Date.now() - t;
    delayMs = 0;
    assert(elapsed < 600, 'took ' + elapsed + 'ms for 5 x 200ms calls');
  });

  console.log('\n' + '='.repeat(56));
  console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : 'PASS ' + pass + '  FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
