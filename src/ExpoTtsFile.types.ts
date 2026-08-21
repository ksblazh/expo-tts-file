// Public types for expo-tts-file.

export type SynthesizeOptions = {
  /** BCP-47 language tag, e.g. "en-US", "ru-RU". Picks the platform default voice for that language. */
  language: string;
  /**
   * Speech rate. `1.0` is the platform's normal speaking rate; `0.5` is half speed,
   * `2.0` double. iOS clamps this to the synthesizer's supported range; Android passes
   * it to the TTS engine as given, which may handle extremes however it likes.
   */
  rate?: number;
  /**
   * Voice pitch. `1.0` is normal; `<1` lower, `>1` higher. Clamped to 0.5–2.0 on iOS,
   * passed to the engine as given on Android.
   */
  pitch?: number;
  /**
   * A specific voice identifier obtained from {@link getVoices}. When set it overrides
   * the language-based voice pick (the voice's own language still applies).
   */
  voice?: string;
  /**
   * iOS only: pronounce the WHOLE `text` per this IPA transcription (Apple's
   * attributed-utterance `AVSpeechSynthesisIPANotationAttribute`) — the public way to
   * steer pronunciation, e.g. Russian ударение, which the bundled voices ignore as
   * combining marks in plain text. Best for a single word/short phrase.
   *
   * Device-verified: honored on BOTH the live and the file path, but only while `text`
   * is LATIN — over Cyrillic the voice falls back to its own lexicon and the
   * transcription is silently ignored, so pass a transliterated carrier. Honored by the
   * classic (Vocalizer) voices; some newer Siri voices ignore it — verify by ear.
   * Android ignores this field (combining stress marks work there natively).
   */
  ipa?: string;
};

/** One run of a mixed utterance: plain text, or text pronounced per its `ipa`. */
export type SpeechSegment = {
  text: string;
  ipa?: string;
};

export type SynthesisResult = {
  /** `file://` URI of the synthesized audio in the app cache directory. */
  uri: string;
  /** Duration of the produced audio, in milliseconds. */
  durationMs: number;
};

export type VoiceQuality = 'default' | 'enhanced' | 'premium';

export type Voice = {
  /** Stable platform voice identifier — pass it back as {@link SynthesizeOptions.voice}. */
  identifier: string;
  /** Human-readable voice name. */
  name: string;
  /** BCP-47 language tag of the voice, e.g. "en-US". */
  language: string;
  /** Quality hint, when the platform exposes one. */
  quality: VoiceQuality;
};
