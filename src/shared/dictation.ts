/**
 * Voice dictation runs OpenAI's Whisper locally (transformers.js + ONNX Runtime
 * Web in a renderer worker). The weights come from Hugging Face the first time
 * they're used and are kept in %APPDATA%\Nest\models; audio never leaves the
 * computer.
 */

export interface DictationModel {
  id: string;
  label: string;
  hint: string;
  /** Hugging Face repo with transformers.js-ready ONNX weights. */
  repo: string;
  /** The two weight files the q8 pipeline loads; they make up nearly all of the download. */
  weights: string[];
  /** Approximate download size, for display and progress. */
  bytes: number;
}

export const DICTATION_MODELS: DictationModel[] = [
  {
    id: 'whisper-base.en',
    label: 'Whisper Base',
    hint: 'Fast. Good for short English messages.',
    repo: 'onnx-community/whisper-base.en',
    weights: ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'],
    bytes: 77_000_000,
  },
  {
    id: 'whisper-small.en',
    label: 'Whisper Small',
    hint: 'More accurate English, a little slower.',
    repo: 'onnx-community/whisper-small.en',
    weights: ['onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx'],
    bytes: 249_000_000,
  },
];

export const DEFAULT_DICTATION_MODEL = DICTATION_MODELS[0].id;

export function dictationModel(id: string | null | undefined): DictationModel {
  return DICTATION_MODELS.find((m) => m.id === id) ?? DICTATION_MODELS[0];
}

/** Scheme the worker loads weights from; main serves it from disk, downloading on first use. */
export const MODEL_SCHEME = 'nest-models';
export const MODEL_BASE_URL = `${MODEL_SCHEME}://hf/`;

export interface DictationModelStatus {
  id: string;
  /** Both weight files are on disk. */
  downloaded: boolean;
  /** Bytes on disk for this model. */
  bytesOnDisk: number;
}

/** Whisper writes these for silence or noise; they're never what the user said. */
const NON_SPEECH = /\[[^\]]*\]|\((?:[a-z ]*(?:music|silence|static|inaudible|sighs|coughs|laughs|breathing|noise)[a-z ]*)\)/gi;

export function cleanTranscript(text: string): string {
  return text.replace(NON_SPEECH, ' ').replace(/\s+/g, ' ').trim();
}

/** Join dictated text onto what's already in the box, spaced the way a person would type it. */
export function insertDictation(value: string, selStart: number, selEnd: number, spoken: string): { value: string; caret: number } {
  const before = value.slice(0, selStart);
  const after = value.slice(selEnd);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^[\s.,!?;:]/.test(after) ? ' ' : '';
  const inserted = `${lead}${spoken}${trail}`;
  return { value: before + inserted + after, caret: before.length + lead.length + spoken.length };
}
