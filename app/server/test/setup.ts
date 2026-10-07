import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';
import { resolveTestConnectionString, TEST_SQL_CATALOG } from './v2/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localEnvPath = path.join(__dirname, '.env.test.local');

function loadLocalEnvFile(): void {
  if (!fs.existsSync(localEnvPath)) return;
  const text = fs.readFileSync(localEnvPath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadLocalEnvFile();

const hasTestCs = Boolean(process.env.AZURE_SQL_TEST_CONNECTION_STRING?.trim());
const hasAzureCs = Boolean(process.env.AZURE_SQL_CONNECTION_STRING?.trim());
if (!hasTestCs && !hasAzureCs) {
  throw new Error(
    `Tests need AZURE_SQL_TEST_CONNECTION_STRING or AZURE_SQL_CONNECTION_STRING ` +
      `(catalog rewritten to ${TEST_SQL_CATALOG}). ` +
      `Set it in the environment or in app/server/test/.env.test.local (gitignored).`,
  );
}

process.env.AZURE_SQL_CONNECTION_STRING = resolveTestConnectionString();

delete process.env.SPOSTORAGE_AUTH_MODE;
delete process.env.SPOSTORAGE_ROLE;
delete process.env.SPOSTORAGE_CLOUD_WORKER;
delete process.env.SPOSTORAGE_ENGINE_V2;
// Deployment settings for tests (never a real tenant).
process.env.SPO_TENANT = 'test';
process.env.SPOSTORAGE_PUBLIC_URL = 'https://spostorage.example.com';
process.env.ARCHIVE_STORAGE_ACCOUNT = 'sttestarchive';
process.env.SPOSTORAGE_ADMINS = 'admin@example.com,admin2@example.com';
process.env.AZURE_SUBSCRIPTION_ID = '00000000-0000-0000-0000-000000000000';
process.env.AZURE_RESOURCE_GROUP = 'rg-test';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spostorage-test-'));
const testDataDir = path.join(testRoot, 'data');

process.env.REPO_ROOT = testRoot;
process.env.DATA_DIR = testDataDir;

fs.mkdirSync(path.join(testRoot, 'config'), { recursive: true });
fs.mkdirSync(testDataDir, { recursive: true });
fs.mkdirSync(path.join(testRoot, 'state'), { recursive: true });
fs.mkdirSync(path.join(testRoot, 'output'), { recursive: true });

fs.writeFileSync(
  path.join(testRoot, 'config', 'settings.json'),
  `${JSON.stringify(
    {
      tenant: {
        name: 'test',
        rootUrl: 'https://test.sharepoint.com',
        adminUrl: 'https://test-admin.sharepoint.com',
        tenantId: 'test.onmicrosoft.com',
      },
      auth: { clientId: '', scopes: [] },
    },
    null,
    2,
  )}\n`,
);

export function getTestRepoRoot(): string {
  return testRoot;
}

export function getTestDataDir(): string {
  return testDataDir;
}

afterAll(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});
