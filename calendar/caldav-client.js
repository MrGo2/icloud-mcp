/**
 * CalDAV client for iCloud Calendar
 */

const { DAVClient } = require('tsdav');
const ICAL = require('ical.js');
const config = require('../config');
const { getCredentials } = require('../auth');

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
    const vevent = comp.getFirstSubcomponent('vevent');

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
 */
async function createEvent({ summary, start, end, description, location, calendarUrl }) {
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

  const startDate = new Date(start);
  const endDate = new Date(end);

  const icalData = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//iCloud MCP//EN
BEGIN:VEVENT
UID:${uid}
DTSTAMP:${formatICalDate(new Date())}
DTSTART:${formatICalDate(startDate)}
DTEND:${formatICalDate(endDate)}
SUMMARY:${escapeICalText(summary)}${description ? `\nDESCRIPTION:${escapeICalText(description)}` : ''}${location ? `\nLOCATION:${escapeICalText(location)}` : ''}
END:VEVENT
END:VCALENDAR`;

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
 * @param {string} ical - Existing iCalendar text
 * @param {Object} changes - Properties to set; undefined values are left alone
 * @returns {string} - Updated iCalendar text
 */
function applyICalChanges(ical, { summary, start, end, description, location }) {
  const updates = [];
  if (summary !== undefined) updates.push(['SUMMARY', escapeICalText(summary)]);
  if (start !== undefined) updates.push(['DTSTART', formatICalDate(new Date(start))]);
  if (end !== undefined) updates.push(['DTEND', formatICalDate(new Date(end))]);
  if (description !== undefined) updates.push(['DESCRIPTION', escapeICalText(description)]);
  if (location !== undefined) updates.push(['LOCATION', escapeICalText(location)]);
  updates.push(['DTSTAMP', formatICalDate(new Date())]);

  const lines = ical.split(/\r?\n/);

  for (const [key, value] of updates) {
    // A property may carry parameters, e.g. DTSTART;TZID=Europe/Madrid:...
    const idx = lines.findIndex(l => {
      const upper = l.toUpperCase();
      return upper.startsWith(key + ':') || upper.startsWith(key + ';');
    });

    if (idx !== -1) {
      lines[idx] = `${key}:${value}`;
    } else {
      const endIdx = lines.findIndex(l => l.toUpperCase().startsWith('END:VEVENT'));
      lines.splice(endIdx === -1 ? lines.length : endIdx, 0, `${key}:${value}`);
    }
  }

  return lines.join('\r\n');
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
 * Escape text for iCalendar
 */
function escapeICalText(text) {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
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
  applyICalChanges
};
