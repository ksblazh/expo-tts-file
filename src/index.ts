import { SpeechSegment, SynthesizeOptions, SynthesisResult, Voice } from './ExpoTtsFile.types';
import ExpoTtsFile from './ExpoTtsFileModule';

export * from './ExpoTtsFile.types';

/**
 * Synthesize `text` to an on-device audio file (offline, no network).
 *
 * The file is written to the app cache directory; the container format is
 * platform-native PCM (CAF on iOS, WAV on Android) and plays back with any
 * standard audio player (e.g. `expo-audio`).
 */
export function synthesizeToFile(
  text: string,
  options: SynthesizeOptions
): Promise<SynthesisResult> {
  return ExpoTtsFile.synthesizeToFile(text, options);
}

/**
 * iOS only: synthesize a MIXED utterance to a file — each segment is either plain text
 * or pronounced per its own `ipa` (Apple honors the attribute per range). The
 * file-bound sibling of {@link speakMixed}, for offline/background playback of
 * sentences whose individual words need steering (e.g. Russian ударение).
 *
 * The attribute is honored on this path too, but — as on the live one — only over
 * LATIN text: pass a transliterated carrier for the segments you transcribe and leave
 * the rest plain. No-op promise rejection on Android (combining marks work there).
 */
export function synthesizeMixedToFile(
  segments: SpeechSegment[],
  options: SynthesizeOptions
): Promise<SynthesisResult> {
  return ExpoTtsFile.synthesizeMixedToFile(segments, options);
}

/** List installed TTS voices, optionally filtered by a BCP-47 language prefix (e.g. "en", "ru-RU"). */
export function getVoices(language?: string): Promise<Voice[]> {
  return ExpoTtsFile.getVoices(language);
}

/**
 * iOS only: LIVE speech (not to a file) with the IPA attribute from `options.ipa` —
 * for interactive playback, where waiting on a file write buys nothing. No-op promise
 * rejection on Android (method not implemented there).
 */
export function speakIpa(text: string, options: SynthesizeOptions): Promise<boolean> {
  return ExpoTtsFile.speakIpa(text, options);
}

/**
 * iOS 16+ only: LIVE speech from an SSML document — a SEPARATE parser from the IPA
 * attribute; `<phoneme alphabet="ipa" ph="...">` may work where the attribute does
 * not. Resolves false when SSML is unsupported or unparseable.
 */
export function speakSsml(ssml: string, options: SynthesizeOptions): Promise<boolean> {
  return ExpoTtsFile.speakSsml(ssml, options);
}

/**
 * iOS only: LIVE speech from segments — Apple honors the IPA attribute per WORD
 * range, so marked words ride as Latin-carrier text with their own `ipa` while the
 * rest of the sentence stays plain and reads naturally.
 */
export function speakMixed(segments: SpeechSegment[], options: SynthesizeOptions): Promise<boolean> {
  return ExpoTtsFile.speakMixed(segments, options);
}

/** iOS only: stop the live speakIpa/speakSsml path (a pending promise resolves false). */
export function stopLiveSpeech(): Promise<void> {
  return ExpoTtsFile.stopLiveSpeech();
}

export default ExpoTtsFile;
