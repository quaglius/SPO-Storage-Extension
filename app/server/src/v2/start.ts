/**
 * Boots the v2 engine in the engine App Service (SPOSTORAGE_ENGINE_V2=1). The web App Service never runs it.
 */
import { auditIngest } from './crawl/audit.js';
import { siteStructure } from './crawl/site.js';
import { libraryScan } from './crawl/library.js';
import { maintenance, planRecurringWork } from './crawl/planner.js';
import { tenantUsage } from './crawl/tenant.js';
import { fileVersions } from './crawl/versions.js';
import { policyRun } from './policies/run.js';
import { archiveCompleteLinks } from './actions/archive-links.js';
import { archiveRestore } from './actions/restore.js';
import { startEngine, type EngineHandle } from './engine/runner.js';
import type { HandlerRegistry } from './engine/types.js';
import { getEngineSettings } from './settings.js';
import { SpoClient } from './spo/client.js';

export function isEngineV2Enabled(): boolean {
  return process.env.SPOSTORAGE_ENGINE_V2 === '1';
}

export const handlers: HandlerRegistry = {
  'tenant-usage': tenantUsage as never,
  'site-structure': siteStructure as never,
  'library-scan': libraryScan as never,
  'file-versions': fileVersions as never,
  maintenance: maintenance as never,
  'policy-run': policyRun as never,
  'audit-ingest': auditIngest as never,
  'archive-restore': archiveRestore as never,
  'archive-complete-links': archiveCompleteLinks as never,
};

export async function startEngineV2(): Promise<EngineHandle> {
  const settings = await getEngineSettings();
  const spo = new SpoClient({
    tenant: settings.tenant,
    requestsPerMinute: settings.requestsPerMinute,
    maxConcurrency: Math.max(2, settings.concurrency + 2),
  });
  console.log(`[engine-v2] starting with ${settings.concurrency} parallel tasks`);
  return startEngine({
    handlers,
    spo,
    planner: planRecurringWork,
    concurrency: settings.concurrency,
    // Archiving copies whole files (up to 15 GB at ~15 MB/s ≈ 17 min each, several in parallel).
    taskTimeoutsByKind: { 'policy-run': 4 * 3_600_000, 'archive-restore': 4 * 3_600_000, 'archive-complete-links': 2 * 3_600_000 },
  });
}

let webClient: SpoClient | null = null;

/** SharePoint client for request-time work in the web App Service (archive access checks, lab probes). */
export async function getWebSpoClient(): Promise<SpoClient> {
  if (!webClient) {
    const settings = await getEngineSettings();
    webClient = new SpoClient({ tenant: settings.tenant, requestsPerMinute: 300, maxConcurrency: 4, maxRetries: 3 });
  }
  return webClient;
}
