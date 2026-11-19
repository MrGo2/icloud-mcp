#!/usr/bin/env node
/**
 * Recurring and all-day events in create-event / update-event / list-events (issue #30).
 *
 * osascript, tsdav and the credential store are stubbed: the tests read the
 * AppleScript and iCalendar the clients would send, and never touch
 * Calendar.app or iCloud.
 */

// West of Greenwich, where reading a bare date as UTC midnight lands on the
// previous day. Set before any Date is built so the date tests mean something.
process.env.TZ = 'America/Los_Angeles';

const path = require('path');
const Module = require('module');
const { z } = require('zod');
const ICAL = require('ical.js');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); console.log('  PASS  ' + name); pass++; }
  catch (e) { console.log('  FAIL  ' + name + ' -> ' + e.message); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
async function rejects(fn, pattern) {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  assert(error, 'expected an error, got none');
  if (pattern) assert(pattern.test(error.message), 'unexpected error: ' + error.message);
}

// Stubs ------------------------------------------------------------------

const scripts = [];
let appleScriptResult = 'UID-1';
// What Calendar.app answers to the clear-recurrence and delete scripts, which
// report which attempt worked after checking the result.
let clearReply = 'cleared:empty';
let deleteReply = 'deleted:direct';
const icsSent = [];
let listedEvents = [];

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../utils/applescript' && this.filename.includes(`${path.sep}calendar${path.sep}`)) {
    const real = realRequire.apply(this, arguments);
    return {
      ...real,
      runAppleScript: async (script) => {
        scripts.push(script);
        if (appleScriptResult === 'not found') return 'not found';
        if (script.includes('"cleared:none"')) return clearReply;
        if (script.includes('"deleted:direct"')) return deleteReply;
        return appleScriptResult;
      },
      runJXA: async (script) => {
        scripts.push(script);
        if (script.includes("ObjC.import('EventKit')")) return JSON.stringify({ status: 2, requested: false, events: null });
        return JSON.stringify(listedEvents);
      }
    };
  }
  if (id === 'tsdav') {
    return {
      DAVClient: class {
        async login() {}
        async fetchCalendars() { return [{ url: 'https://caldav.example/cal/', displayName: 'Test' }]; }
        async createCalendarObject({ iCalString }) { icsSent.push(iCalString); return { url: 'https://caldav.example/cal/x.ics' }; }
      }
    };
  }
  if (id === '../auth' && this.filename.includes(`${path.sep}calendar${path.sep}`)) {
    return { getCredentials: () => ({ email: 'user@example.com', password: 'not-a-real-password' }) };
  }
  return realRequire.apply(this, arguments);
};

const { normalizeRecurrence, allDayRange, allDayDate, parseEventDate } = require(path.join(ROOT, 'calendar/recurrence'));
const local = require(path.join(ROOT, 'calendar/local-client'));
const cloud = require(path.join(ROOT, 'calendar/caldav-client'));
const mode = require(path.join(ROOT, 'mode'));
const { calendarTools } = require(path.join(ROOT, 'calendar'));
const tool = name => calendarTools.find(t => t.name === name);
const schemaFor = name => z.object(tool(name).inputSchema);

const EXPLOIT_AS = 'FREQ=YEARLY"\nend tell\ndo shell script "touch /tmp/icloud-mcp-pwned"\ntell application "Calendar';
const EXPLOIT_ICS = 'FREQ=DAILY\r\nATTENDEE:mailto:attacker@example.com';

const lastScript = () => scripts[scripts.length - 1] || '';
const lastIcs = () => icsSent[icsSent.length - 1] || '';
const veventOf = ics => new ICAL.Component(ICAL.parse(ics)).getFirstSubcomponent('vevent');

(async () => {
  console.log('\nRRULE validation');

  await check('accepts the rules from the issue and normalizes case and prefix', () => {
    assert(normalizeRecurrence('FREQ=YEARLY') === 'FREQ=YEARLY');
    assert(normalizeRecurrence('FREQ=WEEKLY;BYDAY=MO') === 'FREQ=WEEKLY;BYDAY=MO');
    assert(normalizeRecurrence('FREQ=MONTHLY;COUNT=12') === 'FREQ=MONTHLY;COUNT=12');
    assert(normalizeRecurrence('rrule:freq=daily;interval=2') === 'FREQ=DAILY;INTERVAL=2');
    assert(normalizeRecurrence('FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20271231T235959Z') === 'FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20271231T235959Z');
    assert(normalizeRecurrence('FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14;WKST=MO') === 'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14;WKST=MO');
  });

  await check('empty string means remove; undefined means leave alone', () => {
    assert(normalizeRecurrence('') === '');
    assert(normalizeRecurrence('  ') === '');
    assert(normalizeRecurrence(undefined) === undefined);
  });

  await check('"RRULE:" alone is an error, not a request to remove the recurrence', async () => {
    await rejects(() => normalizeRecurrence('RRULE:'), /Invalid recurrence/);
  });

  await check('rule-part ranges follow RFC 5545', async () => {
    for (const ok of ['FREQ=MONTHLY;BYMONTHDAY=-1', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1', 'FREQ=MONTHLY;BYDAY=+2TU',
      'FREQ=YEARLY;BYYEARDAY=366', 'FREQ=YEARLY;BYWEEKNO=-53', 'FREQ=DAILY;BYHOUR=0,23;BYMINUTE=59', 'FREQ=YEARLY;UNTIL=20280229']) {
      assert(normalizeRecurrence(ok) === ok, 'rejected ' + ok);
    }
    for (const bad of ['FREQ=YEARLY;BYMONTH=0', 'FREQ=YEARLY;BYMONTH=13', 'FREQ=YEARLY;BYMONTH=-1', 'FREQ=DAILY;BYHOUR=24',
      'FREQ=MONTHLY;BYMONTHDAY=0', 'FREQ=MONTHLY;BYMONTHDAY=32', 'FREQ=WEEKLY;BYDAY=0MO', 'FREQ=YEARLY;BYDAY=54MO',
      'FREQ=MONTHLY;BYSETPOS=0', 'FREQ=DAILY;UNTIL=20261399', 'FREQ=DAILY;UNTIL=20260101T999999Z', 'FREQ=YEARLY;UNTIL=20270229']) {
      await rejects(() => normalizeRecurrence(bad), /Invalid recurrence/);
    }
  });

  await check('every accepted rule parses in ical.js', () => {
    for (const rule of ['FREQ=YEARLY', 'FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2', 'FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20271231T235959Z',
      'FREQ=YEARLY;BYMONTH=3;BYMONTHDAY=14;WKST=MO', 'FREQ=MONTHLY;BYDAY=MO;BYSETPOS=-1;COUNT=6']) {
      ICAL.Recur.fromString(normalizeRecurrence(rule));
    }
  });

  await check('REJECTS rules that are not RRULEs', async () => {
    for (const bad of ['COUNT=3;FREQ=DAILY', 'FREQ=FORTNIGHTLY', 'FREQ=DAILY;FOO=1', 'FREQ=DAILY;COUNT=2;COUNT=3',
      'FREQ=DAILY;COUNT=2;UNTIL=20270101', 'FREQ=WEEKLY;BYDAY=XX', 'FREQ=DAILY;', 'FREQ=DAILY;COUNT=0',
      'FREQ=DAILY;UNTIL=2027-01-01', 'FREQ=DAILY;' + 'BYHOUR=1,'.repeat(80) + '1']) {
      await rejects(() => normalizeRecurrence(bad), /Invalid recurrence/);
    }
  });

  await check('REJECTS AppleScript and iCalendar injection payloads', async () => {
    await rejects(() => normalizeRecurrence(EXPLOIT_AS), /Invalid recurrence/);
    await rejects(() => normalizeRecurrence(EXPLOIT_ICS), /Invalid recurrence/);
    await rejects(() => normalizeRecurrence('FREQ=DAILY\\'), /Invalid recurrence/);
  });

  await check('zod schema rejects the payloads at the boundary and accepts real rules', () => {
    const create = schemaFor('create-event');
    const base = { summary: 'x', start: '2026-12-25', end: '2026-12-25' };
    assert(!create.safeParse({ ...base, recurrence: EXPLOIT_AS }).success, 'AppleScript payload passed zod');
    assert(!create.safeParse({ ...base, recurrence: EXPLOIT_ICS }).success, 'iCalendar payload passed zod');
    assert(!create.safeParse({ ...base, allDay: 'true; evil' }).success, 'allDay accepted a string');
    assert(create.safeParse({ ...base, recurrence: 'FREQ=YEARLY', allDay: true }).success);
    assert(schemaFor('update-event').safeParse({ eventUrl: 'x', recurrence: '' }).success, 'empty recurrence rejected');
  });

  console.log('\nAll-day dates');

  await check('a bare date is local midnight, not UTC midnight', () => {
    const d = parseEventDate('2026-12-25');
    assert(d.getFullYear() === 2026 && d.getMonth() === 11 && d.getDate() === 25 && d.getHours() === 0);
  });

  await check('impossible dates and trailing garbage are rejected, not rolled over', async () => {
    await rejects(() => parseEventDate('2026-02-30'), /Invalid date/);
    await rejects(() => allDayDate('2026-13-45'), /Invalid date/);
    await rejects(() => allDayDate('2026-12-25junk'), /Invalid date/);
    assert(allDayDate('2026-12-25T10:00:00').getDate() === 25);
  });

  await check('end is exclusive; an end on or before start means one day', () => {
    const one = allDayRange('2026-12-25', '2026-12-25');
    assert(one.endDay.getDate() === 26, 'same-day end not widened');
    const two = allDayRange('2026-12-25', '2026-12-27');
    assert(two.endDay.getDate() === 27, 'explicit end changed');
    const utc = allDayRange('2026-12-25T00:00:00Z', '2026-12-25T00:00:00Z');
    assert(utc.startDay.getDate() === 25, 'UTC timestamp shifted the day');
  });

  console.log('\nLOCAL create-event / update-event (AppleScript)');

  await check('create sets the recurrence after making the event', async () => {
    await local.createEvent({ summary: 'Birthday', start: '2026-12-25T10:00:00', end: '2026-12-25T11:00:00', calendarName: 'Home', recurrence: 'FREQ=YEARLY' });
    const s = lastScript();
    assert(s.includes('set recurrence of newEvent to "FREQ=YEARLY"'), 'no recurrence line');
    assert(s.indexOf('make new event') < s.indexOf('set recurrence'), 'recurrence set before the event exists');
    assert(!s.includes('allday event'), 'timed event marked all-day');
  });

  await check('create without recurrence emits no recurrence line', async () => {
    await local.createEvent({ summary: 'Once', start: '2026-12-25T10:00:00', end: '2026-12-25T11:00:00' });
    assert(!lastScript().includes('recurrence'));
  });

  await check('all-day create: flag set, bare dates land on the right local days', async () => {
    await local.createEvent({ summary: 'Holiday', start: '2026-12-25', end: '2026-12-25', allDay: true, recurrence: 'FREQ=YEARLY' });
    const s = lastScript();
    assert(s.includes('allday event:true'), 'not all-day');
    assert(/set day of newStart to 25/.test(s) && /set time of newStart to 0\b/.test(s), 'start day wrong');
    // Calendar.app reads next-day midnight as a second day; EventKit itself
    // ends a one-day event at 23:59:59.
    assert(/set day of newEnd to 25/.test(s) && /set time of newEnd to 86399/.test(s), 'end is not the last second of the 25th');
  });

  await check('a multi-day all-day event ends on its last day', async () => {
    await local.createEvent({ summary: 'Trip', start: '2026-12-25', end: '2026-12-28', allDay: true });
    assert(/set day of newEnd to 27/.test(lastScript()) && /set time of newEnd to 86399/.test(lastScript()));
  });

  await check('UNTIL must match the start type', async () => {
    await rejects(() => local.createEvent({ summary: 'x', start: '2026-12-25', end: '2026-12-25', allDay: true, recurrence: 'FREQ=YEARLY;UNTIL=20301231T235959Z' }), /UNTIL as a date/);
    await rejects(() => cloud.createEvent({ summary: 'x', start: '2026-12-25T10:00:00Z', end: '2026-12-25T11:00:00Z', recurrence: 'FREQ=YEARLY;UNTIL=20301231' }), /UTC date-time/);
  });

  await check('an invalid rule throws before osascript runs', async () => {
    const before = scripts.length;
    await rejects(() => local.createEvent({ summary: 'x', start: '2026-12-25', end: '2026-12-25', recurrence: EXPLOIT_AS }), /Invalid recurrence/);
    await rejects(() => local.updateEvent('UID-1', { recurrence: EXPLOIT_AS }), /Invalid recurrence/);
    assert(scripts.length === before, 'osascript ran');
  });

  await check('update sets a rule, and an empty string clears it', async () => {
    await local.updateEvent('UID-1', { recurrence: 'FREQ=WEEKLY;BYDAY=MO' });
    assert(lastScript().includes('set recurrence of theEvent to "FREQ=WEEKLY;BYDAY=MO"'));
    const r = await local.updateEvent('UID-1', { recurrence: '' });
    assert(r.success === true && r.method === 'empty', JSON.stringify(r));
  });

  await check('clearing tries EventKit, then each Calendar.app way, checking after each', async () => {
    scripts.length = 0;
    await local.updateEvent('UID-1', { recurrence: '' });
    assert(scripts[0].includes("ObjC.import('EventKit')") && scripts[0].includes('removeRecurrenceRule'), 'EventKit not tried first');
    const s = lastScript();
    const order = ['set recurrence of theEvent to ""', 'set recurrence of theEvent to missing value', 'set recurrence of theEvent to "FREQ=DAILY;COUNT=1"']
      .map(step => s.indexOf(step));
    assert(order.every(i => i !== -1) && order[0] < order[1] && order[1] < order[2], 'attempts missing or out of order');
    assert((s.match(/set r to recurrence of theEvent/g) || []).length === 4, 'not every attempt is checked');
  });

  await check('a recurrence Calendar.app will not drop is an error, not a silent success', async () => {
    clearReply = 'failed:FREQ=YEARLY;INTERVAL=1';
    try {
      const r = await local.updateEvent('UID-1', { recurrence: '' });
      assert(r.success === false && /kept the recurrence/.test(r.message), JSON.stringify(r));
    } finally { clearReply = 'cleared:empty'; }
  });

  await check('delete checks what is left after each attempt and restores the rule on failure', async () => {
    const r = await local.deleteEvent('UID-1');
    assert(r.success === true && r.method === 'direct', JSON.stringify(r));
    const s = lastScript();
    assert((s.match(/count of \(every event of theCal whose uid is "UID-1"\)/g) || []).length === 3, 'an attempt is not checked');
    assert(s.indexOf('delete theEvent') < s.indexOf('delete (every event of theCal'), 'direct delete not first');
    assert(/set recurrence of \(first event of theCal whose uid is "UID-1"\) to original/.test(s), 'rule not restored on failure');
  });

  await check('a recurring event Calendar.app will not delete is an error', async () => {
    deleteReply = 'failed:recurring';
    try {
      const r = await local.deleteEvent('UID-1');
      assert(r.success === false && /did not delete this recurring event/.test(r.message), JSON.stringify(r));
    } finally { deleteReply = 'deleted:direct'; }
  });

  await check('update finds the event first and writes outside the lookup try', async () => {
    await local.updateEvent('UID-1', { summary: 'New' });
    const s = lastScript();
    const lookupEnd = s.indexOf('end repeat');
    assert(lookupEnd !== -1 && s.indexOf('set summary of theEvent') > lookupEnd, 'write still inside the lookup');
    assert(s.includes('if theEvent is missing value then return "not found"'));
  });

  await check('update toggles allDay before touching the dates', async () => {
    await local.updateEvent('UID-1', { allDay: true, start: '2026-12-25', end: '2026-12-25' });
    const s = lastScript();
    assert(s.includes('set allday event of theEvent to true'));
    assert(s.indexOf('set allday event') < s.indexOf('set start date'), 'dates set before the flag');
    assert(/set day of newEnd to 25/.test(s) && /set time of newEnd to 86399/.test(s), 'all-day end not on the last day');
    await local.updateEvent('UID-1', { allDay: false });
    assert(lastScript().includes('set allday event of theEvent to false'));
    // A UTC timestamp still names the 25th, even eight hours west of Greenwich.
    await local.updateEvent('UID-1', { allDay: true, start: '2026-12-25T00:00:00Z' });
    assert(/set day of newStart to 25/.test(lastScript()) && /set time of newStart to 0\b/.test(lastScript()), 'start moved to the 24th');
  });

  console.log('\nCLOUD create-event (CalDAV)');

  await check('timed recurring event: RRULE line inside VEVENT, valid iCalendar', async () => {
    await cloud.createEvent({ summary: 'Standup', start: '2026-12-21T09:00:00Z', end: '2026-12-21T09:15:00Z', recurrence: 'FREQ=WEEKLY;BYDAY=MO' });
    const vevent = veventOf(lastIcs());
    assert(vevent.getFirstPropertyValue('rrule').toString() === 'FREQ=WEEKLY;BYDAY=MO', 'RRULE missing');
    const it = new ICAL.Event(vevent).iterator();
    it.next();
    const second = it.next().toJSDate();
    assert(second.toISOString() === '2026-12-28T09:00:00.000Z', 'second occurrence: ' + second.toISOString());
  });

  await check('all-day yearly event: DATE values, exclusive end, repeats next year', async () => {
    await cloud.createEvent({ summary: 'Holiday', start: '2026-12-25', end: '2026-12-25', allDay: true, recurrence: 'FREQ=YEARLY' });
    const ics = lastIcs();
    assert(ics.includes('DTSTART;VALUE=DATE:20261225') && ics.includes('DTEND;VALUE=DATE:20261226'), ics);
    const it = new ICAL.Event(veventOf(ics)).iterator();
    it.next();
    assert(it.next().toString() === '2027-12-25', 'no 2027 occurrence');
  });

  await check('no RRULE without a recurrence; injection payload never reaches the ICS', async () => {
    await cloud.createEvent({ summary: 'Once', start: '2026-12-21T09:00:00Z', end: '2026-12-21T10:00:00Z' });
    assert(!lastIcs().includes('RRULE'));
    const sent = icsSent.length;
    await rejects(() => cloud.createEvent({ summary: 'x', start: '2026-12-21', end: '2026-12-21', recurrence: EXPLOIT_ICS }), /Invalid recurrence/);
    assert(icsSent.length === sent, 'ICS was sent');
  });

  await check('ICS lines end in CRLF and long lines fold at 75 octets', async () => {
    const longTitle = 'Revisión trimestral del año '.repeat(5);
    await cloud.createEvent({ summary: longTitle, start: '2026-12-21T09:00:00Z', end: '2026-12-21T10:00:00Z', recurrence: 'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12' });
    const ics = lastIcs();
    assert(!/[^\r]\n/.test(ics), 'bare LF line ending');
    for (const line of ics.split('\r\n')) assert(Buffer.byteLength(line) <= 75, 'line over 75 octets: ' + line);
    const vevent = veventOf(ics);
    assert(vevent.getFirstPropertyValue('summary') === longTitle, 'summary changed by folding');
    assert(/BYMONTH=1,2,3/.test(vevent.getFirstPropertyValue('rrule').toString()), 'rule changed by folding');
  });

  await check('a line break in SUMMARY, even a lone CR, cannot start a new property', async () => {
    await cloud.createEvent({ summary: 'Title\rATTENDEE:mailto:attacker@example.com', start: '2026-12-21T09:00:00Z', end: '2026-12-21T10:00:00Z' });
    assert(!/[\r\n]ATTENDEE/.test(lastIcs()), 'injected a property');
  });

  console.log('\nCLOUD update-event (property merge)');

  const SERIES = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VTIMEZONE', 'TZID:Europe/Madrid',
    'BEGIN:DAYLIGHT', 'DTSTART:19810329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'END:DAYLIGHT',
    'END:VTIMEZONE',
    'BEGIN:VEVENT', 'UID:series-1', 'DTSTAMP:20260101T090000Z',
    'DTSTART;TZID=Europe/Madrid:20260105T100000', 'DTEND;TZID=Europe/Madrid:20260105T110000',
    'SUMMARY:Weekly sync',
    'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20271231T235959Z;WKST=MO;BYSETPOS=1,2,3,4,5,6,7,8,9,10,11,12,13,1',
    ' 4,15,16',
    'EXDATE;TZID=Europe/Madrid:20260112T100000',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'TRIGGER:-PT10M', 'END:VALARM',
    'END:VEVENT',
    'BEGIN:VEVENT', 'UID:series-1', 'RECURRENCE-ID;TZID=Europe/Madrid:20260119T100000',
    'DTSTART;TZID=Europe/Madrid:20260119T120000', 'DTEND;TZID=Europe/Madrid:20260119T130000', 'SUMMARY:Moved sync',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');

  const ALL_DAY = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:day-1', 'DTSTAMP:20260101T090000Z',
    'DTSTART;VALUE=DATE:20261225', 'DURATION:P1D', 'SUMMARY:Holiday', 'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n');

  const { applyICalChanges } = cloud;
  const masterOf = ics => new ICAL.Component(ICAL.parse(ics)).getAllSubcomponents('vevent')
    .find(v => !v.hasProperty('recurrence-id'));

  await check('replaces a folded RRULE without leaving its continuation behind', () => {
    const out = applyICalChanges(SERIES, { recurrence: 'FREQ=MONTHLY;COUNT=12' });
    assert(out.includes('RRULE:FREQ=MONTHLY;COUNT=12'), 'rule not set');
    assert(!out.includes(' 4,15,16'), 'orphaned continuation line');
    assert(masterOf(out).getFirstPropertyValue('rrule').toString() === 'FREQ=MONTHLY;COUNT=12');
  });

  await check('empty recurrence removes RRULE, EXDATE and overrides, keeps the time zone rule', () => {
    const out = applyICalChanges(SERIES, { recurrence: '' });
    const comp = new ICAL.Component(ICAL.parse(out));
    const vevents = comp.getAllSubcomponents('vevent');
    assert(vevents.length === 1, 'override VEVENT kept: ' + vevents.length);
    assert(!vevents[0].hasProperty('rrule') && !vevents[0].hasProperty('exdate'), 'recurrence left behind');
    assert(out.includes('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU'), 'VTIMEZONE rule removed');
    assert(vevents[0].getFirstSubcomponent('valarm'), 'alarm lost');
  });

  await check('start changes the event, not the VTIMEZONE DTSTART', () => {
    const out = applyICalChanges(SERIES, { start: '2026-02-02T09:00:00Z' });
    assert(out.includes('DTSTART:19810329T020000'), 'VTIMEZONE DTSTART rewritten');
    assert(out.includes('DTSTART:20260202T090000Z'), 'event DTSTART not set');
  });

  await check('description goes on the event, not the VALARM, and before the VALARM', () => {
    const out = applyICalChanges(SERIES, { description: 'Agenda' });
    assert(out.includes('DESCRIPTION:Reminder'), 'alarm description changed');
    assert(out.indexOf('DESCRIPTION:Agenda') < out.indexOf('BEGIN:VALARM'), 'property after a sub-component');
    assert(masterOf(out).getFirstPropertyValue('description') === 'Agenda');
  });

  await check('override occurrences are edited in neither summary nor recurrence changes', () => {
    const out = applyICalChanges(SERIES, { summary: 'Renamed', recurrence: 'FREQ=WEEKLY;BYDAY=TU' });
    assert(out.includes('SUMMARY:Moved sync'), 'override touched');
    assert(out.includes('RECURRENCE-ID'), 'override dropped');
  });

  await check('an all-day event stays all-day when only its dates change; DURATION gives way to DTEND', () => {
    const out = applyICalChanges(ALL_DAY, { start: '2027-01-01', end: '2027-01-01' });
    assert(out.includes('DTSTART;VALUE=DATE:20270101') && out.includes('DTEND;VALUE=DATE:20270102'), out);
    assert(!out.includes('DURATION'), 'DURATION and DTEND both present');
    new ICAL.Event(masterOf(out));
  });

  await check('switching allDay in cloud mode needs start and end', async () => {
    await rejects(() => applyICalChanges(ALL_DAY, { allDay: false }), /start and end/);
    const out = applyICalChanges(ALL_DAY, { allDay: false, start: '2027-01-01T10:00:00Z', end: '2027-01-01T11:00:00Z' });
    assert(out.includes('DTSTART:20270101T100000Z') && out.includes('DTEND:20270101T110000Z'), out);
  });

  await check('a folded DTSTART;VALUE=DATE is still recognized as all-day', () => {
    const folded = ALL_DAY.replace('DTSTART;VALUE=DATE:20261225', 'DTSTART;\r\n VALUE=DATE:20261225');
    const out = applyICalChanges(folded, { end: '2026-12-28' });
    assert(out.includes('DTEND;VALUE=DATE:20261228'), out);
  });

  await check('moving only the start of an all-day event keeps its length', () => {
    const ics = ALL_DAY.replace('DURATION:P1D', 'DTEND;VALUE=DATE:20261227');
    const out = applyICalChanges(ics, { start: '2026-12-30' });
    assert(out.includes('DTSTART;VALUE=DATE:20261230') && out.includes('DTEND;VALUE=DATE:20270101'), out);
  });

  await check('switching allDay on a series with exceptions is refused unless the recurrence goes', async () => {
    const args = { allDay: true, start: '2026-01-05', end: '2026-01-05' };
    await rejects(() => applyICalChanges(SERIES, args), /exceptions/);
    const out = applyICalChanges(SERIES, { ...args, recurrence: '' });
    assert(out.includes('DTSTART;VALUE=DATE:20260105') && !out.includes('EXDATE') && !out.includes('RECURRENCE-ID'), out);
  });

  await check('a new rule must match the event type', async () => {
    await rejects(() => applyICalChanges(ALL_DAY, { recurrence: 'FREQ=YEARLY;UNTIL=20301231T235959Z' }), /UNTIL as a date/);
    assert(applyICalChanges(ALL_DAY, { recurrence: 'FREQ=YEARLY;UNTIL=20301231' }).includes('RRULE:FREQ=YEARLY;UNTIL=20301231'));
  });

  await check('parseEvent reads the master even when an override comes first', () => {
    const lines = SERIES.split('\r\n');
    const masterStart = lines.indexOf('BEGIN:VEVENT');
    const overrideStart = lines.lastIndexOf('BEGIN:VEVENT');
    const master = lines.slice(masterStart, overrideStart);
    const override = lines.slice(overrideStart, lines.length - 1);
    const reordered = [...lines.slice(0, masterStart), ...override, ...master, 'END:VCALENDAR'].join('\r\n');
    const ev = cloud.parseEvent(reordered, 'u');
    assert(ev.summary === 'Weekly sync' && /^FREQ=WEEKLY/.test(ev.recurrence), JSON.stringify(ev));
  });

  await check('parseEvent reports the recurrence', () => {
    const ev = cloud.parseEvent(SERIES, 'https://caldav.example/cal/1.ics');
    assert(/^FREQ=WEEKLY;BYDAY=MO/.test(ev.recurrence), 'got ' + ev.recurrence);
    assert(cloud.parseEvent(ALL_DAY, 'u').recurrence === null);
  });

  console.log('\nHandlers');

  const originalMode = mode.getMode();
  mode.setMode('local');

  await check('create-event rejects a bad rule with a tool error, before any script', async () => {
    const before = scripts.length;
    const r = await tool('create-event').handler({ summary: 'x', start: '2026-12-25', end: '2026-12-25', recurrence: 'FREQ=SOMETIMES' });
    assert(r.isError === true, 'not an error');
    assert(/Invalid recurrence/.test(r.content[0].text), r.content[0].text);
    assert(scripts.length === before, 'osascript ran');
  });

  await check('create-event reports the all-day day and the rule', async () => {
    const r = await tool('create-event').handler({ summary: 'Holiday', start: '2026-12-25', end: '2026-12-25', allDay: true, recurrence: 'freq=yearly', calendarName: 'Home' });
    assert(!r.isError, r.content[0].text);
    assert(/All day: 2026-12-25/.test(r.content[0].text) && /Repeats: FREQ=YEARLY/.test(r.content[0].text), r.content[0].text);
  });

  await check('update-event says when the recurrence was removed', async () => {
    const r = await tool('update-event').handler({ eventUrl: 'UID-1', recurrence: '' });
    assert(!r.isError && /recurrence: removed/.test(r.content[0].text), r.content[0].text);
  });

  await check('update-event explains the repeat-once fallback', async () => {
    clearReply = 'cleared:count-1';
    try {
      const r = await tool('update-event').handler({ eventUrl: 'UID-1', recurrence: '' });
      assert(!r.isError && /repeats once/.test(r.content[0].text), r.content[0].text);
    } finally { clearReply = 'cleared:empty'; }
  });

  await check('update-event and delete-event surface Calendar.app refusals as errors', async () => {
    clearReply = 'failed:FREQ=YEARLY';
    deleteReply = 'failed:recurring';
    try {
      const u = await tool('update-event').handler({ eventUrl: 'UID-1', recurrence: '' });
      assert(u.isError === true && /kept the recurrence/.test(u.content[0].text), u.content[0].text);
      const d = await tool('delete-event').handler({ eventUrl: 'UID-1' });
      assert(d.isError === true && /did not delete/.test(d.content[0].text), d.content[0].text);
    } finally { clearReply = 'cleared:empty'; deleteReply = 'deleted:direct'; }
  });

  await check('update-event and delete-event report a missing event as an error', async () => {
    appleScriptResult = 'not found';
    try {
      const u = await tool('update-event').handler({ eventUrl: 'NOPE', recurrence: '' });
      assert(u.isError === true && /not found/i.test(u.content[0].text), 'update: ' + u.content[0].text);
      const d = await tool('delete-event').handler({ eventUrl: 'NOPE' });
      assert(d.isError === true && /not found/i.test(d.content[0].text), 'delete: ' + d.content[0].text);
    } finally {
      appleScriptResult = 'UID-1';
    }
  });

  await check('create-event confirms a multi-day all-day event by its last day', async () => {
    const r = await tool('create-event').handler({ summary: 'Trip', start: '2026-12-25', end: '2026-12-28', allDay: true });
    assert(/All day: 2026-12-25 to 2026-12-27/.test(r.content[0].text), r.content[0].text);
  });

  await check('list-events shows the rule and the all-day day, and returns both as data', async () => {
    listedEvents = [
      { id: 'W', summary: 'Weekly', startDate: new Date(Date.now() + 86400000).toISOString(), endDate: null, location: '', calendar: 'Home', allDay: false, recurrence: 'FREQ=WEEKLY;BYDAY=MO' },
      { id: 'H', summary: 'Holiday', startDate: new Date(2099, 11, 25).toISOString(), endDate: null, location: '', calendar: 'Home', allDay: true, recurrence: 'RRULE:FREQ=YEARLY' }
    ];
    const r = await tool('list-events').handler({ count: 10, daysAhead: 365 });
    const text = r.content[0].text;
    assert(/Repeats: FREQ=WEEKLY;BYDAY=MO/.test(text) && /All day: 2099-12-25/.test(text), text);
    const items = r.structuredContent.items;
    assert(items.find(e => e.ref === 'H').isAllDay === true && items.find(e => e.ref === 'H').recurrence === 'FREQ=YEARLY', 'prefix not stripped');
    assert(items.find(e => e.ref === 'W').isAllDay === false);
  });

  mode.setMode(originalMode);

  console.log('\n' + '='.repeat(56));
  console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : 'PASS ' + pass + '  FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
