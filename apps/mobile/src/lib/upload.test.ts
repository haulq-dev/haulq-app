import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('./api.ts', async () => {
  const actual = await vi.importActual<typeof import('./api.ts')>('./api.ts');
  return { ...actual, request: vi.fn() };
});

import { ApiRequestError, request } from './api.ts';
import { uploadDocuments } from './upload.ts';

const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type });

describe('uploadDocuments', () => {
  beforeEach(() => {
    (request as Mock).mockReset();
  });

  it('sends the raw bytes with the filename, load and kind on the query', async () => {
    (request as Mock).mockResolvedValue({ deduped: false });
    const pdf = file('pod.pdf', 'application/pdf');
    await uploadDocuments([pdf], { loadId: 'L1', kind: 'pod' });

    const [path, options] = (request as Mock).mock.calls[0]!;
    expect(path).toBe('/v1/documents?filename=pod.pdf&loadId=L1&kind=pod');
    expect(options.raw).toEqual({ body: pdf, contentType: 'application/pdf' });
  });

  it('reports a re-sent file as already held, not as nothing happening', async () => {
    (request as Mock).mockResolvedValueOnce({ deduped: false }).mockResolvedValueOnce({ deduped: true });
    const res = await uploadDocuments([file('a.pdf', 'application/pdf'), file('b.pdf', 'application/pdf')]);
    expect(res).toMatchObject({ added: 1, already: 1, summary: '1 added, 1 you already had' });
  });

  it('keeps going when one file fails, and says which', async () => {
    (request as Mock)
      .mockRejectedValueOnce(new ApiRequestError(415, { code: 'unsupported_file', explanation: 'Not a PDF or photo.' }))
      .mockResolvedValueOnce({ deduped: false });
    const res = await uploadDocuments([file('notes.txt', 'text/plain'), file('bol.jpg', 'image/jpeg')]);

    expect(res.added).toBe(1);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]!.name).toBe('notes.txt');
  });

  it('refuses a file over 25 MB before sending it', async () => {
    const res = await uploadDocuments([file('album.pdf', 'application/pdf', 26 * 1024 * 1024)]);
    expect(request).not.toHaveBeenCalled();
    expect(res.failed[0]!.error).toBeInstanceOf(Error);
  });
});
