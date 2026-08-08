'use strict';

const { normalizeRows, normalizeValue, truncateText } = require('../core/valueNormalizer');

describe('valueNormalizer', () => {
  it('preserves scalar types and normalizes special values', () => {
    expect(normalizeValue(null)).toBeNull();
    expect(normalizeValue(42)).toBe(42);
    expect(normalizeValue(true)).toBe(true);
    expect(normalizeValue(123n)).toBe('123');
    expect(normalizeValue(new Date('2026-01-02T03:04:05.000Z'))).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });

  it('explicitly limits large cells, not rows', () => {
    expect(truncateText('abcdefghij', 5)).toContain('abcde…');
    const rows = normalizeRows(
      [{ value: 'abcdefghij' }, { value: 'klmnopqrst' }],
      [{ name: 'value' }],
      5,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0][0]).toContain('characters omitted');
  });

  it('generates a safe display value for binary data', () => {
    expect(normalizeValue(Buffer.from([0, 1, 2]))).toContain('<BINARY 3 bytes: 000102>');
  });
});
