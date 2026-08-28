import { SpeechSegment, SynthesizeOptions, SynthesisResult, Voice } from './ExpoTtsFile.types';
import ExpoTtsFile from './ExpoTtsFileModule';
import { requireImplemented } from './platform';
import { requireNonEmptyString, requireOptions, requireSegments } from './validate';

export * from './ExpoTtsFile.types';

/**
 * Synthesize `text` to an on-device audio file (offline, no network).
 *
 * The file is written to the app cache directory; the container format is
 * platform-native PCM (CAF on iOS, WAV on Android) and plays back with any
 * standard audio player (e.g. `expo-audio`).
 */
export async function synthesizeToFile(
  text: string,
  options: SynthesizeOptions
): Promise<SynthesisResult> {
  requireNonEmptyString(text, 'synthesizeToFile()', 'text');
  requireOptions(options, 'synthesizeToFile()');
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
 * the rest plain. Rejects on Android and web, where it is not implemented (combining
 * marks are read natively on Android, so no equivalent is needed there).
 */
export async function synthesizeMixedToFile(
  segments: SpeechSegment[],
  options: SynthesizeOptions
): Promise<SynthesisResult> {
  requireImplemented(ExpoTtsFile.synthesizeMixedToFile, 'synthesizeMixedToFile()');
  requireSegments(segments, 'synthesizeMixedToFile()');
  requireOptions(options, 'synthesizeMixedToFile()');
  return ExpoTtsFile.synthesizeMixedToFile(segments, options);
}

/** List installed TTS voices, optionally filtered by a BCP-47 language prefix (e.g. "en", "ru-RU"). */
export async function getVoices(language?: string): Promise<Voice[]> {
  if (language !== undefined) {
    requireNonEmptyString(language, 'getVoices()', 'language');
  }
  return ExpoTtsFile.getVoices(language);
}

/**
 * Delete one file this module produced — pass the `uri` from {@link synthesizeToFile}.
 *
 * Only files in the module's own cache directory can be deleted; anything else rejects
 * with `ERR_TTS_FOREIGN_FILE`. That limit is not about permissions — the module runs with
 * the app's own rights — but about blast radius: deleting arbitrary files is what
 * `expo-file-system` is for, and confining this keeps a stale URI from costing more than
 * a clip you can synthesize again. A file the OS has already evicted counts as deleted.
 */
export async function deleteFile(uri: string): Promise<void> {
  requireNonEmptyString(uri, 'deleteFile()', 'uri');
  return ExpoTtsFile.deleteFile(uri);
}

/**
 * Delete every file this module has produced, resolving with how many actually went (a
 * file that resists deletion is not counted). Do not call it while a synthesis is in
 * flight — the file being written is one of the ones it removes.
 */
export async function clearCache(): Promise<number> {
  return ExpoTtsFile.clearCache();
}

/** Total size in bytes of the files this module has produced. */
export async function getCacheSize(): Promise<number> {
  return ExpoTtsFile.getCacheSize();
}

/**
 * Abandon every synthesis that is in flight or queued, resolving with how many were
 * dropped — so a screen being unmounted can tell whether it interrupted work or arrived
 * after it had finished.
 *
 * Each abandoned call rejects with `ERR_TTS_CANCELLED`; that is the outcome the caller
 * asked for, so treat it as such rather than as an error to report. Partial files left
 * behind are ordinary cache files — {@link clearCache} removes them.
 *
 * Covers the file paths only. The live `speak*` functions have {@link stopLiveSpeech},
 * which is iOS-only for the same reason the live path is.
 */
export async function cancelAll(): Promise<number> {
  return ExpoTtsFile.cancelAll();
}

/**
 * iOS only: LIVE speech (not to a file) with the IPA attribute from `options.ipa` —
 * for interactive playback, where waiting on a file write buys nothing. Rejects on
 * Android and web, where it is not implemented.
 */
export async function speakIpa(text: string, options: SynthesizeOptions): Promise<boolean> {
  requireImplemented(ExpoTtsFile.speakIpa, 'speakIpa()');
  requireNonEmptyString(text, 'speakIpa()', 'text');
  requireOptions(options, 'speakIpa()');
  return ExpoTtsFile.speakIpa(text, options);
}

/**
 * iOS 16+ only: LIVE speech from an SSML document — a SEPARATE parser from the IPA
 * attribute; `<phoneme alphabet="ipa" ph="...">` may work where the attribute does
 * not. Resolves false when SSML is unsupported or unparseable.
 */
export async function speakSsml(ssml: string, options: SynthesizeOptions): Promise<boolean> {
  requireImplemented(ExpoTtsFile.speakSsml, 'speakSsml()');
  requireNonEmptyString(ssml, 'speakSsml()', 'ssml');
  requireOptions(options, 'speakSsml()');
  return ExpoTtsFile.speakSsml(ssml, options);
}

/**
 * iOS only: LIVE speech from segments — Apple honors the IPA attribute per WORD
 * range, so marked words ride as Latin-carrier text with their own `ipa` while the
 * rest of the sentence stays plain and reads naturally.
 */
export async function speakMixed(
  segments: SpeechSegment[],
  options: SynthesizeOptions
): Promise<boolean> {
  requireImplemented(ExpoTtsFile.speakMixed, 'speakMixed()');
  requireSegments(segments, 'speakMixed()');
  requireOptions(options, 'speakMixed()');
  return ExpoTtsFile.speakMixed(segments, options);
}

/**
 * iOS only: stop the live speakIpa/speakSsml path (a pending promise resolves false).
 * Rejects on Android and web, where the live path is not implemented.
 */
export async function stopLiveSpeech(): Promise<void> {
  requireImplemented(ExpoTtsFile.stopLiveSpeech, 'stopLiveSpeech()');
  return ExpoTtsFile.stopLiveSpeech();
}

export default ExpoTtsFile;
