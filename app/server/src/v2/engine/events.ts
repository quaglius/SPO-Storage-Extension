import { db } from '../db.js';

export type EventLevel = 'info' | 'warn' | 'error';

export interface EventInput {
  level: EventLevel;
  kind: string;
  /** Spanish, shown to the user as-is. */
  message: string;
  siteId?: number | null;
  libraryId?: number | null;
  data?: unknown;
}

/** Writes an engine event. Never throws: losing an event must not stop the engine. */
export async function logEvent(e: EventInput): Promise<void> {
  try {
    const d = await db();
    await d.exec(
      `INSERT INTO spo.engine_events (at, level, kind, site_id, library_id, message, data_json)
       VALUES (SYSUTCDATETIME(), @level, @kind, @siteId, @libraryId, @message, @data)`,
      {
        level: e.level,
        kind: e.kind,
        siteId: e.siteId ?? null,
        libraryId: e.libraryId ?? null,
        message: e.message.slice(0, 1000),
        data: e.data === undefined ? null : JSON.stringify(e.data),
      },
    );
  } catch (err) {
    console.error(`[engine] could not log event ${e.kind}: ${(err as Error).message}`);
  }
}

export async function purgeEvents(olderThanDays: number): Promise<number> {
  const d = await db();
  return d.exec(`DELETE FROM spo.engine_events WHERE at < DATEADD(day, -@days, SYSUTCDATETIME())`, { days: olderThanDays });
}
