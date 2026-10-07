/**
 * SharePoint REST operations used by policy actions. Every destructive call here is PERMANENT
 * (no recycle bin): DeleteByLabel for versions, X-HTTP-Method DELETE for files, DeleteObject for recycle items.
 */
import type { SpoClient } from '../spo/client.js';
import { isNotFound, SpoError, spPath } from '../spo/client.js';

export interface SpVersion {
  id: number;
  label: string;
  size: number;
  created: string | null;
  createdBy: string | null;
}

export interface RoleAssignment {
  principalId: number;
  loginName: string;
  title: string;
  principalType: number;
  roles: Array<{ id: number; name: string; roleTypeKind: number }>;
}

const fileApi = (web: string, url: string) => `${web}/_api/web/GetFileByServerRelativePath(decodedurl='${spPath(url)}')`;
const fileApiById = (web: string, uniqueId: string) => `${web}/_api/web/GetFileById('${uniqueId}')`;

/** SharePoint refuses a REST URL that is too long as `401 ... maxUrlLength` (it is not a permissions problem). */
export function isUrlTooLong(err: unknown): boolean {
  return err instanceof SpoError && err.status === 401 && /maxUrlLength/i.test(err.message);
}

/** Builds the URL of a call on one file: `u('/Versions?$select=ID')`. */
export type FileUrl = (suffix: string) => string;

export const byPath = (web: string, url: string): FileUrl => (s) => `${fileApi(web, url)}${s}`;
const byId = (web: string, uniqueId: string): FileUrl => (s) => `${fileApiById(web, uniqueId)}${s}`;
/** The path moves to the query string (a parameter alias): the URL path, which is what has the length limit, stays short. */
export const byAlias = (web: string, url: string): FileUrl => (s) =>
  `${web}/_api/web/GetFileByServerRelativePath(decodedurl=@p)${s}${s.includes('?') ? '&' : '?'}@p='${spPath(url)}'`;

/**
 * Runs a REST call on a file addressed by its path. Paths that make the URL too long fail with `maxUrlLength`; the
 * same call is then repeated addressing the file by its UniqueId when known, or with the path in the query string.
 * Calls that already work are untouched.
 */
export async function onFile<T>(web: string, url: string, uniqueId: string | null | undefined, run: (u: FileUrl) => Promise<T>): Promise<T> {
  try {
    return await run(byPath(web, url));
  } catch (err) {
    if (!isUrlTooLong(err)) throw err;
    return run(uniqueId ? byId(web, uniqueId) : byAlias(web, url));
  }
}

/** For several calls on the same file: finds out once which way of addressing it works. */
async function addressOf(spo: SpoClient, web: string, url: string, uniqueId: string | null | undefined, signal?: AbortSignal): Promise<FileUrl> {
  const direct = byPath(web, url);
  try {
    await spo.get(direct('?$select=Exists'), signal);
    return direct;
  } catch (err) {
    if (!isUrlTooLong(err)) throw err;
    return uniqueId ? byId(web, uniqueId) : byAlias(web, url);
  }
}

export async function listVersions(spo: SpoClient, web: string, url: string, signal?: AbortSignal, uniqueId?: string | null): Promise<SpVersion[]> {
  const res = await onFile(web, url, uniqueId, (u) =>
    spo.get<{ value: Array<{ ID: number; VersionLabel: string; Size: string | number; Created?: string; CreatedBy?: { Email?: string; Title?: string } }> }>(
      u('/Versions?$select=ID,VersionLabel,Size,Created'),
      signal,
    ),
  );
  return (res.value ?? []).map((v) => ({
    id: Number(v.ID),
    label: String(v.VersionLabel),
    size: Number(v.Size) || 0,
    created: v.Created ?? null,
    createdBy: v.CreatedBy?.Email || v.CreatedBy?.Title || null,
  }));
}

/** Permanent: the version does not go to the recycle bin. */
export async function deleteVersionByLabel(
  spo: SpoClient,
  web: string,
  url: string,
  label: string,
  signal?: AbortSignal,
  uniqueId?: string | null,
): Promise<void> {
  await onFile(web, url, uniqueId, (u) =>
    spo.request(u(`/Versions/DeleteByLabel(versionlabel='${encodeURIComponent(label)}')`), { method: 'POST', signal }),
  );
}

/** Permanent file delete (not recycle()). */
export async function deleteFilePermanently(spo: SpoClient, web: string, url: string, signal?: AbortSignal, uniqueId?: string | null): Promise<void> {
  await onFile(web, url, uniqueId, (u) => spo.request(u(''), { method: 'POST', headers: { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' }, signal }));
}

export async function fileExists(spo: SpoClient, web: string, url: string, signal?: AbortSignal, uniqueId?: string | null): Promise<boolean> {
  try {
    const res = await onFile(web, url, uniqueId, (u) => spo.get<{ Exists?: boolean }>(u('?$select=Exists'), signal));
    return res?.Exists !== false;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** SMTotalSize / size of one item via RenderListDataAsStream (the /items endpoint rejects SMTotalSize here). */
export async function readItemSizes(
  spo: SpoClient,
  web: string,
  listGuid: string,
  itemId: number,
  signal?: AbortSignal,
): Promise<{ size: number; total: number | null; versionLabel: string | null } | null> {
  const viewXml =
    `<View Scope="RecursiveAll"><Query><Where><Eq><FieldRef Name="ID"/><Value Type="Counter">${itemId}</Value></Eq></Where></Query>` +
    '<ViewFields><FieldRef Name="File_x0020_Size"/><FieldRef Name="SMTotalSize"/><FieldRef Name="_UIVersionString"/></ViewFields><RowLimit>1</RowLimit></View>';
  const res = await spo.post<{ Row?: Array<{ File_x0020_Size?: string; SMTotalSize?: string; _UIVersionString?: string }> }>(
    `${web}/_api/web/lists(guid'${listGuid}')/RenderListDataAsStream`,
    { parameters: { RenderOptions: 2, ViewXml: viewXml } },
    signal,
  );
  const row = res.Row?.[0];
  if (!row) return null;
  return {
    size: Number(row.File_x0020_Size ?? 0) || 0,
    total: row.SMTotalSize ? Number(row.SMTotalSize) : null,
    versionLabel: row._UIVersionString ?? null,
  };
}

export interface RecycleEntry {
  id: string;
  leafName: string;
  dirName: string;
  itemType: number;
  itemState: number;
  size: number;
  deletedDate: string;
}

/** Recycle bin entries (both stages) whose name matches, deleted at/after `since`. */
export async function findInRecycleBin(
  spo: SpoClient,
  siteUrl: string,
  leafName: string,
  since: Date,
  signal?: AbortSignal,
): Promise<RecycleEntry[]> {
  const name = leafName.replace(/'/g, "''");
  const res = await spo.get<{ value: Array<{ Id: string; LeafName: string; DirName: string; ItemType: number; ItemState: number; Size: string; DeletedDate: string }> }>(
    `${siteUrl}/_api/site/RecycleBin?$filter=LeafName eq '${encodeURIComponent(name)}'&$select=Id,LeafName,DirName,ItemType,ItemState,Size,DeletedDate&$top=200`,
    signal,
  );
  return (res.value ?? [])
    .filter((e) => new Date(e.DeletedDate).getTime() >= since.getTime() - 60_000)
    .map((e) => ({
      id: e.Id,
      leafName: e.LeafName,
      dirName: e.DirName,
      itemType: e.ItemType,
      itemState: e.ItemState,
      size: Number(e.Size) || 0,
      deletedDate: e.DeletedDate,
    }));
}

export async function preservationHoldItemCount(spo: SpoClient, web: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await spo.get<{ value: Array<{ ItemCount: number }> }>(
      `${web}/_api/web/lists?$select=ItemCount&$filter=Title eq 'Preservation Hold Library'`,
      signal,
    );
    return res.value?.[0]?.ItemCount ?? null;
  } catch {
    return null;
  }
}

export async function hasUniquePermissions(spo: SpoClient, web: string, url: string, signal?: AbortSignal, uniqueId?: string | null): Promise<boolean> {
  const res = await onFile(web, url, uniqueId, (u) =>
    spo.get<{ HasUniqueRoleAssignments?: boolean }>(u('/ListItemAllFields?$select=HasUniqueRoleAssignments'), signal),
  );
  return res.HasUniqueRoleAssignments === true;
}

/** Limited Access (RoleTypeKind 1) is system-managed and cannot be assigned; it is ignored when copying. */
export async function readRoleAssignments(spo: SpoClient, web: string, url: string, signal?: AbortSignal, uniqueId?: string | null): Promise<RoleAssignment[]> {
  return onFile(web, url, uniqueId, (u) => readRoleAssignmentsAt(spo, u, signal));
}

async function readRoleAssignmentsAt(spo: SpoClient, u: FileUrl, signal?: AbortSignal): Promise<RoleAssignment[]> {
  const res = await spo.get<{ value: Array<{ PrincipalId: number; Member: { LoginName: string; Title: string; PrincipalType: number }; RoleDefinitionBindings: Array<{ Id: number; Name: string; RoleTypeKind: number }> }> }>(
    u('/ListItemAllFields/RoleAssignments?$expand=Member,RoleDefinitionBindings'),
    signal,
  );
  return (res.value ?? []).map((a) => ({
    principalId: a.PrincipalId,
    loginName: a.Member?.LoginName ?? '',
    title: a.Member?.Title ?? '',
    principalType: a.Member?.PrincipalType ?? 0,
    roles: (a.RoleDefinitionBindings ?? []).map((r) => ({ id: r.Id, name: r.Name, roleTypeKind: r.RoleTypeKind })),
  }));
}

export function assignableRoles(assignments: RoleAssignment[]): Array<{ principalId: number; roleId: number }> {
  const out: Array<{ principalId: number; roleId: number }> = [];
  for (const a of assignments) {
    for (const r of a.roles) {
      if (r.roleTypeKind === 1) continue; // Limited Access
      out.push({ principalId: a.principalId, roleId: r.id });
    }
  }
  return out;
}

/** Makes `targetUrl` have exactly the assignable permissions of `assignments` (breaks inheritance). */
export async function applyRoleAssignments(
  spo: SpoClient,
  web: string,
  targetUrl: string,
  assignments: RoleAssignment[],
  signal?: AbortSignal,
  uniqueId?: string | null,
): Promise<void> {
  const u = await addressOf(spo, web, targetUrl, uniqueId, signal);
  await spo.request(u('/ListItemAllFields/breakroleinheritance(copyRoleAssignments=false,clearSubscopes=true)'), { method: 'POST', signal });
  // breakroleinheritance(copy=false) may keep the caller's own assignment; remove anything not in the source.
  const wanted = assignableRoles(assignments);
  const current = assignableRoles(await readRoleAssignmentsAt(spo, u, signal));
  for (const c of current) {
    if (!wanted.some((w) => w.principalId === c.principalId && w.roleId === c.roleId)) {
      await spo.request(u(`/ListItemAllFields/roleassignments/removeroleassignment(principalid=${c.principalId},roledefid=${c.roleId})`), { method: 'POST', signal });
    }
  }
  for (const w of wanted) {
    if (!current.some((c) => c.principalId === w.principalId && c.roleId === w.roleId)) {
      await spo.request(u(`/ListItemAllFields/roleassignments/addroleassignment(principalid=${w.principalId},roledefid=${w.roleId})`), { method: 'POST', signal });
    }
  }
}

export async function uploadSmallFile(
  spo: SpoClient,
  web: string,
  folderUrl: string,
  name: string,
  content: string,
  signal?: AbortSignal,
): Promise<string> {
  const send = (url: string) => spo.request(url, { method: 'POST', body: content, headers: { 'Content-Type': 'application/octet-stream' }, signal });
  try {
    await send(`${web}/_api/web/GetFolderByServerRelativePath(decodedurl='${spPath(folderUrl)}')/Files/AddUsingPath(decodedurl='${spPath(name)}',overwrite=true)`);
  } catch (err) {
    if (!isUrlTooLong(err)) throw err;
    // Folder and file name go in the query string: the URL path stays short.
    await send(
      `${web}/_api/web/GetFolderByServerRelativePath(decodedurl=@f)/Files/AddUsingPath(decodedurl=@n,overwrite=true)?@f='${spPath(folderUrl)}'&@n='${spPath(name)}'`,
    );
  }
  return `${folderUrl.replace(/\/$/, '')}/${name}`;
}

/** SPBasePermissions low bits: ViewListItems (0x1) and OpenItems (0x20) are both needed to download. */
export async function userCanOpen(spo: SpoClient, web: string, url: string, upn: string, signal?: AbortSignal): Promise<boolean> {
  const claim = encodeURIComponent(`i:0#.f|membership|${upn.toLowerCase()}`);
  try {
    const res = await onFile(web, url, null, (u) =>
      spo.get<{ High?: string | number; Low?: string | number; GetUserEffectivePermissions?: { High: string; Low: string } }>(
        u(`/ListItemAllFields/GetUserEffectivePermissions(@u)?@u='${claim}'`),
        signal,
      ),
    );
    const low = Number(res.GetUserEffectivePermissions?.Low ?? res.Low ?? 0);
    return (low & 0x1) === 0x1 && (low & 0x20) === 0x20;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** Graph quickXorHash of a list item (the hash SharePoint stores for the current version). */
export async function graphQuickXorHash(
  spo: SpoClient,
  siteHostPath: { host: string; path: string },
  listGuid: string,
  itemId: number,
  signal?: AbortSignal,
): Promise<{ hash: string | null; size: number | null }> {
  const res = await spo.request<{ size?: number; file?: { hashes?: { quickXorHash?: string } } }>(
    `https://graph.microsoft.com/v1.0/sites/${siteHostPath.host}:${siteHostPath.path}:/lists/${listGuid}/items/${itemId}/driveItem?$select=size,file`,
    { signal },
  );
  return { hash: res.file?.hashes?.quickXorHash ?? null, size: res.size ?? null };
}

/** Host and path of a web URL, as Graph addresses a site (`/sites/{host}:{path}`). */
export function hostPath(siteUrl: string): { host: string; path: string } {
  const u = new URL(siteUrl);
  return { host: u.hostname, path: u.pathname.replace(/\/$/, '') };
}

/** Role assignment as stored in spo.archived_files.acl_json (Limited Access excluded). */
export interface StoredAclEntry {
  principalId: number;
  loginName: string;
  title: string;
  principalType: number;
  roles: string[];
}

export function aclSnapshot(assignments: RoleAssignment[]): StoredAclEntry[] {
  return assignments.map((a) => ({
    principalId: a.principalId,
    loginName: a.loginName,
    title: a.title,
    principalType: a.principalType,
    roles: a.roles.filter((r) => r.roleTypeKind !== 1).map((r) => r.name),
  }));
}

/** Null when the JSON is missing or not an ACL snapshot: callers must fail closed. */
export function parseStoredAcl(json: string | null): StoredAclEntry[] | null {
  if (!json) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return null;
    const out: StoredAclEntry[] = [];
    for (const e of value as Array<Record<string, unknown>>) {
      if (!e || typeof e.principalId !== 'number' || !Array.isArray(e.roles)) return null;
      out.push({
        principalId: e.principalId,
        loginName: String(e.loginName ?? ''),
        title: String(e.title ?? ''),
        principalType: Number(e.principalType ?? 0),
        roles: e.roles.map(String),
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** Comparable form of an ACL: one sorted key per (principal, login, role). */
export function aclKeys(entries: StoredAclEntry[]): string[] {
  const keys: string[] = [];
  for (const e of entries) {
    for (const role of e.roles) keys.push(`${e.principalId}|${e.loginName.toLowerCase()}|${role.toLowerCase()}`);
  }
  return keys.sort();
}

/** Role definition ids by lower-cased name for one web. */
export async function readRoleDefinitions(spo: SpoClient, web: string, signal?: AbortSignal): Promise<Map<string, number>> {
  const res = await spo.get<{ value: Array<{ Id: number; Name: string }> }>(`${web}/_api/web/roledefinitions?$select=Id,Name`, signal);
  return new Map((res.value ?? []).map((r) => [String(r.Name).toLowerCase(), Number(r.Id)]));
}

/** Rebuilds assignable role assignments from a stored ACL (names → ids of this web's role definitions). */
export function assignmentsFromStoredAcl(
  entries: StoredAclEntry[],
  roleIds: Map<string, number>,
): { assignments: RoleAssignment[]; missingRoles: string[] } {
  const missing = new Set<string>();
  const assignments = entries.map((e) => ({
    principalId: e.principalId,
    loginName: e.loginName,
    title: e.title,
    principalType: e.principalType,
    roles: e.roles.flatMap((name) => {
      const id = roleIds.get(name.toLowerCase());
      if (id === undefined) {
        missing.add(name);
        return [];
      }
      return [{ id, name, roleTypeKind: 0 }];
    }),
  }));
  return { assignments, missingRoles: [...missing] };
}

/** Current size and last-modified time of a file (REST `Length` / `TimeLastModified`). */
export async function readFileInfo(
  spo: SpoClient,
  web: string,
  url: string,
  signal?: AbortSignal,
  uniqueId?: string | null,
): Promise<{ length: number; modified: string | null }> {
  const res = await onFile(web, url, uniqueId, (u) =>
    spo.get<{ Length?: string | number; TimeLastModified?: string }>(u('?$select=Length,TimeLastModified'), signal),
  );
  return { length: Number(res.Length ?? 0) || 0, modified: res.TimeLastModified ?? null };
}

/**
 * The site cannot take more data: over its storage quota (HTTP 507) or locked read-only. Creating the .url link
 * fails with this; deleting the original is what frees the space.
 */
export function isNoSpaceError(err: unknown): boolean {
  if (!(err instanceof SpoError)) return false;
  if (err.status === 507) return true;
  return (err.status === 403 || err.status === 423) && /storage|quota|read[- ]?only|locked/i.test(err.message);
}
