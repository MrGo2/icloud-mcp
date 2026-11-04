/**
 * Local Calendar Client
 * Accesses Calendar.app via AppleScript
 */

const { runAppleScript, runJXA, escapeAppleScript, escapeJXA, asInt, appleScriptDateStmts } = require('../utils/applescript');
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
          calendar: ObjC.unwrap(ev.calendar.title)
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
            calendar: calNames[i]
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
 * @returns {Promise<Object>} - Created event info
 */
async function createEvent({ summary, start, end, location, description, calendarName, allDay = false }) {
  const startDate = new Date(start);
  const endDate = new Date(end);

  // Use default calendar if none specified
  const targetCalendar = calendarName || 'Calendar';

  const script = `
      tell application "Calendar"
        ${appleScriptDateStmts('newStart', startDate)}
        ${appleScriptDateStmts('newEnd', endDate)}
        tell calendar "${escapeAppleScript(targetCalendar)}"
          set newEvent to make new event with properties {summary:"${escapeAppleScript(summary)}", start date:newStart, end date:newEnd${allDay ? ', allday event:true' : ''}}
          ${location ? `set location of newEvent to "${escapeAppleScript(location)}"` : ''}
          ${description ? `set description of newEvent to "${escapeAppleScript(description)}"` : ''}
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
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} - Result
 */
async function updateEvent(eventId, { summary, start, end, location, description }) {
  let updateCommands = [];
  let dateSetup = [];

  if (summary) updateCommands.push(`set summary of theEvent to "${escapeAppleScript(summary)}"`);
  if (start) {
    dateSetup.push(appleScriptDateStmts('newStart', new Date(start)));
    updateCommands.push('set start date of theEvent to newStart');
  }
  if (end) {
    dateSetup.push(appleScriptDateStmts('newEnd', new Date(end)));
    updateCommands.push('set end date of theEvent to newEnd');
  }
  if (location !== undefined) updateCommands.push(`set location of theEvent to "${escapeAppleScript(location || '')}"`);
  if (description !== undefined) updateCommands.push(`set description of theEvent to "${escapeAppleScript(description || '')}"`);

  if (updateCommands.length === 0) {
    return { success: false, message: 'No updates provided' };
  }

  const script = `
    tell application "Calendar"
      ${dateSetup.join('\n      ')}
      set allCalendars to calendars
      repeat with cal in allCalendars
        try
          set theEvent to first event of cal whose uid is "${escapeAppleScript(eventId)}"
          ${updateCommands.join('\n          ')}
          return "updated"
        end try
      end repeat
      return "not found"
    end tell
  `;

  const result = await runAppleScript(script);
  if (result === 'not found') {
    return { success: false, message: 'Event not found' };
  }
  return { success: true, message: 'Event updated successfully' };
}

/**
 * Delete an event
 * @param {string} eventId - Event UID
 * @returns {Promise<Object>} - Result
 */
async function deleteEvent(eventId) {
  const script = `
    tell application "Calendar"
      set allCalendars to calendars
      repeat with cal in allCalendars
        try
          set theEvent to first event of cal whose uid is "${escapeAppleScript(eventId)}"
          delete theEvent
          return "deleted"
        end try
      end repeat
      return "not found"
    end tell
  `;

  const result = await runAppleScript(script);
  if (result === 'not found') {
    return { success: false, message: 'Event not found' };
  }
  return { success: true, message: 'Event deleted successfully' };
}

module.exports = {
  listEvents,
  listCalendars,
  createEvent,
  updateEvent,
  deleteEvent
};
