import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function getRepoRoot(): string {
  if (process.env.REPO_ROOT) {
    return process.env.REPO_ROOT;
  }
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'app', 'package.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return path.resolve(__dirname, '../../..');
}

export function getPort(): number {
  const raw = process.env.API_PORT ?? '4180';
  const port = Number.parseInt(raw, 10);
  return Number.isFinite(port) ? port : 4180;
}

export const APP_VERSION = '0.1.0';

export interface BuildInfo {
  version: string;
  commit: string | null;
  builtAt: string | null;
}

let cachedBuildInfo: BuildInfo | null = null;

/** Build stamp written by CI (scripts/ci/stage-package.mjs) next to the deployed package. */
export function getBuildInfo(): BuildInfo {
  if (cachedBuildInfo) return cachedBuildInfo;
  let info: BuildInfo = { version: APP_VERSION, commit: null, builtAt: null };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(getRepoRoot(), 'build-info.json'), 'utf8')) as Partial<BuildInfo>;
    info = { version: raw.version ?? APP_VERSION, commit: raw.commit ?? null, builtAt: raw.builtAt ?? null };
  } catch {
    // local dev: no build stamp
  }
  cachedBuildInfo = info;
  return info;
}

export type SpoStorageRole = 'collector' | 'hub';

export function getRole(): SpoStorageRole {
  const role = process.env.SPOSTORAGE_ROLE?.toLowerCase();
  return role === 'hub' ? 'hub' : 'collector';
}

export function isHubRole(): boolean {
  return getRole() === 'hub';
}

/** Azure SQL connection string for the operational store. */
export function getAzureSqlConnectionString(): string | null {
  const cs =
    process.env.AZURE_SQL_CONNECTION_STRING?.trim() ||
    (process.env.DATABASE_URL?.includes('database.windows.net')
      ? process.env.DATABASE_URL.trim()
      : undefined);
  return cs ? cs : null;
}

/**
 * Platform administrators (comma-separated e-mails in SPOSTORAGE_ADMINS; SPOSTORAGE_ADMIN_ALLOWLIST is accepted
 * for backward compatibility). No defaults: an empty list means nobody is an administrator.
 */
export function getAdminAllowlist(): string[] {
  const raw = process.env.SPOSTORAGE_ADMINS?.trim() || process.env.SPOSTORAGE_ADMIN_ALLOWLIST?.trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
