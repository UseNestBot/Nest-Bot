import { useCallback, useEffect, useRef, useState } from 'react';
import { cleanTranscript, dictationModel } from '@shared/dictation';
import { api } from '../api';
import type { WorkerRequest, WorkerResponse } from './worker';

const SAMPLE_RATE = 16000;

/** One Whisper worker for the whole app; it keeps the loaded model between dictations. */
class DictationEngine {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (text: string) => void; reject: (err: Error) => void }>();
  private loads = new Map<string, { promise: Promise<void>; resolve: () => void; reject: (err: Error) => void }>();

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.receive(e.data);
      this.worker.onerror = (e) => this.failAll(new Error(e.message || 'The voice model stopped unexpectedly.'));
    }
    return this.worker;
  }

  private receive(msg: WorkerResponse): void {
    if (msg.type === 'loaded') {
      this.loads.get(msg.repo)?.resolve();
    } else if (msg.type === 'result') {
      this.pending.get(msg.id)?.resolve(msg.text);
      this.pending.delete(msg.id);
    } else if (msg.id !== undefined) {
      this.pending.get(msg.id)?.reject(new Error(msg.message));
      this.pending.delete(msg.id);
    } else if (msg.repo) {
      this.loads.get(msg.repo)?.reject(new Error(msg.message));
      this.loads.delete(msg.repo);
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    for (const l of this.loads.values()) l.reject(err);
    this.pending.clear();
    this.loads.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  /** Download (first time) and load the model; resolves when it can transcribe. */
  load(repo: string): Promise<void> {
    const existing = this.loads.get(repo);
    if (existing) return existing.promise;
    let resolve!: () => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    promise.catch(() => {});
    this.loads.set(repo, { promise, resolve, reject });
    this.post({ type: 'load', repo });
    return promise;
  }

  transcribe(repo: string, audio: Float32Array): Promise<string> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: 'transcribe', id, repo, audio }, [audio.buffer]);
    });
  }

  private post(msg: WorkerRequest, transfer: Transferable[] = []): void {
    this.w.postMessage(msg, transfer);
  }
}

export const dictationEngine = new DictationEngine();

/** Decode recorded audio to the 16 kHz mono samples Whisper expects. */
async function toSamples(blob: Blob): Promise<Float32Array> {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
    const out = new Float32Array(buf.length);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const ch = buf.getChannelData(c);
      for (let i = 0; i < ch.length; i++) out[i] += ch[i] / buf.numberOfChannels;
    }
    return out;
  } finally {
    void ctx.close();
  }
}

/** Too short or too quiet to hold words; Whisper would only invent some. */
function isSilent(samples: Float32Array): boolean {
  if (samples.length < SAMPLE_RATE * 0.3) return true;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  return peak < 0.01;
}

function friendlyError(err: unknown): string {
  const e = err as Error & { name?: string };
  if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') return 'Nest can’t use the microphone. Allow microphone access for desktop apps in Windows Settings → Privacy & security → Microphone.';
  if (e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError') return 'No microphone found.';
  if (/could not locate file|not found locally|fetch|network|502/i.test(e?.message ?? '')) return 'Couldn’t download the voice model. Check your internet connection and try again.';
  return `Dictation failed: ${e?.message ?? String(err)}`;
}

export type DictationState = 'idle' | 'recording' | 'transcribing';

export interface DownloadState {
  loaded: number;
  total: number;
}

/** Track the main process's download of a model's files. */
export function useModelDownload(modelId: string): DownloadState | null {
  const [progress, setProgress] = useState<DownloadState | null>(null);
  useEffect(() => {
    setProgress(null);
    return api.onEvent((e) => {
      if (e.type !== 'dictation-download' || e.modelId !== modelId) return;
      setProgress(e.done ? null : { loaded: e.loaded, total: e.total });
    });
  }, [modelId]);
  return progress;
}

/**
 * Record from the microphone, then transcribe locally when recording stops.
 * Whisper works on whole clips, so text arrives after the user stops speaking.
 */
export function useDictation(modelId: string, onText: (text: string) => void, onError: (message: string) => void) {
  const [state, setState] = useState<DictationState>('idle');
  const [startedAt, setStartedAt] = useState(0);
  const recorder = useRef<MediaRecorder | null>(null);
  const discard = useRef(false);
  // A stop that arrives while the microphone is still opening (a quick hold-to-talk release).
  const stopWhenReady = useRef(false);
  // Likewise a cancel (conversation switched, composer closed) before the microphone opened.
  const cancelWhenReady = useRef(false);
  const meter = useRef<{ ctx: AudioContext; analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> } | null>(null);
  const download = useModelDownload(modelId);
  const callbacks = useRef({ onText, onError });
  callbacks.current = { onText, onError };
  const repo = dictationModel(modelId).repo;

  const start = useCallback(async () => {
    if (recorder.current) return;
    stopWhenReady.current = false;
    cancelWhenReady.current = false;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      callbacks.current.onError(friendlyError(err));
      return;
    }
    if (cancelWhenReady.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    // Load (or download) the model while the user talks.
    const ready = dictationEngine.load(repo);
    const rec = new MediaRecorder(stream);
    const chunks: Blob[] = [];
    discard.current = false;
    // Level meter for the waveform; it only reads the stream the recorder already has.
    const ctx = new AudioContext();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    ctx.createMediaStreamSource(stream).connect(analyser);
    meter.current = { ctx, analyser, buf: new Float32Array(analyser.fftSize) };
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      void meter.current?.ctx.close();
      meter.current = null;
      recorder.current = null;
      if (discard.current) {
        setState('idle');
        return;
      }
      setState('transcribing');
      try {
        const samples = await toSamples(new Blob(chunks, { type: rec.mimeType }));
        if (!isSilent(samples)) {
          await ready;
          const text = cleanTranscript(await dictationEngine.transcribe(repo, samples));
          if (text) callbacks.current.onText(text);
        }
      } catch (err) {
        callbacks.current.onError(friendlyError(err));
      }
      setState('idle');
    };
    recorder.current = rec;
    rec.start();
    setStartedAt(Date.now());
    setState('recording');
    if (stopWhenReady.current) rec.stop();
  }, [repo]);

  const stop = useCallback(() => {
    if (recorder.current) recorder.current.stop();
    else stopWhenReady.current = true;
  }, []);
  const cancel = useCallback(() => {
    discard.current = true;
    if (recorder.current) recorder.current.stop();
    else cancelWhenReady.current = true;
  }, []);

  /** Loudness right now, 0–1: −55 dB (room noise) to −10 dB (loud speech), so quiet and loud words still differ. */
  const level = useCallback((): number => {
    const m = meter.current;
    if (!m) return 0;
    m.analyser.getFloatTimeDomainData(m.buf);
    let sum = 0;
    for (let i = 0; i < m.buf.length; i++) sum += m.buf[i] * m.buf[i];
    const db = 10 * Math.log10(sum / m.buf.length + 1e-12);
    return Math.min(1, Math.max(0, (db + 55) / 45));
  }, []);

  // Never leave the microphone on when the composer goes away.
  useEffect(() => cancel, [cancel]);

  return { state, startedAt, download, start, stop, cancel, level };
}
