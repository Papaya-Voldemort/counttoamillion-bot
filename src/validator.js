/**
 * Parses a count number from a Slack message text.
 *
 * Valid formats per channel rules:
 *   "123"           - bare number
 *   "123 some text" - number followed by space + chat
 *   "123 - comment" - number followed by space-dash-space + chat
 *   "123\ncomment"  - number followed by newline + chat
 *
 * @param {string} text - The raw message text
 * @returns {number|null} The parsed integer, or null if the message is not a count
 */
function parseCount(text) {
  if (!text) return null;
  const trimmed = text.trim();
  // Must start with one or more digits, optionally followed by whitespace, dash, or end of string
  const match = trimmed.match(/^(\d+)(?:\s|[-]|$)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Validates a submitted count against the current channel state.
 *
 * @param {number} number           - The number the user submitted
 * @param {number} expectedCount    - The next expected count (currentCount + 1)
 * @param {string} userId           - Slack user ID of the submitter
 * @param {string|null} lastCounterUserId - Slack user ID of the previous valid counter
 * @returns {{ valid: boolean, error: string|null, expected?: number }}
 */
function validateCount(number, expectedCount, userId, lastCounterUserId) {
  if (userId === lastCounterUserId) {
    return { valid: false, error: 'consecutive' };
  }
  if (number !== expectedCount) {
    return { valid: false, error: 'wrong_number', expected: expectedCount };
  }
  return { valid: true, error: null };
}

module.exports = { parseCount, validateCount };
