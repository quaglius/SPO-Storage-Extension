import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { uploadStreamToSharePoint } from '../../src/v2/actions/restore.js';
import { SpoClient } from '../../src/v2/spo/client.js';

function fakeSharePoint() {
  const calls: Array<{ url: string; bytes: number; method: string | null }> = [];
  const received: Buffer[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = decodeURIComponent(String(input));
    const body = init?.body as Uint8Array | undefined;
    calls.push({ url: url.replace(/^.*\/_api\/web\//, ''), bytes: body?.length ?? 0, method: (init?.headers as Record<string, string>)?.['X-HTTP-Method'] ?? null });
    if (body && body.length) received.push(Buffer.from(body));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { calls, received, spo: new SpoClient({ tenant: 't', tokenProvider: async () => 't', fetchImpl }) };
}

async function* chunks(total: number, piece: number) {
  for (let i = 0; i < total; i += piece) {
    const n = Math.min(piece, total - i);
    yield Buffer.alloc(n, i % 251);
  }
}

describe('uploadStreamToSharePoint', () => {
  it('creates the file without overwrite, then Start/Continue/Finish with the right offsets and bytes', async () => {
    const { calls, received, spo } = fakeSharePoint();
    const total = 25;
    const out = await uploadStreamToSharePoint(spo, 'https://t.sharepoint.com/sites/a', '/sites/a/Docs/x y.zip', chunks(total, 7), { chunkSize: 10 });
    expect(calls[0].url).toContain("Files/AddUsingPath(decodedurl='x y.zip',overwrite=false)");
    expect(calls.slice(1).map((c) => c.url.replace(/guid'[^']+'/, 'guid')).map((u) => u.split(')/')[1] ?? u)).toEqual([
      'StartUpload(uploadId=guid)',
      'ContinueUpload(uploadId=guid,fileOffset=10)',
      'FinishUpload(uploadId=guid,fileOffset=20)',
    ]);
    expect(calls.slice(1).map((c) => c.bytes)).toEqual([10, 10, 5]);
    expect(out.bytes).toBe(total);
    const all = Buffer.concat(received);
    expect(out.sha256).toBe(createHash('sha256').update(all).digest('hex'));
  });

  it('uses a single PUT of $value when the file fits in one chunk', async () => {
    const { calls, spo } = fakeSharePoint();
    const out = await uploadStreamToSharePoint(spo, 'https://t.sharepoint.com/sites/a', '/sites/a/Docs/small.txt', chunks(8, 3), { chunkSize: 10 });
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toContain('/$value');
    expect(calls[1].method).toBe('PUT');
    expect(out.bytes).toBe(8);
  });
});
