# expo-tts-file

On-device **text-to-speech synthesized to an audio file** for React Native / Expo — offline, no network, no API keys. Turn a string into a playable audio file using the OS's built-in TTS, then play it however you like (e.g. background playback with [`expo-audio`](https://docs.expo.dev/versions/latest/sdk/audio/)).

Built with the [Expo Modules API](https://docs.expo.dev/modules/) (Swift + Kotlin).

> Why: `expo-speech` speaks live but can't produce a file, and live speech can't play while the app is backgrounded / the screen is locked. Synthesizing to a file lets you play vocabulary, articles, or any text as a real audio stream — including in the background, like a podcast.

## Platforms

| Platform | Engine | Output container |
| --- | --- | --- |
| iOS / tvOS (13+) | `AVSpeechSynthesizer.write` | CAF (PCM) |
| Android (API 21+) | `TextToSpeech.synthesizeToFile` | WAV (PCM) |
| Web | — | not supported (`synthesizeToFile` throws; `getVoices` returns `[]`) |

The container is platform-native PCM; both play back with any standard audio player.

## Installation

```sh
npx expo install expo-tts-file
```

This is a native module — it requires a [development build](https://docs.expo.dev/develop/development-builds/introduction/) (it does **not** run in Expo Go). No extra permissions are required for synthesis itself; if you intend to play audio in the background, configure background audio in your app (iOS `UIBackgroundModes: ["audio"]`, Android media playback service) separately.

## Usage

```ts
import { synthesizeToFile, getVoices } from 'expo-tts-file';

// Synthesize to a file in the app cache directory.
const { uri, durationMs } = await synthesizeToFile('Hello from on-device TTS', {
  language: 'en-US',
  rate: 1.0,   // 1.0 = normal; clamped per platform
  pitch: 1.0,  // optional
});

// Pick a specific installed voice.
const voices = await getVoices('en');           // filter by BCP-47 language prefix
await synthesizeToFile('Hello', { language: 'en-US', voice: voices[0]?.identifier });
```

### API

```ts
synthesizeToFile(text: string, options: {
  language: string;   // BCP-47, e.g. "en-US", "ru-RU"
  rate?: number;      // 1.0 = normal
  pitch?: number;     // 1.0 = normal
  voice?: string;     // identifier from getVoices()
}): Promise<{ uri: string; durationMs: number }>

getVoices(language?: string): Promise<Array<{
  identifier: string;
  name: string;
  language: string;
  quality: 'default' | 'enhanced' | 'premium';
}>>
```

Files are written to the app cache directory; manage your own caching/eviction keyed by `(text, language, rate)` if you re-synthesize the same phrases.

## Example app

```sh
cd example
npm install
npx expo run:android   # or: npx expo run:ios
```

## Troubleshooting

### iOS build fails with `cstdlib` / `RCTBridge` / header-not-found errors

This is a **known Expo SDK 56 issue** with its default precompiled XCFrameworks (a nested `xcodebuild` drops `HEADER_SEARCH_PATHS`), not something specific to this module — `expo-tts-file`'s own Swift compiles fine. Symptoms: `'cstdlib' file not found`, `'ExpoFileSystem/…​.h' file not found`, or `duplicate interface definition for class 'RCTBridge'`.

Workaround — build React Native from source. In your app config via [`expo-build-properties`](https://docs.expo.dev/versions/latest/sdk/build-properties/):

```json
["expo-build-properties", { "ios": { "buildReactNativeFromSource": true } }]
```

and before building (clean prebuild, first build is slow):

```sh
export RCT_USE_PREBUILT_RNCORE=0 RCT_USE_RN_DEP=0 EXPO_USE_PRECOMPILED_MODULES=0
npx expo prebuild -p ios --clean
npx expo run:ios
```

(Likely fixed in a future SDK patch; revisit when Expo resolves the precompiled-framework header bug.)

## Prior art

On-device TTS→file in React Native isn't new — see [`react-native-tts-export`](https://github.com/NoodleOfDeath/react-native-tts-export) (a fork of `react-native-tts`), which produces the same per-platform formats. `expo-tts-file` differs by being a **maintained, New-Architecture, Expo Modules API** package for current Expo / React Native; the older modules are unmaintained and predate the New Architecture default. Background audio itself was never the gap — `expo-av`/`expo-audio` have supported background playback for years; the gap was a clean, current TTS→file module to feed them.

## License

MIT © Kseniia Blazhkovskaia
