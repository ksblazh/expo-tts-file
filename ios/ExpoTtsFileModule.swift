import ExpoModulesCore
import AVFoundation

struct SynthesizeOptions: Record {
  @Field var language: String = "en-US"
  @Field var rate: Double?
  @Field var pitch: Double?
  @Field var voice: String?
  @Field var ipa: String?
  @Field var timeoutMs: Double?
}

struct SpeechSegment: Record {
  @Field var text: String = ""
  @Field var ipa: String?
}

// Completion relay for the live synthesizer: resolves speakIpa/speakSsml promises on
// natural finish (true) or cancellation (false) so JS can chain playback correctly.
private class LiveSpeechDelegate: NSObject, AVSpeechSynthesizerDelegate {
  // The completion is keyed by the utterance it belongs to. didCancel for a stopped
  // utterance is delivered asynchronously, so an unkeyed completion would be settled
  // by the cancellation of the utterance it just replaced — resolving the new promise
  // false while its speech is in fact playing.
  private var pending: (utterance: AVSpeechUtterance, completion: (Bool) -> Void)?

  func expect(_ utterance: AVSpeechUtterance, completion: @escaping (Bool) -> Void) {
    pending = (utterance, completion)
  }

  /// Settle whatever is pending (used when a new utterance supersedes it).
  func settleNow(_ finished: Bool) {
    guard let current = pending else { return }
    pending = nil
    current.completion(finished)
  }

  private func settle(_ utterance: AVSpeechUtterance, _ finished: Bool) {
    guard let current = pending, current.utterance === utterance else { return }
    pending = nil
    current.completion(finished)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    settle(utterance, true)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    settle(utterance, false)
  }
}

// Frames rendered so far, plus the character ranges collected against them. The buffer
// callback and the delegate's range callback are not documented to run on the same queue,
// so both go through one lock rather than sharing a captured variable.
//
// Stamping a range with the frame count AT THE MOMENT IT IS REPORTED is the whole trick:
// write() reports ranges as it renders, long before anything is played, so the range on
// its own says nothing about when to highlight. Paired with the frames already produced,
// it becomes a playback timestamp.
private final class RenderProgress {
  private let lock = NSLock()
  private var frames: AVAudioFramePosition = 0
  private var collected: [(range: NSRange, frame: AVAudioFramePosition)] = []

  func advance(by count: AVAudioFrameCount) {
    lock.lock()
    defer { lock.unlock() }
    frames += AVAudioFramePosition(count)
  }

  func mark(_ range: NSRange) {
    lock.lock()
    defer { lock.unlock() }
    collected.append((range, frames))
  }

  var totalFrames: AVAudioFramePosition {
    lock.lock()
    defer { lock.unlock() }
    return frames
  }

  /// `[["start": Int, "end": Int, "timeMs": Int]]`, in report order.
  ///
  /// NSRange counts UTF-16 code units, which is also how JavaScript indexes strings, so
  /// these cross the bridge as usable `text.slice(start, end)` bounds without conversion.
  func marks(sampleRate: Double) -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    guard sampleRate > 0 else { return [] }
    return collected.map { entry in
      [
        "start": entry.range.location,
        "end": entry.range.location + entry.range.length,
        "timeMs": Int(Double(entry.frame) / sampleRate * 1000.0),
      ]
    }
  }
}

// Relays the ranges the synthesizer reports while rendering into a RenderProgress.
// AVSpeechSynthesizer holds `delegate` weakly, so whoever installs one of these must keep
// a strong reference for the lifetime of the write.
private class MarkCollector: NSObject, AVSpeechSynthesizerDelegate {
  private let progress: RenderProgress

  init(progress: RenderProgress) {
    self.progress = progress
  }

  /// Reading the marks through the collector is what keeps it alive: see the note where
  /// it is installed.
  func marks(sampleRate: Double) -> [[String: Any]] {
    return progress.marks(sampleRate: sampleRate)
  }

  func speechSynthesizer(
    _ synthesizer: AVSpeechSynthesizer,
    willSpeakRangeOfSpeechString characterRange: NSRange,
    utterance: AVSpeechUtterance
  ) {
    // A range that does not fall inside the spoken text is dropped rather than passed on.
    // Android's equivalent callback turned out to deliver its arguments in an order the
    // documentation did not imply, which shipped frame counters as character offsets; the
    // same class of mistake degrades to "no marks" here instead of to nonsense.
    let length = utterance.speechString.utf16.count
    guard characterRange.location >= 0,
          characterRange.length > 0,
          characterRange.location + characterRange.length <= length else {
      return
    }
    progress.mark(characterRange)
  }
}

public class ExpoTtsFileModule: Module {
  // Synthesizers are retained for the duration of a write() so they are not
  // deallocated mid-synthesis (the buffer callback would then never complete).
  private var active = Set<AVSpeechSynthesizer>()
  // One entry per synthesis in flight; calling it settles that request as cancelled and
  // reports whether it was the one to do so. Touched on the main queue only, alongside
  // `active`, so the two never disagree about what is running.
  private var cancellers: [ObjectIdentifier: () -> Bool] = [:]
  // Live-path synthesizer for speakIpa/speakSsml. On the IPA attribute (device-verified,
  // iOS 26.5): it is honored on BOTH paths — speak() and write() — but only when the
  // attributed text is LATIN. Over Cyrillic the voice falls back to its own lexicon and
  // the transcription is ignored, which is what made the first write() round read as
  // "write() drops the attribute". So file synthesis carries ударение too, as long as
  // callers pass a Latin carrier (see synthesizeMixedToFile / SynthesizeOptions.ipa).
  private let liveSynth = AVSpeechSynthesizer()
  private let liveDelegate = LiveSpeechDelegate()
  // Watchdog default for the file path, in seconds. The live path has no equivalent:
  // speech has no expected duration to measure against, and stopLiveSpeech() is already
  // the way out of it.
  private static let defaultTimeout: TimeInterval = 60

  // Replace any pending completion (cancelled) and speak on the main queue
  // (AVSpeechSynthesizer playback is main-thread-sensitive). The previous promise is
  // settled and the synthesizer stopped BEFORE the new completion is registered, so the
  // late didCancel of the stopped utterance cannot settle the new one.
  private func liveSpeak(_ utterance: AVSpeechUtterance, promise: Promise) {
    DispatchQueue.main.async {
      if self.liveSynth.delegate == nil { self.liveSynth.delegate = self.liveDelegate }
      self.liveDelegate.settleNow(false)
      self.liveSynth.stopSpeaking(at: .immediate)
      self.liveDelegate.expect(utterance) { finished in promise.resolve(finished) }
      self.liveSynth.speak(utterance)
    }
  }

  public func definition() -> ModuleDefinition {
    Name("ExpoTtsFile")

    // Fired once per finished piece of a synthesis. iOS has no input-length limit, so a
    // synthesis is always a single piece and one {1, 1} arrives just before the promise
    // resolves — the event exists here so cross-platform code can subscribe without a
    // platform check, not because it carries information on this platform.
    Events("onSynthesisProgress")

    AsyncFunction("synthesizeToFile") { (text: String, options: SynthesizeOptions, promise: Promise) in
      self.synthesize(
        utterance: Self.utterance(text: text, ipa: options.ipa, options: options),
        options: options,
        promise: promise
      )
    }

    // Attributed synthesis to a FILE: the same per-word IPA ranges as speakMixed, but
    // through write(). This is what lets a background/offline player (a podcast built
    // from clips) carry ударение inside sentences — marked words ride as Latin-carrier
    // runs with their own transcription, the rest of the sentence reads naturally.
    AsyncFunction("synthesizeMixedToFile") { (segments: [SpeechSegment], options: SynthesizeOptions, promise: Promise) in
      guard let utterance = Self.mixedUtterance(segments: segments, options: options) else {
        promise.reject("ERR_TTS", "No speakable segments.")
        return
      }
      self.synthesize(utterance: utterance, options: options, promise: promise)
    }

    // Live speech with the IPA attribute (same options as synthesizeToFile) — for
    // interactive playback, where waiting on a file write is pointless. Speak runs on
    // the MAIN queue (AVSpeechSynthesizer playback is main-thread-sensitive).
    AsyncFunction("speakIpa") { (text: String, options: SynthesizeOptions, promise: Promise) in
      self.liveSpeak(Self.utterance(text: text, ipa: options.ipa, options: options), promise: promise)
    }

    // Live speech from an SSML document (iOS 16+): a SEPARATE parser from the IPA
    // attribute — <phoneme alphabet="ipa" ph="..."> may work where the attribute
    // does not. Resolves false when SSML is unsupported/unparseable.
    AsyncFunction("speakSsml") { (ssml: String, options: SynthesizeOptions, promise: Promise) in
      if #available(iOS 16.0, *) {
        guard let utterance = AVSpeechUtterance(ssmlRepresentation: ssml) else {
          promise.resolve(false)
          return
        }
        if utterance.voice == nil {
          utterance.voice = Self.resolveVoice(identifier: options.voice, language: options.language)
        } else if let voiceId = options.voice, let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
          utterance.voice = voice
        }
        self.liveSpeak(utterance, promise: promise)
      } else {
        promise.resolve(false)
      }
    }

    // Live speech from SEGMENTS — Apple honors the IPA attribute per WORD range,
    // so a sentence rides as [plain Cyrillic runs] + [marked words as Latin-carrier
    // text with their own IPA attribute]. Unmarked words keep the voice's natural
    // reading; only the corrected words are steered.
    AsyncFunction("speakMixed") { (segments: [SpeechSegment], options: SynthesizeOptions, promise: Promise) in
      guard let utterance = Self.mixedUtterance(segments: segments, options: options) else {
        promise.resolve(false)
        return
      }
      self.liveSpeak(utterance, promise: promise)
    }

    // Stop the live path (speakIpa/speakSsml/speakMixed); a pending completion resolves false.
    AsyncFunction("stopLiveSpeech") { (promise: Promise) in
      DispatchQueue.main.async {
        // Settle the pending promise here instead of waiting for didCancel: an
        // immediate stop does not reliably deliver it (device-observed on iOS 26:
        // didFinish arrives instead), which resolved `true` for speech the caller had
        // just stopped — indistinguishable from a natural finish.
        self.liveDelegate.settleNow(false)
        self.liveSynth.stopSpeaking(at: .immediate)
        promise.resolve(nil)
      }
    }

    AsyncFunction("getVoices") { (language: String?) -> [[String: Any]] in
      // Compared lower-cased: BCP-47 is case-insensitive, and the region subtag is
      // conventionally upper-case, so a caller passing "RU" or "en-us" was previously
      // told no such voice exists.
      let prefix = language?.lowercased()
      return AVSpeechSynthesisVoice.speechVoices()
        .filter { voice in
          guard let prefix else { return true }
          return voice.language.lowercased().hasPrefix(prefix)
        }
        .map { voice in
          [
            "identifier": voice.identifier,
            "name": voice.name,
            "language": voice.language,
            "quality": ExpoTtsFileModule.qualityString(voice.quality),
          ]
        }
    }

    // The module's only output is files and nothing else removes them, so it owns the
    // three operations over its own directory. Deliberately NOT a general file API:
    // deleting anything else is `expo-file-system`'s job, and confining these keeps the
    // worst case at "deleted a clip", which re-synthesizing undoes.
    AsyncFunction("deleteFile") { (uri: String, promise: Promise) in
      guard let file = Self.cacheFileURL(uri) else {
        promise.reject(
          "ERR_TTS_FOREIGN_FILE",
          "\(uri) was not written by expo-tts-file. Delete other files with expo-file-system."
        )
        return
      }
      do {
        // Already gone is success, not failure: the OS evicts the caches directory under
        // storage pressure, so a missing file is the state the caller asked for.
        if FileManager.default.fileExists(atPath: file.path) {
          try FileManager.default.removeItem(at: file)
        }
        promise.resolve(nil)
      } catch {
        promise.reject("ERR_TTS_FILE", "Could not delete \(uri): \(error.localizedDescription)")
      }
    }

    AsyncFunction("clearCache") { () -> Int in
      let manager = FileManager.default
      // Counts what actually went, not what was attempted.
      return Self.cacheFiles().reduce(into: 0) { removed, url in
        if (try? manager.removeItem(at: url)) != nil {
          removed += 1
        }
      }
    }

    // Abandon every synthesis in flight, resolving with how many were dropped — enough
    // for a screen being unmounted to tell whether it interrupted work or arrived after
    // it finished. Covers the file path only; the live one has stopLiveSpeech().
    AsyncFunction("cancelAll") { (promise: Promise) in
      DispatchQueue.main.async {
        let pending = self.cancellers.values
        self.cancellers.removeAll()
        promise.resolve(pending.reduce(0) { $0 + ($1() ? 1 : 0) })
      }
    }

    AsyncFunction("getCacheSize") { () -> Int in
      return Self.cacheFiles().reduce(into: 0) { total, url in
        total += (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
      }
    }
  }

  // IPA pronunciation override: the WHOLE `text` range is pronounced per the given IPA
  // string via Apple's attributed-utterance mechanism — the only public way to steer
  // pronunciation (e.g. Russian ударение: the bundled voices ignore combining acute
  // marks in plain text). Honored by the classic Vocalizer voices ON LATIN TEXT; some
  // newer Siri voices ignore the attribute — callers verify by ear (speech lab).
  private static func utterance(text: String, ipa: String?, options: SynthesizeOptions) -> AVSpeechUtterance {
    let utterance: AVSpeechUtterance
    if let ipa, !ipa.isEmpty {
      let key = NSAttributedString.Key(rawValue: AVSpeechSynthesisIPANotationAttribute)
      utterance = AVSpeechUtterance(attributedString: NSAttributedString(string: text, attributes: [key: ipa]))
    } else {
      utterance = AVSpeechUtterance(string: text)
    }
    applyProsody(utterance, options)
    return utterance
  }

  // Apple honors the attribute per RANGE, so a sentence rides as [plain runs] +
  // [marked words as Latin-carrier text with their own IPA]. nil = nothing to say.
  private static func mixedUtterance(segments: [SpeechSegment], options: SynthesizeOptions) -> AVSpeechUtterance? {
    let attributed = NSMutableAttributedString()
    let key = NSAttributedString.Key(rawValue: AVSpeechSynthesisIPANotationAttribute)
    for seg in segments where !seg.text.isEmpty {
      if let ipa = seg.ipa, !ipa.isEmpty {
        attributed.append(NSAttributedString(string: seg.text, attributes: [key: ipa]))
      } else {
        attributed.append(NSAttributedString(string: seg.text))
      }
    }
    if attributed.length == 0 {
      return nil
    }
    let utterance = AVSpeechUtterance(attributedString: attributed)
    applyProsody(utterance, options)
    return utterance
  }

  private static func applyProsody(_ utterance: AVSpeechUtterance, _ options: SynthesizeOptions) {
    utterance.voice = resolveVoice(identifier: options.voice, language: options.language)
    if let rate = options.rate {
      utterance.rate = max(
        AVSpeechUtteranceMinimumSpeechRate,
        min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * Float(rate))
      )
    }
    if let pitch = options.pitch {
      utterance.pitchMultiplier = max(0.5, min(2.0, Float(pitch)))
    }
  }

  private func synthesize(utterance: AVSpeechUtterance, options: SynthesizeOptions, promise: Promise) {
    let fileURL: URL
    do {
      fileURL = try Self.outputFileURL()
    } catch {
      promise.reject("ERR_TTS_FILE", "Could not create output file: \(error.localizedDescription)")
      return
    }

    let synthesizer = AVSpeechSynthesizer()
    let key = ObjectIdentifier(synthesizer)

    var audioFile: AVAudioFile?
    var sampleRate: Double = 0
    let progress = RenderProgress()
    // AVSpeechSynthesizer holds `delegate` WEAKLY. Assigning one and walking away
    // deallocates it the moment this function returns, and no range is ever reported —
    // which is exactly what shipped: playback and timings fine, highlighting silently
    // absent. The collector survives because `finish` below reads the marks out of it,
    // and `finish` is retained by the write callback for the duration of the write.
    let collector = MarkCollector(progress: progress)
    synthesizer.delegate = collector

    // The buffer callback and the watchdog below race to settle the promise, from
    // different queues, so the flag they race on is read and set under a lock rather
    // than in two steps. Exactly one caller is told it may proceed.
    let settleLock = NSLock()
    var settled = false
    let claim: () -> Bool = {
      settleLock.lock()
      defer { settleLock.unlock() }
      if settled { return false }
      settled = true
      return true
    }

    // write() signals completion with a zero-length buffer. An engine that never sends
    // one leaves the promise pending for the life of the app and the synthesizer
    // retained in `active`, so a timer settles it instead — recovery for a stuck engine,
    // not a deadline for slow synthesis (see SynthesizeOptions.timeoutMs).
    let timeout = options.timeoutMs.map { $0 / 1000.0 } ?? Self.defaultTimeout
    // The synthesizer is captured weakly: cancelling a work item does not dequeue it, so
    // a cancelled watchdog still holds whatever it captured until its deadline passes —
    // which, for a caller synthesizing clip after clip, would pile up a minute's worth of
    // finished synthesizers. Whenever this body has real work to do, `active` is still
    // holding the object anyway.
    let watchdog = DispatchWorkItem { [weak self, weak synthesizer] in
      // Claiming commits this body to settling the promise: anything it can bail out of
      // has to be checked before the claim, or the promise it took ownership of would
      // hang exactly the way this timer exists to prevent.
      guard claim() else { return }
      // `audioFile` is deliberately left alone here: the buffer callback may be writing
      // to it on its own queue at this moment, and closing it from a second thread is
      // the one thing worse than the leak. Dropping the synthesizer ends the callbacks;
      // the partial file stays in the cache like every other file this module writes.
      if let synthesizer {
        synthesizer.stopSpeaking(at: .immediate)
        self?.active.remove(synthesizer)
      }
      self?.cancellers.removeValue(forKey: key)
      // Unlinking while the writer may still hold the file is safe on this platform; at
      // worst the delete fails and the partial stays an ordinary cache file.
      try? FileManager.default.removeItem(at: fileURL)
      promise.reject(
        "ERR_TTS_TIMEOUT",
        "Speech synthesis did not finish within \(Int(timeout * 1000)) ms"
      )
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + timeout, execute: watchdog)

    // Registered together with `active` so a cancel can never see one without the other.
    // The canceller races the buffer callback and the watchdog through the same claim,
    // so at most one of the three settles the promise.
    DispatchQueue.main.async {
      self.active.insert(synthesizer)
      self.cancellers[key] = { [weak self, weak synthesizer] in
        guard claim() else { return false }
        watchdog.cancel()
        if let synthesizer {
          synthesizer.stopSpeaking(at: .immediate)
          self?.active.remove(synthesizer)
        }
        try? FileManager.default.removeItem(at: fileURL)
        promise.reject("ERR_TTS_CANCELLED", "Synthesis was cancelled.")
        return true
      }
    }

    let finish: (Result<Void, Error>) -> Void = { [weak self] result in
      guard claim() else { return }
      watchdog.cancel()
      // Close the file BEFORE resolving: AVAudioFile finalizes the header when it is
      // deallocated, and the caller may open the URI the instant the promise resolves.
      audioFile = nil
      DispatchQueue.main.async {
        self?.active.remove(synthesizer)
        self?.cancellers.removeValue(forKey: key)
      }
      switch result {
      case .success:
        let frames = progress.totalFrames
        let durationMs = sampleRate > 0 ? Int(Double(frames) / sampleRate * 1000.0) : 0
        self?.sendEvent(
          "onSynthesisProgress",
          // Matches Android's payload: the bare id, such that the uri's file name is
          // "tts-<id>" plus the platform extension.
          [
            "id": String(fileURL.deletingPathExtension().lastPathComponent.dropFirst(4)),
            "done": 1,
            "total": 1,
          ]
        )
        promise.resolve([
          "uri": fileURL.absoluteString,
          "durationMs": durationMs,
          "marks": collector.marks(sampleRate: sampleRate),
        ])
      case .failure(let error):
        try? FileManager.default.removeItem(at: fileURL)
        promise.reject("ERR_TTS", error.localizedDescription)
      }
    }

    // {done: 0} up front, mirroring Android, so subscribers see the start of every
    // synthesis and not only its completion.
    sendEvent(
      "onSynthesisProgress",
      ["id": String(fileURL.deletingPathExtension().lastPathComponent.dropFirst(4)), "done": 0, "total": 1]
    )
    synthesizer.write(utterance) { (buffer: AVAudioBuffer) in
      guard let pcmBuffer = buffer as? AVAudioPCMBuffer else {
        finish(.failure(TtsError.unexpectedBuffer))
        return
      }

      // A zero-length buffer signals that synthesis is complete.
      if pcmBuffer.frameLength == 0 {
        if audioFile == nil {
          finish(.failure(TtsError.noAudioProduced))
        } else {
          finish(.success(()))
        }
        return
      }

      do {
        if audioFile == nil {
          sampleRate = pcmBuffer.format.sampleRate
          audioFile = try AVAudioFile(
            forWriting: fileURL,
            settings: pcmBuffer.format.settings,
            commonFormat: pcmBuffer.format.commonFormat,
            interleaved: pcmBuffer.format.isInterleaved
          )
        }
        try audioFile?.write(from: pcmBuffer)
        progress.advance(by: pcmBuffer.frameLength)
      } catch {
        finish(.failure(error))
      }
    }
  }

  // Voice by identifier → exact BCP-47 language → language-prefix match ("ru" finds
  // "ru-RU"): AVSpeechSynthesisVoice(language:) is strict about full tags and would
  // otherwise return nil for a bare "ru".
  private static func resolveVoice(identifier: String?, language: String) -> AVSpeechSynthesisVoice? {
    if let id = identifier, let voice = AVSpeechSynthesisVoice(identifier: id) {
      return voice
    }
    if let voice = AVSpeechSynthesisVoice(language: language) {
      return voice
    }
    let prefix = language.lowercased().split(separator: "-")[0]
    return AVSpeechSynthesisVoice.speechVoices().first {
      $0.language.lowercased().hasPrefix(prefix)
    }
  }

  private static func cacheDirectoryURL() throws -> URL {
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let dir = caches.appendingPathComponent("expo-tts-file", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  private static func outputFileURL() throws -> URL {
    return try cacheDirectoryURL().appendingPathComponent("tts-\(UUID().uuidString).caf")
  }

  /// The file `uri` names, or nil if this module did not write it.
  ///
  /// Symlinks and `..` are resolved BEFORE the comparison, so a path that merely looks
  /// contained does not pass. The parent directory is compared rather than a string
  /// prefix — a prefix test would also accept a sibling directory whose name happens to
  /// start the same way, and the module writes flat into one directory anyway.
  private static func cacheFileURL(_ uri: String) -> URL? {
    guard let url = URL(string: uri), url.isFileURL,
          let dir = try? cacheDirectoryURL() else {
      return nil
    }
    let resolved = url.standardizedFileURL.resolvingSymlinksInPath()
    let root = dir.standardizedFileURL.resolvingSymlinksInPath()
    // Compared as paths, not as URLs: the directory URL carries a trailing slash and the
    // one from deletingLastPathComponent() may not, which would make every file look
    // foreign. `path` normalizes that away.
    return resolved.deletingLastPathComponent().path == root.path ? resolved : nil
  }

  private static func cacheFiles() -> [URL] {
    guard let dir = try? cacheDirectoryURL() else {
      return []
    }
    let contents = try? FileManager.default.contentsOfDirectory(
      at: dir,
      includingPropertiesForKeys: [.fileSizeKey],
      options: [.skipsHiddenFiles]
    )
    return contents ?? []
  }

  private static func qualityString(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
    switch quality {
    case .enhanced: return "enhanced"
    case .premium: return "premium"
    default: return "default"
    }
  }

  private enum TtsError: LocalizedError {
    case unexpectedBuffer
    case noAudioProduced

    var errorDescription: String? {
      switch self {
      case .unexpectedBuffer: return "Speech synthesizer returned an unexpected buffer type."
      case .noAudioProduced: return "Speech synthesizer produced no audio (empty or invalid text?)."
      }
    }
  }
}
