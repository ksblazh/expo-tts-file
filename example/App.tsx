import { useAudioPlayer, setAudioModeAsync } from 'expo-audio';
import { synthesizeToFile, getVoices, type SynthesisResult, type Voice } from 'expo-tts-file';
import { useEffect, useState } from 'react';
import { Button, ScrollView, Text, View } from 'react-native';

export default function App() {
  const [result, setResult] = useState<SynthesisResult | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Re-points at the latest synthesized file whenever `result` changes.
  const player = useAudioPlayer(result?.uri ?? undefined);

  // Keep audio playing when the screen locks / the app is backgrounded.
  useEffect(() => {
    setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).catch(() => {});
  }, []);

  async function run(text: string, language: string) {
    setError(null);
    try {
      const res = await synthesizeToFile(text, { language, rate: 1.0 });
      setResult(res);
    } catch (e) {
      setError(String(e));
    }
  }

  async function listVoices() {
    setError(null);
    try {
      setVoices(await getVoices());
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <View style={styles.container}>
      <ScrollView style={styles.container}>
        <Text style={styles.header}>expo-tts-file</Text>

        <Group name="Synthesize to file">
          <Button title="English" onPress={() => run('Hello, this is a background audio test.', 'en-US')} />
          <View style={styles.spacer} />
          <Button title="Русский" onPress={() => run('Привет, это тест фонового аудио.', 'ru-RU')} />
          {result && (
            <View style={styles.output}>
              <Text selectable>uri: {result.uri}</Text>
              <Text>durationMs: {result.durationMs}</Text>
              <View style={styles.spacer} />
              <Button title="▶ Play last" onPress={() => { player.seekTo(0); player.play(); }} />
            </View>
          )}
        </Group>

        <Group name="Voices">
          <Button title={`List voices (${voices.length})`} onPress={listVoices} />
          {voices.slice(0, 12).map((v) => (
            <Text key={v.identifier} style={styles.voice}>
              {v.language} · {v.name} · {v.quality}
            </Text>
          ))}
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

const styles = {
  header: { fontSize: 30, margin: 20 },
  groupHeader: { fontSize: 20, marginBottom: 12 },
  group: { margin: 20, backgroundColor: '#fff', borderRadius: 10, padding: 20 },
  container: { flex: 1, backgroundColor: '#eee' },
  spacer: { height: 10 },
  output: { marginTop: 14, padding: 10, backgroundColor: '#f3f3f3', borderRadius: 6 },
  voice: { marginTop: 6, fontSize: 12, color: '#333' },
  error: { margin: 20, color: '#b00020' },
};
