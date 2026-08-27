import Constants from 'expo-constants';
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from 'expo-audio';
import {
  clearCache,
  deleteFile,
  getCacheSize,
  getVoices,
  synthesizeToFile,
  type SpeechMark,
  type SynthesisResult,
  type Voice,
} from 'expo-tts-file';
import { useEffect, useMemo, useState } from 'react';
import { Button, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

// Long enough to start playback and then background the app or lock the screen to verify
// that audio keeps playing. No dashes: they add nothing here, some engines read them as an
// odd pause, and plain sentences are easier to follow when the words light up one by one.
const DEFAULT_TEXT =
  'This is a background audio test for the expo-tts-file module. ' +
  'Edit this text, optionally pick a voice in another language below, then generate and play it. ' +
  'A passage of this length lets you start playback, send the app to the background or lock the ' +
  'screen, and confirm that the audio keeps going. The quick brown fox jumps over the lazy dog, ' +
  'again and again, until you are satisfied that on-device text to speech works end to end.';

export default function App() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [langFilter, setLangFilter] = useState('en');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voice, setVoice] = useState<Voice | null>(null); // null = default (en-US)
  const [result, setResult] = useState<SynthesisResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watchdogLog, setWatchdogLog] = useState<string[]>([]);
  const [cacheLog, setCacheLog] = useState<string[]>([]);
  const [cacheSize, setCacheSize] = useState<number | null>(null);
  const [spokenText, setSpokenText] = useState('');

  // The player reports its own state, so nothing below infers it. Every earlier attempt to
  // derive "playing" and "finished" from a polled clock was wrong in a different way:
  // seeking is asynchronous, so a fresh reading can still describe the previous position,
  // and a threshold cannot tell a paused clip from a finished one. 50 ms because the
  // default 500 is far too coarse to light words up in time.
  const player = useAudioPlayer(result?.uri ?? undefined, { updateInterval: 50 });
  const status = useAudioPlayerStatus(player);
  const marks = result?.marks ?? [];
  const positionMs = Math.round((status.currentTime ?? 0) * 1000);
  const playing = status.playing;

  // Rewind the moment the clip ends rather than when Play is next pressed. `didJustFinish`
  // is the player's own signal; inferring it from the playhead is what produced a Play
  // button needing two presses. The progress bar returning to zero and the highlight going
  // out both fall out of the position being 0 again — no separate bookkeeping.
  useEffect(() => {
    if (status.didJustFinish) {
      // Paused BEFORE the rewind, and not only for tidiness: Android leaves the player
      // ready to play when it reaches the end, so seeking back to zero there resumes it
      // and the clip loops. iOS has already stopped by this point, where the extra pause
      // does nothing.
      player.pause();
      player.seekTo(0);
    }
  }, [status.didJustFinish, player]);

  // The mark that has started most recently — marks arrive in order, so the last one at
  // or before the playhead is the word being spoken. Nothing is lit while the clip sits at
  // the start; a pause deliberately keeps the current word lit.
  const activeMark = useMemo(() => {
    if (!playing && positionMs === 0) {
      return null;
    }
    let current: SpeechMark | null = null;
    for (const mark of marks) {
      if (mark.timeMs > positionMs) {
        break;
      }
      current = mark;
    }
    return current;
  }, [marks, positionMs, playing]);

  // Built as a list of Text children rather than raw strings interleaved with an element:
  // Android renders the uniform shape predictably, and the mixed one did not.
  //
  // The highlight runs to where the NEXT mark begins rather than to where this one ends.
  // Engines tokenize as they please — Apple reports "expo-tts" and leaves "-file" out of
  // any range — so painting only the reported span leaves holes over hyphens and
  // punctuation. Sweeping to the next word covers them and reads as continuous. This is a
  // rendering choice; the marks themselves stay exactly as the engine reported them.
  const parts = useMemo(() => {
    if (!activeMark) {
      return [{ key: 'all', text: spokenText, active: false }];
    }
    const next = marks[marks.indexOf(activeMark) + 1];
    const highlightEnd = Math.max(activeMark.end, next ? next.start : activeMark.end);
    return [
      { key: 'before', text: spokenText.slice(0, activeMark.start), active: false },
      {
        key: 'active',
        text: spokenText.slice(activeMark.start, highlightEnd),
        active: true,
      },
      { key: 'after', text: spokenText.slice(highlightEnd), active: false },
    ].filter((part) => part.text.length > 0);
  }, [activeMark, marks, spokenText]);

  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch(() => {});
    getVoices()
      .then(setVoices)
      .catch((e) => setError(String(e)));
  }, []);

  const filtered = useMemo(() => {
    const f = langFilter.trim().toLowerCase();
    return voices
      .filter((v) => !f || v.language.toLowerCase().startsWith(f))
      .sort((a, b) => a.language.localeCompare(b.language) || a.name.localeCompare(b.name))
      .slice(0, 50);
  }, [voices, langFilter]);

  // The module deletes its own files now, so the example uses that rather than reaching
  // for expo-file-system — which is the point of the cache API existing.
  async function removeCurrent() {
    if (result?.uri) {
      await deleteFile(result.uri).catch(() => {});
    }
  }

  async function generate() {
    setError(null);
    setBusy(true);
    try {
      await removeCurrent(); // don't let old files pile up in the cache
      const res = await synthesizeToFile(text, {
        language: voice?.language ?? 'en-US',
        rate: 1.0,
        ...(voice ? { voice: voice.identifier } : {}),
      });
      setSpokenText(text);
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function play() {
    // Only Replay rewinds: a finished clip was rewound when it ended, a paused one should
    // resume in place, and a fresh one is already at zero. The seek is awaited because it
    // is asynchronous — starting before it lands just replays the end.
    if (playing) {
      await player.seekTo(0);
    }
    player.play();
  }

  function pause() {
    player.pause();
  }

  // Device check for the synthesis watchdog. A request with an impossibly short
  // `timeoutMs` has to reject with ERR_TTS_TIMEOUT — and then, the part that actually
  // matters, the NEXT request has to still run. Android runs requests one at a time, so
  // before the watchdog existed a request the engine never reported on left every later
  // one pending until the app was restarted. Step 2 is what proves the queue recovers;
  // on iOS, where each request gets its own synthesizer, it only shows no regression.
  async function checkWatchdog() {
    setError(null);
    setBusy(true);
    const log: string[] = [];
    const note = (line: string) => {
      log.push(line);
      setWatchdogLog([...log]);
    };
    try {
      try {
        await synthesizeToFile(text, { language: 'en-US', timeoutMs: 1 });
        note('FAIL 1/2 — a 1 ms budget resolved instead of timing out');
      } catch (e) {
        const code = (e as { code?: string })?.code;
        note(
          code === 'ERR_TTS_TIMEOUT'
            ? 'PASS 1/2 — timed out as ERR_TTS_TIMEOUT'
            : `FAIL 1/2 — rejected as ${code ?? String(e)}, expected ERR_TTS_TIMEOUT`
        );
      }
      // Bounded on the JS side too: a wedged queue should read as a FAIL line, not as a
      // button that never comes back.
      note(
        await Promise.race([
          synthesizeToFile('Queue check.', { language: 'en-US' })
            .then(() => 'PASS 2/2 — the next request still ran')
            .catch((e) => `FAIL 2/2 — the next request rejected: ${String(e)}`),
          new Promise<string>((resolve) =>
            setTimeout(() => resolve('FAIL 2/2 — the queue is still wedged'), 30_000)
          ),
        ])
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteCurrent() {
    await removeCurrent();
    setResult(null);
    setSpokenText('');
    await refreshCacheSize();
  }

  async function refreshCacheSize() {
    setCacheSize(await getCacheSize().catch(() => null));
  }

  // Device check for the cache API. Steps 3 and 4 are the ones worth having: a path that
  // escapes the module's directory with `..`, and a sibling directory whose name starts
  // the same way, both of which a naive prefix check would accept.
  async function checkCache() {
    setError(null);
    setBusy(true);
    const log: string[] = [];
    const note = (line: string) => {
      log.push(line);
      setCacheLog([...log]);
    };
    const refused = async (label: string, step: string, uri: string) => {
      try {
        await deleteFile(uri);
        note(`FAIL ${step} — ${label} was accepted`);
      } catch (e) {
        const code = (e as { code?: string })?.code;
        note(
          code === 'ERR_TTS_FOREIGN_FILE'
            ? `PASS ${step} — ${label} refused`
            : `FAIL ${step} — ${label} rejected as ${code ?? String(e)}`
        );
      }
    };
    try {
      const before = await getCacheSize();
      const res = await synthesizeToFile('Cache check.', { language: 'en-US' });
      const after = await getCacheSize();
      note(
        after > before
          ? `PASS 1/4 — cache grew ${before} → ${after} bytes`
          : `FAIL 1/4 — cache did not grow (${before} → ${after})`
      );

      await deleteFile(res.uri);
      const cleaned = await getCacheSize();
      note(
        cleaned === before
          ? `PASS 2/4 — deleting the clip returned it to ${cleaned}`
          : `FAIL 2/4 — expected ${before} bytes after deleting, got ${cleaned}`
      );

      const dir = res.uri.slice(0, res.uri.lastIndexOf('/'));
      await refused('a `..` escape', '3/4', `${dir}/../escaped.caf`);
      await refused('a same-prefix sibling', '4/4', `${dir}-evil/x.caf`);
    } catch (e) {
      note(`FAIL — the check itself threw: ${String(e)}`);
    } finally {
      await refreshCacheSize();
      setBusy(false);
    }
  }

  return (
    <View style={[styles.container, { paddingTop: Constants.statusBarHeight }]}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.header}>expo-tts-file</Text>

        <Group name="Generate & play">
          <Text style={styles.hint}>
            Synthesizes to a file, then plays it while highlighting each word as it is
            spoken — driven by the timings returned with the file, not by live events.
          </Text>
          <Button title={busy ? 'Generating…' : 'Generate'} onPress={generate} disabled={busy} />
          {result && (
            <View style={styles.output}>
              <Text selectable style={styles.mono}>
                uri: {result.uri}
              </Text>
              <Text>
                durationMs: {result.durationMs} · marks: {marks.length}
              </Text>

              <Text style={styles.karaoke}>
                {parts.map((part) => (
                  <Text key={part.key} style={part.active ? styles.karaokeActive : undefined}>
                    {part.text}
                  </Text>
                ))}
              </Text>

              <View style={styles.track}>
                <View
                  style={[
                    styles.trackFill,
                    {
                      width: `${
                        result.durationMs > 0
                          ? Math.min(100, (positionMs / result.durationMs) * 100)
                          : 0
                      }%`,
                    },
                  ]}
                />
              </View>

              <View style={styles.row}>
                <Button
                  title={
                    playing ? '↻ Replay' : positionMs > 0 ? '▶ Resume' : '▶ Play'
                  }
                  onPress={play}
                />
                <Button title="⏸ Pause" onPress={pause} disabled={!playing} />
                <Button title="🗑 Delete" onPress={deleteCurrent} />
              </View>

              {marks.length === 0 && (
                <Text style={styles.hint}>
                  This engine reports no ranges, so there is nothing to highlight — see the
                  README on when `marks` comes back empty.
                </Text>
              )}
              <Text style={styles.hint}>
                Tip: Play, then background the app / lock the screen — audio should keep going.
              </Text>
            </View>
          )}
        </Group>

        <Group name="Cache">
          <Text style={styles.hint}>
            {cacheSize === null ? 'size unknown' : `${cacheSize} bytes on disk`}
          </Text>
          <View style={styles.row}>
            <Button title="Size" onPress={refreshCacheSize} />
            <Button
              title="Clear"
              onPress={async () => {
                const gone = await clearCache();
                setResult(null);
                setCacheLog([`cleared ${gone} file(s)`]);
                await refreshCacheSize();
              }}
            />
            <Button title="Run check" onPress={checkCache} disabled={busy} />
          </View>
          {cacheLog.map((line) => (
            <Text key={line} style={line.startsWith('FAIL') ? styles.fail : styles.pass}>
              {line}
            </Text>
          ))}
        </Group>

        <Group name="Watchdog">
          <Text style={styles.hint}>
            Forces a timeout, then checks that the next request still goes through.
          </Text>
          <Button title="Run check" onPress={checkWatchdog} disabled={busy} />
          {watchdogLog.map((line) => (
            <Text key={line} style={line.startsWith('PASS') ? styles.pass : styles.fail}>
              {line}
            </Text>
          ))}
        </Group>

        <Group name="Text">
          <TextInput
            style={styles.input}
            value={text}
            onChangeText={setText}
            multiline
            placeholder="Text to synthesize"
          />
        </Group>

        <Group name="Voice">
          <Text style={styles.hint}>Default is English (en-US). Filter by language, then tap a voice.</Text>
          <TextInput
            style={styles.filter}
            value={langFilter}
            onChangeText={setLangFilter}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="language filter, e.g. en, es, ru"
          />
          <Pressable style={[styles.voiceRow, !voice && styles.voiceRowActive]} onPress={() => setVoice(null)}>
            <Text style={styles.voiceText}>Default (en-US)</Text>
          </Pressable>
          {filtered.map((v) => (
            <Pressable
              key={v.identifier}
              style={[styles.voiceRow, voice?.identifier === v.identifier && styles.voiceRowActive]}
              onPress={() => setVoice(v)}>
              <Text style={styles.voiceText}>
                {v.language} · {v.name} · {v.quality}
              </Text>
            </Pressable>
          ))}
          {voices.length > 0 && (
            <Text style={styles.hint}>
              {filtered.length} shown / {voices.length} installed
            </Text>
          )}
        </Group>

        {error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    </View>
  );
}

function Group(props: { name: string; children: React.ReactNode }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupHeader}>{props.name}</Text>
      {props.children}
    </View>
  );
}

// One accent for everything that marks progress or selection, in the same blue family as
// the buttons and the selected voice row.
const ACCENT = '#1a73e8';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#eee' },
  content: { paddingBottom: 40 },
  header: { fontSize: 30, marginHorizontal: 20, marginTop: 12 },
  group: { margin: 20, marginTop: 16, backgroundColor: '#fff', borderRadius: 10, padding: 16 },
  groupHeader: { fontSize: 18, fontWeight: '600', marginBottom: 12 },
  input: { minHeight: 110, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10, textAlignVertical: 'top' },
  filter: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 8, marginBottom: 10 },
  hint: { fontSize: 12, color: '#666', marginTop: 8 },
  voiceRow: { paddingVertical: 8, paddingHorizontal: 10, borderRadius: 6, marginTop: 4, backgroundColor: '#f3f3f3' },
  voiceRowActive: { backgroundColor: '#cfe8ff' },
  voiceText: { fontSize: 13 },
  output: { marginTop: 14, padding: 10, backgroundColor: '#f3f3f3', borderRadius: 6 },
  row: { flexDirection: 'row', gap: 12, marginTop: 10, flexWrap: 'wrap' },
  mono: { fontSize: 11 },
  // No lineHeight and no backgroundColor on the highlight: that pair makes nested Text
  // overlap its own lines on Android.
  track: { height: 4, marginTop: 14, backgroundColor: '#dcdcdc', borderRadius: 2, overflow: 'hidden' },
  trackFill: { height: 4, backgroundColor: ACCENT },
  karaoke: { marginTop: 12, fontSize: 16 },
  karaokeActive: { color: ACCENT, fontWeight: '700' },
  pass: { marginTop: 8, color: '#0a7d28' },
  fail: { marginTop: 8, color: '#b00020' },
  error: { marginHorizontal: 20, color: '#b00020' },
});
