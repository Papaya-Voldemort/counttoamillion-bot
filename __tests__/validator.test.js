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
});
