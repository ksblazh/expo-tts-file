import Constants from 'expo-constants';
import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { synthesizeToFile, getVoices, type SynthesisResult, type Voice } from 'expo-tts-file';
import { useEffect, useMemo, useState } from 'react';
import { Button, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

// Long enough to start playback and then background the app / lock the screen
// to verify audio keeps playing.
const DEFAULT_TEXT =
  'This is a background audio test for the expo-tts-file module. ' +
  'Edit this text, optionally pick a voice in another language below, then generate and play it. ' +
  'A longer passage like this one lets you start playback, send the app to the background or lock ' +
  'the screen, and confirm the audio keeps playing. The quick brown fox jumps over the lazy dog — ' +
  'again and again — until you are satisfied that on-device text-to-speech to a file works end to end.';

export default function App() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [langFilter, setLangFilter] = useState('en');
  const [voices, setVoices] = useState<Voice[]>([]);
  const [voice, setVoice] = useState<Voice | null>(null); // null = default (en-US)
  const [result, setResult] = useState<SynthesisResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const player = useAudioPlayer(result?.uri ?? undefined);

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

  async function removeCurrent() {
    if (result?.uri) {
      await FileSystem.deleteAsync(result.uri, { idempotent: true }).catch(() => {});
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
      setResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteFile() {
    await removeCurrent();
    setResult(null);
  }

  return (
    <View style={[styles.container, { paddingTop: Constants.statusBarHeight }]}>
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.header}>expo-tts-file</Text>

        <Group name="Generate & play">
          <Button title={busy ? 'Generating…' : 'Generate'} onPress={generate} disabled={busy} />
          {result && (
            <View style={styles.output}>
              <Text selectable style={styles.mono}>
                uri: {result.uri}
              </Text>
              <Text>durationMs: {result.durationMs}</Text>
              <View style={styles.row}>
                <Button
                  title="▶ Play"
                  onPress={() => {
                    player.seekTo(0);
                    player.play();
                  }}
                />
                <Button title="⏸ Pause" onPress={() => player.pause()} />
                <Button title="🗑 Delete" onPress={deleteFile} />
              </View>
              <Text style={styles.hint}>Tip: Play, then background the app / lock the screen — audio should keep going.</Text>
            </View>
          )}
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
  error: { marginHorizontal: 20, color: '#b00020' },
});
