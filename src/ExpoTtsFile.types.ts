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
  /**
   * Output encoding; default `'pcm'`.
   *
   * `'pcm'` is uncompressed — a `.wav` on Android, a `.caf` on iOS — at roughly 2.5–3 MB
   * per minute of speech. `'aac'` produces an `.m4a` (AAC-LC) on both platforms at
   * roughly a tenth of that, which is what to use for audio that is kept or shipped
   * rather than played once and deleted. `durationMs` and `marks` are unaffected.
   *
   * MP3 is deliberately absent: neither platform ships an MP3 *encoder*, and `.m4a`
   * plays everywhere `.mp3` does.
   */
  format?: 'pcm' | 'aac';
  /**
   * Watchdog for an engine that never reports back, in milliseconds; default `60000`.
   * After this long without a result the promise rejects with `ERR_TTS_TIMEOUT` instead
   * of staying pending for the life of the app — and on Android the requests queued
   * behind it start running again, which otherwise takes an app restart.
   *
   * This is a recovery path, not a deadline for slow synthesis: a value that fires while
   * the engine is still working turns a request that would have succeeded into a
   * failure. Raise it for long texts rather than lowering it to fail fast.
   *
   * Applies to the file paths only. The live `speak*` functions ignore it — their
   * recovery is {@link stopLiveSpeech}, and speech has no expected duration to time out
   * against.
   */
  timeoutMs?: number;
};

/** One run of a mixed utterance: plain text, or text pronounced per its `ipa`. */
export type SpeechSegment = {
  text: string;
  ipa?: string;
};

/**
 * One reported range of the input text, and when it is spoken in the produced audio.
 *
 * `start` and `end` index the text you passed in, counted in UTF-16 code units — the same
 * units JavaScript strings use, so `text.slice(start, end)` is the spoken word. For
 * {@link synthesizeMixedToFile} they index the segments' `text` values concatenated in
 * order.
 */
export type SpeechMark = {
  /** Index of the first character of the range. */
  start: number;
  /** Index just past the last character of the range. */
  end: number;
  /** Milliseconds from the start of the audio at which this range begins. */
  timeMs: number;
};

/**
 * Progress of a running synthesis: `{done: 0, total}` as it starts, then one event per
 * finished piece.
 *
 * Long text is rendered in pieces on Android (see the README), and for a passage that
 * takes minutes this event is the only feedback while it runs. The starting event is
 * what tells you how many pieces are coming; the piece being rendered after any event is
 * `done + 1`. A short text — and every text on iOS, which has no input-length limit — is
 * a single piece: `{done: 0, total: 1}` at the start, `{done: 1, total: 1}` just before
 * the promise resolves.
 *
 * `id` names the synthesis: the file in the resolved `uri` is `tts-<id>` plus the
 * platform extension. With one request in flight (the common case; Android runs them one
 * at a time regardless) it can be ignored.
 */
export type SynthesisProgressEvent = {
  id: string;
  /** Pieces rendered so far. */
  done: number;
  /** Total pieces in this synthesis. */
  total: number;
};

export type SynthesisResult = {
  /** `file://` URI of the synthesized audio in the app cache directory. */
  uri: string;
  /** Duration of the produced audio, in milliseconds. */
  durationMs: number;
  /**
   * Word-level timings for the produced audio, in report order — the data a caller needs
   * to highlight text while the file plays.
   *
   * **Empty when the engine does not report ranges**, which is not an error: Android TTS
   * engines are not required to implement it (and never do below API 26), and a voice may
   * simply not provide it. Treat an empty array as "no highlighting available" rather
   * than as a failure, and check it before building a UI that depends on it.
   */
  marks: SpeechMark[];
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
  /**
   * Android: the engine synthesizes this voice over the network, so offline it fails or
   * silently substitutes another voice — filter on this before offering voices to a user
   * who may be offline. Always `false` on iOS, which only lists on-device voices.
   */
  requiresNetwork: boolean;
  /**
   * Android: the engine advertises this voice but its data is not downloaded yet (the
   * user installs it in the system TTS settings); picking it does not download it.
   * Always `false` on iOS, which only lists installed voices.
   */
  notInstalled: boolean;
};
