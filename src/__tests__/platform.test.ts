import ExpoTtsFile from '../ExpoTtsFileModule';
import {
  speakIpa,
  speakMixed,
  speakSsml,
  stopLiveSpeech,
  synthesizeMixedToFile,
  synthesizeToFile,
} from '../index';

// The Android Kotlin module and the web stub implement only the cross-platform pair,
// so the iOS-only names are genuinely absent from the native object — this mock is
// what a device sees, not a contrivance.
jest.mock('../ExpoTtsFileModule', () => ({
  __esModule: true,
  default: {
    synthesizeToFile: jest.fn(),
    getVoices: jest.fn(),
  },
}));

const native = jest.mocked(ExpoTtsFile) as unknown as { synthesizeToFile: jest.Mock };
const EN = { language: 'en-US' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('iOS-only functions on a platform that lacks them', () => {
  it.each([
    ['synthesizeMixedToFile', () => synthesizeMixedToFile([{ text: 'hi' }], EN)],
    ['speakIpa', () => speakIpa('hi', EN)],
    ['speakSsml', () => speakSsml('<speak>hi</speak>', EN)],
    ['speakMixed', () => speakMixed([{ text: 'hi' }], EN)],
    ['stopLiveSpeech', () => stopLiveSpeech()],
  ])(
    '%s rejects naming itself and the platform, not "undefined is not a function"',
    async (name, call) => {
      // Was: the call reached an undefined property and died as a bare TypeError.
      await expect(call()).rejects.toThrow(
        new RegExp(`expo-tts-file: ${name}\\(\\) is not implemented on \\w+ — it is iOS-only`)
      );
    }
  );

  it('leaves the cross-platform path alone', async () => {
    const result = { uri: 'file:///cache/tts.wav', durationMs: 700 };
    native.synthesizeToFile.mockResolvedValue(result);

    await expect(synthesizeToFile('hello', EN)).resolves.toBe(result);
  });
});
