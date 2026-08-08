#!/usr/bin/env node
/**
 * Regression guard for the Phase 0 hardening.
 *
 * The important cases here are the negative controls: a payload that WOULD have
 * been injected into AppleScript before the fix must be rejected. A suite that
 * only checks valid input would pass against the vulnerable code too.
 *
 * Run: npm test
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const { validateArgs } = require(path.join(ROOT, 'utils/validate'));
const { asInt, asBool, escapeAppleScript } = require(path.join(ROOT, 'utils/applescript'));

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

// The payload that made the unvalidated numeric arguments exploitable: it
// closes the tell block, runs a shell command, and reopens it so the script
// still parses.
const EXPLOIT = '1\nend tell\ndo shell script "touch /tmp/icloud-mcp-pwned"\ntell window 1';

console.log('\nScript-interpolation coercion (asInt / asBool)');
check('accepts a real number', () => assert(asInt(3, 0) === 3));
check('accepts a numeric string', () => assert(asInt('7', 0) === 7));
check('falls back for undefined', () => assert(asInt(undefined, 5) === 5));
check('REJECTS the AppleScript exploit payload', () => throws(() => asInt(EXPLOIT, 0)));
check('REJECTS a non-numeric string', () => throws(() => asInt('abc', 0)));
check('accepts booleans and "false"', () => {
  assert(asBool(true) === true);
  assert(asBool('false') === false);
});
check('REJECTS an injected boolean', () => throws(() => asBool('true; do shell script "x"')));

console.log('\nTool argument validation against inputSchema');
const numericSchema = {
  type: 'object',
  properties: { windowIndex: { type: 'number' }, tabIndex: { type: 'number' } },
  required: []
};
check('valid numbers pass through', () => {
  const out = validateArgs('close-safari-tab', numericSchema, { windowIndex: 0, tabIndex: 2 });
  assert(out.windowIndex === 0 && out.tabIndex === 2);
});
check('numeric strings are coerced', () => {
  const out = validateArgs('close-safari-tab', numericSchema, { windowIndex: '1' });
  assert(out.windowIndex === 1 && typeof out.windowIndex === 'number');
});
check('REJECTS the exploit payload in a number field', () => {
  throws(() => validateArgs('close-safari-tab', numericSchema, { windowIndex: EXPLOIT }));
});
check('REJECTS a missing required argument', () => {
  throws(() => validateArgs('send-message', {
    type: 'object', properties: { to: { type: 'string' } }, required: ['to']
  }, {}));
});

const enumSchema = {
  type: 'object',
  properties: { mode: { type: 'string', enum: ['local', 'cloud'] } },
  required: ['mode']
};
check('REJECTS a value outside an enum', () => throws(() => validateArgs('set-mode', enumSchema, { mode: 'root' })));
check('accepts a valid enum value', () => {
  assert(validateArgs('set-mode', enumSchema, { mode: 'cloud' }).mode === 'cloud');
});

console.log('\ncreate-note builds real <br> breaks');
check('newlines survive escaping as <br>', () => {
  const html = String('line one\nline two').split('\n').map(escapeAppleScript).join('<br>');
  assert(html === 'line one<br>line two', 'got: ' + html);
});

console.log('\nTool registry');
const dirs = ['auth', 'email', 'calendar', 'contacts', 'reminders', 'notes', 'messages', 'safari'];
let total = 0;
check('every module loads and exports a tools array', () => {
  for (const d of dirs) {
    const mod = require(path.join(ROOT, d));
    const key = Object.keys(mod).find(k => k.endsWith('Tools'));
    assert(Array.isArray(mod[key]), d + ' exports no tools array');
    total += mod[key].length;
  }
});
check('every tool is well formed', () => {
  const seen = new Set();
  for (const d of dirs) {
    const mod = require(path.join(ROOT, d));
    const key = Object.keys(mod).find(k => k.endsWith('Tools'));
    for (const t of mod[key]) {
      assert(typeof t.name === 'string' && t.name, d + ': tool without a name');
      assert(!seen.has(t.name), 'duplicate tool name: ' + t.name);
      seen.add(t.name);
      assert(typeof t.description === 'string' && t.description, t.name + ': no description');
      assert(t.inputSchema && t.inputSchema.type === 'object', t.name + ': bad inputSchema');
      assert(typeof t.handler === 'function', t.name + ': handler is not a function');
    }
  }
});

console.log('\nError handling contract');
check('error-handler exports what the modules import', () => {
  const eh = require(path.join(ROOT, 'utils/error-handler'));
  for (const fn of ['formatError', 'formatSuccess', 'withErrorHandler']) {
    assert(typeof eh[fn] === 'function', 'missing export: ' + fn);
  }
});
check('formatError marks the result as isError', () => {
  const { formatError } = require(path.join(ROOT, 'utils/error-handler'));
  assert(formatError(new Error('boom')).isError === true);
});
check('formatSuccess does not', () => {
  const { formatSuccess } = require(path.join(ROOT, 'utils/error-handler'));
  assert(!formatSuccess('ok').isError);
});

console.log('\n' + '='.repeat(52));
console.log('tools registered: ' + total);
console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : 'PASS ' + pass + '  FAIL ' + fail);
process.exit(fail === 0 ? 0 : 1);
