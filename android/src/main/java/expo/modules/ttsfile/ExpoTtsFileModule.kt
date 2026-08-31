package expo.modules.ttsfile

import android.content.Context
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
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
import java.io.RandomAccessFile
import java.util.Locale
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

class SynthesizeOptions : Record {
  @Field var language: String = "en-US"
  @Field var rate: Double? = null
  @Field var pitch: Double? = null
  @Field var voice: String? = null
  @Field var timeoutMs: Double? = null
  @Field var format: String? = null
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
  private var pumping = false

  // The watchdogs run on the main looper; all they ever do is reject a promise.
  private val watchdogHandler = Handler(Looper.getMainLooper())

  /**
   * One piece of the request's text as handed to the engine.
   *
   * Android caps a single `synthesizeToFile` call at
   * `TextToSpeech.getMaxSpeechInputLength()` characters — about 4000 — and past that some
   * engines quietly produce nothing and report success, which is worse than an error.
   * Anything longer is therefore split, rendered piece by piece and joined back into one
   * file, so a caller can hand over an article without knowing any of this.
   */
  private class Chunk(val text: String, val charOffset: Int, val file: File) {
    /** Ranges the engine reported for THIS piece; guarded by [queueLock]. */
    val marks = mutableListOf<RawRange>()

    /** Audio frames this piece contributed, filled in while joining. */
    var frames: Long = 0
  }

  private class Request(
    val text: String,
    val options: SynthesizeOptions,
    val promise: Promise,
    val id: String,
    val file: File,
    val chunks: List<Chunk>
  ) {
    /** Recovery timer, disarmed by whichever settles the request first. */
    var watchdog: Runnable? = null

    /** Which piece is with the engine now. */
    var index = 0

    val chunk: Chunk get() = chunks[index]

    /** Per PIECE, not per request: the engine keys its callbacks by this. */
    val utteranceId: String get() = "$id-$index"

    /** The engine only writes WAV; for AAC every piece is an intermediate to encode. */
    val aac: Boolean get() = options.format == "aac"
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

    // Fired once per finished piece of a synthesis. A short text is one piece, so a
    // single {1, 1} arrives just before the promise resolves; a long text is the only
    // feedback the caller gets during a render that can run for minutes.
    Events("onSynthesisProgress")

    AsyncFunction("synthesizeToFile") { text: String, options: SynthesizeOptions, promise: Promise ->
      withEngine { engine ->
        if (engine == null) {
          promise.reject(CodedException("TTS engine failed to initialize"))
          return@withEngine
        }
        val id = UUID.randomUUID().toString()
        val dir = cacheDir
        val aac = options.format == "aac"
        val target = File(dir, if (aac) "tts-$id.m4a" else "tts-$id.wav")
        val pieces = splitForEngine(text, TextToSpeech.getMaxSpeechInputLength())
        // A single PCM piece is rendered straight into the final file — there is nothing
        // to join, and copying it would only cost time and disk. For AAC every piece is
        // an intermediate WAV: the engine cannot write anything else, so the encode pass
        // always runs.
        val chunks = pieces.mapIndexed { i, piece ->
          Chunk(
            piece.second,
            piece.first,
            if (!aac && pieces.size == 1) target else File(dir, "tts-$id-$i.wav")
          )
        }
        enqueue(Request(text, options, promise, id, target, chunks))
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
              "quality" to qualityString(voice.quality),
              // Engines list voices they cannot use offline (network synthesis) or have
              // not downloaded yet; picking one anyway fails or silently substitutes.
              // Surfaced so callers can filter before offering the voice to a user.
              "requiresNetwork" to voice.isNetworkConnectionRequired,
              "notInstalled" to (voice.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) == true)
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

    // Abandon everything in flight and everything queued behind it. Returns how many
    // requests were dropped, so a caller unmounting a screen can tell whether it
    // interrupted work or arrived after it finished.
    //
    // Only covers file synthesis; the live speech path has stopLiveSpeech(), which is
    // iOS-only for the same reason the live path is.
    AsyncFunction("cancelAll") { promise: Promise ->
      val dropped = synchronized(queueLock) {
        val victims = mutableListOf<Request>()
        // `current == null` while `processing` is still true means a finished synthesis
        // is being assembled (joined or encoded) on the engine's callback thread. That
        // request settles on its own and its advance() owns the reset: resetting here
        // would let a NEW request start, whose state that advance() then clobbered —
        // leaving its promise hanging with its watchdog already disarmed. The assembling
        // request itself is past cancelling; rejecting it too would settle it twice.
        if (current != null) {
          processing = false
        }
        current?.let { victims.add(it) }
        victims.addAll(queue)
        queue.clear()
        clearCurrentLocked()
        victims
      }
      // Outside the lock: stop() reaches the engine, and rejecting crosses into JS.
      // Neither belongs under a lock the callbacks also take.
      tts?.stop()
      dropped.forEach {
        discardFiles(it)
        it.promise.reject(CodedException("ERR_TTS_CANCELLED", "Synthesis was cancelled", null))
      }
      // A callback still arriving for a cancelled utterance finds no matching current
      // request and is ignored, which is what takeCurrent already does for a late one.
      promise.resolve(dropped.size)
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

  /**
   * Run [block] once the TTS engine is initialized, passing null if it failed or never
   * reported.
   *
   * The null-on-timeout half matters more than it looks: `TextToSpeech`'s init listener
   * is not guaranteed to fire, and on a device with no usable engine it may not. Without
   * a deadline here every caller waits forever — the same "promise never settles" failure
   * the synthesis watchdog exists for, one storey up, and NOT covered by it, because that
   * timer is armed in [start] and this never reaches [start].
   *
   * Each caller carries its own deadline rather than the module holding one init-wide
   * state machine: a late listener then still serves everyone who came after, and a
   * caller can never be woken twice.
   */
  private fun withEngine(block: (TextToSpeech?) -> Unit) {
    val delivered = AtomicBoolean(false)
    val once: (TextToSpeech?) -> Unit = { engine ->
      if (delivered.compareAndSet(false, true)) {
        block(engine)
      }
    }
    synchronized(initLock) {
      if (ready) {
        once(tts)
        return
      }
      initWaiters.add(once)
      watchdogHandler.postDelayed({ once(null) }, INIT_TIMEOUT_MS)
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

  /**
   * Start requests until one is running or the queue drains. Must hold [queueLock].
   *
   * A request that fails inside [start] re-enters here through [advance]; `pumping` turns
   * that nested call into a no-op so the failure just clears `processing` and this loop
   * moves to the next request. Without the guard each consecutive synchronous failure
   * adds a start→advance→pump frame, and the stack depth is whatever the queue length
   * happens to be.
   */
  private fun pumpLocked() {
    if (pumping) return
    pumping = true
    try {
      while (!processing) {
        val req = queue.removeFirstOrNull() ?: return
        processing = true
        current = req
        start(req)
      }
    } finally {
      pumping = false
    }
  }

  private fun advance() {
    synchronized(queueLock) {
      clearCurrentLocked()
      processing = false
      pumpLocked()
    }
  }

  /**
   * Best-effort removal of everything a failed or cancelled request wrote.
   *
   * A request that does not resolve never hands its uri to anyone, so whatever it wrote
   * is unreachable garbage — a cancelled long text was leaving a zero-length piece in the
   * cache, which then showed up as "0 bytes but 1 file" in the cache accounting. Deleting
   * while the engine may still hold the file is fine: at worst the delete fails and the
   * file remains an ordinary cache file, which clearCache() covers.
   */
  private fun discardFiles(req: Request) {
    req.chunks.forEach { it.file.delete() }
    req.file.delete()
  }

  /** Forget the in-flight request and disarm its watchdog. Must hold [queueLock]. */
  private fun clearCurrentLocked() {
    current?.let { disarmWatchdogLocked(it) }
    current = null
  }

  /** Must hold [queueLock]. */
  private fun disarmWatchdogLocked(req: Request) {
    req.watchdog?.let { watchdogHandler.removeCallbacks(it) }
    req.watchdog = null
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
      discardFiles(timedOut)
      timedOut.promise.reject(
        CodedException("ERR_TTS_TIMEOUT", "TTS synthesis did not finish within $timeoutMs ms", null)
      )
      advance()
    }
    req.watchdog = watchdog
    watchdogHandler.postDelayed(watchdog, timeoutMs)
  }

  /**
   * Hand [req] to the engine. Must hold [queueLock].
   *
   * The whole body is guarded because an exception escaping here escapes [pumpLocked] and
   * [enqueue] too, leaving `processing` set with the promise unsettled — the queue wedged
   * exactly as it was before the watchdog existed, and by a path the watchdog cannot
   * cover, since it is armed further down. `getVoices()` is the known offender: it throws
   * on some devices when the engine is not fully up.
   */
  private fun start(req: Request) {
    try {
      startUnguarded(req)
    } catch (e: Exception) {
      discardFiles(req)
      req.promise.reject(
        CodedException("ERR_TTS", "TTS engine failed to accept the request: ${e.message}", e)
      )
      advance()
    }
  }

  private fun startUnguarded(req: Request) {
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

    // {done: 0} up front, so a caller knows how many pieces are coming before the first
    // one lands — the first per-piece event otherwise arrives only after minutes of
    // silence on a long text.
    sendEvent(
      "onSynthesisProgress",
      mapOf("id" to req.id, "done" to 0, "total" to req.chunks.size)
    )
    if (!speakChunkLocked(req)) {
      discardFiles(req)
      req.promise.reject(CodedException("Failed to start synthesizeToFile"))
      advance()
    }
  }

  /**
   * Hand the request's current piece to the engine. Must hold [queueLock].
   *
   * The watchdog is armed before the engine is handed the text rather than after it
   * accepts it: this runs under [queueLock], so no callback can settle the piece in
   * between, and an engine that accepts the text and then says nothing is covered from
   * the start. It is re-armed per piece, so the budget applies to each one rather than
   * to a whole article.
   */
  private fun speakChunkLocked(req: Request): Boolean {
    armWatchdogLocked(req)
    val engine = tts ?: return false
    val chunk = req.chunk
    return engine.synthesizeToFile(chunk.text, Bundle(), chunk.file, req.utteranceId) ==
      TextToSpeech.SUCCESS
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
          req.chunk.marks.add(RawRange(start, end, frame))
        }
      }
    }

    override fun onDone(utteranceId: String?) {
      // Null also means "this piece is done and the next one is already running" — the
      // request is only handed back once every piece has been rendered.
      // finishPiece reports the progress event either way, so it is not repeated here.
      val req = finishPiece(utteranceId) ?: return
      try {
        if (req.aac) {
          encodeAac(req.chunks, req.file)
        } else if (req.chunks.size > 1) {
          concatWav(req.chunks, req.file)
        }
        req.promise.resolve(
          mapOf(
            "uri" to Uri.fromFile(req.file).toString(),
            "durationMs" to durationOf(req.file),
            "marks" to marksOf(req)
          )
        )
      } catch (e: Exception) {
        discardFiles(req)
        req.promise.reject(
          CodedException("ERR_TTS_FILE", "Could not assemble the audio: ${e.message}", e)
        )
      } finally {
        // Intermediates only: for single-piece PCM the one chunk IS the output file.
        if (req.aac || req.chunks.size > 1) {
          req.chunks.forEach { it.file.delete() }
        }
        advance()
      }
    }

    @Deprecated("Deprecated in Java", ReplaceWith(""))
    override fun onError(utteranceId: String?) {
      val req = takeCurrent(utteranceId) ?: return
      discardFiles(req)
      req.promise.reject(CodedException("TTS synthesis error"))
      advance()
    }

    override fun onError(utteranceId: String?, errorCode: Int) {
      val req = takeCurrent(utteranceId) ?: return
      discardFiles(req)
      req.promise.reject(CodedException("TTS synthesis error (code $errorCode)"))
      advance()
    }
  }

  /**
   * Called when the engine finishes a piece.
   *
   * Returns the request only when that was its LAST piece, having released it from the
   * queue; otherwise it starts the next piece and returns null, so the request stays in
   * flight and the caller's promise waits for the whole text rather than the first
   * 4000 characters of it.
   */
  private fun finishPiece(utteranceId: String?): Request? {
    synchronized(queueLock) {
      val req = current ?: return null
      if (req.utteranceId != utteranceId) {
        return null
      }
      disarmWatchdogLocked(req)
      // From inside the lock, but the payload is a snapshot: sendEvent hands the map to
      // the JS bridge without calling back into this module.
      sendEvent(
        "onSynthesisProgress",
        mapOf("id" to req.id, "done" to req.index + 1, "total" to req.chunks.size)
      )
      if (req.index + 1 >= req.chunks.size) {
        current = null
        return req
      }
      req.index++
      if (!speakChunkLocked(req)) {
        current = null
        discardFiles(req)
        req.promise.reject(
          CodedException("Failed to continue synthesizeToFile after part ${req.index}")
        )
        advance()
      }
      return null
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
  /**
   * The collected ranges as `[{start, end, timeMs}]`, in report order across every piece.
   *
   * Two offsets are applied so the numbers describe the ORIGINAL text and the JOINED
   * audio rather than the piece the engine happened to see: character indices shift by
   * where the piece starts in the text, and frames shift by everything rendered before
   * it. Returns empty rather than guessing when the sample rate cannot be read.
   */
  private fun marksOf(req: Request): List<Map<String, Int>> {
    val sampleRate = sampleRateOf(req.file)
    if (sampleRate <= 0) {
      return emptyList()
    }
    val out = mutableListOf<Map<String, Int>>()
    var framesBefore = 0L
    for (chunk in req.chunks) {
      for ((start, end, frame) in rangesOf(chunk)) {
        out.add(
          mapOf(
            "start" to start + chunk.charOffset,
            "end" to end + chunk.charOffset,
            // Long on purpose: frames * 1000 overflows Int a few minutes into an utterance.
            "timeMs" to ((framesBefore + frame).toLong() * 1000L / sampleRate).toInt()
          )
        )
      }
      framesBefore += chunk.frames
    }
    return out
  }

  /** The piece's ranges, read in whichever argument order describes its own text. */
  private fun rangesOf(chunk: Chunk): List<Triple<Int, Int, Int>> {
    if (chunk.marks.isEmpty()) {
      return emptyList()
    }
    // Two readings of the same three numbers. Whichever describes the text coherently is
    // the right one; the documented order wins a tie, so a conforming engine is never
    // second-guessed.
    val documented = chunk.marks.map { Triple(it.first, it.second, it.third) }
    val shifted = chunk.marks.map { Triple(it.second, it.third, it.first) }
    return when {
      describesText(documented, chunk.text.length) -> documented
      describesText(shifted, chunk.text.length) -> {
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
          "Discarding ${chunk.marks.size} speech ranges: neither argument order describes " +
            "the ${chunk.text.length}-character piece. Reporting no marks for it."
        )
        emptyList()
      }
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

  /**
   * Split [text] into pieces of at most [limit] characters, back to back and losing
   * nothing, each paired with where it starts in the original.
   *
   * Contiguity is the point: the reported character ranges are offsets into these pieces,
   * and they are shifted back onto the original text by exactly these offsets. A split
   * that dropped or duplicated a character would silently misplace every highlight after
   * it.
   *
   * Sentence boundaries are preferred so the engine's prosody has somewhere natural to
   * breathe; failing that a space, and failing that a hard cut, because a caller who
   * passes 12000 characters with no punctuation still deserves audio.
   */
  private fun splitForEngine(text: String, limit: Int): List<Pair<Int, String>> {
    if (limit <= 0 || text.length <= limit) {
      return listOf(0 to text)
    }
    val out = mutableListOf<Pair<Int, String>>()
    var pos = 0
    while (pos < text.length) {
      if (text.length - pos <= limit) {
        out.add(pos to text.substring(pos))
        break
      }
      val windowEnd = pos + limit
      var cut = -1
      for (i in windowEnd - 1 downTo pos) {
        if (text[i] in SENTENCE_ENDERS) {
          cut = i + 1
          break
        }
      }
      if (cut <= pos) {
        for (i in windowEnd - 1 downTo pos) {
          if (text[i].isWhitespace()) {
            cut = i + 1
            break
          }
        }
      }
      if (cut <= pos) {
        cut = windowEnd
      }
      out.add(pos to text.substring(pos, cut))
      pos = cut
    }
    return out
  }

  /**
   * Join the pieces' WAV files into [out], one header and their PCM back to back.
   *
   * The chunks are walked rather than read at fixed offsets: a WAV may carry `LIST` or
   * other chunks before `data`, and some engines write them. Audio is streamed rather
   * than loaded, so joining an article does not hold it all in memory, and each piece's
   * frame count is recorded on the way through — that is what shifts its timings onto the
   * joined audio.
   */
  private fun concatWav(chunks: List<Chunk>, out: File) {
    var format: ByteArray? = null
    val regions = mutableListOf<Triple<File, Long, Long>>()
    var total = 0L

    for (chunk in chunks) {
      val (fmt, dataAt, dataSize) = wavLayout(chunk.file)
      val known = format
      if (known == null) {
        format = fmt
      } else if (!fmt.copyOf(16).contentEquals(known.copyOf(16))) {
        throw IllegalStateException("the engine produced parts in different audio formats")
      }
      val blockAlign = leShort(fmt, 12)
      chunk.frames = if (blockAlign > 0) dataSize / blockAlign else 0L
      regions.add(Triple(chunk.file, dataAt, dataSize))
      total += dataSize
    }

    val fmt = format ?: throw IllegalStateException("nothing to join")
    if (total + fmt.size + 28 > Int.MAX_VALUE) {
      throw IllegalStateException("the joined audio is too large for a WAV container")
    }

    out.outputStream().buffered().use { sink ->
      sink.write("RIFF".toByteArray(Charsets.US_ASCII))
      sink.write(leBytes((4 + 8 + fmt.size + 8 + total).toInt()))
      sink.write("WAVE".toByteArray(Charsets.US_ASCII))
      sink.write("fmt ".toByteArray(Charsets.US_ASCII))
      sink.write(leBytes(fmt.size))
      sink.write(fmt)
      sink.write("data".toByteArray(Charsets.US_ASCII))
      sink.write(leBytes(total.toInt()))

      val buffer = ByteArray(64 * 1024)
      for ((file, at, size) in regions) {
        RandomAccessFile(file, "r").use { source ->
          source.seek(at)
          var left = size
          while (left > 0) {
            val n = source.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
            if (n <= 0) {
              throw IllegalStateException("part ended early: $file")
            }
            sink.write(buffer, 0, n)
            left -= n
          }
        }
      }
    }
  }

  /**
   * Encode the pieces' PCM into an AAC-LC `.m4a` at [out].
   *
   * The PCM is streamed straight out of the WAV pieces, so the joined audio never
   * exists on disk; like [concatWav] this fills in [Chunk.frames] while measuring the
   * pieces, which is what keeps the marks' timestamps right past the first piece.
   * MediaCodec runs synchronously here — the caller is the engine's callback thread,
   * where this module has nothing else to do until the request settles, exactly as
   * with the WAV join.
   */
  private fun encodeAac(chunks: List<Chunk>, out: File) {
    val regions = mutableListOf<Triple<File, Long, Long>>()
    var format: ByteArray? = null
    for (chunk in chunks) {
      val (fmt, dataAt, dataSize) = wavLayout(chunk.file)
      val known = format
      if (known == null) {
        format = fmt
      } else if (!fmt.copyOf(16).contentEquals(known.copyOf(16))) {
        throw IllegalStateException("the engine produced parts in different audio formats")
      }
      val blockAlign = leShort(fmt, 12)
      chunk.frames = if (blockAlign > 0) dataSize / blockAlign else 0L
      regions.add(Triple(chunk.file, dataAt, dataSize))
    }
    val fmt = format ?: throw IllegalStateException("nothing to encode")
    if (leShort(fmt, 0) != 1 || leShort(fmt, 14) != 16) {
      throw IllegalStateException("the engine did not produce 16-bit PCM")
    }
    val channels = leShort(fmt, 2)
    val sampleRate = leInt(fmt, 4)
    val blockAlign = leShort(fmt, 12)
    // The request's watchdog is already disarmed by the time the encode runs, so a codec
    // that stalls on some device would hang the promise forever — the exact state the
    // watchdog exists to prevent. Encoding runs far faster than real time, so a budget of
    // the audio's own duration plus a floor is generous, and blowing it turns into an
    // ordinary ERR_TTS_FILE rejection with the partials deleted.
    val deadline = android.os.SystemClock.elapsedRealtime() +
      30_000L + (if (sampleRate > 0) chunks.sumOf { it.frames } * 1000L / sampleRate else 0L)

    val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    var muxer: MediaMuxer? = null
    var muxerStarted = false
    var source: RandomAccessFile? = null
    try {
      codec.configure(
        MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channels).apply {
          setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
          // Per channel, since TTS output is mono or stereo depending on the engine.
          // 64 kbit/s of AAC-LC is transparent for speech at the rates engines use.
          setInteger(MediaFormat.KEY_BIT_RATE, 64_000 * channels)
        },
        null,
        null,
        MediaCodec.CONFIGURE_FLAG_ENCODE
      )
      codec.start()
      val mux = MediaMuxer(out.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      muxer = mux

      var track = -1
      var framesFed = 0L
      var inputDone = false
      var region = 0
      var left = 0L
      val scratch = ByteArray(16 * 1024)
      val info = MediaCodec.BufferInfo()

      while (true) {
        if (android.os.SystemClock.elapsedRealtime() > deadline) {
          throw IllegalStateException("the AAC encoder stalled")
        }
        if (!inputDone) {
          val inIdx = codec.dequeueInputBuffer(10_000L)
          if (inIdx >= 0) {
            // Move to the next non-empty piece; between pieces `source` is null.
            while (source == null && region < regions.size) {
              val (file, at, size) = regions[region]
              if (size > 0) {
                source = RandomAccessFile(file, "r").also { it.seek(at) }
                left = size
              } else {
                region++
              }
            }
            val pcm = source
            val ptsUs = framesFed * 1_000_000L / sampleRate
            if (pcm == null) {
              codec.queueInputBuffer(inIdx, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              inputDone = true
            } else {
              val buf = codec.getInputBuffer(inIdx)
                ?: throw IllegalStateException("encoder handed out no input buffer")
              buf.clear()
              // Whole PCM frames only, or the encoder's channel alignment drifts.
              val want = (minOf(buf.remaining().toLong(), scratch.size.toLong(), left).toInt())
                .let { it - it % blockAlign }
              val n = pcm.read(scratch, 0, want)
              if (n <= 0) {
                throw IllegalStateException("part ended early: ${regions[region].first}")
              }
              buf.put(scratch, 0, n)
              codec.queueInputBuffer(inIdx, 0, n, ptsUs, 0)
              framesFed += n / blockAlign
              left -= n
              if (left == 0L) {
                pcm.close()
                source = null
                region++
              }
            }
          }
        }
        val outIdx = codec.dequeueOutputBuffer(info, 10_000L)
        if (outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
          track = mux.addTrack(codec.outputFormat)
          mux.start()
          muxerStarted = true
        } else if (outIdx >= 0) {
          val outBuf = codec.getOutputBuffer(outIdx)
          // The config buffer (the AudioSpecificConfig) travels in the track format
          // above; writing it as a sample would corrupt the stream.
          if (outBuf != null && info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
            if (track < 0) {
              throw IllegalStateException("encoder produced audio before its format")
            }
            mux.writeSampleData(track, outBuf, info)
          }
          codec.releaseOutputBuffer(outIdx, false)
          if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) {
            break
          }
        }
      }
    } finally {
      // stop() throws when start() never ran (an encode that failed before any output);
      // the file is garbage then and the caller deletes it, so the state error is noise.
      runCatching { source?.close() }
      runCatching { codec.stop() }
      runCatching { codec.release() }
      if (muxerStarted) {
        runCatching { muxer?.stop() }
      }
      runCatching { muxer?.release() }
    }
  }

  /** The file's `fmt ` body plus where its `data` body starts and how long it is. */
  private fun wavLayout(file: File): Triple<ByteArray, Long, Long> {
    RandomAccessFile(file, "r").use { source ->
      val riff = ByteArray(12)
      source.readFully(riff)
      if (String(riff, 0, 4, Charsets.US_ASCII) != "RIFF" ||
        String(riff, 8, 4, Charsets.US_ASCII) != "WAVE"
      ) {
        throw IllegalStateException("not a WAV file: $file")
      }
      var fmt: ByteArray? = null
      while (source.filePointer + 8 <= source.length()) {
        val head = ByteArray(8)
        source.readFully(head)
        val id = String(head, 0, 4, Charsets.US_ASCII)
        val size = leInt(head, 4).toLong() and 0xFFFFFFFFL
        val body = source.filePointer
        when (id) {
          "fmt " -> {
            val bytes = ByteArray(size.toInt())
            source.readFully(bytes)
            fmt = bytes
          }
          "data" -> return Triple(
            fmt ?: throw IllegalStateException("fmt chunk missing in $file"),
            body,
            size
          )
        }
        // Chunks are padded to an even length.
        source.seek(body + size + (size and 1L))
      }
      throw IllegalStateException("data chunk missing in $file")
    }
  }

  private fun leInt(bytes: ByteArray, at: Int): Int =
    (bytes[at].toInt() and 0xFF) or
      ((bytes[at + 1].toInt() and 0xFF) shl 8) or
      ((bytes[at + 2].toInt() and 0xFF) shl 16) or
      ((bytes[at + 3].toInt() and 0xFF) shl 24)

  private fun leShort(bytes: ByteArray, at: Int): Int =
    (bytes[at].toInt() and 0xFF) or ((bytes[at + 1].toInt() and 0xFF) shl 8)

  private fun leBytes(value: Int): ByteArray = byteArrayOf(
    (value and 0xFF).toByte(),
    ((value ushr 8) and 0xFF).toByte(),
    ((value ushr 16) and 0xFF).toByte(),
    ((value ushr 24) and 0xFF).toByte()
  )

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
    // Far above what any synthesis the engine would have completed takes, and short
    // enough that an app recovers within the session instead of at the next launch.
    private const val DEFAULT_TIMEOUT_MS = 60_000L

    // Binding to a TTS service is quick when it works at all; a device that has not
    // reported in this long is not about to.
    private const val INIT_TIMEOUT_MS = 15_000L

    // Where a long text is preferably cut. Latin and CJK terminators both, because the
    // module is used for language learning and the text is not always Latin.
    private const val SENTENCE_ENDERS = ".!?…。！？"
  }
}
