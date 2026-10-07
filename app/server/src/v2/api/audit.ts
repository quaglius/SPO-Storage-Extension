import type { FastifyInstance } from 'fastify';
import type { V2AuditStatus } from '@spostorage/shared';
import { getSetting } from '../settings.js';
import { requireAdmin } from './auth.js';

interface AuditStatusRow {
  consented?: boolean;
  coverageFrom?: string | null;
  coverageTo?: string | null;
  records?: number;
}

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/v2/audit', async (request, reply): Promise<V2AuditStatus | void> => {
    const admin = requireAdmin(request, reply);
    if (!admin) return;

    const status = await getSetting<AuditStatusRow>('audit.status');
    if (!status) {
      return { consented: false, coverageFrom: null, coverageTo: null, records: 0 };
    }
    return {
      consented: Boolean(status.consented),
      coverageFrom: status.coverageFrom ?? null,
      coverageTo: status.coverageTo ?? null,
      records: Number(status.records ?? 0),
    };
  });
}
