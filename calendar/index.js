/**
 * Calendar module for iCloud MCP
 * Provides calendar tools via CalDAV
 */

const config = require('../config');
const useLocal = config.USE_LOCAL_MODE && config.IS_MACOS;
const { listEvents, createEvent, deleteEvent, getCalendars } = useLocal ? require('./local-client') : require('./caldav-client');
const { formatSuccess, formatError, withErrorHandler } = require('../utils/error-handler');
const { formatDate } = require('../utils/date-utils');

/**
 * Handler: List events
 */
async function handleListEvents(args) {
  const count = Math.min(args.count || 25, config.DEFAULTS.MAX_RESULTS);
  const daysAhead = args.daysAhead || 30;

  const events = await listEvents(count, daysAhead);

  if (events.length === 0) {
    return formatSuccess(`No upcoming events in the next ${daysAhead} days.`);
  }

  const lines = events.map((event, i) => {
    const dateStr = event.isAllDay
      ? `All day: ${formatDate(event.start, { hour: undefined, minute: undefined })}`
      : `${formatDate(event.start)} - ${formatDate(event.end, { year: undefined, month: undefined, day: undefined })}`;

    let line = `${i + 1}. ${event.summary}\n   ${dateStr}`;
    if (event.location) line += `\n   Location: ${event.location}`;
    if (event.calendarName) line += `\n   Calendar: ${event.calendarName}`;
    line += `\n   URL: ${event.url}`;

    return line;
  });

  return formatSuccess(`Upcoming events (${events.length}):\n\n${lines.join('\n\n')}`);
}

/**
 * Handler: Create event
 */
async function handleCreateEvent(args) {
  if (!args.summary) {
    return formatError(new Error('Event summary/title is required'));
  }
  if (!args.start) {
    return formatError(new Error('Start date/time is required (ISO 8601 format)'));
  }
  if (!args.end) {
    return formatError(new Error('End date/time is required (ISO 8601 format)'));
  }

  const result = await createEvent({
    summary: args.summary,
    start: args.start,
    end: args.end,
    description: args.description,
    location: args.location,
    calendarUrl: args.calendarUrl
  });

  return formatSuccess(
    `Event created successfully!\n\nTitle: ${args.summary}\nStart: ${formatDate(new Date(args.start))}\nEnd: ${formatDate(new Date(args.end))}${args.location ? `\nLocation: ${args.location}` : ''}\nCalendar: ${result.calendar}\nUID: ${result.uid}`
  );
}

/**
 * Handler: Delete event
 */
async function handleDeleteEvent(args) {
  if (!args.eventUrl) {
    return formatError(new Error('Event URL is required'));
  }

  await deleteEvent(args.eventUrl);

  return formatSuccess(`Event deleted successfully.`);
}

/**
 * Handler: List calendars
 */
async function handleListCalendars() {
  const calendars = await getCalendars();

  if (calendars.length === 0) {
    return formatSuccess('No calendars found.');
  }

  const lines = calendars.map((cal, i) =>
    `${i + 1}. ${cal.displayName}\n   URL: ${cal.url}`
  );

  return formatSuccess(`Calendars (${calendars.length}):\n\n${lines.join('\n\n')}`);
}

// Tool definitions
const calendarTools = [
  {
    name: 'list-events',
    description: 'Lists upcoming calendar events',
    inputSchema: {
      type: 'object',
      properties: {
        count: {
          type: 'number',
          description: 'Number of events to retrieve (default: 25, max: 50)'
        },
        daysAhead: {
          type: 'number',
          description: 'Number of days to look ahead (default: 30)'
        }
      },
      required: []
    },
    handler: withErrorHandler(handleListEvents, 'list-events')
  },
  {
    name: 'create-event',
    description: 'Creates a new calendar event',
    inputSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          description: 'Event title/summary'
        },
        start: {
          type: 'string',
          description: 'Start date/time in ISO 8601 format (e.g., 2025-01-15T10:00:00)'
        },
        end: {
          type: 'string',
          description: 'End date/time in ISO 8601 format'
        },
        description: {
          type: 'string',
          description: 'Event description (optional)'
        },
        location: {
          type: 'string',
          description: 'Event location (optional)'
        },
        calendarUrl: {
          type: 'string',
          description: 'URL of the calendar to add event to (optional, uses default)'
        }
      },
      required: ['summary', 'start', 'end']
    },
    handler: withErrorHandler(handleCreateEvent, 'create-event')
  },
  {
    name: 'delete-event',
    description: 'Deletes a calendar event',
    inputSchema: {
      type: 'object',
      properties: {
        eventUrl: {
          type: 'string',
          description: 'URL of the event to delete (from list-events output)'
        }
      },
      required: ['eventUrl']
    },
    handler: withErrorHandler(handleDeleteEvent, 'delete-event')
  },
  {
    name: 'list-calendars',
    description: 'Lists all available calendars',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    },
    handler: withErrorHandler(handleListCalendars, 'list-calendars')
  }
];

module.exports = {
  calendarTools,
  handleListEvents,
  handleCreateEvent,
  handleDeleteEvent,
  handleListCalendars
};
