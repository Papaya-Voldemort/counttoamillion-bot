/**
 * Maximum value accepted as a valid count.  Anything larger is treated as a
 * fake/cheat number and ignored.  Matches the channel goal of 1 000 000.
 */
const MAX_VALID_COUNT = 1_000_000;

/**
 * Parses a count number from a Slack message text.
 *
 * Valid formats per channel rules:
 *   "123"           - bare number
 *   "123 some text" - number followed by space + chat
 *   "123 - comment" - number followed by dash + chat
 *   "123\ncomment"  - number followed by newline + chat
 *   "123!"          - number followed by punctuation (milestone celebrations)
 *   "123🎉"         - number followed by emoji
 *   "123:tada:"     - number followed by Slack emoji shortcode
 *
 * Only the leading integer matters; anything non-numeric after it is ignored.
 * Numbers less than 1 or greater than MAX_VALID_COUNT are rejected.
 *
 * @param {string} text - The raw message text
 * @returns {number|null} The parsed integer, or null if the message is not a count
 */
function parseCount(text) {
  if (!text) return null;
  const trimmed = text.trim();
  // Must start with one or more digits NOT immediately followed by another digit.
  // This accepts "600!", "600 text", "600.", "600🎉", "600:tada:", etc., while
  // still rejecting messages that start with letters ("wow 42") or are blank.
  const match = trimmed.match(/^(\d+)(?![0-9])/);
  if (match) {
    const n = parseInt(match[1], 10);
    if (Number.isNaN(n) || n < 1 || n > MAX_VALID_COUNT) return null;
    return n;
  }
  return null;
}

/**
 * Given a chronologically-sorted (or unsorted) array of candidate count rows
 * and the highest count already in the database, returns only the rows that
 * form a valid gapless sequential run starting at `startHighest + 1`.
 *
 * Algorithm:
 *  1. Sort candidates chronologically (by Slack ts).
 *  2. Build a map of count_number → first-seen row.  If the same number was
 *     posted twice (duplicate attempt), only the earliest post is kept.
 *  3. Walk the sequence from `startHighest + 1` upward, accepting each count
 *     only if a matching row exists in the map.  Stop at the first gap.
 *
 * This approach is more robust than a single linear pass because it tolerates
 * out-of-order timestamps (e.g., a late-arriving API page) and duplicate posts.
 *
 * @param {{ slackTs: string, userId: string, number: number }[]} candidates
 * @param {number} startHighest  Highest count already stored (0 for fresh sync)
 * @returns {{ slackTs: string, userId: string, number: number }[]}
 */
function processCountBatch(candidates, startHighest) {
  // Sort chronologically so that the *first* occurrence of each number is
  // the earliest legitimate post.
  const sorted = candidates.slice().sort((a, b) => parseFloat(a.slackTs) - parseFloat(b.slackTs));

  // Build a map: count_number → first occurrence row
  const firstOccurrence = new Map();
  for (const row of sorted) {
    if (!firstOccurrence.has(row.number)) {
      firstOccurrence.set(row.number, row);
    }
  }

  // Walk the expected sequence and collect valid rows
  let expected = startHighest + 1;
  const validBatch = [];
  while (firstOccurrence.has(expected)) {
    validBatch.push(firstOccurrence.get(expected));
    expected++;
  }

  return validBatch;
}

module.exports = { parseCount, processCountBatch };
