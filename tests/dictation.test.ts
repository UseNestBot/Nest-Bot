import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanTranscript, DICTATION_MODELS, insertDictation, MODEL_BASE_URL } from '@shared/dictation';
import { ModelStore, type DownloadProgress } from '../src/main/models';

const base = DICTATION_MODELS[0];
const url = (file: string, repo = base.repo) => `${MODEL_BASE_URL}${repo}/${file}`;

describe('dictation text', () => {
  it('drops Whisper non-speech markers', () => {
    expect(cleanTranscript(' [BLANK_AUDIO] ')).toBe('');
    expect(cleanTranscript('Hello there. (upbeat music) [Music]')).toBe('Hello there.');
    expect(cleanTranscript('  Send it   to Sam (the designer). ')).toBe('Send it to Sam (the designer).');
  });

  it('inserts at the cursor with natural spacing', () => {
    expect(insertDictation('', 0, 0, 'Hello.')).toEqual({ value: 'Hello.', caret: 6 });
    expect(insertDictation('Draft:', 6, 6, 'ship it')).toEqual({ value: 'Draft: ship it', caret: 14 });
    expect(insertDictation('Hi team', 2, 2, 'there')).toEqual({ value: 'Hi there team', caret: 8 });
    expect(insertDictation('Call  later', 5, 5, 'Sam')).toEqual({ value: 'Call Sam later', caret: 8 });
    expect(insertDictation('Ask Bob.', 7, 7, 'and Ann')).toEqual({ value: 'Ask Bob and Ann.', caret: 15 });
    expect(insertDictation('replace THIS now', 8, 12, 'that')).toEqual({ value: 'replace that now', caret: 12 });
  });
});

describe('ModelStore', () => {
  let root: string;
  let requests: string[];
  let progress: DownloadProgress[];
  let files: Record<string, string>;

  const fakeFetch = (async (input: string | URL | Request) => {
    const u = String(input);
    requests.push(u);
    const file = u.replace(`https://huggingface.co/${base.repo}/resolve/main/`, '');
    if (!(file in files)) return new Response('missing', { status: 404 });
    await new Promise((r) => setTimeout(r, 10));
    return new Response(files[file], { status: 200 });
  }) as typeof fetch;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'nest-models-'));
    requests = [];
    progress = [];
    files = { 'config.json': '{"model_type":"whisper"}', [base.weights[0]]: 'E'.repeat(1000), [base.weights[1]]: 'D'.repeat(2000) };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const store = () => new ModelStore(root, (p) => progress.push(p), fakeFetch);

  it('only serves files of known model repos', () => {
    const s = store();
    expect(s.resolve(url('config.json'))).not.toBeNull();
    expect(s.resolve(url('config.json', 'someone/else'))).toBeNull();
    expect(s.resolve(url('../../../secrets.txt'))).toBeNull();
    expect(s.resolve(url('onnx/%2e%2e/%2e%2e/x.json'))).toBeNull();
    expect(s.resolve(url('onnx\\..\\x.json'))).toBeNull();
    expect(s.resolve(`nest-models://elsewhere/${base.repo}/config.json`)).toBeNull();
  });

  it('downloads once, saves under the model folder and serves from disk afterwards', async () => {
    const s = store();
    const [a, b] = await Promise.all([s.handle(new Request(url('config.json'))), s.handle(new Request(url('config.json')))]);
    expect(await a.text()).toBe(files['config.json']);
    expect(await b.text()).toBe(files['config.json']);
    expect(a.headers.get('access-control-allow-origin')).toBe('*');
    expect(requests).toEqual([`https://huggingface.co/${base.repo}/resolve/main/config.json`]);
    expect(readFileSync(path.join(root, base.id, 'config.json'), 'utf8')).toBe(files['config.json']);

    const again = await s.handle(new Request(url('config.json')));
    expect(await again.text()).toBe(files['config.json']);
    expect(requests).toHaveLength(1);
  });

  it('passes 404s through without saving anything', async () => {
    const res = await store().handle(new Request(url('normalizer.json')));
    expect(res.status).toBe(404);
    expect((await store().status())[0].bytesOnDisk).toBe(0);
  });

  it('reports progress, status and deletes a model', async () => {
    const s = store();
    expect((await s.status())[0]).toEqual({ id: base.id, downloaded: false, bytesOnDisk: 0 });
    for (const w of base.weights) await (await s.handle(new Request(url(w)))).arrayBuffer();
    await new Promise((r) => setTimeout(r, 20));
    expect(progress.at(-1)).toMatchObject({ modelId: base.id, done: true, loaded: 3000, total: base.bytes });
    expect((await s.status())[0]).toEqual({ id: base.id, downloaded: true, bytesOnDisk: 3000 });
    await s.remove(base.id);
    expect((await s.status())[0].downloaded).toBe(false);
  });

  it('answers 502 when Hugging Face fails, and retries next time', async () => {
    const s = new ModelStore(root, () => {}, (async () => new Response('busy', { status: 503 })) as typeof fetch);
    expect((await s.handle(new Request(url('config.json')))).status).toBe(502);
    const ok = await store().handle(new Request(url('config.json')));
    expect(ok.status).toBe(200);
  });
});
