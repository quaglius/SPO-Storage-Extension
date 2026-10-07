import { describe, expect, it } from 'vitest';
import { formatBytes } from './utils.js';

describe('formatBytes', () => {
  it('formats zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats megabytes', () => {
    expect(formatBytes(20 * 1024 * 1024)).toMatch(/20[.,]00\s*MB/);
  });

  it('returns not measured for non-finite', () => {
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('not measured');
    expect(formatBytes(Number.NaN)).toBe('not measured');
  });
});
