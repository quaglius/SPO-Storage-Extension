/**
 * "Who can open this file?" for the explorer: the file's role assignments (or, for an archived file, those of
 * the .url link that carries its permissions), expanded down to people with e-mail.
 *  - users → their e-mail;
 *  - SharePoint groups → their members (SharePoint REST);
 *  - Microsoft 365 / Entra groups → their members (Graph, needs GroupMember.Read.All);
 *  - "Everyone" claims → flagged as the whole organization.
 * Read-only: nothing here changes permissions.
 */
import type { SpoClient } from '../spo/client.js';
import { SpoError } from '../spo/client.js';
import { readRoleAssignments, type RoleAssignment } from './sp-ops.js';

export type PrincipalKind = 'user' | 'sharepoint-group' | 'm365-group' | 'security-group' | 'everyone' | 'other';

export interface AccessPerson {
  email: string | null;
  name: string;
}

export interface AccessPrincipal {
  kind: PrincipalKind;
  name: string;
  email: string | null;
  roles: string[];
  members: AccessPerson[] | null;
  /** Shown when members could not be listed. */
  membersNote: string | null;
}

export interface FileAccess {
  principals: AccessPrincipal[];
  /** Everyone who can open it, deduplicated by e-mail, with the strongest role. */
  people: Array<AccessPerson & { roles: string[]; via: string[] }>;
  everyone: boolean;
  unique: boolean | null;
}

const ROLE_ORDER = ['Control total', 'Full Control', 'Diseño', 'Design', 'Editar', 'Edit', 'Colaborar', 'Contribute', 'Leer', 'Read'];

function emailFromLogin(login: string): string | null {
  const m = /\|membership\|(.+)$/i.exec(login);
  return m ? m[1].toLowerCase() : null;
}

function groupGuid(login: string): string | null {
  const m = /\|(?:federateddirectoryclaimprovider|tenant)\|([0-9a-f-]{36})/i.exec(login);
  return m ? m[1] : null;
}

export function classifyPrincipal(a: Pick<RoleAssignment, 'loginName' | 'principalType'>): PrincipalKind {
  const login = a.loginName.toLowerCase();
  if (login.includes('spo-grid-all-users') || login.startsWith('c:0(.s|true') || login.includes('|everyone')) return 'everyone';
  if (a.principalType === 1) return 'user';
  if (a.principalType === 8) return 'sharepoint-group';
  if (login.includes('federateddirectoryclaimprovider')) return 'm365-group';
  if (a.principalType === 4) return 'security-group';
  return 'other';
}

async function sharePointGroupMembers(spo: SpoClient, web: string, groupId: number, signal?: AbortSignal) {
  const res = await spo.get<{ value: Array<{ Email?: string; Title?: string; LoginName?: string; PrincipalType?: number }> }>(
    `${web}/_api/web/sitegroups/getbyid(${groupId})/users?$select=Email,Title,LoginName,PrincipalType`,
    signal,
  );
  return res.value ?? [];
}

async function directoryGroupMembers(spo: SpoClient, guid: string, signal?: AbortSignal): Promise<AccessPerson[]> {
  const out: AccessPerson[] = [];
  let url: string | null =
    `https://graph.microsoft.com/v1.0/groups/${guid}/transitiveMembers/microsoft.graph.user?$select=displayName,mail,userPrincipalName&$top=999`;
  while (url && out.length < 5000) {
    const page: { value?: Array<{ displayName?: string; mail?: string; userPrincipalName?: string }>; '@odata.nextLink'?: string } =
      await spo.request(url, { api: 'graph', signal });
    for (const u of page.value ?? []) {
      out.push({ email: (u.mail || u.userPrincipalName || '').toLowerCase() || null, name: u.displayName ?? u.userPrincipalName ?? '' });
    }
    url = page['@odata.nextLink'] ?? null;
  }
  return out;
}

async function expandDirectoryGroup(spo: SpoClient, login: string, signal?: AbortSignal): Promise<{ members: AccessPerson[] | null; note: string | null }> {
  const guid = groupGuid(login);
  if (!guid) return { members: null, note: 'Could not identify the group.' };
  try {
    const members = await directoryGroupMembers(spo, guid, signal);
    const owners = /_o$/i.test(login) || login.toLowerCase().endsWith('_o');
    return { members, note: owners ? 'Owners of the Microsoft 365 group.' : null };
  } catch (err) {
    if (err instanceof SpoError && (err.status === 401 || err.status === 403)) {
      return { members: null, note: 'GroupMember.Read.All is required to list members of this group.' };
    }
    if (err instanceof SpoError && err.status === 404) return { members: null, note: 'The group no longer exists.' };
    throw err;
  }
}

export async function describeAccess(
  spo: SpoClient,
  web: string,
  serverRelativeUrl: string,
  signal?: AbortSignal,
): Promise<FileAccess> {
  const assignments = await readRoleAssignments(spo, web, serverRelativeUrl, signal);
  const principals: AccessPrincipal[] = [];
  for (const a of assignments) {
    const roles = a.roles.filter((r) => r.roleTypeKind !== 1).map((r) => r.name);
    if (roles.length === 0) continue; // Limited Access only: cannot open the file
    const kind = classifyPrincipal(a);
    const p: AccessPrincipal = { kind, name: a.title, email: emailFromLogin(a.loginName), roles, members: null, membersNote: null };
    if (kind === 'sharepoint-group') {
      const members: AccessPerson[] = [];
      const notes: string[] = [];
      for (const m of await sharePointGroupMembers(spo, web, a.principalId, signal)) {
        const login = m.LoginName ?? '';
        const mk = classifyPrincipal({ loginName: login, principalType: m.PrincipalType ?? 0 });
        if (mk === 'user') members.push({ email: (m.Email || emailFromLogin(login) || '').toLowerCase() || null, name: m.Title ?? '' });
        else if (mk === 'm365-group' || mk === 'security-group') {
          const sub = await expandDirectoryGroup(spo, login, signal);
          if (sub.members) members.push(...sub.members);
          else notes.push(`${m.Title}: ${sub.note}`);
        } else if (mk === 'everyone') notes.push('Includes the whole organization.');
      }
      p.members = members;
      p.membersNote = notes.length ? notes.join(' ') : null;
    } else if (kind === 'm365-group' || kind === 'security-group') {
      const sub = await expandDirectoryGroup(spo, a.loginName, signal);
      p.members = sub.members;
      p.membersNote = sub.note;
    } else if (kind === 'everyone') {
      p.membersNote = 'Anyone in the organization can open it.';
    }
    principals.push(p);
  }

  const people = new Map<string, AccessPerson & { roles: string[]; via: string[] }>();
  const add = (person: AccessPerson, roles: string[], via: string) => {
    const key = person.email ?? `nombre:${person.name}`;
    const cur = people.get(key) ?? { ...person, roles: [], via: [] };
    for (const r of roles) if (!cur.roles.includes(r)) cur.roles.push(r);
    if (!cur.via.includes(via)) cur.via.push(via);
    people.set(key, cur);
  };
  for (const p of principals) {
    if (p.kind === 'user') add({ email: p.email, name: p.name }, p.roles, 'directo');
    for (const m of p.members ?? []) add(m, p.roles, p.name);
  }
  const rank = (roles: string[]) => Math.min(...roles.map((r) => (ROLE_ORDER.indexOf(r) + 1 || 99)));
  return {
    principals,
    people: [...people.values()].sort((x, y) => rank(x.roles) - rank(y.roles) || x.name.localeCompare(y.name)),
    everyone: principals.some((p) => p.kind === 'everyone'),
    unique: null,
  };
}
