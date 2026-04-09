const { parseCount, validateCount } = require('../src/validator');

describe('parseCount', () => {
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

  test('trims leading whitespace before parsing', () => {
    expect(parseCount('  100 ')).toBe(100);
  });
});

describe('validateCount', () => {
  test('accepts a correct count from a different user', () => {
    const result = validateCount(5, 5, 'USER_A', 'USER_B');
    expect(result).toEqual({ valid: true, error: null });
  });

  test('rejects a correct number from the same user (consecutive)', () => {
    const result = validateCount(5, 5, 'USER_A', 'USER_A');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('consecutive');
  });

  test('rejects a wrong number from a different user', () => {
    const result = validateCount(7, 5, 'USER_A', 'USER_B');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('wrong_number');
    expect(result.expected).toBe(5);
  });

  test('rejects a wrong number that is also consecutive', () => {
    // Consecutive check takes priority
    const result = validateCount(99, 5, 'USER_A', 'USER_A');
    expect(result.valid).toBe(false);
    expect(result.error).toBe('consecutive');
  });

  test('accepts first count (no previous counter)', () => {
    const result = validateCount(1, 1, 'USER_A', null);
    expect(result).toEqual({ valid: true, error: null });
  });
});
