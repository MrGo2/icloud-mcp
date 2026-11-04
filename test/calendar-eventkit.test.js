#!/usr/bin/env node
/**
 * list-events in LOCAL mode reads EventKit, falling back to Calendar.app (issue #11).
 *
 * runJXA is stubbed: the generated EventKit script runs in a Node vm against a
 * fake `$` whose authorization status is scripted per case. osascript is never
 * called.
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

const DAY = 24 * 3600 * 1000;
const now = Date.now();

// EKEvents in the store, deliberately unsorted. The recurring one appears as
// three occurrences sharing the series id, as EventKit expands them.
let EK_EVENTS = [];
function resetStore() {
  EK_EVENTS = [
    { id: 'C', title: 'Third', start: now + 3 * DAY, cal: 'Work', location: 'Room 1' },
    { id: 'A', title: 'First', start: now + 1 * DAY, cal: 'Home' },
    { id: 'R', title: 'Weekly', start: now + 2 * DAY, cal: 'Home' },
    { id: 'R', title: 'Weekly', start: now + 9 * DAY, cal: 'Home' },
    { id: 'R', title: 'Weekly', start: now + 16 * DAY, cal: 'Home' },
    { id: 'P', title: 'In progress', start: now - DAY / 24, cal: 'Work' }
  ];
}

// Fake EventKit: status starts at `initial` and becomes `afterRequest` once
// access is requested and `pollsToGrant` run-loop turns have passed.
let ek;
function setEventKit(initial, { afterRequest = initial, pollsToGrant = 1, legacy = false } = {}) {
  ek = { status: initial, afterRequest, pollsToGrant, legacy, requested: null, polls: 0 };
}

function nsDate(ms) {
  return { timeIntervalSince1970: String(ms / 1000), isNil: () => false };
}
function nsArray(items) {
  return { count: items.length, objectAtIndex: (i) => items[i] };
}
function fakeDollar() {
  const store = {
    respondsToSelector: (sel) => sel === 'requestFullAccessToEventsWithCompletion:' && !ek.legacy,
    requestFullAccessToEventsWithCompletion: () => { ek.requested = 'full'; },
    requestAccessToEntityTypeCompletion: () => { ek.requested = 'legacy'; },
    predicateForEventsWithStartDateEndDateCalendars: (s, e) => ({ s, e }),
    eventsMatchingPredicate: () => nsArray(EK_EVENTS.map(ev => ({
      calendarItemIdentifier: ev.id,
      title: ev.title,
      location: ev.location,
      startDate: nsDate(ev.start),
      endDate: nsDate(ev.start + 3600 * 1000),
      calendar: { title: ev.cal }
    })))
  };
  return Object.assign(() => undefined, {
    EKEntityTypeEvent: 0,
    EKEventStore: {
      alloc: { init: store },
      // EventKit hands the status back as a string through the bridge.
      authorizationStatusForEntityType: () => String(ek.status)
    },
    NSDate: {
      dateWithTimeIntervalSince1970: (s) => nsDate(s * 1000),
      dateWithTimeIntervalSinceNow: (s) => nsDate(Date.now() + s * 1000)
    },
    NSRunLoop: {
      currentRunLoop: {
        runUntilDate: () => {
          ek.polls++;
          if (ek.requested && ek.polls >= ek.pollsToGrant) ek.status = ek.afterRequest;
        }
      }
    }
  });
}

let scripts = [];
let appleScriptEvents = [];
const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../utils/applescript') {
    const real = realRequire.apply(this, arguments);
    return {
      ...real,
      runJXA: async (script) => {
        scripts.push(script);
        if (script.includes("ObjC.import('EventKit')")) {
          const ObjC = { import: () => {}, unwrap: (v) => v };
          return vm.runInNewContext(script, { ObjC, $: fakeDollar(), Date, Number, JSON });
        }
        return JSON.stringify(appleScriptEvents);
      }
    };
  }
  return realRequire.apply(this, arguments);
};

const client = require(path.join(__dirname, '..', 'calendar', 'local-client'));

let logs = [];
const realError = console.error;
async function run(count, days) {
  logs = [];
  scripts = [];
  console.error = (...a) => logs.push(a.join(' '));
  try { return await client.listEvents(count, days); }
  finally { console.error = realError; }
}
const calendarAppCalls = () => scripts.filter(s => s.includes("Application('Calendar')")).length;
const KEYS = 'calendar,endDate,id,location,startDate,summary';

(async () => {
  console.log('\nLOCAL list-events via EventKit');
  resetStore();
  appleScriptEvents = [{ id: 'as-1', summary: 'From Calendar.app', startDate: new Date(now + DAY).toISOString(),
    endDate: null, location: '', calendar: 'Home' }];

  await check('full access (3): EventKit is used, Calendar.app is never scripted', async () => {
    setEventKit(3);
    const r = await run(25, 30);
    assert(calendarAppCalls() === 0, 'Calendar.app was scripted');
    assert(ek.requested === null, 'requested access although already granted');
    assert(r.length === 5, 'got ' + r.length);
    assert(logs.length === 0, 'unexpected log: ' + logs.join('|'));
  });

  await check('output shape matches the Calendar.app path, ISO dates, sorted', async () => {
    setEventKit(3);
    const r = await run(25, 30);
    for (const e of r) {
      assert(Object.keys(e).sort().join(',') === KEYS, 'keys: ' + Object.keys(e));
      assert(new Date(e.startDate).toISOString() === e.startDate, 'not ISO: ' + e.startDate);
      assert(typeof e.summary === 'string' && typeof e.location === 'string');
    }
    for (let i = 1; i < r.length; i++) assert(r[i - 1].startDate <= r[i].startDate, 'not sorted');
    assert(r[0].id === 'A' && r[0].calendar === 'Home');
    assert(r.find(e => e.id === 'C').location === 'Room 1');
    assert(r.find(e => e.id === 'A').location === '', 'nil location must become ""');
  });

  await check('events that started before now are excluded, as before', async () => {
    setEventKit(3);
    assert(!(await run(25, 30)).some(e => e.id === 'P'));
  });

  await check('count slices after sorting; daysAhead bounds the window', async () => {
    setEventKit(3);
    const two = await run(2, 30);
    assert(two.map(e => e.id).join() === 'A,R', two.map(e => e.id).join());
    const week = await run(25, 7);
    assert(week.length === 3, 'got ' + week.length);
  });

  await check('recurring occurrences share the series id and all come back', async () => {
    setEventKit(3);
    const r = await run(25, 30);
    assert(r.filter(e => e.id === 'R').length === 3);
  });

  await check('denied (2): falls back to Calendar.app and says so on stderr', async () => {
    setEventKit(2);
    const r = await run(25, 30);
    assert(ek.requested === null, 'must not request when denied');
    assert(calendarAppCalls() === 1, 'Calendar.app not scripted');
    assert(r.length === 1 && r[0].id === 'as-1');
    assert(logs.some(l => /EventKit unavailable \(status 2\)/.test(l)), 'no fallback log: ' + logs);
  });

  await check('restricted (1): falls back without requesting', async () => {
    setEventKit(1);
    const r = await run(25, 30);
    assert(ek.requested === null && r[0].id === 'as-1' && calendarAppCalls() === 1);
  });

  await check('an EventKit script error falls back too', async () => {
    setEventKit(3);
    EK_EVENTS = null; // eventsMatchingPredicate throws
    const r = await run(25, 30);
    resetStore();
    assert(r[0].id === 'as-1' && logs.some(l => /EventKit unavailable/.test(l)));
  });

  await check('script interpolation is coerced: dates via JSON, timeout via asInt', async () => {
    setEventKit(3);
    await run('5', '10');
    const s = scripts[0];
    assert(/new Date\("\d{4}-\d\d-\d\dT[\d:.]+Z"\)/.test(s), 'dates not JSON-quoted ISO');
    assert(/Date\.now\(\) \+ \d+ \* 1000/.test(s), 'deadline not a bare integer');
    let threw = false;
    try { await run(5, '1; do shell script "x"'); } catch { threw = true; }
    assert(threw, 'non-numeric daysAhead reached the script');
  });

  // Request path. Order matters: access is requested once per process.
  await check('not determined (0): requests full access, polls, then uses EventKit', async () => {
    setEventKit(0, { afterRequest: 3, pollsToGrant: 3 });
    const r = await run(25, 30);
    assert(ek.requested === 'full', 'requested: ' + ek.requested);
    assert(ek.polls >= 3, 'polled ' + ek.polls);
    assert(calendarAppCalls() === 0 && r.length === 5);
  });

  await check('after one request, a still-undecided status falls back without asking again', async () => {
    setEventKit(0, { afterRequest: 3 });
    const r = await run(25, 30);
    assert(ek.requested === null, 'asked twice in one process');
    assert(r[0].id === 'as-1' && logs.some(l => /status 0/.test(l)));
  });

  // Fresh module for the remaining request-path cases.
  const freshClient = () => {
    delete require.cache[require.resolve(path.join(__dirname, '..', 'calendar', 'local-client'))];
    return require(path.join(__dirname, '..', 'calendar', 'local-client'));
  };

  await check('write-only (4) on macOS < 14 API: legacy request, denial ends polling early', async () => {
    const c = freshClient();
    setEventKit(4, { afterRequest: 2, legacy: true });
    logs = []; scripts = [];
    console.error = (...a) => logs.push(a.join(' '));
    let r;
    try { r = await c.listEvents(25, 30); } finally { console.error = realError; }
    assert(ek.requested === 'legacy', 'requested: ' + ek.requested);
    assert(ek.polls === 1, 'kept polling after denial: ' + ek.polls);
    assert(r[0].id === 'as-1' && logs.some(l => /status 2/.test(l)));
  });

  console.log('\n' + '='.repeat(56));
  console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : 'PASS ' + pass + '  FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
