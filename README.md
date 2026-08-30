# expo-tts-file

[![CI](https://github.com/ksblazh/expo-tts-file/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/ksblazh/expo-tts-file/actions/workflows/ci.yml)
[![Android build](https://github.com/ksblazh/expo-tts-file/actions/workflows/android.yml/badge.svg?branch=main&event=push)](https://github.com/ksblazh/expo-tts-file/actions/workflows/android.yml)
[![iOS build](https://github.com/ksblazh/expo-tts-file/actions/workflows/ios.yml/badge.svg?branch=main&event=push)](https://github.com/ksblazh/expo-tts-file/actions/workflows/ios.yml)
[![npm](https://img.shields.io/npm/v/expo-tts-file.svg)](https://www.npmjs.com/package/expo-tts-file)

On-device **text-to-speech synthesized to an audio file** for React Native / Expo — offline, no network, no API keys. Turn a string into a playable audio file using the OS's built-in TTS, then play it however you like (e.g. background playback with [`expo-audio`](https://docs.expo.dev/versions/latest/sdk/audio/)).

Built with the [Expo Modules API](https://docs.expo.dev/modules/) (Swift + Kotlin).

<!-- Absolute URL on purpose: docs/ is not in the published tarball, so a relative path
     would render as a broken image on npmjs.com. -->
<p align="center">
  <img src="https://raw.githubusercontent.com/ksblazh/expo-tts-file/main/docs/demo.gif"
       alt="Generating an audio file, then playing it back with each word highlighted in time with the speech"
       width="360">
</p>

Recorded on a device: synthesize to a file, play it, and highlight each word as it is spoken — from the timings that come back with the file, so replaying and seeking stay in sync.

> Why: `expo-speech` speaks live but can't produce a file, and live speech can't play while the app is backgrounded / the screen is locked. Synthesizing to a file lets you play vocabulary, articles, or any text as a real audio stream — including in the background, like a podcast.

## Platforms

| Platform | Engine | Output container |
| --- | --- | --- |
| iOS 16.4+ | `AVSpeechSynthesizer.write` | CAF (PCM) or M4A (AAC) |
| Android API 24+ (7.0) | `TextToSpeech.synthesizeToFile` | WAV (PCM) or M4A (AAC) |
| Web | — | not supported (`synthesizeToFile` throws; `getVoices` returns `[]`) |

The default container is platform-native PCM; `format: 'aac'` produces an `.m4a` on both
platforms instead (see "Audio format"). All of them play back with any standard audio
player.

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
  format?: 'pcm' | 'aac'; // default 'pcm'; 'aac' → .m4a (see "Audio format")
  timeoutMs?: number; // watchdog for a stuck engine, default 60000 (see below)
};

type SpeechMark = {
  start: number;      // index into the input text, UTF-16 code units (as in JS)
  end: number;
  timeMs: number;     // when this range is spoken, from the start of the audio
};

synthesizeToFile(text: string, options: SynthesizeOptions):
  Promise<{ uri: string; durationMs: number; marks: SpeechMark[] }>

getVoices(language?: string): Promise<Array<{
  identifier: string;
  name: string;
  language: string;
  quality: 'default' | 'enhanced' | 'premium';
  requiresNetwork: boolean;   // Android: synthesized over the network; false on iOS
  notInstalled: boolean;      // Android: listed but not downloaded; false on iOS
}>>

deleteFile(uri: string): Promise<void>   // one file this module produced
clearCache(): Promise<number>            // resolves with how many files went
getCacheSize(): Promise<number>          // bytes
cancelAll(): Promise<number>             // abandon synthesis in flight; how many were dropped

addSynthesisProgressListener(
  listener: (e: { id: string; done: number; total: number }) => void
): EventSubscription                     // one event per finished piece; see "Long text"

// iOS only (see the platform table):
synthesizeMixedToFile(segments: Array<{ text: string; ipa?: string }>, options: SynthesizeOptions):
  Promise<{ uri: string; durationMs: number; marks: SpeechMark[] }>
speakIpa(text: string, options: SynthesizeOptions): Promise<boolean>
speakMixed(segments: Array<{ text: string; ipa?: string }>, options: SynthesizeOptions): Promise<boolean>
speakSsml(ssml: string, options: SynthesizeOptions): Promise<boolean>   // iOS 16+
stopLiveSpeech(): Promise<void>
```

`language` picks the platform default voice for that tag; a bare prefix such as `"ru"`
resolves to an installed `ru-*` voice. The `getVoices` filter matches that prefix
case-insensitively, so `"RU"` and `"en-us"` work as well as `"ru"` and `"en-US"`.

An Android engine lists every voice it knows about, including ones it can only
synthesize over the network (`requiresNetwork`) and ones whose data the user has not
downloaded in the system TTS settings (`notInstalled`) — picking such a voice offline
fails or silently substitutes another. Filter on those two flags before offering the
list to a user. iOS only lists installed on-device voices, so both are always `false`
there.

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

### Long text

Pass as much as you like. Android's TTS engine accepts only about 4000 characters in one
call — `TextToSpeech.getMaxSpeechInputLength()` — and past that some engines quietly
produce nothing while reporting success, which is worse than an error. The module
therefore splits longer text itself, renders the pieces in order and joins them into one
file, preferring sentence boundaries so the prosody has somewhere natural to breathe.
iOS has no such limit and is handed the text whole.

This is invisible from the outside: one call, one file, one set of timings. The `marks`
offsets refer to the text you passed, not to the pieces, and their timestamps refer to
the joined audio.

Two consequences worth knowing. The per-request `timeoutMs` budget applies to **each
piece**, not to the whole text, so a long article does not need a raised timeout. And an
engine that fails midway leaves the request rejected with the pieces rendered so far
discarded — there is no partial file.

A multi-minute render is otherwise silent, so progress is reported as an event:
`{done: 0, total}` when the synthesis starts, then one event per finished piece. The
piece being rendered after any event is `done + 1`.

```ts
const sub = addSynthesisProgressListener(({ done, total }) => {
  setProgress(done / total);
});
// …later:
sub.remove();
```

A short text — and any text on iOS, which has no input-length limit — is a single piece:
`{done: 0, total: 1}` at the start and `{done: 1, total: 1}` just before the promise
resolves. The event's `id` names the synthesis (the file in the resolved `uri` is
`tts-<id>`); with one request in flight it can be ignored, and Android runs requests one
at a time regardless.

### Audio format

The default output is uncompressed PCM — a `.wav` on Android, a `.caf` on iOS — which is
fine for a clip that is played once and deleted, and costs roughly 2.5–3 MB per minute of
speech. `format: 'aac'` produces an `.m4a` (AAC-LC, MPEG-4 container) on both platforms
at roughly a tenth of the size — the format to use for audio that is kept, cached across
sessions or shipped anywhere:

```ts
const { uri } = await synthesizeToFile(text, { language: 'en-US', format: 'aac' });
```

Everything else is unchanged: `durationMs`, `marks` and their timestamps, progress
events, the cache functions. iOS encodes while it writes; Android's engine can only
produce WAV, so the module renders PCM first and encodes it in one pass at the end —
for a long text expect the promise to resolve a moment after the last progress event
rather than instantly.

There is no `'mp3'`: neither platform ships an MP3 **encoder** (both only decode it),
and `.m4a` plays everywhere `.mp3` does, at better quality per byte. If you need MP3 for
some legacy consumer, transcode the `.m4a` server-side.

### Cancelling

`cancelAll()` abandons everything in flight and everything queued, resolving with how many
requests were dropped — enough for a screen being unmounted to tell whether it interrupted
work or arrived after it had finished. Each abandoned call rejects with
`ERR_TTS_CANCELLED`, which is the outcome you asked for rather than a failure to report.
Whatever a cancelled or failed request had written is deleted — its uri was never handed
out, so the files would be unreachable garbage.

It covers the file paths only — the live `speak*` functions have `stopLiveSpeech()`.

### Highlighting words while the file plays

`marks` comes back with the file: each entry is a range of your input text and the
millisecond at which that range is spoken. The engine reports the ranges *while it
renders*, long before anything plays; pairing each one with the audio produced so far is
what turns it into a playback timestamp, and that is what the module does for you.

```ts
const { uri, marks } = await synthesizeToFile(text, { language: 'en-US' });

// …later, during playback, at position `ms`:
const spoken = marks.filter((m) => m.timeMs <= ms).at(-1);
const word = spoken && text.slice(spoken.start, spoken.end);
```

`start` and `end` count UTF-16 code units, which is how JavaScript indexes strings too, so
they slice the input directly — no conversion, and no ambiguity when a word repeats. For
`synthesizeMixedToFile` they index the segments' `text` values concatenated in order.

Because the timings travel with the file rather than arriving as events, they survive
caching, seeking, pausing and replaying — the file synthesized today still highlights
correctly when it is played from the cache next week.

**`marks` can be empty, and that is not an error.** Android TTS engines are not required
to report ranges, and the callback that carries them does not exist below API 26; a
particular voice may not report them either. Check the array before building a UI that
depends on it, and fall back to plain text rather than treating it as a failure.

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

Failures from the native side reject with a `code` you can branch on:

| Code | Meaning |
| --- | --- |
| `ERR_TTS_TIMEOUT` | the engine reported nothing within `timeoutMs` |
| `ERR_TTS_FOREIGN_FILE` | `deleteFile` was handed a path outside the module's own directory |
| `ERR_TTS_FILE` | an output file could not be created, or a cache file could not be removed |
| `ERR_TTS` | the synthesizer failed, or the segments contained nothing speakable (iOS) |
| `ERR_TTS_CANCELLED` | the request was abandoned by `cancelAll` |

Android raises the first three. Its remaining failures — engine initialization, an
unsupported language, a synthesis the engine aborted — currently carry their reason in the
message rather than in a distinct code, so match on the message if you need to tell those
apart there.

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

The demo app in `example/` exercises the module end to end: synthesis with a
language-filtered voice picker, playback that keeps going in the background and on the
lock screen, and the cache functions. It also carries two self-checks that print PASS/FAIL
— one forces a timeout and confirms the queue recovers behind it, the other confirms
`deleteFile` refuses a path that escapes the cache directory.

It needs a development build (like any consumer of this module), not Expo Go:

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
