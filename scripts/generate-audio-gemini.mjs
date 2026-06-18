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
const VOICE_NAME = process.env.VOICE_NAME || 'Fenrir';
const MODEL = process.env.MODEL || 'gemini-2.5-flash-preview-tts';
const STYLE = process.env.STYLE ||
  'Прочитай драматично и выразительно, глубоким мужским голосом, в быстром, энергичном темпе, бодро, динамично и без пауз:';
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

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '2', 10);

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
    const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    if (res.status === 429) err.quota = true; // дневной лимит исчерпан
    throw err;
  }
}

// Озвучить список элементов {id, text, audio, voice} в подпапку outDir.
// Пропускает уже готовые в нужном голосе (если не FORCE). Возвращает счётчики
// и флаг quotaHit (дневной лимит исчерпан — выше можно остановиться).
async function processItems(items, outDir, label) {
  await mkdir(join(ROOT, outDir), { recursive: true });
  let made = 0, failed = 0, skipped = 0, quotaHit = false;
  console.log(`\n— ${label} —`);
  for (const it of items) {
    if (it.placeholder) { console.log(`⏭  Пропуск (заглушка): ${it.name || it.id}`); continue; }
    const rel = `${outDir}/${it.id}.wav`;
    const upToDate = it.audio && existsSync(join(ROOT, rel)) && it.voice === VOICE_NAME;
    if (!FORCE && upToDate) { skipped++; continue; }
    process.stdout.write(`🎙  ${it.name || it.id} (${VOICE_NAME}) … `);
    try {
      const wav = await synth(it.text);
      await writeFile(join(ROOT, rel), wav);
      it.audio = rel;
      it.voice = VOICE_NAME;
      made++;
      console.log('готово');
    } catch (e) {
      failed++;
      console.error('ОШИБКА:', e.message);
      if (e.quota) {
        console.log('⏸  Лимит Gemini на сегодня исчерпан — останавливаюсь. Запустите завтра, доделает остальное.');
        quotaHit = true;
        break;
      }
    }
  }
  console.log(`Итог (${label}): +${made}, пропущено: ${skipped}, ошибок: ${failed}`);
  return { made, failed, skipped, quotaHit };
}

console.log(`Голос: ${VOICE_NAME} | модель: ${MODEL}`);

// 1) Катастрофы
const catPath = join(ROOT, 'data', 'catastrophes.json');
const catData = JSON.parse(await readFile(catPath, 'utf8'));
const r1 = await processItems(catData.catastrophes, 'audio/voice', 'Катастрофы');
await writeFile(catPath, JSON.stringify(catData, null, 2) + '\n', 'utf8');

// 2) Реплики ведущего (без имён игроков) — тем же голосом
const annPath = join(ROOT, 'data', 'announcer.json');
if (!r1.quotaHit && existsSync(annPath)) {
  const annData = JSON.parse(await readFile(annPath, 'utf8'));
  await processItems(annData.clips, 'audio/announcer', 'Реплики ведущего');
  await writeFile(annPath, JSON.stringify(annData, null, 2) + '\n', 'utf8');
} else if (r1.quotaHit) {
  console.log('\n(Реплики ведущего пропущены — лимит исчерпан, доделаются при следующем запуске.)');
}

console.log('\n✅ Готово.');
