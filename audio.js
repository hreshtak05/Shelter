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
  let musicNodes = null;   // { gain, oscillators[] }
  let tickTimer = null;
  let duckTarget = 0.18;   // громкость музыки во время речи (ducking)
  let musicLevel = 0.5;    // обычная громкость музыки

  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // ——— Фоновая «тревожная» музыка (синтезированный дрон). Заменяется на MP3 в Фазе 4. ———
  function startMusic() {
    if (musicNodes) return;
    const c = ac();
    const gain = c.createGain();
    gain.gain.value = 0;
    gain.connect(c.destination);
    gain.gain.linearRampToValueAtTime(musicLevel, c.currentTime + 2.5);

    const freqs = [55, 82.4, 110, 164.8]; // A1, E2, A2, E3 — мрачное созвучие
    const oscillators = freqs.map((f, i) => {
      const o = c.createOscillator();
      o.type = i % 2 ? 'sawtooth' : 'sine';
      o.frequency.value = f;
      const og = c.createGain();
      og.gain.value = i === 0 ? 0.5 : 0.18;
      // лёгкое биение для «живого» дрона
      const lfo = c.createOscillator();
      lfo.frequency.value = 0.07 + i * 0.013;
      const lfoGain = c.createGain();
      lfoGain.gain.value = 0.06;
      lfo.connect(lfoGain).connect(og.gain);
      lfo.start();
      o.connect(og).connect(gain);
      o.start();
      return o;
    });
    musicNodes = { gain, oscillators };
  }

  function stopMusic() {
    if (!musicNodes) return;
    const c = ac();
    const { gain, oscillators } = musicNodes;
    gain.gain.cancelScheduledValues(c.currentTime);
    gain.gain.linearRampToValueAtTime(0, c.currentTime + 1.5);
    setTimeout(() => oscillators.forEach(o => { try { o.stop(); } catch (e) {} }), 1600);
    musicNodes = null;
  }

  function duck(on) {
    if (!musicNodes) return;
    const c = ac();
    const g = musicNodes.gain.gain;
    g.cancelScheduledValues(c.currentTime);
    g.linearRampToValueAtTime(on ? duckTarget : musicLevel, c.currentTime + 0.4);
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
    return speak(cat.text, { rate: 0.86, pitch: 0.65 });
  }

  function stopSpeaking() {
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    duck(false);
  }

  return {
    startMusic, stopMusic, duck,
    startTick, stopTick, stinger,
    speak, speakCatastrophe, stopSpeaking,
    setMusicLevel: v => { musicLevel = v; if (musicNodes && !tickTimer) duck(false); }
  };
})();
