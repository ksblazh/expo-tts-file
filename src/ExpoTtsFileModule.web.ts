import { registerWebModule, NativeModule } from 'expo';

import { SpeechSegment, SynthesizeOptions, SynthesisResult, Voice } from './ExpoTtsFile.types';
import type { ExpoTtsFileEvents } from './ExpoTtsFileModule';

// Web has the Web Speech API for live speech, but no supported path to capture
// synthesis to a file. The module is intentionally a no-op stub on web.
// The events map is declared so addListener type-checks; nothing ever fires.
class ExpoTtsFileModule extends NativeModule<ExpoTtsFileEvents> {
  async synthesizeToFile(_text: string, _options: SynthesizeOptions): Promise<SynthesisResult> {
    throw new Error('expo-tts-file: synthesizeToFile is not supported on web.');
  }

  async synthesizeMixedToFile(
    _segments: SpeechSegment[],
    _options: SynthesizeOptions
  ): Promise<SynthesisResult> {
    throw new Error('expo-tts-file: synthesizeMixedToFile is not supported on web.');
  }

  async getVoices(_language?: string): Promise<Voice[]> {
    return [];
  }

  // The cache is empty on web because nothing ever writes to it — `synthesizeToFile`
  // throws here, so no caller can hold a URI to delete. These report that truthfully
  // instead of throwing, which keeps cross-platform cleanup code free of a Platform
  // check.
  async deleteFile(_uri: string): Promise<void> {}

  async clearCache(): Promise<number> {
    return 0;
  }

  async getCacheSize(): Promise<number> {
    return 0;
  }

  async cancelAll(): Promise<number> {
    return 0;
  }
}

export default registerWebModule(ExpoTtsFileModule, 'ExpoTtsFileModule');
