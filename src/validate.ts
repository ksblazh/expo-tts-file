// Runtime checks for the public API. The native layers surface bad input as opaque
// platform exceptions (or, worse, as a silently wrong synthesis); failing in JS keeps
// the error attributable, and identical on both platforms.
import { SpeechSegment, SynthesizeOptions } from './ExpoTtsFile.types';

export function requireNonEmptyString(value: string, api: string, name: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`expo-tts-file: ${api} needs a non-empty \`${name}\` string`);
  }
}

function requirePositiveFinite(value: number | undefined, api: string, name: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`expo-tts-file: ${api} needs \`${name}\` to be a positive finite number`);
  }
}

export function requireOptions(options: SynthesizeOptions, api: string): void {
  if (options === null || typeof options !== 'object') {
    throw new TypeError(`expo-tts-file: ${api} needs an options object with \`language\``);
  }
  requireNonEmptyString(options.language, api, 'options.language');
  requirePositiveFinite(options.rate, api, 'options.rate');
  requirePositiveFinite(options.pitch, api, 'options.pitch');
  if (options.voice !== undefined) {
    requireNonEmptyString(options.voice, api, 'options.voice');
  }
  if (options.ipa !== undefined) {
    requireNonEmptyString(options.ipa, api, 'options.ipa');
  }
}

export function requireSegments(segments: SpeechSegment[], api: string): void {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new TypeError(`expo-tts-file: ${api} needs a non-empty \`segments\` array`);
  }
  segments.forEach((segment, i) => {
    requireNonEmptyString(segment?.text, api, `segments[${i}].text`);
    if (segment.ipa !== undefined) {
      requireNonEmptyString(segment.ipa, api, `segments[${i}].ipa`);
    }
  });
}
