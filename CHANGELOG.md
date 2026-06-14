# Changelog

All notable changes to this project are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
