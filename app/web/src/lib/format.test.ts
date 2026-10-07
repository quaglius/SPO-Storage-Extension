import { describe, expect, it } from 'vitest';
import {
  formatAbsoluteDate,
  formatBytes,
  formatNumber,
  formatPercent,
  formatRelativeDate,
  logPositionToMb,
  mbToLogPosition,
} from './format.js';

describe('formatBytes', () => {
  it('formats zero', () => {
    expect(formatBytes(0)).toBe('0 B');
  });

  it('formats megabytes with default locale', () => {
    const formatted = formatBytes(20 * 1024 * 1024);
    expect(formatted).toMatch(/20[.,]00\s*MB/);
  });
});

describe('formatNumber', () => {
  it('uses locale thousands separator', () => {
    expect(formatNumber(1234567)).toMatch(/1[.,\s]234[.,\s]567|1,234,567/);
  });
});

describe('formatPercent', () => {
  it('formats percentage', () => {
    const formatted = formatPercent(42.567, 1);
    expect(formatted).toMatch(/42[.,]6\s*%/);
  });
});

describe('formatRelativeDate', () => {
  it('returns relative text for recent dates', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(formatRelativeDate(yesterday)).toMatch(/yesterday|day|ayer|hace/i);
  });
});

describe('formatAbsoluteDate', () => {
  it('formats ISO date with default locale', () => {
    expect(formatAbsoluteDate('2026-09-13T12:00:00.000Z')).toContain('2026');
  });
});

describe('log slider helpers', () => {
  it('round-trips threshold positions', () => {
    const mb = logPositionToMb(50);
    expect(mb).toBeGreaterThan(1);
    expect(mb).toBeLessThan(500);
    expect(mbToLogPosition(mb)).toBeCloseTo(50, 0);
  });
});
