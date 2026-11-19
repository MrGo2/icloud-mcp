/**
 * Date formatting utilities
 */

const config = require('../config');

/**
 * Format date for display (ICLOUD_LOCALE, Spanish by default)
 */
function formatDate(date, options = {}) {
  const d = date instanceof Date ? date : new Date(date);

  const defaultOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: config.DEFAULTS.TIMEZONE
  };

  return d.toLocaleString(config.DEFAULTS.DATE_FORMAT, { ...defaultOptions, ...options });
}

/**
 * Format date for iCalendar (YYYYMMDDTHHMMSS format)
 */
function formatICalDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * Parse ISO date string
 */
function parseDate(dateStr) {
  return new Date(dateStr);
}

/**
 * Get date range for calendar queries
 */
function getDateRange(daysAhead = 30) {
  const start = new Date();
  const end = new Date();
  end.setDate(end.getDate() + daysAhead);

  return { start, end };
}

/**
 * Format relative date (today, yesterday, etc.)
 */
function formatRelative(date) {
  const d = date instanceof Date ? date : new Date(date);
  const now = new Date();
  const diff = Math.floor((now - d) / (1000 * 60 * 60 * 24));

  if (diff >= 0 && diff < 7) {
    // Worded in the configured locale ("Hoy" for es-ES, "Today" for en-US).
    const rel = new Intl.RelativeTimeFormat(config.DEFAULTS.DATE_FORMAT, { numeric: 'auto' })
      .format(-diff, 'day');
    return rel.charAt(0).toUpperCase() + rel.slice(1);
  }

  return formatDate(d, { hour: undefined, minute: undefined });
}

module.exports = {
  formatDate,
  formatICalDate,
  parseDate,
  getDateRange,
  formatRelative
};
