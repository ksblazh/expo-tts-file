import { NativeModule, requireNativeModule } from 'expo';

import { SynthesizeOptions, SynthesisResult, Voice } from './ExpoTtsFile.types';

declare class ExpoTtsFileModule extends NativeModule<{}> {
  /** Synthesize `text` to an audio file on disk and resolve with its URI + duration. */
  synthesizeToFile(text: string, options: SynthesizeOptions): Promise<SynthesisResult>;
  /** List installed TTS voices, optionally filtered by a BCP-47 language prefix (e.g. "en"). */
  getVoices(language?: string): Promise<Voice[]>;
}

export default requireNativeModule<ExpoTtsFileModule>('ExpoTtsFile');
