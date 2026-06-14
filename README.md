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

## License

MIT © Kseniia Blazhkovskaia
