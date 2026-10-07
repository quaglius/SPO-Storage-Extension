/** Response types for the v2 read API (`/api/v2/*`). */

export type V2EngineState = 'working' | 'idle' | 'paused' | 'no_signal';
export type V2EventLevel = 'info' | 'warn' | 'error';

export interface V2StatusTenant {
  capturedAt: string;
  source: string;
  quotaBytes: number | null;
  usedBytes: number | null;
  versionsBytes: number | null;
  excessBytes: number | null;
  estimatedMonthlyCostUsd: number | null;
}

export interface V2StatusSites {
  total: number;
  excluded: number;
  denied: number;
  usedBytes: number;
}

export interface V2StatusReconciliation {
  explainedBytes: number;
  percent: number | null;
  libraries: {
    total: number;
    done: number;
    running: number;
    pending: number;
    failed: number;
  };
  filesKnown: number;
  filesDeclared: number;
  /** Sites using ≥ 1 GB, compared one by one (files + recycle bin vs what Microsoft counts). */
  sitesChecked: number;
  /** Within ±2 %. */
  sitesMatching: number;
  /** Files add up to more than Microsoft counts for the quota. */
  sitesOver: number;
  /** Files add up to less: something is missing from the inventory. */
  sitesUnder: number;
}

export interface V2StatusSavings {
  heavyVersionsBytes: number;
  heavyVersionsFiles: number;
  olderThan365Bytes: number;
  olderThan730Bytes: number;
}

export interface V2EngineSlot {
  kind: string | null;
  target: string | null;
  since: string | null;
  status: string | null;
}

export interface V2ThroughputMinute {
  minute: string;
  items: number;
  throttled: number;
  errors: number;
}

export interface V2StatusEngine {
  state: V2EngineState;
  heartbeatAt: string | null;
  lastProgressAt: string | null;
  startedAt: string | null;
  commit: string | null;
  pauseReason: string | null;
  slots: V2EngineSlot[];
  lastHour: {
    items: number;
    requests: number;
    throttled: number;
    errors: number;
    perMinute: V2ThroughputMinute[];
  };
  queue: { ready: number; due: number; leased: number; failed: number };
}

export interface V2StatusEvent {
  id: number;
  at: string;
  level: V2EventLevel;
  kind: string;
  message: string;
  siteId: number | null;
  siteTitle: string | null;
}

export interface V2StatusResponse {
  tenant: V2StatusTenant | null;
  sites: V2StatusSites;
  reconciliation: V2StatusReconciliation;
  savings: V2StatusSavings;
  engine: V2StatusEngine;
  recentEvents: V2StatusEvent[];
}

export interface V2SiteListItem {
  id: number;
  url: string;
  title: string | null;
  template: string | null;
  usedBytes: number | null;
  fileCountDeclared: number | null;
  lastActivityAt: string | null;
  accessState: string;
  excluded: boolean;
  explainedBytes: number;
  percent: number | null;
  versionsBytes: number;
  heavyVersionsBytes: number;
  olderThan365Bytes: number;
  libraries: { total: number; done: number; failed: number };
}

export interface V2SiteListResponse {
  items: V2SiteListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2RecycleBin {
  firstStageBytes: number;
  firstStageItems: number;
  secondStageBytes: number;
  secondStageItems: number;
  oldestDeletedAt: string | null;
  capturedAt: string;
}

export interface V2LibraryDetail {
  id: number;
  title: string;
  hidden: boolean;
  metricsTotalBytes: number | null;
  metricsStreamBytes: number | null;
  metricsFileCount: number | null;
  metricsCapturedAt: string | null;
  baselineState: string;
  baselineDoneAt: string | null;
  deltaAt: string | null;
  lastError: string | null;
  rollup: {
    fileCount: number;
    currentBytes: number;
    totalBytes: number;
    versionsBytes: number;
    heavyVersionsBytes: number;
    olderThan365Bytes: number;
  } | null;
}

export interface V2TopFile {
  id: number;
  name: string;
  url: string;
  sizeBytes: number;
  versionsBytes: number;
  totalBytes: number | null;
  modifiedAt: string | null;
  libraryTitle: string | null;
}

export interface V2SiteDetailResponse {
  id: number;
  url: string;
  title: string | null;
  template: string | null;
  usedBytes: number | null;
  fileCountDeclared: number | null;
  lastActivityAt: string | null;
  accessState: string;
  accessError: string | null;
  excluded: boolean;
  explainedBytes: number;
  percent: number | null;
  versionsBytes: number;
  recycleBin: V2RecycleBin | null;
  libraries: V2LibraryDetail[];
  topFilesByVersions: V2TopFile[];
  topFilesBySize: V2TopFile[];
}

export interface V2FileListItem {
  id: number;
  siteId: number;
  siteTitle: string | null;
  libraryTitle: string | null;
  url: string;
  name: string;
  extension: string | null;
  sizeBytes: number;
  totalBytes: number | null;
  versionsBytes: number;
  versionLabel: string | null;
  modifiedAt: string | null;
  editor: string | null;
  createdAt: string | null;
  author: string | null;
  lastAccessAt: string | null;
  hasUniquePerms: boolean | null;
}

export interface V2FileListResponse {
  items: V2FileListItem[];
  total: number;
  totalBytes: number;
  page: number;
  pageSize: number;
}

export interface V2EventListItem {
  id: number;
  at: string;
  level: V2EventLevel;
  kind: string;
  message: string;
  siteId: number | null;
  siteTitle: string | null;
  libraryId: number | null;
}

export interface V2EventListResponse {
  items: V2EventListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2TaskListItem {
  id: number;
  kind: string;
  targetKey: string;
  siteTitle: string | null;
  libraryTitle: string | null;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
  state: string;
}

export interface V2TaskListResponse {
  items: V2TaskListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2RetryFailedResponse {
  retried: number;
}

export interface V2NoticeLink {
  label: string;
  href: string;
}

export interface V2NoticeSite {
  siteId: number;
  title: string | null;
  url: string;
  detail: string;
}

/** Things Dani must act on outside the app (Purview, Entra…), shown on Estado. */
export interface V2Notice {
  id: string;
  level: 'info' | 'warn' | 'error';
  title: string;
  body: string;
  links: V2NoticeLink[];
  sites: V2NoticeSite[];
}

export interface V2NoticesResponse {
  notices: V2Notice[];
}

/** Policy kinds for v2 policies / lab (mirrors server definitions). */
export type V2PolicyKind = 'delete_versions' | 'archive_files' | 'purge_recycle' | 'version_limit';

export interface V2PolicyItem {
  id: number;
  name: string;
  kind: V2PolicyKind;
  kindLabel: string;
  enabled: boolean;
  definition: unknown;
  createdBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface V2PolicyListResponse {
  items: V2PolicyItem[];
}

export interface V2SimulationBySite {
  siteId: number;
  title: string | null;
  count: number;
  bytes: number;
}

export interface V2SimulationPreview {
  siteId: number;
  siteTitle: string | null;
  libraryId: number | null;
  libraryTitle: string | null;
  fileId: number | null;
  fileName: string | null;
  extension: string | null;
  targetUrl: string;
  /** Estimated bytes freed by this target. */
  bytes: number;
  /** Current version size. */
  sizeBytes: number | null;
  /** Weight of all historic versions. */
  versionsBytes: number | null;
  versionLabel: string | null;
  /** delete_versions: how many historic versions would be deleted. */
  versionsToDelete: number | null;
  modifiedAt: string | null;
  lastAccessAt: string | null;
}

export interface V2SimulationResponse {
  count: number;
  bytes: number;
  bySite: V2SimulationBySite[];
  preview: V2SimulationPreview[];
}

export interface V2RunApproval {
  step: 1 | 2 | 3;
  by: string;
  at: string;
}

export interface V2PolicyRun {
  id: number;
  policyId: number | null;
  policyName: string | null;
  scope: string;
  mode: string;
  status: string;
  definition: unknown;
  selection: unknown;
  requestedBy: string | null;
  approvals: V2RunApproval[];
  plannedCount: number | null;
  plannedBytes: number | null;
  doneCount: number | null;
  freedBytes: number | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  actionTotals?: Record<string, number>;
}

export interface V2PolicyRunListResponse {
  items: V2PolicyRun[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2PolicyAction {
  id: number;
  siteId: number | null;
  libraryId: number | null;
  fileId: number | null;
  targetUrl: string;
  action: string;
  bytes: number;
  status: string;
  detail: string | null;
  evidence: unknown;
  executedAt: string | null;
}

export interface V2PolicyActionListResponse {
  items: V2PolicyAction[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2ArchivedListItem {
  id: number;
  name: string;
  sizeBytes: number;
  state: string;
  archivedAt: string | null;
  siteId: number;
  siteTitle: string | null;
  originalUrl: string;
}

export interface V2ArchivedListResponse {
  items: V2ArchivedListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface V2ArchivedDetail extends V2ArchivedListItem {
  webUrl: string;
  linkUrl: string | null;
  contentType: string | null;
  blobPath: string;
  sha256: string;
  archivedBy: string | null;
  acl: unknown;
  accessLog: Array<{
    id: number;
    at: string | null;
    userUpn: string;
    granted: boolean;
    reason: string | null;
  }>;
}

export interface V2PortalFile {
  name: string;
  sizeBytes: number;
  archivedAt: string | null;
  originalUrl: string;
  siteTitle: string | null;
  granted: boolean;
  reason: string;
}

export interface V2LabAccessCheckResponse {
  archivedId: number;
  results: Array<{ upn: string; granted: boolean; reason: string }>;
}

export interface V2AuditStatus {
  consented: boolean;
  coverageFrom: string | null;
  coverageTo: string | null;
  records: number;
}

export interface V2ExplorerLibrary {
  id: number;
  title: string;
  rootUrl: string;
  fileCount: number;
  currentBytes: number;
  totalBytes: number;
  versionsBytes: number;
}

export interface V2ExplorerFolder {
  name: string;
  path: string;
  fileCount: number;
  totalBytes: number;
  archivedCount: number;
}

export interface V2ExplorerFileRow {
  id: number | null;
  name: string;
  serverRelativeUrl: string;
  sizeBytes: number;
  versionsBytes: number;
  totalBytes: number;
  modifiedAt: string | null;
  lastAccessAt: string | null;
  archived: boolean;
  archivedId: number | null;
  archivedAt: string | null;
  blobTier: string | null;
}

export interface V2ExplorerFolderResponse {
  siteId: number;
  siteTitle: string | null;
  libraryId: number | null;
  libraryTitle: string | null;
  rootUrl: string | null;
  path: string;
  libraries: V2ExplorerLibrary[];
  folders: V2ExplorerFolder[];
  files: V2ExplorerFileRow[];
  hasMore: boolean;
}

export interface V2ExplorerAccessPerson {
  email: string | null;
  name: string;
  roles: string[];
  via: string[];
}

export interface V2ExplorerAccessPrincipal {
  kind: string;
  name: string;
  email: string | null;
  roles: string[];
  members: Array<{ email: string | null; name: string }> | null;
  membersNote: string | null;
}

export type V2ExplorerAccess =
  | {
      people: V2ExplorerAccessPerson[];
      principals: V2ExplorerAccessPrincipal[];
      everyone: boolean;
      unique: boolean | null;
    }
  | { error: string };

export interface V2ExplorerFileDetail {
  id: number;
  name: string;
  extension: string | null;
  serverRelativeUrl: string;
  webUrl: string;
  siteId: number;
  siteTitle: string | null;
  libraryId: number;
  libraryTitle: string | null;
  sizeBytes: number;
  versionsBytes: number;
  totalBytes: number;
  versionLabel: string | null;
  versionCount: number | null;
  createdAt: string | null;
  modifiedAt: string | null;
  author: string | null;
  editor: string | null;
  lastAccessAt: string | null;
  versions: Array<{
    label: string;
    sizeBytes: number;
    createdAt: string | null;
    createdBy: string | null;
  }>;
  lastAccess: {
    at: string;
    user: string | null;
    operation: string | null;
  } | null;
  access: V2ExplorerAccess;
}

export interface V2ExplorerArchivedDetail {
  id: number;
  name: string;
  extension: string | null;
  originalUrl: string;
  linkUrl: string | null;
  webUrl: string;
  siteId: number;
  siteTitle: string | null;
  sizeBytes: number;
  blobTier: string;
  state: string;
  archivedAt: string | null;
  archivedBy: string | null;
  acl: unknown;
  accessLog: Array<{
    id: number;
    at: string | null;
    userUpn: string;
    granted: boolean;
    reason: string | null;
  }>;
  access: V2ExplorerAccess;
}

export interface V2ArchiveTreeSite {
  siteId: number;
  title: string | null;
  url: string;
  fileCount: number;
  bytes: number;
  lastArchivedAt: string | null;
}

export interface V2ArchiveTreeFolder {
  name: string;
  path: string;
  fileCount: number;
  bytes: number;
}

export interface V2ArchiveTreeFile {
  archivedId: number;
  name: string;
  extension: string | null;
  sizeBytes: number;
  archivedAt: string | null;
  archivedBy: string | null;
  originalModifiedAt: string | null;
  originalModifiedBy: string | null;
  blobTier: string;
  state: string;
}

export interface V2ArchiveTreeResponse {
  summary: { fileCount: number; bytes: number };
  sites: V2ArchiveTreeSite[];
  siteId: number | null;
  siteTitle: string | null;
  siteUrl: string | null;
  path: string;
  folders: V2ArchiveTreeFolder[];
  files: V2ArchiveTreeFile[];
}

/** Archives waiting for their .url link (site over quota or read-only), see GET /api/v2/archive/links. */
export interface V2ArchiveLinksStatus {
  /** Blob copy verified, original still in SharePoint. */
  originalsPending: number;
  originalsPendingBytes: number;
  /** Original already deleted, link not created yet. */
  linksPending: number;
  /** A pass is queued or running. */
  running: boolean;
  errors: Array<{ message: string; count: number }>;
}

export interface V2ArchiveItemDetail {
  id: number;
  name: string;
  extension: string | null;
  sizeBytes: number;
  sha256: string;
  contentType: string | null;
  blobPath: string;
  blobTier: string;
  state: string;
  originalUrl: string;
  linkUrl: string | null;
  webUrl: string;
  siteId: number;
  siteTitle: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
  originalModifiedAt: string | null;
  originalModifiedBy: string | null;
  blobUrlInPortal: string | null;
  containerUrlInPortal: string | null;
  sharePointFolderUrl: string | null;
  sharePointLinkUrl: string | null;
  portalUrl: string;
  acl: unknown;
  access: V2ExplorerAccess;
  accessLog: Array<{
    id: number;
    at: string | null;
    userUpn: string;
    granted: boolean;
    reason: string | null;
  }>;
  integrity: {
    sha256: string;
    detail: string | null;
    evidence: unknown;
  } | null;
  restore: {
    /** requested | uploaded | done | failed; null = never requested. */
    state: string | null;
    requestedBy: string | null;
    requestedAt: string | null;
    restoredAt: string | null;
    error: string | null;
  };
}

/** GET /api/health — no database. */
export interface HealthResponse {
  status: string;
  version: string;
  build: {
    version: string;
    commit: string | null;
    builtAt: string | null;
  };
  role: 'collector' | 'hub';
  engine: boolean;
}

export interface V2EngineSettings {
  tenant: string;
  concurrency: number;
  requestsPerMinute: number;
  heavyVersionsThresholdBytes: number;
  tenantUsageIntervalMinutes: number;
  siteStructureIntervalHours: number;
  libraryScanIntervalHours: number;
  versionsRescanDays: number;
  maxSubwebDepth: number;
  retryFailedAfterHours: number;
}

export interface V2ArchiveSettings {
  account: string;
  container: string;
  tier: 'Hot' | 'Cool' | 'Cold' | 'Archive';
  portalBaseUrl: string;
  maxFileBytes: number;
  subscriptionId: string;
  resourceGroup: string;
}

export type V2SettingsKey = 'engine' | 'archive' | 'pricing.extraStorageUsdPerGbMonth';

export interface V2SettingsResponse<T = unknown> {
  key: string;
  value: T;
}
