const { parseCount, processCountBatch } = require('../src/validator');

// ---------------------------------------------------------------------------
// parseCount
// ---------------------------------------------------------------------------

describe('parseCount', () => {
  // Basic valid formats
  test('parses a bare number', () => {
    expect(parseCount('42')).toBe(42);
  });

  test('parses number followed by space and chat', () => {
    expect(parseCount('336017 hello world')).toBe(336017);
  });

  test('parses number followed by dash-space and chat', () => {
    expect(parseCount('336029 - count with letters with us!')).toBe(336029);
  });

  test('parses number followed by a newline', () => {
    expect(parseCount('100\nsome chat here')).toBe(100);
  });

  // Celebration / milestone formats (these were the primary cause of broken chains)
  test('parses number followed by exclamation mark', () => {
    expect(parseCount('600!')).toBe(600);
  });

  test('parses number followed by multiple exclamation marks', () => {
    expect(parseCount('1000!!!')).toBe(1000);
  });

  test('parses number followed by emoji shortcode', () => {
    expect(parseCount('600:tada:')).toBe(600);
  });

  test('parses number followed by unicode emoji', () => {
    expect(parseCount('600🎉')).toBe(600);
  });

  test('parses number followed by period (e.g. "600.")', () => {
    expect(parseCount('600.')).toBe(600);
  });

  test('parses number followed by comma and text', () => {
    expect(parseCount('336613, woohoo!')).toBe(336613);
  });

  test('parses number with trailing whitespace after exclamation', () => {
    expect(parseCount('500! nice milestone')).toBe(500);
  });

  // False info / typos that should still parse correctly
  test('parses number followed by a hyphen (typo dash)', () => {
    expect(parseCount('42-comment')).toBe(42);
  });

  test('parses number even when followed by emoji and text', () => {
    expect(parseCount('999 🔥 let\'s go!')).toBe(999);
  });

  // Null cases
  test('returns null for pure chat messages', () => {
    expect(parseCount('hello world')).toBeNull();
  });

  test('returns null for messages starting with text', () => {
    expect(parseCount('wow 42')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseCount('')).toBeNull();
  });

  test('returns null for null', () => {
    expect(parseCount(null)).toBeNull();
  });

  test('returns null for zero (not a valid count)', () => {
    expect(parseCount('0')).toBeNull();
  });

  test('returns null for negative-like text (leading minus)', () => {
    expect(parseCount('-5')).toBeNull();
  });

  // Boundary / cheat number handling
  test('trims leading whitespace before parsing', () => {
    expect(parseCount('  100 ')).toBe(100);
  });

  test('accepts the goal value (1 000 000)', () => {
    expect(parseCount('1000000')).toBe(1_000_000);
  });

  test('returns null for numbers exceeding the maximum valid count', () => {
    expect(parseCount('1000001')).toBeNull();
  });

  test('returns null for absurdly large cheat numbers', () => {
    expect(parseCount('2966666666666666700000000000000000000000000000000000000000000000')).toBeNull();
  });

  // Tricky strings designed to confuse the parser
  test('returns null for a URL-like string starting with text', () => {
    expect(parseCount('https://example.com/100')).toBeNull();
  });

  test('parses a number even when followed by a colon (list format)', () => {
    // "1: first item" would parse as 1 — acceptable in counting context
    expect(parseCount('1: first item')).toBe(1);
  });

  test('returns null for a message that is only whitespace', () => {
    expect(parseCount('   ')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// processCountBatch
// ---------------------------------------------------------------------------

describe('processCountBatch', () => {
  const mkRow = (number, ts) => ({ slackTs: ts, userId: 'U001', number });

  test('returns empty array for empty candidates', () => {
    expect(processCountBatch([], 0)).toEqual([]);
  });

  test('accepts a clean sequential run from 1', () => {
    const candidates = [
      mkRow(1, '1000001.000000'),
      mkRow(2, '1000002.000000'),
      mkRow(3, '1000003.000000'),
    ];
    const result = processCountBatch(candidates, 0);
    expect(result.map((r) => r.number)).toEqual([1, 2, 3]);
  });

  test('continues from the given startHighest', () => {
    const candidates = [
      mkRow(600, '1000600.000000'),
      mkRow(601, '1000601.000000'),
      mkRow(602, '1000602.000000'),
    ];
    const result = processCountBatch(candidates, 599);
    expect(result.map((r) => r.number)).toEqual([600, 601, 602]);
  });

  test('stops at the first gap in the sequence', () => {
    // Missing 3 — should only return 1 and 2
    const candidates = [
      mkRow(1, '1000001.000000'),
      mkRow(2, '1000002.000000'),
      // 3 is absent
      mkRow(4, '1000004.000000'),
      mkRow(5, '1000005.000000'),
    ];
    const result = processCountBatch(candidates, 0);
    expect(result.map((r) => r.number)).toEqual([1, 2]);
  });

  test('ignores duplicate count numbers — keeps the earliest ts', () => {
    const candidates = [
      mkRow(1, '1000001.000000'),
      mkRow(2, '1000002.000000'),
      { slackTs: '1000002b.000000', userId: 'U002', number: 2 }, // duplicate 2 (later)
      mkRow(3, '1000003.000000'),
    ];
    const result = processCountBatch(candidates, 0);
    expect(result.map((r) => r.number)).toEqual([1, 2, 3]);
    // The earliest occurrence of 2 should be kept
    expect(result[1].slackTs).toBe('1000002.000000');
  });

  test('handles out-of-order candidate timestamps', () => {
    // Candidates arrive out of order; the algorithm sorts first
    const candidates = [
      mkRow(3, '1000003.000000'),
      mkRow(1, '1000001.000000'),
      mkRow(2, '1000002.000000'),
    ];
    const result = processCountBatch(candidates, 0);
    expect(result.map((r) => r.number)).toEqual([1, 2, 3]);
  });

  test('rejects counts that appear before startHighest', () => {
    // DB already has 1-5; batch includes old counts that must be ignored
    const candidates = [
      mkRow(3, '1000003.000000'), // already in DB
      mkRow(6, '1000006.000000'),
      mkRow(7, '1000007.000000'),
    ];
    const result = processCountBatch(candidates, 5);
    expect(result.map((r) => r.number)).toEqual([6, 7]);
  });

  test('ignores messages with cheat/skipped numbers far ahead', () => {
    // Someone posts 9999 to try to skip ahead; sequence should stop at the gap
    const candidates = [
      mkRow(1, '1000001.000000'),
      mkRow(2, '1000002.000000'),
      mkRow(9999, '1000999.000000'), // cheater
      mkRow(3, '1000003.000000'),
    ];
    const result = processCountBatch(candidates, 0);
    expect(result.map((r) => r.number)).toEqual([1, 2, 3]);
  });

  test('handles messages with typos (non-sequential) interspersed', () => {
    // Real channel scenario: most messages valid, a few wrong numbers scattered
    const candidates = [
      mkRow(1, '1000001.000000'),
      mkRow(2, '1000002.000000'),
      mkRow(2, '1000002b.000000'), // duplicate typo
      mkRow(4, '1000004.000000'),  // skipped 3 — gap here
      mkRow(3, '1000003.000000'),  // late-arriving 3 (out of order)
      mkRow(5, '1000005.000000'),
    ];
    const result = processCountBatch(candidates, 0);
    // 3 arrives out of order but is still the earliest for its number
    expect(result.map((r) => r.number)).toEqual([1, 2, 3, 4, 5]);
  });

  test('handles a large sequential run correctly', () => {
    const candidates = Array.from({ length: 1000 }, (_, i) => ({
      slackTs: `${1_000_000 + i}.000000`,
      userId: 'U001',
      number: i + 1,
    }));
    const result = processCountBatch(candidates, 0);
    expect(result.length).toBe(1000);
    expect(result[999].number).toBe(1000);
  });
});
