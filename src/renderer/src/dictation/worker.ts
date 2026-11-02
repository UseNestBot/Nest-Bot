/// <reference lib="webworker" />
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';
import ortWasm from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjs from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import { MODEL_BASE_URL } from '@shared/dictation';

export type WorkerRequest = { type: 'load'; repo: string } | { type: 'transcribe'; id: number; repo: string; audio: Float32Array };
export type WorkerResponse = { type: 'loaded'; repo: string } | { type: 'result'; id: number; text: string } | { type: 'error'; id?: number; repo?: string; message: string };

// Everything comes from the app: weights through main's nest-models:// scheme
// (which downloads them once), the ONNX runtime from the bundle. Nothing here
// reaches the network directly or uses the browser cache.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = MODEL_BASE_URL;
env.useBrowserCache = false;
env.useWasmCache = false;
const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } };
if (onnx.wasm) {
  onnx.wasm.wasmPaths = { wasm: new URL(ortWasm, self.location.href).href, mjs: new URL(ortMjs, self.location.href).href };
  // Threads need SharedArrayBuffer, which main enables for this app.
  if (typeof SharedArrayBuffer !== 'undefined') onnx.wasm.numThreads = Math.min(4, Math.max(1, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
}

let current: { repo: string; asr: Promise<AutomaticSpeechRecognitionPipeline> } | null = null;

function load(repo: string): Promise<AutomaticSpeechRecognitionPipeline> {
  if (current?.repo === repo) return current.asr;
  const previous = current;
  const asr = pipeline('automatic-speech-recognition', repo, { dtype: 'q8', device: 'wasm' }) as Promise<AutomaticSpeechRecognitionPipeline>;
  current = { repo, asr };
  // A failed load (e.g. offline) shouldn't stick; the next request retries.
  asr.catch(() => {
    if (current?.asr === asr) current = null;
  });
  void previous?.asr.then((p) => p.dispose()).catch(() => {});
  return asr;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  const post = (r: WorkerResponse) => self.postMessage(r);
  if (msg.type === 'load') {
    try {
      await load(msg.repo);
      post({ type: 'loaded', repo: msg.repo });
    } catch (err) {
      post({ type: 'error', repo: msg.repo, message: (err as Error).message });
    }
    return;
  }
  try {
    const asr = await load(msg.repo);
    // Whisper reads 30 s windows; longer dictation is chunked with overlap.
    const out = await asr(msg.audio, msg.audio.length > 16000 * 30 ? { chunk_length_s: 30, stride_length_s: 5 } : {});
    const text = (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text) ?? '';
    post({ type: 'result', id: msg.id, text });
  } catch (err) {
    post({ type: 'error', id: msg.id, message: (err as Error).message });
  }
};
