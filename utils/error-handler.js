/**
 * Centralized error handling utilities
 */

/**
 * Format error for MCP response
 */
function formatError(error, context = '') {
  const prefix = context ? `[${context}] ` : '';

  if (error.message === 'UNAUTHORIZED' || error.message?.includes('authentication')) {
    return {
      content: [{
        type: 'text',
        text: `${prefix}Authentication failed. Please verify your iCloud credentials in .env file.\n\nTo set up:\n1. Go to https://appleid.apple.com\n2. Security → App-Specific Passwords → Generate\n3. Copy the password to ICLOUD_APP_PASSWORD in .env`
      }],
      isError: true
    };
  }

  return {
    content: [{
      type: 'text',
      text: `${prefix}Error: ${error.message || 'Unknown error occurred'}`
    }],
    isError: true
  };
}

/**
 * Create success response
 *
 * @param {string} text - Human-readable result
 * @param {Object} [structuredContent] - Machine-readable result. Only pass this
 *   when the tool declares an outputSchema; the SDK validates one against the
 *   other and fails the call if they disagree.
 */
function formatSuccess(text, structuredContent) {
  const response = {
    content: [{
      type: 'text',
      text: text
    }]
  };

  if (structuredContent !== undefined) {
    response.structuredContent = structuredContent;
  }

  return response;
}

/**
 * Wrap handler with error catching
 */
function withErrorHandler(handler, context) {
  return async (args) => {
    try {
      return await handler(args);
    } catch (error) {
      console.error(`[${context}] Error:`, error.message);
      return formatError(error, context);
    }
  };
}

module.exports = {
  formatError,
  formatSuccess,
  withErrorHandler
};
