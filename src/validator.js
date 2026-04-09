/**
 * Parses a count number from a Slack message text.
 *
 * Valid formats per channel rules:
 *   "123"           - bare number
 *   "123 some text" - number followed by space + chat
 *   "123 - comment" - number followed by dash + chat
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

module.exports = { parseCount };
