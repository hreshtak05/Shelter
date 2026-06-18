/*
 * audio.js — атмосферный звук для «Бункера».
 *
 * Фаза 1: фоновая музыка и тик-так синтезируются через Web Audio API,
 * поэтому звук работает сразу, без файлов. Голос — speechSynthesis (ru-RU).
 *
 * Фаза 4 (кинематографичный звук): положите MP3 в audio/music и audio/voice,
 * затем замените тело Audio.playMusic / Audio.speakFile на проигрывание файлов
 * (структура и публичные методы менять не нужно).
 */
const Audio = (() => {
  let ctx = null;
  let musicEl = null;      // HTMLAudioElement с вашим треком
  let musicFade = null;    // таймер плавного изменения громкости
  let tickTimer = null;
  let duckTarget = 0.20;   // громкость музыки во время речи (ducking)
  let musicLevel = 0.6;    // обычная громкость музыки (0..1)

  // ⬇️ ВАШ ТРЕК: положите MP3 сюда и назовите его theme.mp3
  //    (или поменяйте имя/путь здесь). Если файла нет — просто тишина, без «шума».
  const MUSIC_SRC = 'audio/music/theme.mp3';

  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // ——— Фоновая музыка из вашего файла (audio/music/theme.mp3). ———
  function fadeMusicTo(target, ms) {
    if (!musicEl) return;
    if (musicFade) { clearInterval(musicFade); musicFade = null; }
    const steps = Math.max(1, Math.round(ms / 50));
    const start = musicEl.volume;
    let i = 0;
    musicFade = setInterval(() => {
      i++;
      const v = start + (target - start) * (i / steps);
      musicEl.volume = Math.min(1, Math.max(0, v));
      if (i >= steps) { clearInterval(musicFade); musicFade = null; }
    }, 50);
  }

  function startMusic() {
    if (musicEl) { musicEl.play().catch(() => {}); fadeMusicTo(musicLevel, 1500); return; }
    musicEl = new window.Audio(MUSIC_SRC);
    musicEl.loop = true;
    musicEl.volume = 0;
    musicEl.addEventListener('canplaythrough', () => fadeMusicTo(musicLevel, 2500), { once: true });
    musicEl.addEventListener('error', () => { /* файла нет — тишина, без «шума» */ });
    musicEl.play().catch(() => {});
  }

  function stopMusic() {
    if (!musicEl) return;
    fadeMusicTo(0, 1200);
    const el = musicEl;
    setTimeout(() => { try { el.pause(); el.currentTime = 0; } catch (e) {} }, 1300);
    musicEl = null;
  }

  function duck(on) {
    if (!musicEl) return;
    fadeMusicTo(on ? duckTarget : musicLevel, 350);
  }

  // ——— Тик-так во время таймеров ———
  function tick() {
    const c = ac();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'square';
    o.frequency.value = 1400;
    g.gain.value = 0.0001;
    o.connect(g).connect(c.destination);
    const t = c.currentTime;
    g.gain.exponentialRampToValueAtTime(0.22, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    o.start(t);
    o.stop(t + 0.08);
  }

  function startTick(intervalMs = 1000) {
    stopTick();
    tick();
    tickTimer = setInterval(tick, intervalMs);
  }
  function stopTick() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  // Короткий драматичный «стингер» (например, при изгнании)
  function stinger() {
    const c = ac();
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, c.currentTime);
    o.frequency.exponentialRampToValueAtTime(40, c.currentTime + 1.2);
    g.gain.setValueAtTime(0.0001, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.5, c.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 1.3);
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + 1.35);
  }

  // ——— Голос (ru-RU). В Фазе 4 для статичных фраз можно проигрывать MP3. ———
  let ruVoice = null;
  function pickVoice() {
    const voices = speechSynthesis.getVoices();
    ruVoice = voices.find(v => /ru[-_]RU/i.test(v.lang)) ||
              voices.find(v => /^ru/i.test(v.lang)) || null;
  }
  if ('speechSynthesis' in window) {
    pickVoice();
    speechSynthesis.onvoiceschanged = pickVoice;
  }

  // Озвучить текст. Возвращает Promise, который резолвится по окончании речи.
  function speak(text, { rate = 0.9, pitch = 0.7 } = {}) {
    return new Promise(resolve => {
      if (!('speechSynthesis' in window) || !text) { resolve(); return; }
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ru-RU';
      if (ruVoice) u.voice = ruVoice;
      u.rate = rate;
      u.pitch = pitch;
      duck(true);
      u.onend = () => { duck(false); resolve(); };
      u.onerror = () => { duck(false); resolve(); };
      speechSynthesis.speak(u);
    });
  }

  // Озвучить катастрофу: если есть готовый MP3 — играем его, иначе голос браузера.
  function speakCatastrophe(cat) {
    if (cat.audio) {
      return new Promise(resolve => {
        const a = new window.Audio(cat.audio);
        duck(true);
        a.onended = () => { duck(false); resolve(); };
        a.onerror = () => { duck(false); resolve(); };
        a.play().catch(() => { duck(false); resolve(); });
      });
    }
    return speak(cat.text, { rate: 1.05, pitch: 0.7 });
  }

  function stopSpeaking() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    duck(false);
  }

  return {
    startMusic, stopMusic, duck,
    startTick, stopTick, stinger,
    speak, speakCatastrophe, stopSpeaking,
    setMusicLevel: v => { musicLevel = v; if (musicEl && !musicFade) musicEl.volume = v; }
  };
})();
