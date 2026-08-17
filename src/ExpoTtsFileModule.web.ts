import { registerWebModule, NativeModule } from 'expo';

import { SpeechSegment, SynthesizeOptions, SynthesisResult, Voice } from './ExpoTtsFile.types';

// Web has the Web Speech API for live speech, but no supported path to capture
// synthesis to a file. The module is intentionally a no-op stub on web.
class ExpoTtsFileModule extends NativeModule<Record<string, never>> {
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
}

export default registerWebModule(ExpoTtsFileModule, 'ExpoTtsFileModule');
