/**
 * Tool argument validation
 *
 * The MCP server advertises an inputSchema per tool but nothing enforced it,
 * so a client could send a string where a number was declared. Several tools
 * interpolate numeric arguments straight into AppleScript/JXA source, which
 * turns a type mismatch into arbitrary script execution.
 */

const NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * Coerce and check a single value against a property schema.
 * Returns the coerced value, or throws with a message naming the property.
 */
function coerceValue(name, spec, value) {
  const expected = spec.type;

  if (spec.enum && !spec.enum.includes(value)) {
    throw new Error(`"${name}" must be one of: ${spec.enum.join(', ')}`);
  }

  switch (expected) {
    case 'number':
    case 'integer': {
      let n = value;
      if (typeof n === 'string' && NUMERIC.test(n.trim())) n = Number(n);
      if (typeof n !== 'number' || !Number.isFinite(n)) {
        throw new Error(`"${name}" must be a number`);
      }
      return expected === 'integer' ? Math.trunc(n) : n;
    }

    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      throw new Error(`"${name}" must be a boolean`);
    }

    case 'string': {
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      throw new Error(`"${name}" must be a string`);
    }

    case 'array': {
      if (!Array.isArray(value)) throw new Error(`"${name}" must be an array`);
      return value;
    }

    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`"${name}" must be an object`);
      }
      return value;
    }

    default:
      return value;
  }
}

/**
 * Validate a tool call's arguments against the tool's declared inputSchema.
 * Undeclared properties are passed through untouched.
 *
 * @param {string} toolName - Tool being called, used in error messages
 * @param {Object} schema - The tool's inputSchema
 * @param {Object} args - Raw arguments from the client
 * @returns {Object} - Arguments with declared properties coerced to their types
 */
function validateArgs(toolName, schema, args) {
  if (!schema || schema.type !== 'object') return args;

  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error(`Invalid arguments for ${toolName}: expected an object`);
  }

  for (const name of schema.required || []) {
    if (args[name] === undefined || args[name] === null || args[name] === '') {
      throw new Error(`Invalid arguments for ${toolName}: "${name}" is required`);
    }
  }

  const properties = schema.properties || {};
  const validated = { ...args };

  for (const [name, spec] of Object.entries(properties)) {
    if (validated[name] === undefined || validated[name] === null) continue;
    try {
      validated[name] = coerceValue(name, spec, validated[name]);
    } catch (error) {
      throw new Error(`Invalid arguments for ${toolName}: ${error.message}`);
    }
  }

  return validated;
}

module.exports = { validateArgs };
