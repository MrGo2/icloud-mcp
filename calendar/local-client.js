/**
 * Local Calendar Client
 * Accesses Calendar.app via AppleScript
 */

const { runAppleScript, runJXA, escapeAppleScript, escapeJXA, asInt, asBool, appleScriptDateStmts } = require('../utils/applescript');
const { normalizeRecurrence, checkUntilType, parseEventDate, allDayDate, allDayRange } = require('./recurrence');
const config = require('../config');

// EKAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied, 3 fullAccess, 4 writeOnly
const EK_FULL_ACCESS = 3;
// How long to wait for the user to answer the Calendars permission prompt.
// The completion block never fires inside osascript, so the status is polled.
const EK_REQUEST_TIMEOUT_SECONDS = 25;
// Ask for access at most once per server process: a host that never shows the
// prompt would otherwise pay the full timeout on every call.
let eventKitRequested = false;

/**
 * List upcoming events from every calendar.
 * Uses EventKit (fast, one store query) when the host has full Calendars
 * access; otherwise falls back to scripting Calendar.app.
 * @param {number} count - Number of events to retrieve
 * @param {number} daysAhead - Number of days to look ahead
 * @returns {Promise<Array>} - List of events
 */
async function listEvents(count = 25, daysAhead = 30) {
  const now = new Date();
  const future = new Date(now.getTime() + asInt(daysAhead, 30) * 24 * 60 * 60 * 1000);

  let status;
  try {
    const result = JSON.parse(await runJXA(eventKitScript(now, future, !eventKitRequested)));
    status = result.status;
    if (result.requested) eventKitRequested = true;
    if (status === EK_FULL_ACCESS && Array.isArray(result.events)) {
      return sortAndSlice(result.events, count);
    }
  } catch (error) {
    status = 'error: ' + error.message;
  }

  console.error(`[icloud-mcp] list-events: EventKit unavailable (status ${status}), using Calendar.app`);
  return listEventsAppleScript(count, now, future);
}

/**
 * JXA that reads the window from EventKit. Occurrences of recurring events
 * are expanded; each carries its series' calendarItemIdentifier, which is
 * the Calendar.app `uid` that update-event and delete-event resolve.
 */
function eventKitScript(now, future, request) {
  return `
    ObjC.import('EventKit');
    ObjC.import('Foundation');
    const T = $.EKEntityTypeEvent;
    const store = $.EKEventStore.alloc.init;
    const readStatus = () => Number($.EKEventStore.authorizationStatusForEntityType(T));
    let status = readStatus();
    let requested = false;

    if (${request ? 'true' : 'false'} && (status === 0 || status === 4)) {
      requested = true;
      if (store.respondsToSelector('requestFullAccessToEventsWithCompletion:')) {
        store.requestFullAccessToEventsWithCompletion((granted, err) => {});
      } else {
        store.requestAccessToEntityTypeCompletion(T, (granted, err) => {});
      }
      const deadline = Date.now() + ${asInt(EK_REQUEST_TIMEOUT_SECONDS, 25)} * 1000;
      while (status !== 3 && Date.now() < deadline) {
        $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.2));
        status = readStatus();
        if (status === 1 || status === 2) break;
      }
    }

    let events = null;
    if (status === 3) {
      const rangeStart = new Date(${JSON.stringify(now.toISOString())});
      const rangeEnd = new Date(${JSON.stringify(future.toISOString())});
      const nsDate = (d) => $.NSDate.dateWithTimeIntervalSince1970(d.getTime() / 1000);
      const toDate = (ns) => ns && !ns.isNil() ? new Date(Number(ns.timeIntervalSince1970) * 1000) : null;
      // EKRecurrenceRule has no RRULE accessor, so rebuild one from its fields.
      const FREQ = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
      const WEEKDAY = ['', 'SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
      const list = (arr, f) => {
        const out = [];
        if (arr && !arr.isNil()) for (let k = 0; k < arr.count; k++) out.push(f(arr.objectAtIndex(k)));
        return out;
      };
      const num = (n) => Number(ObjC.unwrap(n));
      const icalUTC = (d) => d.toISOString().split('.')[0].split('-').join('').split(':').join('') + 'Z';
      const icalDay = (d) => String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
      const isTrue = (v) => v === true || v === 1;
      // UNTIL takes the start's value type: a date for all-day events.
      const rruleOf = (rule, allDay) => {
        const freq = FREQ[Number(rule.frequency)];
        if (!freq) return null;
        const parts = ['FREQ=' + freq];
        const interval = Number(rule.interval);
        if (interval > 1) parts.push('INTERVAL=' + interval);
        const days = list(rule.daysOfTheWeek, (d) => WEEKDAY[Number(d.dayOfTheWeek)] ? (Number(d.weekNumber) || '') + WEEKDAY[Number(d.dayOfTheWeek)] : null)
          .filter(Boolean);
        if (days.length) parts.push('BYDAY=' + days.join(','));
        [['BYMONTHDAY', rule.daysOfTheMonth], ['BYMONTH', rule.monthsOfTheYear], ['BYWEEKNO', rule.weeksOfTheYear],
          ['BYYEARDAY', rule.daysOfTheYear], ['BYSETPOS', rule.setPositions]].forEach(([key, arr]) => {
          const values = list(arr, num);
          if (values.length) parts.push(key + '=' + values.join(','));
        });
        const end = rule.recurrenceEnd;
        if (end && !end.isNil()) {
          const until = toDate(end.endDate);
          if (until) parts.push('UNTIL=' + (allDay ? icalDay(until) : icalUTC(until)));
          else if (Number(end.occurrenceCount) > 0) parts.push('COUNT=' + Number(end.occurrenceCount));
        }
        const wkst = Number(rule.firstDayOfTheWeek);
        if (wkst > 0 && WEEKDAY[wkst]) parts.push('WKST=' + WEEKDAY[wkst]);
        return parts.join(';');
      };
      const recurrenceOf = (ev) => {
        if (!isTrue(ev.hasRecurrenceRules)) return null;
        const rules = list(ev.recurrenceRules, (r) => rruleOf(r, isTrue(ev.isAllDay))).filter(Boolean);
        return rules.length ? rules[0] : null;
      };
      const pred = store.predicateForEventsWithStartDateEndDateCalendars(nsDate(rangeStart), nsDate(rangeEnd), $());
      const evs = store.eventsMatchingPredicate(pred);
      events = [];
      for (let i = 0; i < evs.count; i++) {
        const ev = evs.objectAtIndex(i);
        const start = toDate(ev.startDate);
        // Same window as the Calendar.app path: events starting inside it.
        if (!start || start < rangeStart || start > rangeEnd) continue;
        const end = toDate(ev.endDate);
        events.push({
          id: ObjC.unwrap(ev.calendarItemIdentifier),
          summary: ObjC.unwrap(ev.title) || '',
          startDate: start.toISOString(),
          endDate: end ? end.toISOString() : null,
          location: ObjC.unwrap(ev.location) || '',
          calendar: ObjC.unwrap(ev.calendar.title),
          // The getter of EKEvent's allDay property is isAllDay.
          allDay: isTrue(ev.isAllDay),
          recurrence: recurrenceOf(ev)
        });
      }
    }

    JSON.stringify({ status, requested, events });
  `;
}

function sortAndSlice(events, count) {
  events.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  return events.slice(0, asInt(count, 25));
}

/**
 * Calendar.app path: used when EventKit access is not granted.
 * Slow on accounts with many or subscribed calendars.
 */
async function listEventsAppleScript(count, now, future) {

  // Batch property access: per-event JXA calls trigger AppleEvent errors.
  // The window is filtered inside the script so a busy calendar cannot push
  // upcoming events out of the result set before we ever see them.
  const script = `
    const calendar = Application('Calendar');
    const cals = calendar.calendars;
    const calNames = cals.name();
    const rangeStart = new Date(${JSON.stringify(now.toISOString())});
    const rangeEnd = new Date(${JSON.stringify(future.toISOString())});
    let allEvents = [];

    for (let i = 0; i < calNames.length; i++) {
      try {
        // Filter the window app-side: reading every property of every event
        // of every calendar transfers whole subscribed-calendar histories
        // and hangs on real accounts.
        const evts = cals[i].events.whose({
          _and: [
            { startDate: { _greaterThan: rangeStart } },
            { startDate: { _lessThan: rangeEnd } }
          ]
        });
        const uids = evts.uid();
        const summaries = evts.summary();
        const starts = evts.startDate();
        const ends = evts.endDate();
        const locations = evts.location();
        // Optional extras: a calendar that cannot report them still lists.
        let alldays = [], recurrences = [];
        try { alldays = evts.alldayEvent(); } catch (e) {}
        try { recurrences = evts.recurrence(); } catch (e) {}

        for (let j = 0; j < uids.length; j++) {
          const start = starts[j];
          if (!start) continue;
          if (start < rangeStart || start > rangeEnd) continue;

          allEvents.push({
            id: uids[j],
            summary: summaries[j] || '',
            startDate: start.toISOString(),
            endDate: ends[j] ? ends[j].toISOString() : null,
            location: locations[j] || '',
            calendar: calNames[i],
            allDay: alldays[j] === true,
            recurrence: recurrences[j] || null
          });
        }
      } catch (e) {
        // One unreadable calendar must not hide the rest, but say which.
        console.log('calendar skipped: ' + calNames[i] + ' (' + e + ')');
      }
    }

    JSON.stringify(allEvents);
  `;

  const result = await runJXA(script);
  if (!result) return [];

  return sortAndSlice(JSON.parse(result), count);
}

/**
 * List all calendars
 * @returns {Promise<Array>} - List of calendars
 */
async function listCalendars() {
  // Use batch property access - JXA iteration causes AppleEvent errors
  const script = `
    const calendar = Application('Calendar');
    const cals = calendar.calendars;
    const names = cals.name();
    const writables = cals.writable();

    let result = [];
    for (let i = 0; i < names.length; i++) {
      result.push({
        name: names[i],
        id: names[i], // Use name as ID since cal.id() causes errors
        writable: writables[i]
      });
    }

    JSON.stringify(result);
  `;

  const result = await runJXA(script);
  return result ? JSON.parse(result) : [];
}

/**
 * Create a new event
 * @param {Object} options - Event options
 * @param {boolean} [options.allDay] - All-day event; end is exclusive (see allDayRange)
 * @param {string} [options.recurrence] - RFC 5545 RRULE, e.g. FREQ=YEARLY
 * @returns {Promise<Object>} - Created event info
 */
async function createEvent({ summary, start, end, location, description, calendarName, allDay = false, recurrence }) {
  const isAllDay = asBool(allDay);
  const rule = normalizeRecurrence(recurrence);
  checkUntilType(rule, isAllDay);
  let startDate, endDate;
  if (isAllDay) {
    const { startDay, endDay } = allDayRange(start, end);
    startDate = startDay;
    endDate = lastSecondBefore(endDay);
  } else {
    startDate = parseEventDate(start);
    endDate = parseEventDate(end);
  }

  // Use default calendar if none specified
  const targetCalendar = calendarName || 'Calendar';

  const script = `
      tell application "Calendar"
        ${appleScriptDateStmts('newStart', startDate)}
        ${appleScriptDateStmts('newEnd', endDate)}
        tell calendar "${escapeAppleScript(targetCalendar)}"
          set newEvent to make new event with properties {summary:"${escapeAppleScript(summary)}", start date:newStart, end date:newEnd${isAllDay ? ', allday event:true' : ''}}
          ${location ? `set location of newEvent to "${escapeAppleScript(location)}"` : ''}
          ${description ? `set description of newEvent to "${escapeAppleScript(description)}"` : ''}
          ${rule ? `set recurrence of newEvent to "${escapeAppleScript(rule)}"` : ''}
          return uid of newEvent
        end tell
      end tell
    `;

  const uid = await runAppleScript(script);
  return { success: true, id: uid, message: 'Event created successfully' };
}

/**
 * Update an existing event
 * @param {string} eventId - Event UID
 * @param {Object} updates - Fields to update; recurrence '' removes the rule
 * @returns {Promise<Object>} - Result
 */
async function updateEvent(eventId, { summary, start, end, location, description, allDay, recurrence }) {
  let updateCommands = [];
  let dateSetup = [];

  // allDay first: Calendar.app reinterprets the dates when the flag flips.
  if (allDay !== undefined) updateCommands.push(`set allday event of theEvent to ${asBool(allDay) ? 'true' : 'false'}`);
  if (summary) updateCommands.push(`set summary of theEvent to "${escapeAppleScript(summary)}"`);
  const makeAllDay = allDay !== undefined && asBool(allDay);
  let startDate = start ? parseEventDate(start) : null;
  let endDate = end ? parseEventDate(end) : null;
  if (makeAllDay) {
    if (start) startDate = allDayDate(start);
    if (end) endDate = lastSecondBefore(start ? allDayRange(start, end).endDay : allDayDate(end));
  }
  if (startDate) {
    dateSetup.push(appleScriptDateStmts('newStart', startDate));
    updateCommands.push('set start date of theEvent to newStart');
  }
  if (endDate) {
    dateSetup.push(appleScriptDateStmts('newEnd', endDate));
    updateCommands.push('set end date of theEvent to newEnd');
  }
  const rule = recurrence === undefined ? undefined : normalizeRecurrence(recurrence);
  if (rule !== undefined && allDay !== undefined) checkUntilType(rule, makeAllDay);
  if (rule) updateCommands.push(`set recurrence of theEvent to "${escapeAppleScript(rule)}"`);
  if (location !== undefined) updateCommands.push(`set location of theEvent to "${escapeAppleScript(location || '')}"`);
  if (description !== undefined) updateCommands.push(`set description of theEvent to "${escapeAppleScript(description || '')}"`);

  if (updateCommands.length === 0 && rule !== '') {
    return { success: false, message: 'No updates provided' };
  }

  if (updateCommands.length > 0) {
    // Look the event up first and change it outside the try, so a failed write
    // surfaces as an error instead of reading as "not found".
    const script = `
    tell application "Calendar"
      ${dateSetup.join('\n      ')}
      ${findEventStmts(eventId)}
      if theEvent is missing value then return "not found"
      ${updateCommands.join('\n      ')}
      return "updated"
    end tell
  `;

    const result = await runAppleScript(script);
    if (result === 'not found') {
      return { success: false, message: 'Event not found' };
    }
  }

  // An empty rule turns a recurring event back into a single one.
  if (rule === '') {
    const cleared = await clearRecurrence(eventId);
    if (!cleared.success) return cleared;
    return { success: true, message: 'Event updated successfully', method: cleared.method, note: cleared.note };
  }
  return { success: true, message: 'Event updated successfully' };
}

// EKSpanFutureEvents: from a series' first occurrence, that is the whole series.
const EK_SPAN_FUTURE_EVENTS = 1;

/**
 * Remove or strip a whole series through EventKit. Runs only with full
 * Calendars access (status 3) and never asks for it, so with any other status
 * it does nothing and the caller falls back to Calendar.app.
 *
 * Calendar.app scripting cannot do either for a recurring event: it ignores
 * `set recurrence to ""` and its `delete` leaves the series in place.
 *
 * @param {string} eventId - calendarItemIdentifier (= Calendar.app uid)
 * @param {'delete'|'clear-recurrence'} action
 * @returns {Promise<{status, found, done}>}
 */
async function eventKitSeriesAction(eventId, action) {
  const script = `
    ObjC.import('EventKit');
    const status = Number($.EKEventStore.authorizationStatusForEntityType($.EKEntityTypeEvent));
    const out = { status, found: false, done: false };
    if (status === 3) {
      const store = $.EKEventStore.alloc.init;
      const id = ${JSON.stringify(String(eventId))};
      const fetch = () => {
        const item = store.calendarItemWithIdentifier(id);
        return item && !item.isNil() ? item : null;
      };
      const isTrue = (v) => v === true || v === 1;
      const ev = fetch();
      if (ev) {
        out.found = true;
        if (${JSON.stringify(action)} === 'delete') {
          store.removeEventSpanCommitError(ev, ${asInt(EK_SPAN_FUTURE_EVENTS, 1)}, true, null);
          out.done = fetch() === null;
        } else {
          const rules = ev.recurrenceRules;
          const copy = [];
          if (rules && !rules.isNil()) for (let i = 0; i < rules.count; i++) copy.push(rules.objectAtIndex(i));
          copy.forEach((rule) => ev.removeRecurrenceRule(rule));
          store.saveEventSpanCommitError(ev, ${asInt(EK_SPAN_FUTURE_EVENTS, 1)}, true, null);
          const again = fetch();
          out.done = !!again && !isTrue(again.hasRecurrenceRules);
        }
      }
    }
    JSON.stringify(out);
  `;
  try {
    return JSON.parse(await runJXA(script));
  } catch (error) {
    return { status: 'error: ' + error.message, found: false, done: false };
  }
}

/**
 * Turn a recurring event into a single one, checking the result each time:
 * EventKit when it has full access, then Calendar.app with "" and
 * missing value, and as a last resort a rule that repeats once
 * (FREQ=DAILY;COUNT=1), which leaves exactly the original occurrence.
 */
async function clearRecurrence(eventId) {
  const ek = await eventKitSeriesAction(eventId, 'clear-recurrence');
  if (ek.done) return { success: true, method: 'eventkit' };

  const script = `
    tell application "Calendar"
      ${findEventStmts(eventId)}
      if theEvent is missing value then return "not found"
      set r to recurrence of theEvent
      if r is missing value or r is "" then return "cleared:none"
      try
        set recurrence of theEvent to ""
      end try
      set r to recurrence of theEvent
      if r is missing value or r is "" then return "cleared:empty"
      try
        set recurrence of theEvent to missing value
      end try
      set r to recurrence of theEvent
      if r is missing value or r is "" then return "cleared:missing-value"
      set recurrence of theEvent to "FREQ=DAILY;COUNT=1"
      set r to recurrence of theEvent
      if r contains "COUNT=1" then return "cleared:count-1"
      return "failed:" & r
    end tell
  `;
  const result = await runAppleScript(script);
  if (result === 'not found') return { success: false, message: 'Event not found' };
  const method = result.replace(/^(cleared|failed):/, '');
  if (result.startsWith('cleared:')) {
    if (method !== 'none' && method !== 'empty') {
      console.error(`[icloud-mcp] update-event: recurrence cleared via ${method} (EventKit status ${ek.status})`);
    }
    const note = method === 'count-1'
      ? 'Calendar.app would not drop the rule, so it now repeats once (FREQ=DAILY;COUNT=1): a single occurrence.'
      : undefined;
    return { success: true, method, note };
  }
  return { success: false, message: `Calendar.app kept the recurrence (${method})` };
}

/**
 * AppleScript that sets `theEvent` to the event with this UID, searching every
 * calendar, and `theCal` to its calendar; both stay missing value if absent.
 */
function findEventStmts(eventId) {
  return [
    'set theEvent to missing value',
    'set theCal to missing value',
    'repeat with cal in calendars',
    '  try',
    `    set theEvent to first event of cal whose uid is "${escapeAppleScript(eventId)}"`,
    '    set theCal to contents of cal',
    '  end try',
    '  if theEvent is not missing value then exit repeat',
    'end repeat'
  ].join('\n      ');
}

/**
 * Calendar.app's all-day end date: the last second of the last day, which is
 * how EventKit itself stores one. Midnight of the next day would read as an
 * extra day.
 */
function lastSecondBefore(day) {
  return new Date(day.getTime() - 1000);
}

/**
 * Delete an event
 * @param {string} eventId - Event UID
 * @returns {Promise<Object>} - Result
 */
async function deleteEvent(eventId) {
  const ek = await eventKitSeriesAction(eventId, 'delete');
  if (ek.done) return { success: true, method: 'eventkit', message: 'Event deleted successfully' };

  // Calendar.app reports success on a recurring event and keeps the series,
  // so every attempt is checked by counting what is left. The last one makes
  // the series repeat once before deleting it, and restores the rule if that
  // fails too.
  const uid = escapeAppleScript(eventId);
  const left = `(count of (every event of theCal whose uid is "${uid}"))`;
  const script = `
    tell application "Calendar"
      ${findEventStmts(eventId)}
      if theEvent is missing value then return "not found"
      try
        delete theEvent
      end try
      if ${left} is 0 then return "deleted:direct"
      try
        delete (every event of theCal whose uid is "${uid}")
      end try
      if ${left} is 0 then return "deleted:whose"
      set theEvent to first event of theCal whose uid is "${uid}"
      set original to recurrence of theEvent
      if original is missing value or original is "" then return "failed:single"
      try
        set recurrence of theEvent to "FREQ=DAILY;COUNT=1"
        delete theEvent
      end try
      if ${left} is 0 then return "deleted:count-1"
      try
        set recurrence of (first event of theCal whose uid is "${uid}") to original
      end try
      return "failed:recurring"
    end tell
  `;

  const result = await runAppleScript(script);
  if (result === 'not found') {
    return { success: false, message: 'Event not found' };
  }
  const method = result.replace(/^(deleted|failed):/, '');
  if (result.startsWith('deleted:')) {
    if (method !== 'direct') {
      console.error(`[icloud-mcp] delete-event: deleted via ${method} (EventKit status ${ek.status})`);
    }
    return { success: true, method, message: 'Event deleted successfully' };
  }
  return {
    success: false,
    message: method === 'recurring'
      ? 'Calendar.app did not delete this recurring event; delete it in Calendar, or grant full Calendars access so EventKit can'
      : 'Calendar.app did not delete the event'
  };
}

module.exports = {
  listEvents,
  listCalendars,
  createEvent,
  updateEvent,
  deleteEvent
};
