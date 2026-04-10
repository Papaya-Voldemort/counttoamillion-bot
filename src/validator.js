/**
 * Maximum value accepted as a valid count.  Anything larger is treated as a
 * fake/cheat number and ignored.  Set to 10× the channel goal so the bot still
 * works even if the community overshoots 1 000 000.
 */
const MAX_VALID_COUNT = 10_000_000;

/**
 * Parses a count number from a Slack message text.
 *
 * Valid formats per channel rules:
 *   "123"           - bare number
 *   "123 some text" - number followed by space + chat
 *   "123 - comment" - number followed by dash + chat
 *   "123\ncomment"  - number followed by newline + chat
 *
 * Numbers greater than MAX_VALID_COUNT are rejected as fake/cheat values.
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
    const n = parseInt(match[1], 10);
    if (!Number.isFinite(n) || n > MAX_VALID_COUNT) return null;
    return n;
  }
  return null;
}

module.exports = { parseCount };
