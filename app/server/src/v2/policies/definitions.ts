import { z } from 'zod';

const MB = 1024 * 1024;

export const scopeSchema = z
  .object({
    siteIds: z.array(z.number().int()).optional(),
    excludeSiteIds: z.array(z.number().int()).optional(),
    libraryIds: z.array(z.number().int()).optional(),
    /** Lowercase with dot: ['.mp4', '.mov']. */
    extensions: z.array(z.string()).optional(),
    excludeExtensions: z.array(z.string()).optional(),
    /** Lab: exact files. */
    fileIds: z.array(z.number().int()).optional(),
  })
  .default({});

export const deleteVersionsSchema = z.object({
  kind: z.literal('delete_versions'),
  scope: scopeSchema,
  /** Only files whose historic versions weigh at least this. */
  minVersionsBytes: z.number().int().min(0).default(20 * MB),
  minFileSizeBytes: z.number().int().min(0).default(0),
  /** Most recent historic versions to keep (the current version is never touched). */
  keepLatest: z.number().int().min(0).max(500).default(1),
  /** Only versions older than N days (null = any age). */
  olderThanDays: z.number().int().min(0).nullable().default(30),
});

export const archiveFilesSchema = z.object({
  kind: z.literal('archive_files'),
  scope: scopeSchema,
  minSizeBytes: z.number().int().min(0).default(10 * MB),
  notModifiedDays: z.number().int().min(0).default(365),
  /** Requires access data; null = ignore last access. Files with unknown access are excluded when set. */
  notAccessedDays: z.number().int().min(0).nullable().default(null),
});

export const purgeRecycleSchema = z.object({
  kind: z.literal('purge_recycle'),
  scope: scopeSchema,
  olderThanDays: z.number().int().min(0).default(30),
  stage: z.enum(['first', 'second', 'both']).default('both'),
});

export const versionLimitSchema = z.object({
  kind: z.literal('version_limit'),
  scope: scopeSchema,
  majorVersionLimit: z.number().int().min(1).max(50000).default(50),
});

export const policyDefinitionSchema = z.discriminatedUnion('kind', [
  deleteVersionsSchema,
  archiveFilesSchema,
  purgeRecycleSchema,
  versionLimitSchema,
]);

export type PolicyDefinition = z.infer<typeof policyDefinitionSchema>;
export type PolicyKind = PolicyDefinition['kind'];

export const POLICY_KIND_LABELS: Record<PolicyKind, string> = {
  delete_versions: 'Delete heavy historic versions',
  archive_files: 'Archive inactive files to Blob Cold',
  purge_recycle: 'Empty recycle bins',
  version_limit: 'Limit versions per library',
};

/**
 * Every kind needs the triple validation (docs/PLAN-V2.md D10). version_limit looks harmless but SharePoint
 * permanently trims the versions above the new limit the next time each file is edited.
 */
export function isDestructive(_kind: PolicyKind): boolean {
  return true;
}
