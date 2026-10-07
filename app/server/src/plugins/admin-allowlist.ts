import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAdminAllowlist, isHubRole } from '../config.js';

const FORBIDDEN = {
  error: {
    code: 'FORBIDDEN_ADMIN',
    message:
      'Access is restricted to SpoStorage global administrators. If you need an archived file, use the link from SharePoint.',
  },
};

function requestPath(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? '/';
}

function connectedUser(request: FastifyRequest): string | null {
  const raw = request.headers['x-ms-client-principal-name'];
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  return name ? name : null;
}

/** Portal routes any authenticated user of the tenant may call (not only admins). */
export function isExemptPath(method: string, url: string): boolean {
  // SPA shell for end-user download portal (English + legacy Spanish path).
  if (method === 'GET' && /^\/(archive|archivo)\/[^/]+$/.test(url)) return true;
  if (/^\/api\/v2\/portal(\/|$)/.test(url)) return true;
  if (method === 'GET' && (url === '/api/health' || url === '/health')) return true;
  return false;
}

export function isPlatformAdmin(email: string | null, allowlist: string[]): boolean {
  if (!email || allowlist.length === 0) return false;
  const needle = email.trim().toLowerCase();
  return allowlist.some((a) => a.toLowerCase() === needle);
}

export async function registerAdminAllowlistPlugin(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    if (!isHubRole()) return;

    const url = requestPath(request);
    const method = request.method.toUpperCase();
    if (isExemptPath(method, url)) return;

    const allowlist = getAdminAllowlist();
    const user = connectedUser(request);
    if (isPlatformAdmin(user, allowlist)) return;

    return reply.status(403).send(FORBIDDEN);
  });
}
