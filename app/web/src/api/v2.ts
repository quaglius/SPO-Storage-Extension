import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  HealthResponse,
  V2ArchiveItemDetail,
  V2ArchiveLinksStatus,
  V2ArchiveSettings,
  V2ArchiveTreeResponse,
  V2ArchivedDetail,
  V2ArchivedListResponse,
  V2AuditStatus,
  V2EngineSettings,
  V2EventListResponse,
  V2ExplorerArchivedDetail,
  V2ExplorerFileDetail,
  V2ExplorerFolderResponse,
  V2FileListResponse,
  V2NoticesResponse,
  V2LabAccessCheckResponse,
  V2PolicyActionListResponse,
  V2PolicyItem,
  V2PolicyListResponse,
  V2PolicyRun,
  V2PolicyRunListResponse,
  V2PortalFile,
  V2RetryFailedResponse,
  V2SettingsResponse,
  V2SimulationResponse,
  V2SiteDetailResponse,
  V2SiteListResponse,
  V2StatusResponse,
  V2TaskListResponse,
} from '@spostorage/shared';
import { apiDelete, apiGet, apiPost, apiPut } from './client.js';

export const v2Keys = {
  health: ['health'] as const,
  status: ['v2', 'status'] as const,
  sites: (params: Record<string, unknown>) => ['v2', 'sites', params] as const,
  site: (id: number) => ['v2', 'site', id] as const,
  files: (params: Record<string, unknown>) => ['v2', 'files', params] as const,
  events: (params: Record<string, unknown>) => ['v2', 'events', params] as const,
  tasks: (params: Record<string, unknown>) => ['v2', 'tasks', params] as const,
  policies: ['v2', 'policies'] as const,
  runs: (params: Record<string, unknown>) => ['v2', 'runs', params] as const,
  run: (id: number) => ['v2', 'run', id] as const,
  runActions: (id: number, params: Record<string, unknown>) => ['v2', 'run-actions', id, params] as const,
  archived: (params: Record<string, unknown>) => ['v2', 'archived', params] as const,
  archivedDetail: (id: number) => ['v2', 'archived', id] as const,
  portal: (id: number) => ['v2', 'portal', id] as const,
  audit: ['v2', 'audit'] as const,
  explorerFolder: (params: Record<string, unknown>) => ['v2', 'explorer-folder', params] as const,
  explorerFile: (id: number) => ['v2', 'explorer-file', id] as const,
  explorerArchived: (id: number) => ['v2', 'explorer-archived', id] as const,
  archiveTree: (params: Record<string, unknown>) => ['v2', 'archive-tree', params] as const,
  archiveItem: (id: number) => ['v2', 'archive-item', id] as const,
  archiveLinks: ['v2', 'archive-links'] as const,
  settings: (key: string) => ['v2', 'settings', key] as const,
};

export function useHealth() {
  return useQuery({
    queryKey: v2Keys.health,
    queryFn: () => apiGet<HealthResponse>('/health'),
    staleTime: 60_000,
  });
}

export function useV2Status() {
  return useQuery({
    queryKey: v2Keys.status,
    queryFn: () => apiGet<V2StatusResponse>('/v2/status'),
    refetchInterval: 10_000,
    placeholderData: (prev) => prev,
  });
}

export function useV2Sites(params: {
  search?: string;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
}) {
  return useQuery({
    queryKey: v2Keys.sites(params),
    queryFn: () =>
      apiGet<V2SiteListResponse>('/v2/sites', {
        search: params.search,
        sort: params.sort,
        dir: params.dir,
        page: params.page,
        pageSize: params.pageSize,
      }),
    placeholderData: (prev) => prev,
  });
}

export function useV2Site(id: number) {
  return useQuery({
    queryKey: v2Keys.site(id),
    queryFn: () => apiGet<V2SiteDetailResponse>(`/v2/sites/${id}`),
    enabled: Number.isFinite(id) && id > 0,
  });
}

export function useV2Files(params: Record<string, string | number | boolean | undefined>) {
  return useQuery({
    queryKey: v2Keys.files(params),
    queryFn: () => apiGet<V2FileListResponse>('/v2/files', params),
    placeholderData: (prev) => prev,
  });
}

export function useV2Events(params: {
  level?: string;
  siteId?: number;
  page?: number;
  pageSize?: number;
}) {
  return useQuery({
    queryKey: v2Keys.events(params),
    queryFn: () =>
      apiGet<V2EventListResponse>('/v2/events', {
        level: params.level,
        siteId: params.siteId,
        page: params.page,
        pageSize: params.pageSize,
      }),
    placeholderData: (prev) => prev,
  });
}

export function useV2Tasks(params: { state?: string; page?: number; pageSize?: number }) {
  return useQuery({
    queryKey: v2Keys.tasks(params),
    queryFn: () =>
      apiGet<V2TaskListResponse>('/v2/tasks', {
        state: params.state,
        page: params.page,
        pageSize: params.pageSize,
      }),
    placeholderData: (prev) => prev,
  });
}

export function useV2PauseEngine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (reason?: string) =>
      apiPost<{ ok: boolean }>('/v2/engine/pause', reason ? { reason } : {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: v2Keys.status });
      void qc.invalidateQueries({ queryKey: ['v2', 'events'] });
    },
  });
}

export function useV2ResumeEngine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ ok: boolean }>('/v2/engine/resume'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: v2Keys.status });
      void qc.invalidateQueries({ queryKey: ['v2', 'events'] });
    },
  });
}

export function useV2RetryFailed() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<V2RetryFailedResponse>('/v2/tasks/retry-failed'),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: v2Keys.status });
      void qc.invalidateQueries({ queryKey: ['v2', 'tasks'] });
      void qc.invalidateQueries({ queryKey: ['v2', 'events'] });
    },
  });
}

export function useV2Notices() {
  return useQuery({
    queryKey: ['v2', 'notices'] as const,
    queryFn: () => apiGet<V2NoticesResponse>('/v2/notices'),
    refetchInterval: 5 * 60_000,
    placeholderData: (prev) => prev,
  });
}
export function useV2Policies() {
  return useQuery({
    queryKey: v2Keys.policies,
    queryFn: () => apiGet<V2PolicyListResponse>('/v2/policies'),
  });
}

export function useV2CreatePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; definition: unknown }) =>
      apiPost<V2PolicyItem>('/v2/policies', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: v2Keys.policies }),
  });
}

export function useV2UpdatePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: number; name: string; definition: unknown }) =>
      apiPut<V2PolicyItem>(`/v2/policies/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: v2Keys.policies }),
  });
}

export function useV2DeletePolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiDelete<void>(`/v2/policies/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: v2Keys.policies }),
  });
}

export function useV2SimulatePolicy() {
  return useMutation({
    mutationFn: (definition: unknown) =>
      apiPost<V2SimulationResponse>('/v2/policies/simulate', { definition }),
  });
}

export function useV2CreatePolicyRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (policyId: number) =>
      apiPost<V2PolicyRun>(`/v2/policies/${policyId}/runs`, { scope: 'tenant' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['v2', 'runs'] }),
  });
}

export function useV2Runs(params: { scope?: string; status?: string; page?: number }) {
  return useQuery({
    queryKey: v2Keys.runs(params),
    queryFn: () =>
      apiGet<V2PolicyRunListResponse>('/v2/runs', {
        scope: params.scope,
        status: params.status,
        page: params.page,
      }),
    placeholderData: (prev) => prev,
  });
}

export function useV2Run(id: number) {
  return useQuery({
    queryKey: v2Keys.run(id),
    queryFn: () => apiGet<V2PolicyRun>(`/v2/runs/${id}`),
    enabled: Number.isFinite(id) && id > 0,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 5_000 : false),
  });
}

export function useV2RunActions(id: number, params: { status?: string; page?: number }) {
  return useQuery({
    queryKey: v2Keys.runActions(id, params),
    queryFn: () =>
      apiGet<V2PolicyActionListResponse>(`/v2/runs/${id}/actions`, {
        status: params.status,
        page: params.page,
      }),
    enabled: Number.isFinite(id) && id > 0,
    refetchInterval: 5_000,
  });
}

export function useV2ApproveRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, step, confirmText }: { id: number; step: 1 | 2 | 3; confirmText?: string }) =>
      apiPost<V2PolicyRun>(`/v2/runs/${id}/approve`, { step, confirmText }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: v2Keys.run(data.id) });
      void qc.invalidateQueries({ queryKey: ['v2', 'runs'] });
    },
  });
}

export function useV2CancelRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiPost<{ ok: boolean }>(`/v2/runs/${id}/cancel`),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: v2Keys.run(id) });
      void qc.invalidateQueries({ queryKey: ['v2', 'runs'] });
    },
  });
}

export function useV2LabRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { definition: unknown; fileIds?: number[]; siteIds?: number[] }) =>
      apiPost<V2PolicyRun>('/v2/lab/runs', body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['v2', 'runs'] }),
  });
}

export function useV2LabAccessCheck() {
  return useMutation({
    mutationFn: (body: { archivedId: number; upns: string[] }) =>
      apiPost<V2LabAccessCheckResponse>('/v2/lab/access-check', body),
  });
}

export function useV2Archived(params: { search?: string; siteId?: number; page?: number }) {
  return useQuery({
    queryKey: v2Keys.archived(params),
    queryFn: () =>
      apiGet<V2ArchivedListResponse>('/v2/archived', {
        search: params.search,
        siteId: params.siteId,
        page: params.page,
      }),
    placeholderData: (prev) => prev,
  });
}

export function useV2ArchivedDetail(id: number) {
  return useQuery({
    queryKey: v2Keys.archivedDetail(id),
    queryFn: () => apiGet<V2ArchivedDetail>(`/v2/archived/${id}`),
    enabled: Number.isFinite(id) && id > 0,
  });
}

export function useV2PortalFile(id: number) {
  return useQuery({
    queryKey: v2Keys.portal(id),
    queryFn: () => apiGet<V2PortalFile>(`/v2/portal/${id}`),
    enabled: Number.isFinite(id) && id > 0,
    retry: false,
  });
}

export function useV2Audit() {
  return useQuery({
    queryKey: v2Keys.audit,
    queryFn: () => apiGet<V2AuditStatus>('/v2/audit'),
    staleTime: 60_000,
  });
}

export function useV2ExplorerFolder(params: {
  siteId: number | null;
  libraryId?: number | null;
  path?: string;
  enabled?: boolean;
}) {
  const { siteId, libraryId, path = '', enabled = true } = params;
  return useQuery({
    queryKey: v2Keys.explorerFolder({ siteId, libraryId, path }),
    queryFn: () =>
      apiGet<V2ExplorerFolderResponse>('/v2/explorer/folder', {
        siteId: siteId!,
        libraryId: libraryId ?? undefined,
        path: path || undefined,
      }),
    enabled: enabled && siteId != null && siteId > 0,
  });
}

export function useV2ExplorerFile(fileId: number | null) {
  return useQuery({
    queryKey: v2Keys.explorerFile(fileId ?? 0),
    queryFn: () => apiGet<V2ExplorerFileDetail>(`/v2/explorer/file/${fileId}`),
    enabled: fileId != null && fileId > 0,
  });
}

export function useV2ExplorerArchived(archivedId: number | null) {
  return useQuery({
    queryKey: v2Keys.explorerArchived(archivedId ?? 0),
    queryFn: () => apiGet<V2ExplorerArchivedDetail>(`/v2/explorer/archived/${archivedId}`),
    enabled: archivedId != null && archivedId > 0,
  });
}

export function useV2ArchiveTree(params: {
  siteId: number | null;
  path?: string;
  enabled?: boolean;
}) {
  const { siteId, path = '', enabled = true } = params;
  return useQuery({
    queryKey: v2Keys.archiveTree({ siteId, path }),
    queryFn: () =>
      apiGet<V2ArchiveTreeResponse>('/v2/archive/tree', {
        siteId: siteId ?? undefined,
        path: path || undefined,
      }),
    enabled,
  });
}

export function useV2ArchiveItem(archivedId: number | null) {
  return useQuery({
    queryKey: v2Keys.archiveItem(archivedId ?? 0),
    queryFn: () => apiGet<V2ArchiveItemDetail>(`/v2/archive/item/${archivedId}`),
    enabled: archivedId != null && archivedId > 0,
    // While a restore is in progress, follow it.
    refetchInterval: (q) =>
      q.state.data?.restore?.state === 'requested' || q.state.data?.restore?.state === 'uploaded' ? 5_000 : false,
  });
}

export function useV2ArchiveLinks() {
  return useQuery({
    queryKey: v2Keys.archiveLinks,
    queryFn: () => apiGet<V2ArchiveLinksStatus>('/v2/archive/links'),
    refetchInterval: (q) => (q.state.data?.running ? 5_000 : 30_000),
  });
}

export function useV2CompleteArchiveLinks() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ started: boolean }>('/v2/archive/links/complete', {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: v2Keys.archiveLinks });
    },
  });
}

export function useV2RestoreArchived() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (archivedId: number) =>
      apiPost<{ archivedId: number; restoreState: string }>(`/v2/archive/item/${archivedId}/restore`, {}),
    onSuccess: (_r, archivedId) => {
      void qc.invalidateQueries({ queryKey: v2Keys.archiveItem(archivedId) });
    },
  });
}

export function useV2Settings<T>(key: string) {
  return useQuery({
    queryKey: v2Keys.settings(key),
    queryFn: () => apiGet<V2SettingsResponse<T>>(`/v2/settings/${encodeURIComponent(key)}`),
  });
}

export function useUpdateV2Settings<T>() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, value }: { key: string; value: T }) =>
      apiPut<V2SettingsResponse<T>>(`/v2/settings/${encodeURIComponent(key)}`, { value }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: v2Keys.settings(data.key) });
    },
  });
}

export type { V2EngineSettings, V2ArchiveSettings };
