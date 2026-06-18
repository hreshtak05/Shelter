/*
 * generate-audio-gemini.mjs — кинематографичная озвучка катастроф голосом Gemini (Google).
 *
 * Запускается ОДИН РАЗ (или при изменении текстов). Для каждой катастрофы из
 * data/catastrophes.json генерирует аудиофайл мужским драматичным голосом и
 * проставляет поле "audio". В рантайме сайт просто играет готовые файлы — ключ
 * остаётся приватным, ноль обращений к ИИ во время игры, ноль галлюцинаций.
 *
 * Использование:
 *   GEMINI_API_KEY=xxxx node scripts/generate-audio-gemini.mjs
 *
 * Необязательные переменные:
 *   VOICE_NAME=Charon   мужские голоса: Charon (глубокий), Fenrir, Orus, Algenib,
 *                       Iapetus, Rasalgethi, Achernar. По умолчанию Charon.
 *   STYLE="Прочитай зловещим, глубоким, драматичным голосом, медленно и мрачно:"
 *   MODEL=gemini-2.5-flash-preview-tts   (или gemini-2.5-pro-preview-tts)
 *
 * Получить ключ: https://aistudio.google.com/apikey
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const API_KEY = process.env.GEMINI_API_KEY;
const VOICE_NAME = process.env.VOICE_NAME || 'Charon';
const MODEL = process.env.MODEL || 'gemini-2.5-flash-preview-tts';
const STYLE = process.env.STYLE ||
  'Прочитай драматично и выразительно, глубоким мужским голосом, в бодром, уверенном темпе, энергично и без лишних пауз:';
const FORCE = /^(1|true|yes)$/i.test(process.env.FORCE || ''); // перегенерировать даже готовые

if (!API_KEY) {
  console.error('Нужна переменная окружения GEMINI_API_KEY (ключ: https://aistudio.google.com/apikey).');
  process.exit(1);
}

// PCM (16-bit LE, mono) -> WAV (браузеры играют WAV без конвертации)
function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const blockAlign = channels * bits / 8;
  const byteRate = sampleRate * blockAlign;
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);            // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(byteRate, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

function rateFromMime(mime) {
  const m = /rate=(\d+)/.exec(mime || '');
  return m ? parseInt(m[1], 10) : 24000;
}

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '4', 10);

async function synth(text) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-goog-api-key': API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${STYLE} ${text}` }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
        },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const part = data?.candidates?.[0]?.content?.parts?.find(p => p.inlineData);
      if (!part) throw new Error('В ответе нет аудио: ' + JSON.stringify(data).slice(0, 300));
      const pcm = Buffer.from(part.inlineData.data, 'base64');
      return pcmToWav(pcm, rateFromMime(part.inlineData.mimeType));
    }
    // 429 = превышен лимит. Если поминутный — поможет пауза; если суточный — нет.
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const wait = 20000 * (attempt + 1); // 20с, 40с, 60с, 80с
      process.stdout.write(`(лимит 429, пауза ${wait / 1000}с) `);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

const dataPath = join(ROOT, 'data', 'catastrophes.json');
const data = JSON.parse(await readFile(dataPath, 'utf8'));
await mkdir(join(ROOT, 'audio', 'voice'), { recursive: true });

console.log(`Голос: ${VOICE_NAME} | модель: ${MODEL}\n`);
let made = 0, failed = 0, skipped = 0;
for (const cat of data.catastrophes) {
  if (cat.placeholder) { console.log(`⏭  Пропуск (заглушка): ${cat.name}`); continue; }
  const rel = `audio/voice/${cat.id}.wav`;
  // Уже озвучено? Пропускаем — повторный запуск доделывает только недостающее.
  // (FORCE=1 — перегенерировать всё, например при смене голоса или темпа.)
  if (!FORCE && cat.audio && existsSync(join(ROOT, rel))) { skipped++; continue; }
  process.stdout.write(`🎙  ${cat.name} … `);
  try {
    const wav = await synth(cat.text);
    await writeFile(join(ROOT, rel), wav);
    cat.audio = rel;
    made++;
    console.log('готово');
  } catch (e) {
    failed++;
    console.error('ОШИБКА:', e.message);
  }
}
console.log(`\nГотово: +${made}, пропущено (уже было): ${skipped}, ошибок: ${failed}`);

await writeFile(dataPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
console.log('\n✅ Озвучка сгенерирована, catastrophes.json обновлён.');
