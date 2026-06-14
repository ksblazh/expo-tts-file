// Public types for expo-tts-file.

export type SynthesizeOptions = {
  /** BCP-47 language tag, e.g. "en-US", "ru-RU". Picks the platform default voice for that language. */
  language: string;
  /**
   * Speech rate. `1.0` is the platform's normal speaking rate; `0.5` is half speed,
   * `2.0` double. Clamped to each platform's supported range.
   */
  rate?: number;
  /** Voice pitch. `1.0` is normal; `<1` lower, `>1` higher. */
  pitch?: number;
  /**
   * A specific voice identifier obtained from {@link getVoices}. When set it overrides
   * the language-based voice pick (the voice's own language still applies).
   */
  voice?: string;
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
