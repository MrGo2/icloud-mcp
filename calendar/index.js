/**
 * Calendar module for iCloud MCP
 * Provides calendar tools via CalDAV
 */

const { z } = require('zod');
const { listEvents, createEvent, updateEvent, deleteEvent, getCalendars } = require('./caldav-client');
const { formatSuccess, formatError, withErrorHandler } = require('../utils/error-handler');
const { listOutput, listResult } = require('../utils/schemas');
const { formatDate } = require('../utils/date-utils');
const config = require('../config');

/**
 * Handler: List events
 */
async function handleListEvents(args) {
  const count = Math.min(args.count || 25, config.DEFAULTS.MAX_RESULTS);
  const daysAhead = args.daysAhead || 30;

  const events = await listEvents(count, daysAhead);

  if (events.length === 0) {
    return formatSuccess(`No upcoming events in the next ${daysAhead} days.`, listResult([]));
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

  return formatSuccess(`Upcoming events (${events.length}):\n\n${lines.join('\n\n')}`, listResult(events));
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
 * Handler: Update event
 */
async function handleUpdateEvent(args) {
  if (!args.eventUrl) {
    return formatError(new Error('Event URL is required (from list-events output)'));
  }

  const changes = {};
  for (const field of ['summary', 'start', 'end', 'description', 'location']) {
    if (args[field] !== undefined) changes[field] = args[field];
  }

  if (Object.keys(changes).length === 0) {
    return formatError(new Error('Nothing to update. Provide at least one of: summary, start, end, description, location.'));
  }

  for (const field of ['start', 'end']) {
    if (changes[field] !== undefined && Number.isNaN(new Date(changes[field]).getTime())) {
      return formatError(new Error(`Invalid ${field} date. Use ISO 8601, e.g. 2026-01-15T10:00:00`));
    }
  }

  await updateEvent(args.eventUrl, changes);

  const summary = Object.entries(changes)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');

  return formatSuccess(`Event updated successfully.\n\n${summary}`);
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
    return formatSuccess('No calendars found.', listResult([]));
  }

  const lines = calendars.map((cal, i) =>
    `${i + 1}. ${cal.displayName}\n   URL: ${cal.url}`
  );

  return formatSuccess(`Calendars (${calendars.length}):\n\n${lines.join('\n\n')}`, listResult(calendars));
}

// Tool definitions
const calendarTools = [
  {
    name: 'list-events',
    outputSchema: listOutput('Calendar events'),
    title: 'List Events',
    description: 'Lists upcoming calendar events',
    inputSchema: {
      count: z.number().int().min(1).max(50).optional().describe('Number of events to retrieve (default: 25, max: 50)'),
      daysAhead: z.number().int().min(1).max(365).optional().describe('Number of days to look ahead (default: 30)')
    },
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":true},
    handler: withErrorHandler(handleListEvents, 'list-events')
  },
  {
    name: 'create-event',
    title: 'Create Event',
    description: 'Creates a new calendar event',
    inputSchema: {
      summary: z.string().describe('Event title/summary'),
      start: z.string().describe('Start date/time in ISO 8601 format (e.g., 2026-01-15T10:00:00)'),
      end: z.string().describe('End date/time in ISO 8601 format'),
      description: z.string().optional().describe('Event description (optional)'),
      location: z.string().optional().describe('Event location (optional)'),
      calendarUrl: z.string().optional().describe('URL of the calendar to add event to (optional, uses default)')
    },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true},
    handler: withErrorHandler(handleCreateEvent, 'create-event')
  },
  {
    name: 'update-event',
    title: 'Update Event',
    description: 'Updates an existing calendar event. Only the fields you pass are changed; recurrence, invitees and alarms are preserved.',
    inputSchema: {
      eventUrl: z.string().describe('URL of the event to update (from list-events output)'),
      summary: z.string().optional().describe('New event title (optional)'),
      start: z.string().optional().describe('New start date/time in ISO 8601 format (optional)'),
      end: z.string().optional().describe('New end date/time in ISO 8601 format (optional)'),
      description: z.string().optional().describe('New description (optional)'),
      location: z.string().optional().describe('New location (optional)')
    },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
    handler: withErrorHandler(handleUpdateEvent, 'update-event')
  },
  {
    name: 'delete-event',
    title: 'Delete Event',
    description: 'Deletes a calendar event',
    inputSchema: {
      eventUrl: z.string().describe('URL of the event to delete (from list-events output)')
    },
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true},
    handler: withErrorHandler(handleDeleteEvent, 'delete-event')
  },
  {
    name: 'list-calendars',
    outputSchema: listOutput('Calendars'),
    title: 'List Calendars',
    description: 'Lists all available calendars',
    inputSchema: {},
    annotations: {"readOnlyHint":true,"idempotentHint":true,"openWorldHint":true},
    handler: withErrorHandler(handleListCalendars, 'list-calendars')
  }
];

module.exports = {
  calendarTools,
  handleListEvents,
  handleCreateEvent,
  handleUpdateEvent,
  handleDeleteEvent,
  handleListCalendars
};
