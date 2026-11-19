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

// A comma list of integers in [min, max]; `signed` allows -max..-1 as well.
function intList(min, max, signed = false) {
  return value => value.split(',').every(item => {
    const m = /^([+-])?(\d{1,3})$/.exec(item);
    if (!m || (m[1] && !signed)) return false;
    const n = Number(m[2]);
    return n >= (signed ? 1 : min) && n <= max && (!m[1] || n >= 1);
  });
}

function isRealDate(y, mo, d) {
  const date = new Date(y, mo - 1, d);
  return date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
}

function isUntil(value) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(value);
  if (!m || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  return m[4] === undefined || (Number(m[4]) <= 23 && Number(m[5]) <= 59 && Number(m[6]) <= 60);
}

// Value grammar and ranges per rule part (RFC 5545 section 3.3.10).
const PARTS = {
  FREQ: v => FREQS.includes(v),
  UNTIL: isUntil,
  COUNT: v => /^[1-9]\d{0,5}$/.test(v),
  INTERVAL: v => /^[1-9]\d{0,5}$/.test(v),
  BYSECOND: intList(0, 60),
  BYMINUTE: intList(0, 59),
  BYHOUR: intList(0, 23),
  BYDAY: v => v.split(',').every(d => {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(d);
    return !!m && (m[1] === undefined || (Math.abs(Number(m[1])) >= 1 && Math.abs(Number(m[1])) <= 53));
  }),
  BYMONTHDAY: intList(1, 31, true),
  BYYEARDAY: intList(1, 366, true),
  BYWEEKNO: intList(1, 53, true),
  BYMONTH: intList(1, 12),
  BYSETPOS: intList(1, 366, true),
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

  const trimmed = value.trim();
  if (trimmed === '') return '';

  const fail = reason => new Error(`Invalid recurrence: ${reason}. Use an RFC 5545 RRULE, ${EXAMPLES}`);
  const rule = trimmed.replace(/^RRULE:/i, '').toUpperCase();
  // "RRULE:" alone is a mistake, not a request to remove the recurrence.
  if (rule === '') throw fail('the rule is empty');
  if (rule.length > MAX_LENGTH) throw fail(`longer than ${MAX_LENGTH} characters`);
  if (!RECURRENCE_INPUT.test(rule) || rule.includes(':')) throw fail('unexpected character');

  const seen = new Set();
  rule.split(';').forEach((part, i) => {
    const eq = part.indexOf('=');
    const name = eq === -1 ? part : part.slice(0, eq);
    const val = eq === -1 ? '' : part.slice(eq + 1);
    if (i === 0 && name !== 'FREQ') throw fail('it must start with FREQ=');
    if (!Object.hasOwn(PARTS, name)) throw fail(`unknown rule part "${name}"`);
    if (seen.has(name)) throw fail(`${name} appears twice`);
    if (!PARTS[name](val)) throw fail(`bad ${name} value "${val}"`);
    seen.add(name);
  });
  if (seen.has('UNTIL') && seen.has('COUNT')) throw fail('UNTIL and COUNT cannot be combined');

  return rule;
}

/**
 * UNTIL must have the same value type as the start (RFC 5545 section 3.3.10):
 * a date (20271231) for all-day events, a UTC date-time (20271231T235959Z)
 * for timed ones.
 *
 * @throws {Error} when the types disagree
 */
function checkUntilType(rule, allDay) {
  const m = /(?:^|;)UNTIL=([0-9TZ]+)/.exec(rule || '');
  if (!m) return;
  const isDate = /^\d{8}$/.test(m[1]);
  if (allDay && !isDate) {
    throw new Error('Invalid recurrence: an all-day event needs UNTIL as a date, e.g. UNTIL=20271231');
  }
  if (!allDay && isDate) {
    throw new Error('Invalid recurrence: a timed event needs UNTIL as a UTC date-time, e.g. UNTIL=20271231T235959Z');
  }
}

/**
 * Parse an event date. A bare date (YYYY-MM-DD) means local midnight, not
 * UTC midnight as `new Date()` would read it, which lands on the previous day
 * west of Greenwich.
 */
function parseEventDate(value) {
  const text = String(value).trim();
  // V8 reads "2026-12-25junk" as some other date; an ISO date must end or go on with a time.
  if (/^\d{4}-\d{2}-\d{2}(?![T ]|$)/.test(text)) throw new Error(`Invalid date: ${value}`);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (m && !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) throw new Error(`Invalid date: ${value}`);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(text);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
  return d;
}

/**
 * The calendar day an all-day event falls on, as a local-midnight Date.
 * When the value is ISO 8601 those date digits win, so
 * 2026-12-25T00:00:00Z is the 25th in every time zone.
 */
function allDayDate(value) {
  const text = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(text);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!isRealDate(y, mo, d) || Number.isNaN(new Date(text).getTime())) throw new Error(`Invalid date: ${value}`);
    return new Date(y, mo - 1, d);
  }
  const d = parseEventDate(text);
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
  if (!endDay || endDay <= startDay) endDay = addDays(startDay, 1);
  return { startDay, endDay };
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** Local calendar date as YYYY-MM-DD. */
function formatDay(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

module.exports = {
  RECURRENCE_INPUT,
  normalizeRecurrence,
  checkUntilType,
  parseEventDate,
  allDayDate,
  allDayRange,
  addDays,
  formatDay
};
