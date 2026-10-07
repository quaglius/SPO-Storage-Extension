/**
 * Thin wrapper around getWebSpoClient so API tests can inject a fake SpoClient
 * without touching start.ts.
 */
import type { SpoClient } from '../spo/client.js';
import { getWebSpoClient } from '../start.js';

type Provider = () => Promise<SpoClient>;

let override: Provider | null = null;

export function setWebSpoClientForTests(provider: Provider | null): void {
  override = provider;
}

export async function webSpoClient(): Promise<SpoClient> {
  if (override) return override();
  return getWebSpoClient();
}
