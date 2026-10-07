import type { FastifyReply, FastifyRequest } from 'fastify';
import { getAdminAllowlist } from '../../config.js';

/** Easy Auth principal, or local@dev when the header is absent (local / tests). */
export function requestUser(request: FastifyRequest): string {
  // In production the header is only trustworthy when App Service Easy Auth injects it (and strips forged ones).
  if (process.env.NODE_ENV === 'production' && process.env.WEBSITE_AUTH_ENABLED?.toLowerCase() !== 'true') {
    return 'anonymous';
  }
  const raw = request.headers['x-ms-client-principal-name'];
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].trim()) return raw[0].trim();
  return 'local@dev';
}

export function isAdminUser(upn: string): boolean {
  const needle = upn.trim().toLowerCase();
  if (getAdminAllowlist().some((a) => a.toLowerCase() === needle)) return true;
  // Local without Easy Auth: treat as admin outside production.
  if (needle === 'local@dev' && process.env.NODE_ENV !== 'production') return true;
  return false;
}

export function requireAdmin(request: FastifyRequest, reply: FastifyReply): string | null {
  const upn = requestUser(request);
  if (!isAdminUser(upn)) {
    void reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'Only administrators can perform this action.',
      },
    });
    return null;
  }
  return upn;
}
