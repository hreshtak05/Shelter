/*
 * generate-audio.mjs — Фаза 4: кинематографичная озвучка катастроф (ElevenLabs).
 *
 * Запускается ОДИН РАЗ, когда меняются тексты катастроф. Создаёт MP3 в audio/voice/
 * и проставляет поле "audio" в data/catastrophes.json. В рантайме приложение просто
 * играет готовые файлы — никаких обращений к ИИ во время игры, ноль галлюцинаций.
 *
 * Использование:
 *   ELEVENLABS_API_KEY=xxxx VOICE_ID=yyyy node scripts/generate-audio.mjs
 *
 * VOICE_ID — id драматичного русскоязычного голоса из вашего аккаунта ElevenLabs.
 * Модель eleven_multilingual_v2 хорошо читает по-русски.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const API_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.VOICE_ID;
const MODEL = process.env.MODEL || 'eleven_multilingual_v2';

if (!API_KEY || !VOICE_ID) {
  console.error('Нужны переменные окружения ELEVENLABS_API_KEY и VOICE_ID.');
  process.exit(1);
}

const dataPath = join(ROOT, 'data', 'catastrophes.json');
const data = JSON.parse(await readFile(dataPath, 'utf8'));
await mkdir(join(ROOT, 'audio', 'voice'), { recursive: true });

for (const cat of data.catastrophes) {
  if (cat.placeholder) {
    console.log(`⏭  Пропуск (заглушка): ${cat.name}`);
    continue;
  }
  const rel = `audio/voice/${cat.id}.mp3`;
  process.stdout.write(`🎙  ${cat.name} … `);
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`, {
    method: 'POST',
    headers: { 'xi-api-key': API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: cat.text,
      model_id: MODEL,
      voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.6 },
    }),
  });
  if (!res.ok) {
    console.error('ОШИБКА', res.status, await res.text());
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(join(ROOT, rel), buf);
  cat.audio = rel;
  console.log('готово');
}

await writeFile(dataPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('✅ Озвучка сгенерирована, catastrophes.json обновлён.');
