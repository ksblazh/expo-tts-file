# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

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
