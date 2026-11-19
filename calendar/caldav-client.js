/**
 * CalDAV client for iCloud Calendar
 */

const { DAVClient } = require('tsdav');
const ICAL = require('ical.js');
const config = require('../config');
const { getCredentials } = require('../auth');
const { normalizeRecurrence, checkUntilType, parseEventDate, allDayRange, addDays } = require('./recurrence');

let cachedClient = null;

/**
 * Get or create CalDAV client
 */
async function getClient() {
  if (cachedClient) {
    return cachedClient;
  }

  const creds = getCredentials();

  const client = new DAVClient({
    serverUrl: config.CALDAV.SERVER_URL,
    credentials: {
      username: creds.email,
      password: creds.password
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav'
  });

  try {
    await client.login();
    cachedClient = client;
    return client;
  } catch (error) {
    if (error.message?.includes('401') || error.message?.includes('auth')) {
      throw new Error('UNAUTHORIZED');
    }
    throw error;
  }
}

/**
 * Clear cached client (for re-auth)
 */
function clearClient() {
  cachedClient = null;
}

/**
 * Get all calendars
 */
async function getCalendars() {
  const client = await getClient();
  const calendars = await client.fetchCalendars();
  return calendars.map(cal => ({
    url: cal.url,
    displayName: cal.displayName || 'Unnamed Calendar',
    ctag: cal.ctag,
    syncToken: cal.syncToken
  }));
}

/**
 * Parse iCalendar event to simple object
 */
function parseEvent(icalData, url) {
  try {
    const jcalData = ICAL.parse(icalData);
    const comp = new ICAL.Component(jcalData);
    // The series master, not an overridden occurrence that may come first.
    const vevents = comp.getAllSubcomponents('vevent');
    const vevent = vevents.find(v => !v.hasProperty('recurrence-id')) || vevents[0];

    if (!vevent) return null;

    const event = new ICAL.Event(vevent);

    return {
      url,
      uid: event.uid,
      summary: event.summary || '(No title)',
      description: event.description || '',
      location: event.location || '',
      start: event.startDate?.toJSDate(),
      end: event.endDate?.toJSDate(),
      isAllDay: event.startDate?.isDate || false,
      recurrence: vevent.getFirstPropertyValue('rrule')?.toString() || null,
      organizer: vevent.getFirstPropertyValue('organizer'),
      attendees: vevent.getAllProperties('attendee').map(a => a.getFirstValue()),
      status: event.status,
      created: vevent.getFirstPropertyValue('created')?.toJSDate(),
      lastModified: vevent.getFirstPropertyValue('last-modified')?.toJSDate()
    };
  } catch (error) {
    console.error('Error parsing event:', error.message);
    return null;
  }
}

/**
 * List events from all calendars
 */
async function listEvents(count = 25, daysAhead = 30) {
  const client = await getClient();
  const calendars = await client.fetchCalendars();

  const now = new Date();
  const endDate = new Date();
  endDate.setDate(endDate.getDate() + daysAhead);

  const allEvents = [];

  for (const calendar of calendars) {
    try {
      const calendarObjects = await client.fetchCalendarObjects({
        calendar,
        timeRange: {
          start: now.toISOString(),
          end: endDate.toISOString()
        }
      });

      for (const obj of calendarObjects) {
        const event = parseEvent(obj.data, obj.url);
        if (event) {
          event.calendarName = calendar.displayName || 'Calendar';
          allEvents.push(event);
        }
      }
    } catch (error) {
      console.error(`Error fetching from calendar ${calendar.displayName}:`, error.message);
    }
  }

  // Sort by start date
  allEvents.sort((a, b) => (a.start || 0) - (b.start || 0));

  return allEvents.slice(0, count);
}

/**
 * Create a new event
 * @param {Object} options - Event options
 * @param {boolean} [options.allDay] - All-day event (DATE values); end is exclusive
 * @param {string} [options.recurrence] - RFC 5545 RRULE, e.g. FREQ=YEARLY
 */
async function createEvent({ summary, start, end, description, location, calendarUrl, allDay = false, recurrence }) {
  const rule = normalizeRecurrence(recurrence);
  checkUntilType(rule, allDay === true);
  const client = await getClient();

  // Get calendars if URL not provided
  let targetCalendar;
  if (calendarUrl) {
    const calendars = await client.fetchCalendars();
    targetCalendar = calendars.find(c => c.url === calendarUrl);
  }

  if (!targetCalendar) {
    const calendars = await client.fetchCalendars();
    targetCalendar = calendars[0]; // Use first calendar
  }

  if (!targetCalendar) {
    throw new Error('No calendar found');
  }

  // Create iCalendar data
  const uid = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}@icloud-mcp`;

  let dtStart, dtEnd;
  if (allDay === true) {
    const { startDay, endDay } = allDayRange(start, end);
    dtStart = `DTSTART;VALUE=DATE:${formatICalDay(startDay)}`;
    dtEnd = `DTEND;VALUE=DATE:${formatICalDay(endDay)}`;
  } else {
    dtStart = `DTSTART:${formatICalDate(parseEventDate(start))}`;
    dtEnd = `DTEND:${formatICalDate(parseEventDate(end))}`;
  }

  const icalData = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//iCloud MCP//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatICalDate(new Date())}`,
    dtStart,
    dtEnd,
    `SUMMARY:${escapeICalText(summary)}`,
    description ? `DESCRIPTION:${escapeICalText(description)}` : null,
    location ? `LOCATION:${escapeICalText(location)}` : null,
    rule ? `RRULE:${rule}` : null,
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean).map(foldLine).join('\r\n');

  const result = await client.createCalendarObject({
    calendar: targetCalendar,
    filename: `${uid}.ics`,
    iCalString: icalData
  });

  return {
    success: true,
    uid,
    url: result?.url,
    calendar: targetCalendar.displayName
  };
}

/**
 * Rewrite individual properties of an existing VEVENT.
 *
 * Deliberately a line-level edit rather than rebuilding the iCalendar from
 * scratch: a rebuild would silently drop RRULE, ATTENDEE, VALARM and any other
 * property this server does not model, which on a real calendar means losing
 * recurrence and invitees on every edit.
 *
 * Only the top-level properties of the master VEVENT are touched. VTIMEZONE
 * carries its own DTSTART and RRULE, VALARM its own DESCRIPTION, and an
 * overridden occurrence (RECURRENCE-ID) its own copy of everything. Folded
 * lines (RFC 5545 section 3.1) move or disappear together with their property.
 *
 * @param {string} ical - Existing iCalendar text
 * @param {Object} changes - Properties to set; undefined values are left alone.
 *   recurrence '' removes the rule, along with RDATE, EXDATE and overrides.
 * @returns {string} - Updated iCalendar text
 */
function applyICalChanges(ical, { summary, start, end, description, location, allDay, recurrence }) {
  const rule = normalizeRecurrence(recurrence);

  // One entry per property: its first line plus any continuation lines.
  const props = [];
  for (const line of ical.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && props.length) props[props.length - 1].push(line);
    else props.push([line]);
  }
  const head = i => props[i][0].trim().toUpperCase();
  const nameOf = i => head(i).split(/[:;]/, 1)[0];
  // The whole property with its continuation lines joined back.
  const unfolded = i => props[i].map((line, k) => (k ? line.slice(1) : line)).join('');

  // Locate every VEVENT and its own (depth 0) properties.
  const vevents = [];
  for (let i = 0; i < props.length; i++) {
    if (head(i) !== 'BEGIN:VEVENT') continue;
    const ev = { begin: i, end: props.length, own: [], firstChild: null };
    let depth = 0;
    for (let j = i + 1; j < props.length; j++) {
      const h = head(j);
      if (h.startsWith('BEGIN:')) {
        if (depth === 0 && ev.firstChild === null) ev.firstChild = j;
        depth++;
      } else if (h.startsWith('END:')) {
        if (depth === 0) { ev.end = j; break; }
        depth--;
      } else if (depth === 0) {
        ev.own.push(j);
      }
    }
    ev.isOverride = ev.own.some(j => nameOf(j) === 'RECURRENCE-ID');
    vevents.push(ev);
    i = ev.end;
  }
  const master = vevents.find(ev => !ev.isOverride) || vevents[0];
  if (!master) throw new Error('No VEVENT found in the calendar object');

  const removed = new Set();
  const inserts = [];
  const find = name => master.own.find(j => !removed.has(j) && nameOf(j) === name);
  const drop = name => master.own.forEach(j => { if (nameOf(j) === name) removed.add(j); });
  const set = (name, line) => {
    const idx = find(name);
    drop(name);
    if (idx === undefined) {
      inserts.push(foldLine(line));
    } else {
      removed.delete(idx);
      props[idx] = [foldLine(line)];
    }
  };

  // Keep DATE vs DATE-TIME consistent: DTSTART, DTEND, UNTIL, EXDATE, RDATE
  // and RECURRENCE-ID must share a value type.
  const dtstart = find('DTSTART');
  const dtend = find('DTEND');
  const isDateProp = i => i !== undefined && /;VALUE="?DATE"?[;:]/.test(unfolded(i).toUpperCase());
  const dayOf = i => {
    const m = i === undefined ? null : /:(\d{4})(\d{2})(\d{2})/.exec(unfolded(i));
    return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  };
  const wasAllDay = isDateProp(dtstart);
  const isAllDay = allDay === undefined ? wasAllDay : allDay === true;

  if (isAllDay !== wasAllDay) {
    if (start === undefined || end === undefined) {
      throw new Error('Changing allDay in cloud mode needs start and end in the same update');
    }
    const rrule = find('RRULE');
    const keepsSeries = rule !== '';
    const hasExceptions = find('EXDATE') !== undefined || find('RDATE') !== undefined || vevents.some(ev => ev.isOverride);
    if (keepsSeries && hasExceptions) {
      throw new Error('This recurring event has exceptions; remove the recurrence (recurrence: "") or change it in Calendar to switch allDay in cloud mode');
    }
    if (rule === undefined && rrule !== undefined) checkUntilType(unfolded(rrule).replace(/^RRULE:/i, ''), isAllDay);
  }
  if (rule) checkUntilType(rule, isAllDay);

  if (summary !== undefined) set('SUMMARY', `SUMMARY:${escapeICalText(summary)}`);
  if (isAllDay && (start !== undefined || end !== undefined)) {
    const oldStart = dayOf(dtstart);
    const newStart = start !== undefined ? allDayRange(start).startDay : oldStart;
    if (!newStart) throw new Error('The event has no DTSTART to keep; pass start as well');
    if (start !== undefined) set('DTSTART', `DTSTART;VALUE=DATE:${formatICalDay(newStart)}`);
    if (end !== undefined) {
      drop('DURATION');
      set('DTEND', `DTEND;VALUE=DATE:${formatICalDay(allDayRange(formatDayISO(newStart), end).endDay)}`);
    } else if (wasAllDay && dtend !== undefined && oldStart && dayOf(dtend)) {
      // Moving only the start keeps the length; DTEND must stay after DTSTART.
      const span = Math.max(1, Math.round((dayOf(dtend) - oldStart) / 86400000));
      set('DTEND', `DTEND;VALUE=DATE:${formatICalDay(addDays(newStart, span))}`);
    }
  } else {
    if (start !== undefined) set('DTSTART', `DTSTART:${formatICalDate(parseEventDate(start))}`);
    if (end !== undefined) {
      drop('DURATION');
      set('DTEND', `DTEND:${formatICalDate(parseEventDate(end))}`);
    }
  }
  if (description !== undefined) set('DESCRIPTION', `DESCRIPTION:${escapeICalText(description)}`);
  if (location !== undefined) set('LOCATION', `LOCATION:${escapeICalText(location)}`);
  if (rule) {
    set('RRULE', `RRULE:${rule}`);
  } else if (rule === '') {
    for (const name of ['RRULE', 'RDATE', 'EXDATE']) drop(name);
    // Overridden occurrences belong to the series that no longer exists.
    for (const ev of vevents) {
      if (ev !== master && ev.isOverride) {
        for (let j = ev.begin; j <= ev.end; j++) removed.add(j);
      }
    }
  }
  set('DTSTAMP', `DTSTAMP:${formatICalDate(new Date())}`);

  // New properties go before the first sub-component (VALARM), as RFC 5545
  // orders them, or before END:VEVENT.
  const insertAt = master.firstChild !== null ? master.firstChild : master.end;
  const out = [];
  props.forEach((lines, i) => {
    if (i === insertAt) out.push(...inserts);
    if (!removed.has(i)) out.push(...lines);
  });
  return out.join('\r\n');
}

/**
 * Update an existing event, preserving every property not being changed.
 */
async function updateEvent(eventUrl, changes) {
  const client = await getClient();
  const calendars = await client.fetchCalendars();

  let existing = null;
  for (const calendar of calendars) {
    try {
      const objects = await client.fetchCalendarObjects({
        calendar,
        objectUrls: [eventUrl]
      });
      if (objects && objects.length && objects[0].data) {
        existing = objects[0];
        break;
      }
    } catch (error) {
      // Wrong calendar for this URL; keep looking.
    }
  }

  if (!existing) {
    throw new Error(`Event not found: ${eventUrl}`);
  }

  const updated = applyICalChanges(existing.data, changes);

  await client.updateCalendarObject({
    calendarObject: {
      url: eventUrl,
      data: updated,
      etag: existing.etag || ''
    }
  });

  return { success: true, url: eventUrl };
}

/**
 * Delete an event
 */
async function deleteEvent(eventUrl) {
  const client = await getClient();

  await client.deleteCalendarObject({
    calendarObject: {
      url: eventUrl,
      etag: '' // Will be fetched
    }
  });

  return { success: true };
}

/**
 * Format date for iCalendar
 */
function formatICalDate(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Format a calendar day as an iCalendar DATE value (YYYYMMDD)
 */
function formatICalDay(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
}

/** Local calendar date as YYYY-MM-DD */
function formatDayISO(date) {
  const v = formatICalDay(date);
  return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
}

/**
 * Fold a content line at 75 octets (RFC 5545 section 3.1), never inside a
 * UTF-8 character.
 */
function foldLine(line) {
  const out = [];
  let current = '';
  let octets = 0;
  for (const ch of line) {
    const size = Buffer.byteLength(ch);
    if (octets + size > 75) {
      out.push(current);
      current = ' ';
      octets = 1;
    }
    current += ch;
    octets += size;
  }
  out.push(current);
  return out.join('\r\n');
}

/**
 * Escape text for iCalendar
 */
function escapeICalText(text) {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    // Any line break, including a lone CR, would end the content line.
    .replace(/\r\n|\r|\n/g, '\\n');
}

module.exports = {
  getClient,
  clearClient,
  getCalendars,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  parseEvent,
  applyICalChanges,
  foldLine
};
