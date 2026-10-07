import { describe, expect, it } from 'vitest';
import { classifyPrincipal, describeAccess } from '../../src/v2/actions/access-list.js';
import { SpoClient } from '../../src/v2/spo/client.js';

const WEB = 'https://t.sharepoint.com/sites/a';
const M365 = 'c:0o.c|federateddirectoryclaimprovider|11111111-2222-3333-4444-555555555555';

const fakeFetch = (async (input: string | URL) => {
  const url = String(input);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.includes('/RoleAssignments')) {
    return json({
      value: [
        { PrincipalId: 7, Member: { LoginName: 'i:0#.f|membership|jorge@example.com', Title: 'Jorge', PrincipalType: 1 }, RoleDefinitionBindings: [{ Id: 1, Name: 'Editar', RoleTypeKind: 6 }] },
        { PrincipalId: 5, Member: { LoginName: 'Miembros de A', Title: 'Miembros de A', PrincipalType: 8 }, RoleDefinitionBindings: [{ Id: 2, Name: 'Leer', RoleTypeKind: 2 }] },
        { PrincipalId: 9, Member: { LoginName: 'i:0#.f|membership|nadie@example.com', Title: 'Nadie', PrincipalType: 1 }, RoleDefinitionBindings: [{ Id: 3, Name: 'Acceso limitado', RoleTypeKind: 1 }] },
      ],
    });
  }
  if (url.includes('/sitegroups/getbyid(5)/users')) {
    return json({
      value: [
        { Email: 'Eduardo@example.com', Title: 'Eduardo', LoginName: 'i:0#.f|membership|eduardo@example.com', PrincipalType: 1 },
        { Title: 'A Members', LoginName: M365, PrincipalType: 4 },
      ],
    });
  }
  if (url.startsWith('https://graph.microsoft.com/v1.0/groups/11111111-2222-3333-4444-555555555555/transitiveMembers')) {
    return json({ value: [{ displayName: 'Jorge', mail: 'jorge@example.com' }, { displayName: 'Laura', mail: 'laura@example.com' }] });
  }
  return json({ error: { message: `unexpected ${url}` } }, 404);
}) as typeof fetch;

describe('describeAccess', () => {
  it('classifies principals', () => {
    expect(classifyPrincipal({ loginName: 'c:0-.f|rolemanager|spo-grid-all-users/abc', principalType: 4 })).toBe('everyone');
    expect(classifyPrincipal({ loginName: M365, principalType: 4 })).toBe('m365-group');
    expect(classifyPrincipal({ loginName: 'i:0#.f|membership|x@y.co', principalType: 1 })).toBe('user');
  });

  it('expands SharePoint and Microsoft 365 groups to people and ignores limited access', async () => {
    const spo = new SpoClient({ tenant: 't', tokenProvider: async () => 't', fetchImpl: fakeFetch });
    const access = await describeAccess(spo, WEB, '/sites/a/Shared Documents/x.pptx');
    expect(access.principals.map((p) => p.name)).toEqual(['Jorge', 'Miembros de A']);
    expect(access.people.map((p) => p.email)).toEqual(['jorge@example.com', 'eduardo@example.com', 'laura@example.com']);
    expect(access.people[0]).toMatchObject({ roles: ['Editar', 'Leer'], via: ['directo', 'Miembros de A'] });
    expect(access.everyone).toBe(false);
  });
});
