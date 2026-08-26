import WebModule from '../ExpoTtsFileModule.web';

// The real registerWebModule wires expo's event-emitter plumbing, which the stub does
// not use — an instance of the class is all these tests need.
jest.mock('expo', () => ({
  __esModule: true,
  NativeModule: class {},
  registerWebModule: (ModuleClass: new () => unknown) => new ModuleClass(),
}));

describe('web stub', () => {
  it('synthesizeToFile rejects: no supported file-synthesis path on web', async () => {
    await expect(WebModule.synthesizeToFile('hi', { language: 'en' })).rejects.toThrow(
      /not supported on web/
    );
  });

  it('synthesizeMixedToFile rejects the same way', async () => {
    await expect(
      WebModule.synthesizeMixedToFile([{ text: 'hi' }], { language: 'en' })
    ).rejects.toThrow(/not supported on web/);
  });

  it('getVoices resolves to an empty list instead of throwing', async () => {
    await expect(WebModule.getVoices()).resolves.toEqual([]);
  });

  it('the cache functions report an empty cache rather than throwing', async () => {
    await expect(WebModule.getCacheSize()).resolves.toBe(0);
    await expect(WebModule.clearCache()).resolves.toBe(0);
    await expect(WebModule.deleteFile('file:///whatever')).resolves.toBeUndefined();
  });
});
