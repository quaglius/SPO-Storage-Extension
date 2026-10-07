import { z } from 'zod';
import { db } from './db.js';
import { spoTenant } from './env.js';

const MB = 1024 * 1024;

export const engineSettingsSchema = z.object({
  /** Overrides SPO_TENANT (rarely needed). */
  tenant: z.string().optional(),
  concurrency: z.number().int().min(1).max(16).default(4),
  requestsPerMinute: z.number().int().min(30).max(3000).default(600),
  /** Files whose historic versions weigh at least this get version detail (L4). */
  heavyVersionsThresholdBytes: z.number().int().min(0).default(20 * MB),
  tenantUsageIntervalMinutes: z.number().int().min(5).default(60),
  siteStructureIntervalHours: z.number().min(1).default(12),
  /** Full pass of every library (captures adds, changes and deletions). */
  libraryScanIntervalHours: z.number().min(1).default(24),
  versionsRescanDays: z.number().min(1).default(7),
  maxSubwebDepth: z.number().int().min(0).max(10).default(5),
  /** Auto re-arm tasks that failed for good after this long (the engine never gives up for ever). */
  retryFailedAfterHours: z.number().min(1).default(6),
});

export type EngineSettings = z.infer<typeof engineSettingsSchema>;

export async function getSetting<T>(key: string): Promise<T | null> {
  const d = await db();
  const row = await d.one<{ value_json: string }>(`SELECT value_json FROM spo.settings WHERE [key] = @key`, { key });
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  const d = await db();
  await d.exec(
    `MERGE spo.settings AS t
     USING (SELECT @key AS [key]) AS s ON t.[key] = s.[key]
     WHEN MATCHED THEN UPDATE SET value_json = @value, updated_at = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT ([key], value_json) VALUES (@key, @value);`,
    { key, value: JSON.stringify(value) },
  );
}

export type ResolvedEngineSettings = EngineSettings & { tenant: string };

export async function getEngineSettings(): Promise<ResolvedEngineSettings> {
  const raw = (await getSetting<unknown>('engine')) ?? {};
  const parsed = engineSettingsSchema.safeParse(raw);
  const settings = parsed.success ? parsed.data : engineSettingsSchema.parse({});
  return { ...settings, tenant: settings.tenant ?? spoTenant() };
}
