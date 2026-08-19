# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
- Android: `rate` and `pitch` leaked between requests — they are engine-global, and were
  applied only when present, so a later call that omitted them inherited the previous
  values. Both are now always set, with the platform default when omitted.

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
