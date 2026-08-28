# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- Long text no longer has to fit in one engine call. Android's `TextToSpeech` accepts only
  about 4000 characters at a time, and past that some engines quietly produce nothing
  while reporting success — the failure mode behind
  [expo/expo#7214](https://github.com/expo/expo/issues/7214). The module now splits longer
  text at sentence boundaries, renders the pieces in order and joins their PCM into a
  single file. It is invisible to the caller: one call, one file, and `marks` whose
  offsets still refer to the text that was passed in and whose timestamps refer to the
  joined audio. The `timeoutMs` budget applies per piece, so a long article does not need
  a raised timeout. iOS has no such limit and is handed the text whole.
- `cancelAll()` — abandon every synthesis in flight or queued, resolving with how many
  were dropped. Abandoned calls reject with `ERR_TTS_CANCELLED`. Until now a screen could
  be unmounted while a synthesis ran on regardless.

### Fixed
- Android: an exception from the engine while a request was being handed over — most
  plausibly `getVoices()`, which throws on some devices before the engine is fully up —
  escaped the queue and left it wedged with the promise unsettled. That is the failure the
  synthesis watchdog exists for, reached by a path the watchdog cannot cover, because it
  is armed further down. Handing a request over is now guarded end to end.
- Android: waiting for the TTS engine to initialize had no deadline. `TextToSpeech`'s init
  listener is not guaranteed to fire, and on a device without a usable engine every call
  waited forever with no `ERR_TTS_TIMEOUT` — the watchdog only covers synthesis, which
  such a device never reaches. Each caller now carries its own 15 s deadline, so a late
  listener still serves whoever comes after.

## [0.2.4] — 2026-08-27

### Added
- `SynthesisResult.marks` — word-level timings returned with the synthesized file, as
  `{ start, end, timeMs }` per reported range. Enough to highlight each word as the file
  plays, which is what the module exists for and what no comparable package offers.

  The ranges are reported by the engine *during rendering*, long before playback, so a
  raw range says nothing about when to highlight; each one is stamped with the audio
  produced so far, which converts it into a playback timestamp. Because the timings come
  back with the file instead of arriving as events, they survive caching, seeking and
  replay — a clip synthesized today still highlights correctly when played from the cache
  next week.

  `start` and `end` count UTF-16 code units, matching how JavaScript indexes strings, so
  they slice the input text directly rather than carrying the spoken substrings — which
  also keeps a repeated word unambiguous. The array is empty when the engine reports no
  ranges (Android engines are not required to implement this, and none do below API 26);
  that is a missing capability, not a failure.

  One Android quirk is handled rather than documented away: the platform specifies
  `onRangeStart(utteranceId, start, end, frame)`, and a shipping engine was observed
  delivering `(frame, start, end)` instead — a frame counter arriving where a character
  offset belongs, which renders as the passage printed twice. Both orders now produce the
  same marks, decided per utterance by which reading walks forward through the text
  without overlapping; numbers that fit neither are discarded with a warning rather than
  reported as ranges.

### Changed
- The version guard now also covers `package-lock.json`, which states the version twice.
  It knew three of the five declarations, and the 0.2.3 bump nearly shipped with the
  lockfile behind.
- `release.yml` pins npm to a major instead of installing `@latest`. That line is how a
  release breaks while CI stays green: npm 12 changed the shape of `npm pack --json`, and
  only the release job reads it.
- Every GitHub action was three majors behind and is now current; Dependabot is set up so
  that stops recurring, with major bumps of `expo`, `react` and `react-native` excluded —
  an SDK migration is a decision with device verification attached.

## [0.2.3] — 2026-08-26

### Fixed
- A request the TTS engine never reported on hung forever, and on Android took every
  later request with it: the queue keeps one request in flight at a time and only a
  completion callback released it, so an engine that fell silent — or a callback whose
  utterance id did not match, which was discarded without releasing the queue — left
  every subsequent `synthesizeToFile` pending with no recovery short of restarting the
  app. Each request now carries a watchdog that rejects it with `ERR_TTS_TIMEOUT` and
  lets the queue move on. On iOS the same timer covers a `write()` that never delivers
  its terminal zero-length buffer, which previously also leaked the synthesizer.
- iOS: the engine callback and the watchdog can now both try to settle a request, so the
  flag deciding which one wins is read and set under a lock instead of in two steps.
- `getVoices` compared the language filter case-sensitively on both platforms, so
  `getVoices('RU')` or `getVoices('en-us')` returned nothing at all. BCP-47 is
  case-insensitive and the region subtag is conventionally upper-case, which made this
  easy to hit.

### Added
- Cache management: `deleteFile(uri)`, `clearCache()` and `getCacheSize()`. The module's
  only output is files and nothing else removed them, so the README used to hand the
  problem to `expo-file-system`. `deleteFile` takes the `uri` that `synthesizeToFile`
  returned and refuses anything outside the module's own directory with
  `ERR_TTS_FOREIGN_FILE` — a blast-radius limit rather than a permission one, since a
  stale URI should at worst cost a clip that can be synthesized again. Paths are resolved
  before the check, so neither a `..` escape nor a sibling directory sharing the same name
  prefix gets through. Deleting a file the OS has already evicted counts as success.
- `SynthesizeOptions.timeoutMs` — how long to wait for the engine before giving up on a
  request, defaulting to 60000 ms. It is a recovery path for a stuck engine rather than a
  deadline for slow synthesis, so raising it for long texts is the intended use; the live
  `speak*` functions ignore it.

## [0.2.2] — 2026-08-25

### Changed
- Developed and tested against **Expo SDK 57** (React Native 0.86) instead of SDK 56
  (0.85). No source change was needed to meet it, and nothing is dropped: SDK 56 remains
  supported, the platform floors are identical in both (`expo-modules-core` declares
  iOS 16.4 and `minSdk` 24 either way), and `peerDependencies` still accepts any Expo.
- The published tarball is now decided by an allowlist (`package.json#files`) rather than
  by `.npmignore`: nothing ships unless it is listed, so a stray or gitignored working
  file in the publishing tree can no longer be swept in. The contents are unchanged
  except that `.prettierrc`, `eslint.config.cjs` and `tsconfig.json` no longer ship —
  none of them are used by consumers.
- Packaging is verified on every build: `npm run check:package` packs the module and
  fails if a packed file is untracked by git, if a tracked native source is missing from
  the tarball, or if the compiled entry points are absent. It also runs from
  `prepublishOnly`, so a manual publish is checked the same way CI is.

### Documentation
- The iOS build workaround (`buildReactNativeFromSource`) is now marked as applying to
  SDK 56 only — SDK 57 fixed the precompiled-XCFramework header bug it worked around.
  The instructions stay for anyone still on 56. Upgrading removes the need for
  `expo-build-properties` and the tens of gigabytes of free disk a source build wants;
  this repository's own iOS CI went from ~28 minutes to ~5.

## [0.2.1] — 2026-08-21

### Fixed
- iOS: a live utterance that superseded another (`speakIpa` / `speakMixed` / `speakSsml`
  called twice in a row) resolved `false` immediately — the `didCancel` of the stopped
  utterance, delivered asynchronously, settled the promise of the one replacing it. The
  delegate now keys its completion by utterance, so each call resolves on its own
  outcome.
- iOS: `synthesizeToFile` / `synthesizeMixedToFile` resolved before the output file was
  closed. `AVAudioFile` finalizes the header on deallocation, so a caller that opened the
  URI immediately could see a truncated file or a zero duration; the file is now closed
  before the promise resolves.
- iOS: `stopLiveSpeech()` resolved the stopped utterance's promise `true` — the promise
  was settled by the synthesizer delegate, and an immediate stop delivers `didFinish`
  rather than `didCancel` on current iOS, so a caller could not tell "finished" from
  "I stopped it". The stop now settles the pending promise `false` itself.
- Android: `rate` and `pitch` leaked between requests — they are engine-global, and were
  applied only when present, so a later call that omitted them inherited the previous
  values. Both are now always set, with the platform default when omitted.
- Calling an iOS-only function (`synthesizeMixedToFile`, `speakIpa`, `speakMixed`,
  `speakSsml`, `stopLiveSpeech`) on Android or web rejected with a bare
  `TypeError: undefined is not a function` — those names are absent from the Kotlin
  module and the web stub. They now reject with a message naming the function and the
  platform.
- The example's Metro config aliased the module with a relative `'..'`, which resolves
  against the working directory — Release builds, bundled by the Xcode build phase,
  failed with "Unable to resolve module expo-tts-file". The alias is now absolute.
- `ios/ExpoTtsFile.podspec` and `android/build.gradle` still declared `0.1.0` while the
  package was published as `0.2.0`. All three now carry the same version, and CI fails
  the build if they drift apart again.

### Documentation
- `rate` and `pitch` were documented as "clamped to each platform's supported range".
  Only iOS clamps; Android passes the value to the TTS engine as given. Stated as it is.
- The platform note said the module was verified on the iOS *Simulator*; both platforms
  are now verified on physical devices.

## [0.2.0] — 2026-08-17

First published release (0.1.0 was the pre-publication cut, see below).

### Added
- iOS pronunciation steering via Apple's `AVSpeechSynthesisIPANotationAttribute`:
  `SynthesizeOptions.ipa` (whole-utterance transcription) on `synthesizeToFile`, plus
  `speakIpa` / `speakMixed` / `speakSsml` / `stopLiveSpeech` for live playback.
- `synthesizeMixedToFile(segments, options)` — the file-bound sibling of `speakMixed`:
  a sentence where only the marked words carry their own IPA. Lets an offline/background
  player (clips, not live speech) keep e.g. Russian ударение inside sentences.
- Runtime argument validation in the TS layer: public functions reject with a
  `TypeError` naming the offending argument (`options.rate`, `segments[1].ipa`, …)
  instead of an opaque native exception; a jest suite covers the matrix.

### Changed
- Public functions are declared `async`, so invalid input is always a promise
  rejection — never a sync throw halfway into a `.then()` chain.

### Fixed
- File synthesis resolves the voice the way the live path does (identifier → exact
  BCP-47 → language prefix), so a bare tag such as `"ru"` no longer falls through to
  the system-default voice.

### Notes
- Device-verified (iOS 26.5): the IPA attribute is honored on **both** the live and the
  `write()`/file path, but **only over Latin text** — over Cyrillic the voice falls back
  to its own lexicon. An earlier "write() drops the attribute" reading was that same
  fallback, measured over Cyrillic. Pass a transliterated carrier (README → Steering
  pronunciation).

## [0.1.0] — 2026-06-14

Initial release.

### Added
- `synthesizeToFile(text, { language, rate?, pitch?, voice? }) → { uri, durationMs }` —
  on-device text-to-speech synthesized to an audio file
  (iOS `AVSpeechSynthesizer.write` → CAF, Android `TextToSpeech.synthesizeToFile` → WAV).
- `getVoices(language?) → Voice[]` — list installed voices, optionally filtered by a
  BCP-47 language prefix.
- Android `<queries>` for the TTS engine (required on Android 11+); requests are
  serialized so per-utterance language/rate/pitch/voice apply correctly.
- Web stub (`synthesizeToFile` throws, `getVoices` returns `[]`).
- Example app: editable text, language-filtered voice picker, playback, background audio.

### Validated
- End-to-end on Android (physical device) and iOS (simulator): synth + voices + playback.

### Known issues
- iOS local builds may need React Native built from source due to an Expo SDK 56
  precompiled-XCFramework bug (not this module) — see README → Troubleshooting.
