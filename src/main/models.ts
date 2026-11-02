import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DICTATION_MODELS, type DictationModel, type DictationModelStatus } from '@shared/dictation';

export interface DownloadProgress {
  modelId: string;
  loaded: number;
  total: number;
  done: boolean;
}

const SAFE_FILE = /^[\w.-]+(?:\/[\w.-]+)*$/;
const CONTENT_TYPES: Record<string, string> = { '.json': 'application/json', '.txt': 'text/plain', '.onnx': 'application/octet-stream' };

/**
 * Serves dictation model files to the renderer's worker over the nest-models://
 * scheme. A file that isn't on disk yet is downloaded from Hugging Face first,
 * but only for the repos in DICTATION_MODELS, so the scheme can't be used to
 * fetch anything else.
 */
export class ModelStore {
  private downloads = new Map<string, Promise<boolean>>();
  private inflight = new Map<string, Map<string, number>>();
  private lastEmit = 0;

  constructor(
    private root: string,
    private onProgress: (p: DownloadProgress) => void,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  /** Handler for protocol.handle: URLs look like nest-models://hf/<repo>/<file>. */
  async handle(request: Request): Promise<Response> {
    const target = this.resolve(request.url);
    if (!target) return new Response('Not found', { status: 404 });
    try {
      if (!(await exists(target.local))) {
        const found = await this.download(target.model, target.file, target.local);
        if (!found) return new Response('Not found', { status: 404 });
      }
      const size = (await stat(target.local)).size;
      const headers = {
        'Content-Type': CONTENT_TYPES[path.extname(target.local)] ?? 'application/octet-stream',
        'Content-Length': String(size),
        // The renderer is file:// in the installed app and http://localhost in dev.
        'Access-Control-Allow-Origin': '*',
      };
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
      return new Response(Readable.toWeb(createReadStream(target.local)) as ReadableStream, { status: 200, headers });
    } catch (err) {
      console.error('[nest] model file failed:', (err as Error).message);
      return new Response('Download failed', { status: 502 });
    }
  }

  resolve(url: string): { model: DictationModel; file: string; local: string } | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    if (parsed.hostname !== 'hf') return null;
    const rel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
    const model = DICTATION_MODELS.find((m) => rel.startsWith(`${m.repo}/`));
    if (!model) return null;
    const file = rel.slice(model.repo.length + 1);
    if (!SAFE_FILE.test(file) || file.split('/').some((part) => part === '..' || part === '.')) return null;
    return { model, file, local: path.join(this.modelDir(model), ...file.split('/')) };
  }

  async status(): Promise<DictationModelStatus[]> {
    return Promise.all(
      DICTATION_MODELS.map(async (m) => {
        const dir = this.modelDir(m);
        const weights = await Promise.all(m.weights.map((w) => exists(path.join(dir, ...w.split('/')))));
        return { id: m.id, downloaded: weights.every(Boolean), bytesOnDisk: await dirSize(dir) };
      }),
    );
  }

  async remove(id: string): Promise<void> {
    const model = DICTATION_MODELS.find((m) => m.id === id);
    if (!model) return;
    if (this.inflight.get(model.id)?.size) throw new Error('That model is still downloading.');
    await rm(this.modelDir(model), { recursive: true, force: true });
  }

  private modelDir(m: DictationModel): string {
    return path.join(this.root, m.id);
  }

  /** One download per file even when the worker asks for it twice at once. */
  private download(model: DictationModel, file: string, local: string): Promise<boolean> {
    let pending = this.downloads.get(local);
    if (!pending) {
      pending = this.fetchToDisk(model, file, local).finally(() => this.downloads.delete(local));
      this.downloads.set(local, pending);
    }
    return pending;
  }

  private async fetchToDisk(model: DictationModel, file: string, local: string): Promise<boolean> {
    const url = `https://huggingface.co/${model.repo}/resolve/main/${file}`;
    const res = await this.fetchImpl(url);
    if (res.status === 404) return false;
    if (!res.ok || !res.body) throw new Error(`Hugging Face returned ${res.status} for ${file}`);

    await mkdir(path.dirname(local), { recursive: true });
    const part = `${local}.part`;
    const files = this.inflight.get(model.id) ?? new Map<string, number>();
    this.inflight.set(model.id, files);
    files.set(file, 0);
    let loaded = 0;
    const counter = new Transform({
      transform: (chunk: Buffer, _enc, done) => {
        loaded += chunk.length;
        files.set(file, loaded);
        this.emit(model, false);
        done(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, createWriteStream(part));
      await rename(part, local);
      return true;
    } catch (err) {
      await rm(part, { force: true });
      throw err;
    } finally {
      files.delete(file);
      this.emit(model, files.size === 0);
    }
  }

  private emit(model: DictationModel, done: boolean): void {
    const now = Date.now();
    if (!done && now - this.lastEmit < 200) return;
    this.lastEmit = now;
    void this.onDiskWeights(model).then((onDisk) => {
      let loaded = onDisk;
      for (const n of this.inflight.get(model.id)?.values() ?? []) loaded += n;
      this.onProgress({ modelId: model.id, loaded: Math.min(loaded, model.bytes), total: model.bytes, done });
    });
  }

  private async onDiskWeights(model: DictationModel): Promise<number> {
    let total = 0;
    for (const w of model.weights) {
      try {
        total += (await stat(path.join(this.modelDir(model), ...w.split('/')))).size;
      } catch {
        /* not downloaded yet */
      }
    }
    return total;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  try {
    for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
      if (entry.isFile()) total += (await stat(path.join(entry.parentPath, entry.name))).size;
    }
  } catch {
    /* no folder yet */
  }
  return total;
}
