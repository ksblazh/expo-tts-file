# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- iOS pronunciation steering via Apple's `AVSpeechSynthesisIPANotationAttribute`:
  `SynthesizeOptions.ipa` (whole-utterance transcription) on `synthesizeToFile`, plus
  `speakIpa` / `speakMixed` / `speakSsml` / `stopLiveSpeech` for live playback.
- `synthesizeMixedToFile(segments, options)` — the file-bound sibling of `speakMixed`:
  a sentence where only the marked words carry their own IPA. Lets an offline/background
  player (clips, not live speech) keep e.g. Russian ударение inside sentences.

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
