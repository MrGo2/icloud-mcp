/**
 * Recurrence rules and all-day dates for create-event / update-event.
 *
 * A recurrence is an RFC 5545 RRULE value without the "RRULE:" prefix, e.g.
 * FREQ=YEARLY or FREQ=WEEKLY;BYDAY=MO. It ends up inside an AppleScript string
 * (local) and an iCalendar line (cloud), so it is checked part by part against
 * the RRULE grammar before it reaches either. Escaping still applies on top:
 * defence in depth, as everywhere else in this server.
 */

const FREQS = ['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const NUMBER_LIST = /^[+-]?\d{1,3}(,[+-]?\d{1,3})*$/;

// Value grammar per rule part (RFC 5545 section 3.3.10).
const PARTS = {
  FREQ: v => FREQS.includes(v),
  UNTIL: v => /^\d{8}(T\d{6}Z?)?$/.test(v),
  COUNT: v => /^[1-9]\d{0,5}$/.test(v),
  INTERVAL: v => /^[1-9]\d{0,5}$/.test(v),
  BYSECOND: v => NUMBER_LIST.test(v),
  BYMINUTE: v => NUMBER_LIST.test(v),
  BYHOUR: v => NUMBER_LIST.test(v),
  BYDAY: v => v.split(',').every(d => /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.test(d)),
  BYMONTHDAY: v => NUMBER_LIST.test(v),
  BYYEARDAY: v => NUMBER_LIST.test(v),
  BYWEEKNO: v => NUMBER_LIST.test(v),
  BYMONTH: v => NUMBER_LIST.test(v),
  BYSETPOS: v => NUMBER_LIST.test(v),
  WKST: v => WEEKDAYS.includes(v)
};

const MAX_LENGTH = 512;

// Boundary check for the zod schemas: only the RRULE alphabet gets through, so
// no quote, backslash, space or line break can reach a script or an ICS line.
// The empty string is allowed: update-event uses it to remove a recurrence.
const RECURRENCE_INPUT = /^[A-Za-z0-9=;,:+-]*$/;

const EXAMPLES = 'e.g. FREQ=YEARLY, FREQ=WEEKLY;BYDAY=MO or FREQ=MONTHLY;COUNT=12';

/**
 * Validate and normalize a recurrence rule.
 *
 * @param {string|undefined|null} value - RRULE value; an optional "RRULE:"
 *   prefix is stripped and the rule is upper-cased
 * @returns {string|undefined} undefined when not given, '' to remove, else the rule
 * @throws {Error} when the rule is not a valid RRULE
 */
function normalizeRecurrence(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error('Invalid recurrence: expected a string');

  const rule = value.trim().replace(/^RRULE:/i, '').toUpperCase();
  if (rule === '') return '';

  const fail = reason => new Error(`Invalid recurrence: ${reason}. Use an RFC 5545 RRULE, ${EXAMPLES}`);
  if (rule.length > MAX_LENGTH) throw fail(`longer than ${MAX_LENGTH} characters`);
  if (!RECURRENCE_INPUT.test(rule) || rule.includes(':')) throw fail('unexpected character');

  const seen = new Set();
  rule.split(';').forEach((part, i) => {
    const eq = part.indexOf('=');
    const name = eq === -1 ? part : part.slice(0, eq);
    const val = eq === -1 ? '' : part.slice(eq + 1);
    if (i === 0 && name !== 'FREQ') throw fail('it must start with FREQ=');
    if (!PARTS[name]) throw fail(`unknown rule part "${name}"`);
    if (seen.has(name)) throw fail(`${name} appears twice`);
    if (!PARTS[name](val)) throw fail(`bad ${name} value "${val}"`);
    seen.add(name);
  });
  if (seen.has('UNTIL') && seen.has('COUNT')) throw fail('UNTIL and COUNT cannot be combined');

  return rule;
}

/**
 * Parse an event date. A bare date (YYYY-MM-DD) means local midnight, not
 * UTC midnight as `new Date()` would read it, which lands on the previous day
 * west of Greenwich.
 */
function parseEventDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value).trim());
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
  return d;
}

/**
 * The calendar day an all-day event falls on, as a local-midnight Date.
 * When the value starts with YYYY-MM-DD those digits win, so
 * 2026-12-25T00:00:00Z is the 25th in every time zone.
 */
function allDayDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = parseEventDate(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * All-day start and end days. The end is exclusive, as in iCalendar: a
 * one-day event on the 25th ends on the 26th. An end on or before the start
 * day means a single day.
 */
function allDayRange(start, end) {
  const startDay = allDayDate(start);
  let endDay = end === undefined || end === null || end === '' ? null : allDayDate(end);
  if (!endDay || endDay <= startDay) {
    endDay = new Date(startDay.getFullYear(), startDay.getMonth(), startDay.getDate() + 1);
  }
  return { startDay, endDay };
}

module.exports = {
  RECURRENCE_INPUT,
  normalizeRecurrence,
  parseEventDate,
  allDayDate,
  allDayRange
};
