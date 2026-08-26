import { NativeModule, requireNativeModule } from 'expo';

import { SpeechSegment, SynthesizeOptions, SynthesisResult, Voice } from './ExpoTtsFile.types';

declare class ExpoTtsFileModule extends NativeModule<Record<string, never>> {
  /** Synthesize `text` to an audio file on disk and resolve with its URI + duration. */
  synthesizeToFile(text: string, options: SynthesizeOptions): Promise<SynthesisResult>;
  /** iOS only: synthesize a mixed (per-segment IPA) utterance to a file. */
  synthesizeMixedToFile(
    segments: SpeechSegment[],
    options: SynthesizeOptions
  ): Promise<SynthesisResult>;
  /** List installed TTS voices, optionally filtered by a BCP-47 language prefix (e.g. "en"). */
  getVoices(language?: string): Promise<Voice[]>;
  /** iOS only: live speech with the IPA attribute. */
  speakIpa(text: string, options: SynthesizeOptions): Promise<boolean>;
  /** iOS 16+ only: live speech from an SSML document. */
  speakSsml(ssml: string, options: SynthesizeOptions): Promise<boolean>;
  /** iOS only: live speech from segments (per-word IPA attributes). */
  speakMixed(segments: SpeechSegment[], options: SynthesizeOptions): Promise<boolean>;
  /** iOS only: stop the live speech path. */
  stopLiveSpeech(): Promise<void>;
  /** Delete one file this module produced; rejects for anything outside its cache. */
  deleteFile(uri: string): Promise<void>;
  /** Delete every file this module produced; resolves with how many went. */
  clearCache(): Promise<number>;
  /** Total size in bytes of the files this module produced. */
  getCacheSize(): Promise<number>;
}

export default requireNativeModule<ExpoTtsFileModule>('ExpoTtsFile');
