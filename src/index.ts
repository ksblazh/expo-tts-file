import { SynthesizeOptions, SynthesisResult, Voice } from './ExpoTtsFile.types';
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

/** List installed TTS voices, optionally filtered by a BCP-47 language prefix (e.g. "en", "ru-RU"). */
export function getVoices(language?: string): Promise<Voice[]> {
  return ExpoTtsFile.getVoices(language);
}

export default ExpoTtsFile;
