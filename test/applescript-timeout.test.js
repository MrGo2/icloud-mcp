#!/usr/bin/env node
/**
 * runJXA({ timeoutMs }) kills osascript and rejects instead of hanging.
 *
 * Runs a real osascript (a JXA `delay`, no app is scripted), so it needs
 * macOS; elsewhere it is skipped.
 */

const path = require('path');
const { runJXA } = require(path.join(__dirname, '..', 'utils', 'applescript'));

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + ' -> ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

(async () => {
  if (process.platform !== 'darwin') {
    console.log('\nrunJXA timeout: skipped (needs osascript)');
    process.exit(0);
  }
  console.log('\nrunJXA timeout');
  await check('a script slower than timeoutMs is killed and rejects', async () => {
    const started = Date.now();
    let msg = '';
    try { await runJXA('delay(10); "late"', { timeoutMs: 500 }); } catch (e) { msg = e.message; }
    const took = Date.now() - started;
    assert(msg.startsWith('Timed out after'), 'message: ' + msg);
    assert(took < 3000, 'took ' + took + ' ms');
  });
  await check('a script within timeoutMs resolves normally', async () => {
    const out = await runJXA('"ok"', { timeoutMs: 10000 });
    assert(out === 'ok', out);
  });
  await check('no timeoutMs keeps the old behaviour', async () => {
    const out = await runJXA('"ok"');
    assert(out === 'ok', out);
  });

  console.log('\n' + '='.repeat(56));
  console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : 'PASS ' + pass + '  FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
