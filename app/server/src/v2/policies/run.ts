/**
 * Executes an approved policy run inside the engine: task 'policy-run' on target 'run:<id>'.
 * Small batches per execution; each action records status, freed bytes, detail and evidence.
 * Transient SharePoint errors leave the action 'planned' and back the task off; anything else fails only
 * that action and the run continues.
 */
import { db } from '../db.js';
import { getArchiveSettings } from '../actions/blob.js';
import { executeArchiveFile, executeDeleteVersions, type ActionOutcome, type FileTarget } from '../actions/execute.js';
import { enqueue } from '../engine/queue.js';
import type { TaskContext, TaskHandler } from '../engine/types.js';
import { SpoError, type SpoClient } from '../spo/client.js';
import { policyDefinitionSchema, type PolicyDefinition } from './definitions.js';

const BATCH: Record<string, number> = { archive_file: 6, delete_versions: 15, purge_recycle: 1, set_version_limit: 20 };
/** Actions of these kinds run in parallel inside one execution (archive is bound by transfer speed per stream). */
const PARALLEL: Record<string, number> = { archive_file: 6 };
const MB = 1024 * 1024;

interface ActionRow {
  id: number;
  action: string;
  target_url: string;
  site_id: number | null;
  library_id: number | null;
  file_id: number | null;
  bytes: number;
}

interface RunRow {
  id: number;
  scope: 'lab' | 'tenant';
  status: string;
  definition_json: string;
  requested_by: string | null;
}

export async function enqueuePolicyRun(runId: number): Promise<void> {
  await enqueue({ kind: 'policy-run', targetKey: `run:${runId}`, priority: 30, maxAttempts: 20 });
}

export async function fileTarget(fileId: number): Promise<FileTarget | null> {
  const d = await db();
  const r = await d.one<{
    id: number; site_id: number; site_url: string; web_url: string; list_guid: string; list_item_id: number | null;
    server_relative_url: string; name: string; size_bytes: number; modified_at: Date | null; editor: string | null; unique_id: string | null;
  }>(
    `SELECT f.id, f.site_id, s.url AS site_url, l.web_url, CAST(l.list_guid AS NVARCHAR(36)) AS list_guid, f.list_item_id,
            f.server_relative_url, f.name, f.size_bytes, f.modified_at, f.editor, CAST(f.unique_id AS NVARCHAR(36)) AS unique_id
     FROM spo.files f JOIN spo.libraries l ON l.id = f.library_id JOIN spo.sites s ON s.id = f.site_id WHERE f.id = @fileId`,
    { fileId },
  );
  if (!r || r.list_item_id === null) return null;
  return {
    fileId: Number(r.id),
    siteId: r.site_id,
    siteUrl: r.site_url,
    webUrl: r.web_url,
    listGuid: r.list_guid,
    listItemId: r.list_item_id,
    uniqueId: r.unique_id,
    url: r.server_relative_url,
    name: r.name,
    sizeBytes: Number(r.size_bytes),
    modifiedAt: r.modified_at ? new Date(r.modified_at).toISOString() : null,
    editor: r.editor,
  };
}

async function purgeRecycle(spo: SpoClient, siteUrl: string, def: Extract<PolicyDefinition, { kind: 'purge_recycle' }>, signal: AbortSignal): Promise<ActionOutcome> {
  const cutoff = new Date(Date.now() - def.olderThanDays * 86_400_000);
  const stages = def.stage === 'both' ? [1, 2] : def.stage === 'first' ? [1] : [2];
  const pick = async () => {
    const res = await spo.get<{ value: Array<{ Id: string; ItemState: number; Size: string; DeletedDate: string }> }>(
      `${siteUrl}/_api/site/RecycleBin?$select=Id,ItemState,Size,DeletedDate&$filter=DeletedDate lt datetime'${cutoff.toISOString()}'&$top=500`,
      signal,
    );
    return (res.value ?? []).filter((x) => stages.includes(x.ItemState));
  };
  let freed = 0;
  let removed = 0;
  for (let round = 0; round < 40; round++) {
    const items = await pick();
    if (items.length === 0) break;
    const ids = items.map((x) => x.Id);
    await spo.request(`${siteUrl}/_api/site/RecycleBin/DeleteByIds`, { method: 'POST', body: { ids }, signal });
    // First-stage deletes land in the second stage; they are picked again next round and deleted for good.
    const secondStageNow = items.filter((x) => x.ItemState === 2);
    freed += secondStageNow.reduce((a, x) => a + (Number(x.Size) || 0), 0);
    removed += secondStageNow.length;
    if (!stages.includes(2) && items.every((x) => x.ItemState === 1)) {
      freed += items.reduce((a, x) => a + (Number(x.Size) || 0), 0);
      removed += items.length;
      break; // first stage only: moving to the second stage is what was asked
    }
  }
  const left = await pick();
  return {
    status: left.length === 0 ? 'done' : 'failed',
    bytes: freed,
    detail: left.length === 0 ? `Recycle bin emptied: ${removed} items` : `${left.length} items remain undeleted`,
    evidence: { cutoff: cutoff.toISOString(), removed, freed, remaining: left.length },
  };
}

async function setVersionLimit(spo: SpoClient, libraryId: number, limit: number, signal: AbortSignal): Promise<ActionOutcome> {
  const d = await db();
  const lib = await d.one<{ web_url: string; list_guid: string; title: string; major_version_limit: number | null }>(
    `SELECT web_url, CAST(list_guid AS NVARCHAR(36)) AS list_guid, title, major_version_limit FROM spo.libraries WHERE id = @libraryId`,
    { libraryId },
  );
  if (!lib) return { status: 'skipped', bytes: 0, detail: 'The library no longer exists', evidence: {} };
  const api = `${lib.web_url}/_api/web/lists(guid'${lib.list_guid}')`;
  await spo.request(api, {
    method: 'POST',
    headers: { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' },
    body: { EnableVersioning: true, MajorVersionLimit: limit },
    signal,
  });
  const after = await spo.get<{ MajorVersionLimit: number }>(`${api}?$select=MajorVersionLimit`, signal);
  await d.exec(`UPDATE spo.libraries SET major_version_limit = @limit, versioning_enabled = 1 WHERE id = @libraryId`, { libraryId, limit: after.MajorVersionLimit });
  return {
    status: after.MajorVersionLimit === limit ? 'done' : 'failed',
    bytes: 0,
    detail: `Version limit for ${lib.title}: ${lib.major_version_limit ?? 'no limit'} → ${after.MajorVersionLimit}`,
    evidence: { before: lib.major_version_limit, after: after.MajorVersionLimit },
  };
}

async function executeAction(
  ctx: TaskContext,
  run: RunRow,
  def: PolicyDefinition,
  a: ActionRow,
  onBytes?: (bytes: number) => void,
): Promise<ActionOutcome> {
  const verify = run.scope === 'lab' ? 'full' : 'basic';
  switch (a.action) {
    case 'delete_versions': {
      if (def.kind !== 'delete_versions' || !a.file_id) throw new Error('inconsistent action');
      const target = await fileTarget(a.file_id);
      if (!target) return { status: 'skipped', bytes: 0, detail: 'The file is no longer in inventory', evidence: {} };
      return executeDeleteVersions(ctx.spo, target, { keepLatest: def.keepLatest, olderThanDays: def.olderThanDays ?? undefined }, verify, ctx.signal);
    }
    case 'archive_file': {
      if (!a.file_id) throw new Error('inconsistent action');
      const target = await fileTarget(a.file_id);
      if (!target) return { status: 'skipped', bytes: 0, detail: 'The file is no longer in inventory', evidence: {} };
      return executeArchiveFile(ctx.spo, target, await getArchiveSettings(), {
        runId: run.id,
        archivedBy: run.requested_by ?? 'engine',
        verify,
        signal: ctx.signal,
        onBytes,
      });
    }
    case 'purge_recycle':
      if (def.kind !== 'purge_recycle') throw new Error('inconsistent action');
      return purgeRecycle(ctx.spo, a.target_url, def, ctx.signal);
    case 'set_version_limit':
      if (def.kind !== 'version_limit' || !a.library_id) throw new Error('inconsistent action');
      return setVersionLimit(ctx.spo, a.library_id, def.majorVersionLimit, ctx.signal);
    default:
      throw new Error(`Unknown action ${a.action}`);
  }
}

export const policyRun: TaskHandler = async (ctx) => {
  const d = await db();
  const runId = Number(ctx.task.target_key.split(':')[1]);
  const run = await d.one<RunRow>(
    `SELECT id, scope, status, definition_json, requested_by FROM spo.policy_runs WHERE id = @runId`,
    { runId },
  );
  if (!run || run.status !== 'running') return { outcome: 'done' };
  const def = policyDefinitionSchema.parse(JSON.parse(run.definition_json));

  const first = await d.one<{ action: string }>(
    `SELECT TOP 1 action FROM spo.policy_actions WHERE run_id = @runId AND status IN (N'planned', N'running') ORDER BY id`,
    { runId },
  );
  if (!first) {
    await d.exec(
      `UPDATE spo.policy_runs SET status = N'done', finished_at = SYSUTCDATETIME(),
         done_count = (SELECT COUNT(*) FROM spo.policy_actions WHERE run_id = @runId AND status = N'done'),
         freed_bytes = (SELECT ISNULL(SUM(bytes), 0) FROM spo.policy_actions WHERE run_id = @runId AND status = N'done')
       WHERE id = @runId`,
      { runId },
    );
    await ctx.event({ level: 'info', kind: 'policy-run-done', message: `Run finished #${runId}.` });
    return { outcome: 'done' };
  }

  // 'running' rows were interrupted (restart, lease lost): executors are idempotent, so they are resumed.
  const actions = await d.all<ActionRow>(
    `SELECT TOP (${BATCH[first.action] ?? 5}) id, action, target_url, site_id, library_id, file_id, bytes
     FROM spo.policy_actions WHERE run_id = @runId AND status IN (N'planned', N'running') ORDER BY id`,
    { runId },
  );

  const runOne = async (a: ActionRow): Promise<SpoError | null> => {
    ctx.signal.throwIfAborted();
    await d.exec(`UPDATE spo.policy_actions SET status = N'running', detail = N'In progress' WHERE id = @id`, { id: a.id });
    let copied = 0;
    let lastWrite = Date.now();
    const onBytes = (n: number) => {
      copied += n;
      ctx.progress(0); // keeps the watchdog quiet during long copies
      if (Date.now() - lastWrite > 15_000) {
        lastWrite = Date.now();
        const total = Number(a.bytes) || 0;
        void d
          .exec(`UPDATE spo.policy_actions SET detail = @detail WHERE id = @id AND status = N'running'`, {
            id: a.id,
            detail: `In progress: copied ${Math.round(copied / MB)} of ~${Math.round(total / MB)} MB`,
          })
          .catch(() => undefined);
      }
    };
    let outcome: ActionOutcome;
    try {
      outcome = await executeAction(ctx, run, def, a, onBytes);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      if (err instanceof SpoError && err.retryable) {
        await d.exec(`UPDATE spo.policy_actions SET status = N'planned', detail = @detail WHERE id = @id`, {
          id: a.id,
          detail: `Will retry: ${err.message}`.slice(0, 2000),
        });
        return err; // action goes back to planned; the task backs off after the batch
      }
      outcome = { status: 'failed', bytes: 0, detail: (err as Error).message.slice(0, 1900), evidence: {} };
    }
    await d.exec(
      `UPDATE spo.policy_actions SET status = @status, bytes = CASE WHEN @status = N'done' THEN @bytes ELSE bytes END,
         detail = @detail, evidence_json = @evidence, executed_at = SYSUTCDATETIME() WHERE id = @id;
       UPDATE spo.policy_runs SET
         done_count = ISNULL(done_count, 0) + CASE WHEN @status = N'done' THEN 1 ELSE 0 END,
         freed_bytes = ISNULL(freed_bytes, 0) + CASE WHEN @status = N'done' THEN @bytes ELSE 0 END
       WHERE id = @runId`,
      {
        id: a.id,
        runId,
        status: outcome.status,
        bytes: outcome.bytes,
        detail: outcome.detail.slice(0, 2000),
        evidence: JSON.stringify(outcome.evidence),
      },
    );
    if (outcome.status === 'failed') {
      await ctx.event({ level: 'warn', kind: 'policy-action-failed', siteId: a.site_id, message: `#${runId} ${a.target_url}: ${outcome.detail}`.slice(0, 1000) });
    }
    ctx.progress(1);
    return null;
  };

  const width = PARALLEL[first.action] ?? 1;
  ctx.status(`Run #${runId}: ${actions.length} actions (${width} in parallel)`);
  let retry: SpoError | null = null;
  for (let i = 0; i < actions.length; i += width) {
    const results = await Promise.all(actions.slice(i, i + width).map(runOne));
    retry = results.find((r): r is SpoError => r !== null) ?? retry;
    if (retry) break;
  }
  if (retry) throw retry;
  return { outcome: 'again', afterMs: 0 };
};
