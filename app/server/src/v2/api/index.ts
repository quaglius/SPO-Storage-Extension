import type { FastifyInstance } from 'fastify';
import { registerArchiveRoutes } from './archive.js';
import { registerArchiveExplorerRoutes } from './archive-explorer.js';
import { registerAuditRoutes } from './audit.js';
import { registerEngineRoutes, registerEventsRoutes } from './engine.js';
import { registerExplorerRoutes } from './explorer.js';
import { registerFileRoutes } from './files.js';
import { registerNoticeRoutes } from './notices.js';
import { registerLabRoutes } from './lab.js';
import { registerPolicyRoutes } from './policies.js';
import { registerSettingsRoutes } from './settings.js';
import { registerSiteRoutes } from './sites.js';
import { registerStatusRoutes } from './status.js';

/** Registers all v2 read/control routes under `/api/v2`. */
export async function registerV2Routes(app: FastifyInstance): Promise<void> {
  await registerStatusRoutes(app);
  await registerSiteRoutes(app);
  await registerFileRoutes(app);
  await registerEventsRoutes(app);
  await registerEngineRoutes(app);
  await registerNoticeRoutes(app);
  await registerPolicyRoutes(app);
  await registerLabRoutes(app);
  await registerArchiveRoutes(app);
  await registerArchiveExplorerRoutes(app);
  await registerAuditRoutes(app);
  await registerExplorerRoutes(app);
  await registerSettingsRoutes(app);
}
