const { parseCount } = require('../src/validator');

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

  test('accepts the goal value (1 000 000)', () => {
    expect(parseCount('1000000')).toBe(1_000_000);
  });

  test('accepts numbers up to the maximum valid count (10 000 000)', () => {
    expect(parseCount('10000000')).toBe(10_000_000);
  });

  test('returns null for numbers exceeding the maximum valid count', () => {
    expect(parseCount('10000001')).toBeNull();
  });

  test('returns null for absurdly large cheat numbers', () => {
    expect(parseCount('2966666666666666700000000000000000000000000000000000000000000000')).toBeNull();
  });
});
