package expo.modules.ttsfile

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.util.Locale
import java.util.UUID

class SynthesizeOptions : Record {
  @Field var language: String = "en-US"
  @Field var rate: Double? = null
  @Field var pitch: Double? = null
  @Field var voice: String? = null
  @Field var timeoutMs: Double? = null
}

class ExpoTtsFileModule : Module() {
  private var tts: TextToSpeech? = null
  private var ready = false
  private var initStarted = false
  private val initLock = Any()
  private val initWaiters = mutableListOf<(TextToSpeech?) -> Unit>()

  // The engine's language/rate/pitch/voice are global, so requests are run one at
  // a time: each request applies its own params, then renders, before the next starts.
  private val queueLock = Any()
  private val queue = ArrayDeque<Request>()
  private var processing = false
  private var current: Request? = null

  // The watchdogs run on the main looper; all they ever do is reject a promise.
  private val watchdogHandler = Handler(Looper.getMainLooper())

  private class Request(
    val text: String,
    val options: SynthesizeOptions,
    val promise: Promise,
    val utteranceId: String,
    val file: File
  ) {
    /** Recovery timer, disarmed by whichever settles the request first. */
    var watchdog: Runnable? = null

    /** Ranges the engine reported while rendering; guarded by [queueLock]. */
    val marks = mutableListOf<RawRange>()
  }

  /**
   * The three integers `onRangeStart` delivered, kept unlabelled on purpose.
   *
   * The platform documents them as (start, end, frame), and at least one shipping engine
   * delivers (frame, start, end) instead — device-verified on a Pixel, 2026-08-27, where
   * the second argument counted audio frames while the third held character offsets.
   * Which reading is right cannot be decided per callback, so it is decided per utterance
   * in [marksOf] against the text they must describe.
   */
  private class RawRange(val first: Int, val second: Int, val third: Int)

  private val context: Context
    get() = appContext.reactContext?.applicationContext
      ?: throw CodedException("React context is not available")

  private val cacheDir: File
    get() = File(context.cacheDir, "expo-tts-file").apply { mkdirs() }

  override fun definition() = ModuleDefinition {
    Name("ExpoTtsFile")

    AsyncFunction("synthesizeToFile") { text: String, options: SynthesizeOptions, promise: Promise ->
      withEngine { engine ->
        if (engine == null) {
          promise.reject(CodedException("TTS engine failed to initialize"))
          return@withEngine
        }
        val utteranceId = UUID.randomUUID().toString()
        val file = File(cacheDir, "tts-$utteranceId.wav")
        enqueue(Request(text, options, promise, utteranceId, file))
      }
    }

    AsyncFunction("getVoices") { language: String?, promise: Promise ->
      withEngine { engine ->
        if (engine == null) {
          promise.reject(CodedException("TTS engine failed to initialize"))
          return@withEngine
        }
        val voices = engine.voices ?: emptySet()
        // Compared ignoring case: BCP-47 is case-insensitive and the region subtag is
        // conventionally upper-case, so a caller passing "RU" or "en-us" was previously
        // told no such voice exists.
        val result = voices
          .filter { language == null || it.locale.toLanguageTag().startsWith(language, ignoreCase = true) }
          .map { voice ->
            mapOf(
              "identifier" to voice.name,
              "name" to voice.name,
              "language" to voice.locale.toLanguageTag(),
              "quality" to qualityString(voice.quality)
            )
          }
        promise.resolve(result)
      }
    }

    // The module's only output is files and nothing else removes them, so it owns the
    // three operations over its own directory. Deliberately NOT a general file API:
    // deleting anything else is `expo-file-system`'s job, and confining these keeps the
    // worst case at "deleted a clip", which re-synthesizing undoes.
    AsyncFunction("deleteFile") { uri: String ->
      val file = cacheFileOrNull(uri) ?: throw CodedException(
        "ERR_TTS_FOREIGN_FILE",
        "$uri was not written by expo-tts-file. Delete other files with expo-file-system.",
        null
      )
      // Already gone is success, not failure: the OS evicts the cache directory under
      // storage pressure, so a missing file is the state the caller asked for.
      if (file.exists() && !file.delete()) {
        throw CodedException("ERR_TTS_FILE", "Could not delete $uri", null)
      }
    }

    // Both take an explicit Promise rather than being written as no-argument lambdas:
    // the DSL carries two overloads for a bare `{ … }` body, and the Promise form is
    // unambiguous as well as being what the rest of this module uses.
    AsyncFunction("clearCache") { promise: Promise ->
      // Counts what actually went, not what was attempted.
      promise.resolve(cacheFiles().count { it.delete() })
    }

    AsyncFunction("getCacheSize") { promise: Promise ->
      promise.resolve(cacheFiles().sumOf { it.length() }.toDouble())
    }

    OnDestroy {
      watchdogHandler.removeCallbacksAndMessages(null)
      tts?.shutdown()
      tts = null
    }
  }

  /** Run [block] once the TTS engine is initialized (passing null if init failed). */
  private fun withEngine(block: (TextToSpeech?) -> Unit) {
    synchronized(initLock) {
      if (ready) {
        block(tts)
        return
      }
      initWaiters.add(block)
      if (!initStarted) {
        initStarted = true
        tts = TextToSpeech(context) { status ->
          synchronized(initLock) {
            ready = status == TextToSpeech.SUCCESS
            if (ready) {
              tts?.setOnUtteranceProgressListener(progressListener)
            }
            val engine = if (ready) tts else null
            val waiters = initWaiters.toList()
            initWaiters.clear()
            waiters.forEach { it(engine) }
          }
        }
      }
    }
  }

  private fun enqueue(req: Request) {
    synchronized(queueLock) {
      queue.addLast(req)
      pumpLocked()
    }
  }

  /** Start the next request if idle. Must hold [queueLock]. */
  private fun pumpLocked() {
    if (processing) return
    val req = queue.removeFirstOrNull() ?: return
    processing = true
    current = req
    start(req)
  }

  private fun advance() {
    synchronized(queueLock) {
      clearCurrentLocked()
      processing = false
      pumpLocked()
    }
  }

  /** Forget the in-flight request and disarm its watchdog. Must hold [queueLock]. */
  private fun clearCurrentLocked() {
    current?.let { req ->
      req.watchdog?.let { watchdogHandler.removeCallbacks(it) }
      req.watchdog = null
    }
    current = null
  }

  /**
   * Arm the recovery timer for [req]. Must hold [queueLock].
   *
   * Without it a request the engine never reports on holds [processing] forever, and
   * every later one waits behind it with no way out but an app restart.
   */
  private fun armWatchdogLocked(req: Request) {
    val timeoutMs = req.options.timeoutMs?.toLong() ?: DEFAULT_TIMEOUT_MS
    val watchdog = Runnable {
      val timedOut = takeCurrent(req.utteranceId) ?: return@Runnable
      timedOut.promise.reject(
        CodedException("ERR_TTS_TIMEOUT", "TTS synthesis did not finish within $timeoutMs ms", null)
      )
      advance()
    }
    req.watchdog = watchdog
    watchdogHandler.postDelayed(watchdog, timeoutMs)
  }

  private fun start(req: Request) {
    val engine = tts
    if (engine == null) {
      req.promise.reject(CodedException("TTS engine is not available"))
      advance()
      return
    }
    val langResult = engine.setLanguage(Locale.forLanguageTag(req.options.language))
    if (langResult == TextToSpeech.LANG_MISSING_DATA || langResult == TextToSpeech.LANG_NOT_SUPPORTED) {
      req.promise.reject(CodedException("Language not supported or missing data: ${req.options.language}"))
      advance()
      return
    }
    req.options.voice?.let { voiceId ->
      engine.voices?.firstOrNull { it.name == voiceId }?.let { engine.voice = it }
    }
    // Rate and pitch are engine-global and survive between requests (unlike the voice,
    // which setLanguage above resets), so they are always set: an omitted option means
    // "platform default", not "whatever the previous request happened to use".
    engine.setSpeechRate(req.options.rate?.toFloat() ?: 1.0f)
    engine.setPitch(req.options.pitch?.toFloat() ?: 1.0f)

    // Armed before the engine is handed the text rather than after it accepts it: this
    // runs while [queueLock] is held, so no callback can settle the request in between,
    // and an engine that accepts the text and then says nothing is covered from the
    // start.
    armWatchdogLocked(req)

    val result = engine.synthesizeToFile(req.text, Bundle(), req.file, req.utteranceId)
    if (result != TextToSpeech.SUCCESS) {
      req.promise.reject(CodedException("Failed to start synthesizeToFile"))
      advance()
    }
  }

  private val progressListener = object : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) {}

    // Word-level timing: a range of the utterance text and the audio frame at which it is
    // spoken, which is what makes the range usable during PLAYBACK rather than during
    // synthesis. Deliberately does not claim the request the way the settling callbacks
    // do — it fires many times per utterance and the request has to stay in flight.
    //
    // The parameters are named for the documented contract and then stored UNLABELLED,
    // because one shipping engine does not honour it (see [RawRange]). [marksOf] decides
    // which reading the numbers actually support.
    //
    // Added in API 26. On 24 and 25 the framework never calls it, which is the same
    // outcome as an engine that does not supply ranges.
    override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) {
      synchronized(queueLock) {
        val req = current
        if (req != null && req.utteranceId == utteranceId) {
          req.marks.add(RawRange(start, end, frame))
        }
      }
    }

    override fun onDone(utteranceId: String?) {
      val req = takeCurrent(utteranceId) ?: return
      req.promise.resolve(
        mapOf(
          "uri" to Uri.fromFile(req.file).toString(),
          "durationMs" to durationOf(req.file),
          "marks" to marksOf(req)
        )
      )
      advance()
    }

    @Deprecated("Deprecated in Java", ReplaceWith(""))
    override fun onError(utteranceId: String?) {
      val req = takeCurrent(utteranceId) ?: return
      req.promise.reject(CodedException("TTS synthesis error"))
      advance()
    }

    override fun onError(utteranceId: String?, errorCode: Int) {
      val req = takeCurrent(utteranceId) ?: return
      req.promise.reject(CodedException("TTS synthesis error (code $errorCode)"))
      advance()
    }
  }

  /**
   * Claim the in-flight request if [utteranceId] identifies it, so exactly one of the
   * engine callback and the watchdog settles it — the other gets null and stops there.
   *
   * Null is also what an unrecognized id gets: a callback arriving for a request that
   * already timed out, or a second callback for one already done, refers to something
   * the queue has moved past and must not disturb whatever is running now. The watchdog,
   * not this check, is what keeps an unrecognized id from stalling the queue.
   */
  private fun takeCurrent(utteranceId: String?): Request? {
    synchronized(queueLock) {
      val req = current
      if (req == null || req.utteranceId != utteranceId) {
        return null
      }
      clearCurrentLocked()
      return req
    }
  }

  private fun cacheFiles(): List<File> =
    cacheDir.listFiles()?.filter { it.isFile } ?: emptyList()

  /**
   * The file [uri] names, or null if this module did not write it.
   *
   * `canonicalFile` resolves `..` and symlinks BEFORE the comparison, so a path that
   * merely looks contained does not pass. The parent directory is compared rather than a
   * string prefix — a prefix test would also accept a sibling directory whose name
   * happens to start the same way, and the module writes flat into one directory anyway.
   */
  private fun cacheFileOrNull(uri: String): File? {
    val parsed = Uri.parse(uri)
    if (parsed.scheme != null && parsed.scheme != "file") {
      return null
    }
    val path = parsed.path ?: return null
    return runCatching {
      val file = File(path).canonicalFile
      if (file.parentFile == cacheDir.canonicalFile) file else null
    }.getOrNull()
  }

  /**
   * The collected ranges as `[{start, end, timeMs}]`, in report order.
   *
   * Frames become milliseconds through the file's own sample rate, so an engine that
   * renders at an unexpected rate still lands on the right timestamps. Returns empty
   * rather than guessing when the rate cannot be read or the engine reported nothing —
   * `start`/`end` count UTF-16 code units, which is also how JavaScript indexes strings.
   */
  private fun marksOf(req: Request): List<Map<String, Int>> {
    if (req.marks.isEmpty()) {
      return emptyList()
    }
    val sampleRate = sampleRateOf(req.file)
    if (sampleRate <= 0) {
      return emptyList()
    }

    // Two readings of the same three numbers. Whichever describes the text coherently is
    // the right one; the documented order wins a tie, so a conforming engine is never
    // second-guessed.
    val documented = req.marks.map { Triple(it.first, it.second, it.third) }
    val shifted = req.marks.map { Triple(it.second, it.third, it.first) }
    val chosen = when {
      describesText(documented, req.text.length) -> documented
      describesText(shifted, req.text.length) -> {
        Log.w(
          "ExpoTtsFile",
          "This TTS engine reports onRangeStart as (frame, start, end); the platform " +
            "documents (start, end, frame). Reading the ranges in the order the numbers fit."
        )
        shifted
      }
      else -> {
        Log.w(
          "ExpoTtsFile",
          "Discarding ${req.marks.size} speech ranges: neither argument order describes " +
            "the ${req.text.length}-character utterance. Reporting no marks."
        )
        return emptyList()
      }
    }

    return chosen.map { (start, end, frame) ->
      mapOf(
        "start" to start,
        "end" to end,
        // Long on purpose: frames * 1000 overflows Int a few minutes into an utterance.
        "timeMs" to (frame.toLong() * 1000L / sampleRate).toInt()
      )
    }
  }

  /**
   * Whether these (start, end, frame) triples can describe [length] characters of text.
   *
   * Bounds alone do not separate the two candidate orders — on a conforming engine the
   * wrong reading also lands inside a long text. What separates them is that real ranges
   * walk forward through the text without overlapping: read the wrong way round, the
   * "ranges" leap over each other immediately.
   */
  private fun describesText(ranges: List<Triple<Int, Int, Int>>, length: Int): Boolean {
    var previousEnd = 0
    for ((start, end, frame) in ranges) {
      if (frame < 0 || start < previousEnd || end <= start || end > length) {
        return false
      }
      previousEnd = end
    }
    return true
  }

  private fun sampleRateOf(file: File): Int {
    val extractor = MediaExtractor()
    return try {
      extractor.setDataSource(file.absolutePath)
      if (extractor.trackCount == 0) {
        0
      } else {
        val format = extractor.getTrackFormat(0)
        // getInteger(key, default) only exists from API 29.
        if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) {
          format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        } else {
          0
        }
      }
    } catch (e: Exception) {
      0
    } finally {
      extractor.release()
    }
  }

  private fun durationOf(file: File): Int {
    val retriever = MediaMetadataRetriever()
    return try {
      retriever.setDataSource(file.absolutePath)
      retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toIntOrNull() ?: 0
    } catch (e: Exception) {
      0
    } finally {
      retriever.release()
    }
  }

  private fun qualityString(quality: Int): String = when {
    quality >= android.speech.tts.Voice.QUALITY_VERY_HIGH -> "premium"
    quality >= android.speech.tts.Voice.QUALITY_HIGH -> "enhanced"
    else -> "default"
  }

  companion object {
    // Far above what any synthesis the engine would have completed takes — it caps its
    // own input at getMaxSpeechInputLength() characters — and short enough that an app
    // recovers within the session instead of at the next launch.
    private const val DEFAULT_TIMEOUT_MS = 60_000L
  }
}
