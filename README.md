# expo-tts-file

[![CI](https://github.com/ksblazh/expo-tts-file/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/ksblazh/expo-tts-file/actions/workflows/ci.yml)
[![Android build](https://github.com/ksblazh/expo-tts-file/actions/workflows/android.yml/badge.svg?branch=main&event=push)](https://github.com/ksblazh/expo-tts-file/actions/workflows/android.yml)
[![iOS build](https://github.com/ksblazh/expo-tts-file/actions/workflows/ios.yml/badge.svg?branch=main&event=push)](https://github.com/ksblazh/expo-tts-file/actions/workflows/ios.yml)
[![npm](https://img.shields.io/npm/v/expo-tts-file.svg)](https://www.npmjs.com/package/expo-tts-file)

On-device **text-to-speech synthesized to an audio file** for React Native / Expo — offline, no network, no API keys. Turn a string into a playable audio file using the OS's built-in TTS, then play it however you like (e.g. background playback with [`expo-audio`](https://docs.expo.dev/versions/latest/sdk/audio/)).

Built with the [Expo Modules API](https://docs.expo.dev/modules/) (Swift + Kotlin).

> Why: `expo-speech` speaks live but can't produce a file, and live speech can't play while the app is backgrounded / the screen is locked. Synthesizing to a file lets you play vocabulary, articles, or any text as a real audio stream — including in the background, like a podcast.

## Platforms

| Platform | Engine | Output container |
| --- | --- | --- |
| iOS 16.4+ | `AVSpeechSynthesizer.write` | CAF (PCM) |
| Android API 24+ (7.0) | `TextToSpeech.synthesizeToFile` | WAV (PCM) |
| Web | — | not supported (`synthesizeToFile` throws; `getVoices` returns `[]`) |

The container is platform-native PCM; both play back with any standard audio player.

The platform floors are the SDK's own (`expo-modules-core`: iOS 16.4; Expo's Gradle
plugin: `minSdk` 24) — this module adds no requirement of its own beyond them, and SDK 56
and 57 declare the same two numbers. Verified on physical devices — an iPhone on iOS 26
and a Pixel 9a; the podspec also declares tvOS 16.4, but tvOS has **not** been tested.

Not every function exists on every platform:

| | iOS | Android | Web |
| --- | --- | --- | --- |
| `synthesizeToFile`, `getVoices` | ✅ | ✅ | `getVoices` → `[]`, synthesis throws |
| `deleteFile`, `clearCache`, `getCacheSize` | ✅ | ✅ | report an empty cache (nothing writes one) |
| `synthesizeMixedToFile`, `speakIpa`, `speakMixed`, `speakSsml`, `stopLiveSpeech` | ✅ | ❌ not implemented | ❌ not implemented |

The IPA/live-speech functions are an iOS-only feature (they exist to work around Apple's
handling of pronunciation); calling one elsewhere rejects with an error naming the
function and the platform. On Android, combining stress marks such as `а́` are read
natively in plain text, so no equivalent is needed there.

## Installation

```sh
npx expo install expo-tts-file
```

Developed and tested against **Expo SDK 57** (React Native 0.86), New Architecture. **SDK 56** (React Native 0.85) is supported too and is what the released 0.2.x line was built against — see [Troubleshooting](#ios-build-fails-with-cstdlib--rctbridge--header-not-found-errors) for the one thing that differs there.

This is a native module — it requires a [development build](https://docs.expo.dev/develop/development-builds/introduction/) (it does **not** run in Expo Go). No extra permissions are required for synthesis itself; if you intend to play audio in the background, configure background audio in your app (iOS `UIBackgroundModes: ["audio"]`, Android media playback service) separately.

## Usage

```ts
import { synthesizeToFile, getVoices } from 'expo-tts-file';

// Synthesize to a file in the app cache directory.
const { uri, durationMs } = await synthesizeToFile('Hello from on-device TTS', {
  language: 'en-US',
  rate: 1.0,   // 1.0 = normal, relative to the platform default
  pitch: 1.0,  // optional
});

// Pick a specific installed voice.
const voices = await getVoices('en');           // filter by BCP-47 language prefix
await synthesizeToFile('Hello', { language: 'en-US', voice: voices[0]?.identifier });
```

### API

```ts
type SynthesizeOptions = {
  language: string;   // BCP-47, e.g. "en-US", "ru-RU"
  rate?: number;      // 1.0 = normal (see below)
  pitch?: number;     // 1.0 = normal (see below)
  voice?: string;     // identifier from getVoices()
  ipa?: string;       // iOS only — see "Steering pronunciation" below
  timeoutMs?: number; // watchdog for a stuck engine, default 60000 (see below)
};

synthesizeToFile(text: string, options: SynthesizeOptions):
  Promise<{ uri: string; durationMs: number }>

getVoices(language?: string): Promise<Array<{
  identifier: string;
  name: string;
  language: string;
  quality: 'default' | 'enhanced' | 'premium';
}>>

deleteFile(uri: string): Promise<void>   // one file this module produced
clearCache(): Promise<number>            // resolves with how many files went
getCacheSize(): Promise<number>          // bytes

// iOS only (see the platform table):
synthesizeMixedToFile(segments: Array<{ text: string; ipa?: string }>, options: SynthesizeOptions):
  Promise<{ uri: string; durationMs: number }>
speakIpa(text: string, options: SynthesizeOptions): Promise<boolean>
speakMixed(segments: Array<{ text: string; ipa?: string }>, options: SynthesizeOptions): Promise<boolean>
speakSsml(ssml: string, options: SynthesizeOptions): Promise<boolean>   // iOS 16+
stopLiveSpeech(): Promise<void>
```

`language` picks the platform default voice for that tag; a bare prefix such as `"ru"`
resolves to an installed `ru-*` voice. The `getVoices` filter matches that prefix
case-insensitively, so `"RU"` and `"en-us"` work as well as `"ru"` and `"en-US"`.

`rate` and `pitch` are relative to the platform default (`1.0`). iOS clamps them to the
synthesizer's own range (`AVSpeechUtteranceMinimum`/`MaximumSpeechRate`, pitch 0.5–2.0);
Android hands the value to the TTS engine as given, so what an extreme value does there
is up to the engine.

`timeoutMs` is a watchdog, not a deadline. If the engine has reported nothing after that
long the promise rejects with `ERR_TTS_TIMEOUT` instead of staying pending for the life
of the app, and on Android the requests queued behind it start moving again — otherwise
that state needs an app restart to clear. It defaults to `60000`. Raise it when you
synthesize a lot of text in one call rather than lowering it to fail fast: a timeout that
fires while the engine is still working turns a request that would have succeeded into an
error. The live `speak*` functions ignore it, since speech has no expected duration to
measure against; `stopLiveSpeech()` is the way out of those.

The live `speak*` functions resolve `true` when the utterance finished and `false` when
it was cancelled — by `stopLiveSpeech` or by a newer utterance.

Files are written to `<app cache>/expo-tts-file/tts-<uuid>.{caf,wav}` — on iOS the app's
`Library/Caches`, on Android `context.cacheDir`. Nothing is deleted for you, so keep your
own index keyed by `(text, language, rate)` and remove what you no longer need with
`deleteFile`; `clearCache` empties the directory and `getCacheSize` reports what it holds.
The OS may evict the whole directory under storage pressure, so treat a stored URI as
disposable and re-synthesize if it is gone — which is also why deleting a file that has
already vanished counts as success rather than an error.

`deleteFile` accepts only files inside that directory and rejects anything else with
`ERR_TTS_FOREIGN_FILE`. That is a limit on blast radius, not a permission boundary — the
module runs with your app's own rights. Deleting arbitrary files is what `expo-file-system`
is for; keeping this one confined means a stale URI costs you a clip you can synthesize
again, and nothing else. A file you have moved out of the cache to keep it is your app's
file from then on, and `deleteFile` will refuse it.

Invalid arguments (empty `text`, missing `language`, non-positive `rate`/`pitch`/`timeoutMs`, …) reject
with a `TypeError` naming the argument — before anything crosses into native code.

### Steering pronunciation (iOS)

Some languages need more than the text: Russian word stress (ударение), for one, is
unpredictable and the bundled voices ignore the combining acute (U+0301) in plain text.
Apple's public lever is the IPA attribute on an attributed utterance, and this module
exposes it on both the file and the live path:

```ts
// Whole utterance pronounced per one transcription.
synthesizeToFile('zamok', { language: 'ru-RU', ipa: 'zaˈmok' })

// A sentence where only some words need steering: each segment is plain, or its own IPA.
synthesizeMixedToFile(
  [{ text: 'On povesil ' }, { text: 'zamok', ipa: 'zaˈmok' }, { text: ' na dver.' }],
  { language: 'ru-RU' },
)

// Same two shapes, spoken live instead of written to a file (interactive taps).
speakIpa(text, options)         // → Promise<boolean>: false = cancelled by a newer utterance
speakMixed(segments, options)
speakSsml(ssml, options)        // iOS 16+, a separate parser: <phoneme alphabet="ipa" ph="…">
stopLiveSpeech()
```

**The attribute is honored only over LATIN text.** Over a Cyrillic (or other non-Latin)
range the voice silently falls back to its own lexicon and your transcription is
ignored — so pass a **transliterated carrier** and let the IPA carry the pronunciation.
A useful side effect: if a voice ignores the attribute entirely (some Siri voices do),
the carrier still reads as a rough approximation rather than silence. Verify by ear with
an A/B: the same word, two transcriptions — the mechanism is alive iff they differ.

On Android the `ipa` option is ignored (combining stress marks are read natively there)
and the live functions are not implemented — see the platform table above.

## Example app

```sh
cd example
npm install
npx expo run:android   # or: npx expo run:ios
```

## Troubleshooting

### iOS build fails with `cstdlib` / `RCTBridge` / header-not-found errors

**This applies to Expo SDK 56 only. It is fixed in SDK 57** — if you are on 57 and see these errors, the cause is something else.

On SDK 56 the default precompiled XCFrameworks fail because a nested `xcodebuild` drops `HEADER_SEARCH_PATHS`. It is not specific to this module — `expo-tts-file`'s own Swift compiles fine. Symptoms: `'cstdlib' file not found`, `'ExpoFileSystem/…​.h' file not found`, or `duplicate interface definition for class 'RCTBridge'`.

Workaround on 56 — build React Native from source. In your app config via [`expo-build-properties`](https://docs.expo.dev/versions/latest/sdk/build-properties/):

```json
["expo-build-properties", { "ios": { "buildReactNativeFromSource": true } }]
```

and before building (clean prebuild, first build is slow — budget 40–60 GB of free disk):

```sh
export RCT_USE_PREBUILT_RNCORE=0 RCT_USE_RN_DEP=0 EXPO_USE_PRECOMPILED_MODULES=0
npx expo prebuild -p ios --clean
npx expo run:ios
```

Upgrading to SDK 57 removes all of the above: this repository's own iOS CI build went from ~28 minutes building React Native from source to ~5 minutes on the stock precompiled frameworks, with no `expo-build-properties` in the example app at all.

## Prior art

On-device TTS→file in React Native isn't new — see [`react-native-tts-export`](https://github.com/NoodleOfDeath/react-native-tts-export) (a fork of `react-native-tts`), which produces the same per-platform formats. `expo-tts-file` differs by being a **maintained, New-Architecture, Expo Modules API** package for current Expo / React Native; the older modules are unmaintained and predate the New Architecture default. Background audio itself was never the gap — `expo-av`/`expo-audio` have supported background playback for years; the gap was a clean, current TTS→file module to feed them.

## License

MIT © Kseniia Blazhkovskaia
