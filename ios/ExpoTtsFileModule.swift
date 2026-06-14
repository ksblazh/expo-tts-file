import ExpoModulesCore
import AVFoundation

struct SynthesizeOptions: Record {
  @Field var language: String = "en-US"
  @Field var rate: Double?
  @Field var pitch: Double?
  @Field var voice: String?
}

public class ExpoTtsFileModule: Module {
  // Synthesizers are retained for the duration of a write() so they are not
  // deallocated mid-synthesis (the buffer callback would then never complete).
  private var active = Set<AVSpeechSynthesizer>()

  public func definition() -> ModuleDefinition {
    Name("ExpoTtsFile")

    AsyncFunction("synthesizeToFile") { (text: String, options: SynthesizeOptions, promise: Promise) in
      self.synthesize(text: text, options: options, promise: promise)
    }

    AsyncFunction("getVoices") { (language: String?) -> [[String: Any]] in
      return AVSpeechSynthesisVoice.speechVoices()
        .filter { language == nil || $0.language.hasPrefix(language!) }
        .map { voice in
          [
            "identifier": voice.identifier,
            "name": voice.name,
            "language": voice.language,
            "quality": ExpoTtsFileModule.qualityString(voice.quality),
          ]
        }
    }
  }

  private func synthesize(text: String, options: SynthesizeOptions, promise: Promise) {
    let utterance = AVSpeechUtterance(string: text)
    if let voiceId = options.voice, let voice = AVSpeechSynthesisVoice(identifier: voiceId) {
      utterance.voice = voice
    } else {
      utterance.voice = AVSpeechSynthesisVoice(language: options.language)
    }
    if let rate = options.rate {
      utterance.rate = max(
        AVSpeechUtteranceMinimumSpeechRate,
        min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * Float(rate))
      )
    }
    if let pitch = options.pitch {
      utterance.pitchMultiplier = max(0.5, min(2.0, Float(pitch)))
    }

    let fileURL: URL
    do {
      fileURL = try Self.outputFileURL()
    } catch {
      promise.reject("ERR_TTS_FILE", "Could not create output file: \(error.localizedDescription)")
      return
    }

    let synthesizer = AVSpeechSynthesizer()
    DispatchQueue.main.async { self.active.insert(synthesizer) }

    var audioFile: AVAudioFile?
    var totalFrames: AVAudioFramePosition = 0
    var sampleRate: Double = 0
    var settled = false

    let finish: (Result<Void, Error>) -> Void = { [weak self] result in
      if settled { return }
      settled = true
      DispatchQueue.main.async { self?.active.remove(synthesizer) }
      switch result {
      case .success:
        let durationMs = sampleRate > 0 ? Int(Double(totalFrames) / sampleRate * 1000.0) : 0
        promise.resolve([
          "uri": fileURL.absoluteString,
          "durationMs": durationMs,
        ])
      case .failure(let error):
        promise.reject("ERR_TTS", error.localizedDescription)
      }
    }

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
        totalFrames += AVAudioFramePosition(pcmBuffer.frameLength)
      } catch {
        finish(.failure(error))
      }
    }
  }

  private static func outputFileURL() throws -> URL {
    let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
    let dir = caches.appendingPathComponent("expo-tts-file", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("tts-\(UUID().uuidString).caf")
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
