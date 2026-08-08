#!/usr/bin/env node
/**
 * Regression guard for the MCP server.
 *
 * The important cases are the negative controls: a payload that WOULD have been
 * injected into AppleScript before hardening must be rejected. A suite that only
 * checked valid input would pass against the vulnerable code too.
 *
 * Includes a live end-to-end run of the real server over stdio, which is the
 * only check that covers registration, validation and framing together.
 *
 * Run: npm test
 */

const path = require('path');
const { spawn } = require('child_process');
const { z } = require('zod');

const ROOT = path.join(__dirname, '..');
const { asInt, asBool, escapeAppleScript } = require(path.join(ROOT, 'utils/applescript'));
const { listOutput, listResult } = require(path.join(ROOT, 'utils/schemas'));

let pass = 0, fail = 0;

function check(name, fn) {
  try { fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + ' -> ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function throws(fn, why) {
  let threw = false;
  try { fn(); } catch (e) { threw = true; }
  assert(threw, why || 'expected a throw, got none');
}

// Closes the tell block, runs a shell command, reopens it so the script parses.
const EXPLOIT = '1\nend tell\ndo shell script "touch /tmp/icloud-mcp-pwned"\ntell window 1';

const DIRS = ['auth', 'email', 'calendar', 'contacts', 'reminders', 'notes', 'messages', 'safari'];

function allTools() {
  const out = [];
  for (const d of DIRS) {
    const mod = require(path.join(ROOT, d));
    const key = Object.keys(mod).find(k => k.endsWith('Tools'));
    for (const t of mod[key]) out.push(t);
  }
  return out;
}

console.log('\nTool registry contract');
const tools = allTools();
check('every tool has name, title, description, inputSchema, handler', () => {
  const seen = new Set();
  for (const t of tools) {
    assert(t.name, 'tool without a name');
    assert(!seen.has(t.name), 'duplicate tool name: ' + t.name);
    seen.add(t.name);
    assert(t.title, t.name + ': no title');
    assert(t.description, t.name + ': no description');
    assert(t.inputSchema !== undefined, t.name + ': no inputSchema');
    assert(typeof t.handler === 'function', t.name + ': handler is not a function');
  }
});
check('every inputSchema field is a zod schema, not JSON Schema', () => {
  for (const t of tools) {
    assert(t.inputSchema.type !== 'object', t.name + ': still a raw JSON Schema');
    for (const [k, v] of Object.entries(t.inputSchema)) {
      assert(v && typeof v.safeParse === 'function', `${t.name}.${k} is not a zod schema`);
    }
  }
});
check('every tool declares annotations', () => {
  for (const t of tools) assert(t.annotations, t.name + ': no annotations');
});
check('every list-* tool declares an outputSchema', () => {
  const missing = tools.filter(t => t.name.startsWith('list-') && !t.outputSchema).map(t => t.name);
  assert(missing.length === 0, 'missing outputSchema: ' + missing.join(', '));
});
check('destructive tools are annotated destructive', () => {
  for (const name of ['delete-event', 'delete-contact', 'delete-reminder', 'close-safari-tab']) {
    const t = tools.find(x => x.name === name);
    assert(t, 'missing tool ' + name);
    assert(t.annotations.destructiveHint === true, name + ': not marked destructive');
  }
});
check('read-only tools are annotated read-only', () => {
  for (const name of ['list-contacts', 'search-contacts', 'read-note', 'list-events']) {
    const t = tools.find(x => x.name === name);
    assert(t.annotations.readOnlyHint === true, name + ': not marked read-only');
  }
});

console.log('\nzod schemas reject the injection class');
function schemaFor(toolName) {
  const t = tools.find(x => x.name === toolName);
  assert(t, 'no such tool: ' + toolName);
  return z.object(t.inputSchema);
}
check('close-safari-tab REJECTS the AppleScript exploit payload', () => {
  assert(!schemaFor('close-safari-tab').safeParse({ windowIndex: EXPLOIT }).success);
});
check('close-safari-tab accepts a real index', () => {
  assert(schemaFor('close-safari-tab').safeParse({ windowIndex: 0, tabIndex: 2 }).success);
});
check('reminders priority REJECTS a string', () => {
  assert(!schemaFor('create-reminder').safeParse({ name: 'x', priority: '1; evil' }).success);
});
check('set-mode REJECTS an unknown mode', () => {
  assert(!schemaFor('set-mode').safeParse({ mode: 'root' }).success);
});
check('set-mode accepts local and cloud', () => {
  assert(schemaFor('set-mode').safeParse({ mode: 'local' }).success);
  assert(schemaFor('set-mode').safeParse({ mode: 'cloud' }).success);
});
check('count over the documented max is REJECTED', () => {
  assert(!schemaFor('list-emails').safeParse({ count: 999 }).success);
});
check('required args are enforced', () => {
  assert(!schemaFor('read-note').safeParse({}).success);
});

console.log('\nScript-interpolation coercion still guards (defence in depth)');
check('asInt REJECTS the exploit payload', () => throws(() => asInt(EXPLOIT, 0)));
check('asInt accepts numbers and numeric strings', () => {
  assert(asInt(3, 0) === 3);
  assert(asInt('7', 0) === 7);
  assert(asInt(undefined, 5) === 5);
});
check('asBool REJECTS an injected string', () => throws(() => asBool('true; do shell script "x"')));
check('asBool accepts booleans', () => {
  assert(asBool(true) === true);
  assert(asBool('false') === false);
});

console.log('\nDual-mode routing (email + calendar)');
{
  // Stub both clients so we can see which one a handler reaches, without
  // touching Mail.app, Calendar.app or the network.
  const Module = require('module');
  const calls = [];
  const realRequire = Module.prototype.require;
  const stub = (label, fns) => {
    const out = {};
    for (const f of fns) out[f] = async () => { calls.push(label + '.' + f); return []; };
    return out;
  };
  Module.prototype.require = function (id) {
    if (id === './local-client' && this.filename.includes('/email/')) {
      return stub('email-LOCAL', ['listEmails', 'listFolders']);
    }
    if (id === './imap-client') return stub('email-CLOUD', ['listEmails', 'listFolders']);
    if (id === './local-client' && this.filename.includes('/calendar/')) {
      return stub('cal-LOCAL', ['listEvents', 'listCalendars']);
    }
    if (id === './caldav-client') return stub('cal-CLOUD', ['listEvents', 'getCalendars']);
    return realRequire.apply(this, arguments);
  };

  for (const k of Object.keys(require.cache)) {
    if (/\/(email|calendar)\/index\.js$/.test(k)) delete require.cache[k];
  }

  const mode = require(path.join(ROOT, 'mode'));
  const originalMode = mode.getMode();
  const { emailTools } = require(path.join(ROOT, 'email'));
  const { calendarTools } = require(path.join(ROOT, 'calendar'));
  const byName = n => [...emailTools, ...calendarTools].find(t => t.name === n);

  const exercise = async () => {
    calls.length = 0;
    await byName('list-emails').handler({ folder: 'inbox', count: 5 });
    await byName('list-folders').handler({});
    await byName('list-events').handler({ count: 5, daysAhead: 7 });
    await byName('list-calendars').handler({});
    return calls.join(',');
  };

  let localCalls, cloudCalls;
  const done = (async () => {
    mode.setMode('local');
    localCalls = await exercise();
    mode.setMode('cloud');
    cloudCalls = await exercise();
    mode.setMode(originalMode);
  })();

  done.then(() => {
    check('LOCAL mode reaches the AppleScript clients', () => {
      assert(/email-LOCAL\.listEmails/.test(localCalls), 'email not routed local: ' + localCalls);
      assert(/cal-LOCAL\.listEvents/.test(localCalls), 'calendar not routed local: ' + localCalls);
    });
    check('CLOUD mode reaches the IMAP/CalDAV clients', () => {
      assert(/email-CLOUD\.listEmails/.test(cloudCalls), 'email not routed cloud: ' + cloudCalls);
      assert(/cal-CLOUD\.getCalendars/.test(cloudCalls), 'calendar not routed cloud: ' + cloudCalls);
    });
    check('no local client is reached in cloud mode', () => {
      assert(!/-LOCAL\./.test(cloudCalls), 'local client leaked into cloud mode: ' + cloudCalls);
    });
    Module.prototype.require = realRequire;
    for (const k of Object.keys(require.cache)) {
      if (/\/(email|calendar)\/index\.js$/.test(k)) delete require.cache[k];
    }
  });
}

console.log('\nStructured output contract');
check('listResult always satisfies listOutput', () => {
  const schema = z.object(listOutput('test'));
  const cases = [[], [{ id: 'x', name: 'A' }], [{ a: 1, nested: { b: [1, 2] } }], null, undefined];
  for (const c of cases) {
    const r = schema.safeParse(listResult(c));
    assert(r.success, 'failed for ' + JSON.stringify(c));
  }
});

console.log('\nupdate-event preserves properties it does not touch');
{
  const { applyICalChanges } = require(path.join(ROOT, 'calendar/caldav-client'));
  const ICAL = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT',
    'UID:abc-123@icloud-mcp', 'DTSTAMP:20260101T090000Z',
    'DTSTART:20260115T100000Z', 'DTEND:20260115T110000Z',
    'SUMMARY:Old title', 'RRULE:FREQ=WEEKLY;COUNT=10',
    'ATTENDEE;CN=Someone:mailto:someone@example.com',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');

  check('replaces SUMMARY', () => {
    const out = applyICalChanges(ICAL, { summary: 'New title' });
    assert(out.includes('SUMMARY:New title') && !out.includes('SUMMARY:Old title'));
  });
  check('PRESERVES RRULE, ATTENDEE, VALARM and UID', () => {
    const out = applyICalChanges(ICAL, { summary: 'New title' });
    for (const keep of ['RRULE:FREQ=WEEKLY;COUNT=10', 'ATTENDEE;CN=Someone', 'BEGIN:VALARM', 'UID:abc-123@icloud-mcp']) {
      assert(out.includes(keep), 'lost: ' + keep);
    }
  });
  check('inserts an absent property inside VEVENT', () => {
    const out = applyICalChanges(ICAL, { location: 'Madrid' });
    assert(out.includes('LOCATION:Madrid'));
    assert(out.indexOf('LOCATION:Madrid') < out.indexOf('END:VEVENT'));
  });
  check('always refreshes DTSTAMP', () => {
    assert(!applyICalChanges(ICAL, { summary: 'x' }).includes('DTSTAMP:20260101T090000Z'));
  });
}

console.log('\ncreate-note builds real <br> breaks');
check('newlines survive escaping as <br>', () => {
  const html = String('line one\nline two').split('\n').map(escapeAppleScript).join('<br>');
  assert(html === 'line one<br>line two', 'got: ' + html);
});

console.log('\nError handling contract');
check('error-handler exports what the modules import', () => {
  const eh = require(path.join(ROOT, 'utils/error-handler'));
  for (const fn of ['formatError', 'formatSuccess', 'withErrorHandler']) {
    assert(typeof eh[fn] === 'function', 'missing export: ' + fn);
  }
});
check('formatError marks isError, formatSuccess does not', () => {
  const { formatError, formatSuccess } = require(path.join(ROOT, 'utils/error-handler'));
  assert(formatError(new Error('boom')).isError === true);
  assert(!formatSuccess('ok').isError);
});
check('formatSuccess only adds structuredContent when given', () => {
  const { formatSuccess } = require(path.join(ROOT, 'utils/error-handler'));
  assert(!('structuredContent' in formatSuccess('ok')));
  assert(formatSuccess('ok', { items: [], total: 0 }).structuredContent.total === 0);
});

/**
 * Live end-to-end run against the real server over stdio.
 */
function runServer(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'index.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('server timed out')); }, 20000);
    child.stdout.on('data', c => { out += c; });
    child.on('error', reject);
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l)));
    });
    child.stdin.write(requests.map(r => JSON.stringify(r)).join('\n') + '\n');
    child.stdin.end();
  });
}

(async () => {
  console.log('\nLive end-to-end over stdio');
  let responses;
  try {
    responses = await runServer([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'about', arguments: {} } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'close-safari-tab', arguments: { windowIndex: EXPLOIT } } },
      { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'set-mode', arguments: { mode: 'root' } } }
    ]);
  } catch (e) {
    console.log('  FAIL  server run -> ' + e.message);
    fail++;
    responses = [];
  }

  const byId = new Map(responses.map(r => [r.id, r]));

  check('initialize negotiates a modern protocol version', () => {
    const r = byId.get(1);
    assert(r && r.result, 'no initialize response');
    assert(/^\d{4}-\d{2}-\d{2}$/.test(r.result.protocolVersion), 'bad version');
    assert(r.result.protocolVersion >= '2025-03-26', 'stale protocol: ' + r.result.protocolVersion);
  });
  check('server advertises tools.listChanged', () => {
    assert(byId.get(1).result.capabilities.tools.listChanged === true);
  });
  check('tools/list returns every tool with title and annotations', () => {
    const t = byId.get(2).result.tools;
    assert(t.length === tools.length, `expected ${tools.length}, got ${t.length}`);
    assert(t.every(x => x.title), 'a tool is missing title');
    assert(t.every(x => x.annotations), 'a tool is missing annotations');
  });
  check('advertised schemas are JSON Schema with typed properties', () => {
    const tab = byId.get(2).result.tools.find(x => x.name === 'close-safari-tab');
    assert(tab.inputSchema.properties.windowIndex.type === 'integer', 'windowIndex not typed integer');
  });
  check('about succeeds', () => {
    const r = byId.get(3);
    assert(!r.result.isError, 'about failed: ' + JSON.stringify(r.result).slice(0, 120));
  });
  check('LIVE: injection payload is rejected, not executed', () => {
    const r = byId.get(4);
    assert(r.result && r.result.isError === true, 'injection was not rejected');
    assert(/validation|expected number|Invalid/i.test(r.result.content[0].text), 'not a validation error');
    assert(!require('fs').existsSync('/tmp/icloud-mcp-pwned'), 'EXPLOIT EXECUTED');
  });
  check('LIVE: invalid enum is rejected', () => {
    const r = byId.get(5);
    assert(r.result && r.result.isError === true, 'bad enum accepted');
  });

  console.log('\n' + '='.repeat(52));
  console.log('tools registered: ' + tools.length);
  console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : 'PASS ' + pass + '  FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
