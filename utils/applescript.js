/**
 * AppleScript Executor Utility
 * Executes AppleScript and JXA scripts via osascript
 */

const { spawn } = require('child_process');

/**
 * Execute an AppleScript string via stdin (handles multi-line scripts)
 * @param {string} script - The AppleScript code to execute
 * @returns {Promise<string>} - The script output
 */
async function runAppleScript(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', ['-']);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new AppleScriptError(stderr || stdout, script));
      }
    });

    proc.on('error', (err) => {
      reject(new AppleScriptError(err.message, script));
    });

    // Write script to stdin
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

/**
 * Execute a JXA (JavaScript for Automation) script via stdin
 * @param {string} script - The JXA code to execute
 * @returns {Promise<string>} - The script output
 */
async function runJXA(script) {
  return new Promise((resolve, reject) => {
    const proc = spawn('osascript', ['-l', 'JavaScript', '-']);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new AppleScriptError(stderr || stdout, script));
      }
    });

    proc.on('error', (err) => {
      reject(new AppleScriptError(err.message, script));
    });

    // Write script to stdin
    proc.stdin.write(script);
    proc.stdin.end();
  });
}

/**
 * Execute JXA and parse JSON result
 * @param {string} script - JXA script that returns JSON.stringify() output
 * @returns {Promise<any>} - Parsed JSON result
 */
async function runJXAWithJSON(script) {
  const result = await runJXA(script);
  if (!result) return null;
  try {
    return JSON.parse(result);
  } catch (e) {
    return result;
  }
}

/**
 * Escape string for use in AppleScript
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
function escapeAppleScript(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/**
 * Escape string for use in JXA
 * @param {string} str - String to escape
 * @returns {string} - Escaped string
 */
function escapeJXA(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Coerce a value that gets interpolated into script source as a bare number.
 * Anything non-numeric would be injected as raw AppleScript/JXA, so reject it.
 * @param {*} value - Value to coerce
 * @param {number} fallback - Used when value is null/undefined
 * @returns {number} - A finite integer
 */
function asInt(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return Math.trunc(fallback);
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Expected a number, got: ${JSON.stringify(value)}`);
  }
  return Math.trunc(n);
}

/**
 * Coerce a value that gets interpolated into script source as a bare boolean.
 * @param {*} value - Value to coerce
 * @param {boolean} fallback - Used when value is null/undefined
 * @returns {boolean}
 */
function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected a boolean, got: ${JSON.stringify(value)}`);
}

/**
 * Format date for AppleScript
 * @param {Date|string} date - Date to format
 * @returns {string} - AppleScript date string
 */
function formatAppleScriptDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  // Format: "January 15, 2026 at 10:30:00 AM"
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).replace(',', ' at');
}

/**
 * Custom error class for AppleScript errors
 */
class AppleScriptError extends Error {
  constructor(message, script) {
    super(message);
    this.name = 'AppleScriptError';
    this.script = script;

    // Parse common AppleScript errors
    if (message.includes('not allowed')) {
      this.code = 'PERMISSION_DENIED';
      this.userMessage = 'Permission denied. Please grant access in System Settings > Privacy & Security.';
    } else if (message.includes('Application isn\'t running')) {
      this.code = 'APP_NOT_RUNNING';
      this.userMessage = 'The application is not running.';
    } else if (message.includes('Can\'t get')) {
      this.code = 'NOT_FOUND';
      this.userMessage = 'The requested item was not found.';
    } else {
      this.code = 'SCRIPT_ERROR';
      this.userMessage = message;
    }
  }
}

module.exports = {
  runAppleScript,
  runJXA,
  runJXAWithJSON,
  escapeAppleScript,
  escapeJXA,
  asInt,
  asBool,
  formatAppleScriptDate,
  AppleScriptError
};
