import ExpoTtsFile from '../ExpoTtsFileModule';
import {
  getVoices,
  speakIpa,
  speakMixed,
  speakSsml,
  stopLiveSpeech,
  synthesizeMixedToFile,
  synthesizeToFile,
} from '../index';

jest.mock('../ExpoTtsFileModule', () => ({
  __esModule: true,
  default: {
    synthesizeToFile: jest.fn(),
    synthesizeMixedToFile: jest.fn(),
    getVoices: jest.fn(),
    speakIpa: jest.fn(),
    speakSsml: jest.fn(),
    speakMixed: jest.fn(),
    stopLiveSpeech: jest.fn(),
  },
}));

const native = jest.mocked(ExpoTtsFile);
const EN = { language: 'en-US' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('delegation to the native module', () => {
  it('synthesizeToFile passes args through and resolves the native result', async () => {
    const result = { uri: 'file:///cache/tts.caf', durationMs: 1234 };
    native.synthesizeToFile.mockResolvedValue(result);

    await expect(synthesizeToFile('hello', { language: 'en-US', rate: 1.2 })).resolves.toBe(result);
    expect(native.synthesizeToFile).toHaveBeenCalledWith('hello', { language: 'en-US', rate: 1.2 });
  });

  it('synthesizeMixedToFile passes segments through', async () => {
    const result = { uri: 'file:///cache/tts.caf', durationMs: 42 };
    native.synthesizeMixedToFile.mockResolvedValue(result);
    const segments = [{ text: 'privet, ' }, { text: 'zamok', ipa: 'zɐˈmok' }];

    await expect(synthesizeMixedToFile(segments, EN)).resolves.toBe(result);
    expect(native.synthesizeMixedToFile).toHaveBeenCalledWith(segments, EN);
  });

  it('getVoices forwards the optional language filter', async () => {
    native.getVoices.mockResolvedValue([]);

    await expect(getVoices()).resolves.toEqual([]);
    expect(native.getVoices).toHaveBeenLastCalledWith(undefined);

    await getVoices('ru');
    expect(native.getVoices).toHaveBeenLastCalledWith('ru');
  });

  it('speakSsml resolves the native verdict as-is', async () => {
    native.speakSsml.mockResolvedValue(false);
    await expect(speakSsml('<speak>hi</speak>', EN)).resolves.toBe(false);
  });

  it('stopLiveSpeech delegates', async () => {
    native.stopLiveSpeech.mockResolvedValue(undefined);
    await stopLiveSpeech();
    expect(native.stopLiveSpeech).toHaveBeenCalledTimes(1);
  });

  it('synthesizeToFile forwards timeoutMs rather than consuming it', async () => {
    native.synthesizeToFile.mockResolvedValue({ uri: 'file:///cache/tts.caf', durationMs: 1 });

    await synthesizeToFile('hello', { language: 'en-US', timeoutMs: 5000 });
    expect(native.synthesizeToFile).toHaveBeenCalledWith('hello', {
      language: 'en-US',
      timeoutMs: 5000,
    });
  });

  it('native rejections propagate to the caller', async () => {
    native.synthesizeToFile.mockRejectedValue(new Error('synthesis failed'));
    await expect(synthesizeToFile('hello', EN)).rejects.toThrow('synthesis failed');
  });
});

describe('argument validation (rejects before crossing the bridge)', () => {
  it.each([
    ['empty text', () => synthesizeToFile('', EN), /non-empty `text`/],
    ['whitespace-only text', () => synthesizeToFile('   ', EN), /non-empty `text`/],
    ['non-string text', () => synthesizeToFile(123 as never, EN), /non-empty `text`/],
    ['missing options', () => synthesizeToFile('hi', undefined as never), /options object/],
    ['null options', () => synthesizeToFile('hi', null as never), /options object/],
    ['missing language', () => synthesizeToFile('hi', {} as never), /options\.language/],
    ['empty language', () => synthesizeToFile('hi', { language: '' }), /options\.language/],
    ['zero rate', () => synthesizeToFile('hi', { language: 'en', rate: 0 }), /options\.rate/],
    ['NaN rate', () => synthesizeToFile('hi', { language: 'en', rate: NaN }), /options\.rate/],
    [
      'negative pitch',
      () => synthesizeToFile('hi', { language: 'en', pitch: -1 }),
      /options\.pitch/,
    ],
    [
      'empty voice id',
      () => synthesizeToFile('hi', { language: 'en', voice: '' }),
      /options\.voice/,
    ],
    ['empty ipa', () => synthesizeToFile('hi', { language: 'en', ipa: '' }), /options\.ipa/],
    [
      'zero timeoutMs',
      () => synthesizeToFile('hi', { language: 'en', timeoutMs: 0 }),
      /options\.timeoutMs/,
    ],
    [
      'negative timeoutMs',
      () => synthesizeToFile('hi', { language: 'en', timeoutMs: -1 }),
      /options\.timeoutMs/,
    ],
  ])('synthesizeToFile rejects on %s', async (_case, call, message) => {
    await expect(call()).rejects.toThrow(TypeError);
    await expect(call()).rejects.toThrow(message);
    expect(native.synthesizeToFile).not.toHaveBeenCalled();
  });

  it.each([
    ['an empty segments array', () => synthesizeMixedToFile([], EN), /non-empty `segments`/],
    [
      'a non-array segments value',
      () => synthesizeMixedToFile(null as never, EN),
      /non-empty `segments`/,
    ],
    [
      'a segment with empty text',
      () => synthesizeMixedToFile([{ text: '' }], EN),
      /segments\[0]\.text/,
    ],
    [
      'a segment with an empty ipa',
      () => synthesizeMixedToFile([{ text: 'ok' }, { text: 'zamok', ipa: '' }], EN),
      /segments\[1]\.ipa/,
    ],
  ])('synthesizeMixedToFile rejects on %s', async (_case, call, message) => {
    await expect(call()).rejects.toThrow(TypeError);
    await expect(call()).rejects.toThrow(message);
    expect(native.synthesizeMixedToFile).not.toHaveBeenCalled();
  });

  it('speakIpa and speakSsml validate like the file path', async () => {
    await expect(speakIpa(' ', EN)).rejects.toThrow(/speakIpa\(\) needs a non-empty `text`/);
    await expect(speakSsml('', EN)).rejects.toThrow(/speakSsml\(\) needs a non-empty `ssml`/);
    expect(native.speakIpa).not.toHaveBeenCalled();
    expect(native.speakSsml).not.toHaveBeenCalled();
  });

  it('speakMixed validates segments', async () => {
    await expect(speakMixed([], EN)).rejects.toThrow(TypeError);
    expect(native.speakMixed).not.toHaveBeenCalled();
  });

  it('getVoices rejects an empty language filter (omit it instead)', async () => {
    await expect(getVoices('')).rejects.toThrow(/getVoices\(\) needs a non-empty `language`/);
    expect(native.getVoices).not.toHaveBeenCalled();
  });
});
