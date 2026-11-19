#!/usr/bin/env node
/**
 * Recurring and all-day events in create-event / update-event / list-events (issue #30).
 *
 * osascript, tsdav and the credential store are stubbed: the tests read the
 * AppleScript and iCalendar the clients would send, and never touch
 * Calendar.app or iCloud.
 */

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
const icsSent = [];
let listedEvents = [];

const realRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../utils/applescript' && this.filename.includes(`${path.sep}calendar${path.sep}`)) {
    const real = realRequire.apply(this, arguments);
    return {
      ...real,
      runAppleScript: async (script) => { scripts.push(script); return appleScriptResult; },
      runJXA: async (script) => { scripts.push(script); return JSON.stringify({ status: 2, requested: false, events: null }); }
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

const { normalizeRecurrence, allDayRange, parseEventDate } = require(path.join(ROOT, 'calendar/recurrence'));
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
    assert(/set day of newEnd to 26/.test(s), 'end is not the next day');
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
    await local.updateEvent('UID-1', { recurrence: '' });
    assert(lastScript().includes('set recurrence of theEvent to ""'), 'recurrence not cleared');
  });

  await check('update toggles allDay before touching the dates', async () => {
    await local.updateEvent('UID-1', { allDay: true, start: '2026-12-25', end: '2026-12-25' });
    const s = lastScript();
    assert(s.includes('set allday event of theEvent to true'));
    assert(s.indexOf('set allday event') < s.indexOf('set start date'), 'dates set before the flag');
    assert(/set day of newEnd to 26/.test(s), 'all-day end not exclusive');
    await local.updateEvent('UID-1', { allDay: false });
    assert(lastScript().includes('set allday event of theEvent to false'));
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

  mode.setMode(originalMode);

  console.log('\n' + '='.repeat(56));
  console.log(fail === 0 ? 'ALL PASS (' + pass + ')' : 'PASS ' + pass + '  FAIL ' + fail);
  process.exit(fail === 0 ? 0 : 1);
})();
