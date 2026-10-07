import { describe, expect, it } from 'vitest';
import { isExemptPath } from '../../src/plugins/admin-allowlist.js';

describe('admin allowlist exemptions', () => {
  it('allows archive and archivo SPA shell paths for GET', () => {
    expect(isExemptPath('GET', '/archive/42')).toBe(true);
    expect(isExemptPath('GET', '/archivo/42')).toBe(true);
  });

  it('allows portal API and health endpoints', () => {
    expect(isExemptPath('GET', '/api/v2/portal/7')).toBe(true);
    expect(isExemptPath('GET', '/api/v2/portal/7/download')).toBe(true);
    expect(isExemptPath('GET', '/api/health')).toBe(true);
    expect(isExemptPath('GET', '/health')).toBe(true);
  });

  it('does not exempt random admin API paths', () => {
    expect(isExemptPath('GET', '/api/v2/policies')).toBe(false);
    expect(isExemptPath('POST', '/api/v2/engine/pause')).toBe(false);
    expect(isExemptPath('GET', '/archive/42/extra')).toBe(false);
  });
});
