/*
 * app.js — игровой движок «Бункера»: состояние, экраны, таймеры, голосование.
 * Поток раундов берётся из data/round-table.json (Таблица раундов, стр. 5 правил).
 */
(() => {
  'use strict';

  // ——— Состояние ———
  const state = {
    players: [],          // [{ name, out:false }]
    mode: 'basic',
    table: null,          // { votings:[...], eliminated, seats } для текущего числа игроков
    roundTable: null,     // весь JSON таблицы
    catastrophes: [],
    phrases: {},
    round: 1,
    activeIdx: -1,        // индекс активного игрока в «Круге открытия карт»
    phase: 'explore',     // explore | reveal | discussion | vote
    marked: new Set(),    // индексы отмеченных на изгнание
    timer: null,          // { id, remaining, onDone }
  };

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  // ——— Загрузка данных ———
  async function loadData() {
    const [rt, cat, ph, ann] = await Promise.all([
      fetch('data/round-table.json').then(r => r.json()),
      fetch('data/catastrophes.json').then(r => r.json()),
      fetch('data/phrases.json').then(r => r.json()),
      fetch('data/announcer.json').then(r => r.json()).catch(() => ({ clips: [] })),
    ]);
    state.roundTable = rt;
    state.catastrophes = cat.catastrophes;
    state.phrases = ph;
    state.announcer = {};
    (ann.clips || []).forEach(c => { state.announcer[c.id] = c; });
  }

  // Озвучить реплику ведущего: готовый MP3 (мужской голос) если есть, иначе голос браузера.
  function announce(id) {
    const clip = state.announcer && state.announcer[id];
    if (clip && clip.audio) return Audio.playFile(clip.audio);
    return Audio.speak(clip ? clip.text : '', { rate: 1.0, pitch: 0.7 });
  }

  function phrase(key, vars = {}) {
    let s = state.phrases[key] || '';
    for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
    return s;
  }

  // ——— Навигация по экранам ———
  function show(id) {
    $$('.screen').forEach(s => s.classList.remove('active'));
    $('#' + id).classList.add('active');
  }

  // ——— Разблокировка звука (нужен жест пользователя) ———
  let audioReady = false;
  function unlockAudio() {
    if (audioReady) return;
    audioReady = true;
    $('#audio-note').classList.add('hidden');
  }
  document.addEventListener('pointerdown', unlockAudio, { once: false });

  // ——— Переключатель фоновой музыки ———
  const musicBtn = $('#btn-music-toggle');
  function refreshMusicBtn() {
    const on = Audio.isMusicEnabled();
    musicBtn.textContent = on ? '🔊 Музыка' : '🔇 Музыка';
    musicBtn.classList.toggle('off', !on);
  }
  musicBtn.addEventListener('click', () => { unlockAudio(); Audio.toggleMusic(); refreshMusicBtn(); });
  refreshMusicBtn();

  // ═══════════════ ЭКРАН НАСТРОЙКИ ═══════════════
  $$('.mode-btn').forEach(b => b.addEventListener('click', () => {
    $$('.mode-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.mode = b.dataset.mode;
  }));

  $('#btn-to-catastrophe').addEventListener('click', () => {
    const names = $('#players-input').value.split('\n').map(s => s.trim()).filter(Boolean);
    const err = $('#setup-error');
    if (names.length < 4) {
      err.textContent = 'Нужно минимум 4 игрока (для 2–3 играйте двумя персонажами и впишите их отдельными строками).';
      return;
    }
    if (names.length > 16) { err.textContent = 'Максимум 16 игроков.'; return; }
    err.textContent = '';
    state.players = names.map(name => ({ name, out: false }));
    state.table = state.roundTable[String(names.length)];
    buildCatastropheGrid();
    show('screen-catastrophe');
  });

  // ═══════════════ ВЫБОР КАТАСТРОФЫ ═══════════════
  function buildCatastropheGrid() {
    const grid = $('#catastrophe-grid');
    grid.innerHTML = '';
    state.catastrophes.forEach(cat => {
      const card = document.createElement('button');
      card.className = 'cat-card';
      card.textContent = cat.name;
      if (cat.placeholder) {
        const b = document.createElement('span');
        b.className = 'mini-badge'; b.textContent = 'ПРИМЕР';
        card.appendChild(b);
      }
      card.addEventListener('click', () => playCatastrophe(cat));
      grid.appendChild(card);
    });
  }

  let currentCat = null;
  function playCatastrophe(cat) {
    currentCat = cat;
    unlockAudio();
    $('#cat-title').textContent = cat.name;
    $('#cat-text').textContent = cat.text;
    $('#cat-badge').classList.toggle('hidden', !cat.placeholder);
    show('screen-cat-play');
    Audio.startMusic();
    Audio.speakCatastrophe(cat);
  }

  // ——— Кубик: случайная катастрофа с анимацией «прокрутки» ———
  let rolling = false;
  $('#btn-random').addEventListener('click', () => {
    if (rolling) return;
    const cats = state.catastrophes;
    const cards = [...document.querySelectorAll('.cat-card')];
    if (!cats.length || !cards.length) return;
    unlockAudio();
    rolling = true;
    $('#btn-random').disabled = true;

    const pick = Math.floor(Math.random() * cats.length);
    const totalTicks = cards.length + pick + 1; // финальная подсветка придётся на pick
    let t = 0;
    Audio.startTick(70);
    const iv = setInterval(() => {
      cards.forEach(c => c.classList.remove('rolling'));
      cards[t % cards.length].classList.add('rolling');
      t++;
      if (t >= totalTicks) {
        clearInterval(iv);
        Audio.stopTick();
        cards.forEach(c => c.classList.remove('rolling'));
        rolling = false;
        $('#btn-random').disabled = false;
        playCatastrophe(cats[pick]);
      }
    }, 70);
  });

  $('#btn-replay').addEventListener('click', () => currentCat && Audio.speakCatastrophe(currentCat));
  $('#btn-cat-stop').addEventListener('click', () => Audio.stopSpeaking());
  $('#btn-start-game').addEventListener('click', startGame);

  // ═══════════════ ИГРА ═══════════════
  function startGame() {
    Audio.stopVoice(); // остановить чтение катастрофы, чтобы не наложилось на ведущего
    state.round = 1;
    state.players.forEach(p => p.out = false);
    show('screen-game');
    enterRound(1);
  }

  function alivePlayers() { return state.players.filter(p => !p.out); }
  function votingsThisRound() { return state.table.votings[state.round - 1] || 0; }

  function enterRound(n) {
    state.round = n;
    state.phase = 'explore';
    state.activeIdx = -1;
    state.marked.clear();
    stopTimer();

    $('#round-num').textContent = n;
    $('#phase-label').textContent = 'Исследование Бункера';
    $('#stage-prompt').textContent = `Раунд ${n}. Исследование Бункера — откройте ${n}-ю пару карт Бункера и Угрозы и зачитайте вслух.`;
    $('#stage-prompt').classList.remove('hidden');
    $('#timer-wrap').classList.add('hidden');

    renderPlayers();
    updateControls();
    announce('round-' + n);
  }

  function renderPlayers() {
    const ul = $('#players-list');
    ul.innerHTML = '';
    state.players.forEach((p, i) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="num">${String(i + 1).padStart(2, '0')}</span><span>${p.name}</span>`;
      if (p.out) li.classList.add('out');
      if (i === state.activeIdx && !p.out) li.classList.add('active');
      if (state.phase === 'vote' && !p.out) {
        li.classList.add('selectable');
        if (state.marked.has(i)) li.classList.add('marked');
        li.addEventListener('click', () => toggleMark(i));
      }
      ul.appendChild(li);
    });
  }

  // ——— Круг открытия карт ———
  $('#btn-reveal-start').addEventListener('click', () => {
    state.phase = 'reveal';
    $('#phase-label').textContent = 'Круг открытия карт';
    // первый живой игрок
    state.activeIdx = state.players.findIndex(p => !p.out);
    startRevealForActive();
    updateControls();
  });

  function startRevealForActive() {
    const p = state.players[state.activeIdx];
    if (!p) return;
    renderPlayers();
    $('#stage-prompt').classList.add('hidden');
    announce('reveal');
    startTimer(30, `Говорит: ${p.name}`, () => {
      // время вышло — ждём «Следующий игрок»
    });
  }

  $('#btn-reveal-next').addEventListener('click', () => {
    // следующий живой игрок
    let i = state.activeIdx + 1;
    while (i < state.players.length && state.players[i].out) i++;
    if (i >= state.players.length) {
      // круг завершён
      state.activeIdx = -1;
      stopTimer();
      renderPlayers();
      $('#stage-prompt').classList.remove('hidden');
      $('#stage-prompt').textContent = votingsThisRound() > 0
        ? 'Круг завершён. Проведите обсуждение и голосование.'
        : 'Круг завершён. В этом раунде голосования нет — переходите к следующему раунду.';
      $('#phase-label').textContent = 'Круг завершён';
      updateControls();
    } else {
      state.activeIdx = i;
      startRevealForActive();
      updateControls();
    }
  });

  // ——— Обсуждение ———
  $$('.disc-btn').forEach(b => b.addEventListener('click', () => startDiscussion(parseInt(b.dataset.min, 10))));
  $('#btn-disc-custom').addEventListener('click', () => {
    const m = parseInt($('#disc-custom').value, 10);
    if (m > 0) startDiscussion(m);
  });
  function startDiscussion(min) {
    state.phase = 'discussion';
    $('#phase-label').textContent = 'Обсуждение';
    $('#stage-prompt').classList.add('hidden');
    announce('discussion');
    startTimer(min * 60, 'Обсуждение', () => {});
    updateControls();
  }

  // ——— Голосование ———
  function startVotePhase() {
    state.phase = 'vote';
    state.marked.clear();
    const need = votingsThisRound();
    $('#phase-label').textContent = 'Голосование';
    $('#vote-need').textContent = `изгнать: ${need}`;
    $('#stage-prompt').classList.remove('hidden');
    $('#stage-prompt').textContent = `Отметьте ${need} ${plural(need, 'игрока', 'игроков', 'игроков')} на изгнание в списке слева.`;
    announce('vote');
    renderPlayers();
    updateControls();
  }

  function toggleMark(i) {
    if (state.marked.has(i)) state.marked.delete(i);
    else {
      if (state.marked.size >= votingsThisRound()) return; // не больше нужного
      state.marked.add(i);
    }
    renderPlayers();
    updateControls();
  }

  // (обработчик кнопки голосования назначается в updateControls — startVotePhase или confirmVote)

  // ——— Следующий раунд / финал ———
  $('#btn-next-round').addEventListener('click', () => {
    if (state.round >= 5) { enterFinale(); return; }
    enterRound(state.round + 1);
  });

  // ——— Управление: какие кнопки активны ———
  function updateControls() {
    const need = votingsThisRound();
    const inReveal = state.phase === 'reveal' && state.activeIdx >= 0;
    const revealDone = state.phase !== 'reveal' && state.activeIdx === -1 && state.phase !== 'explore';

    $('#btn-reveal-start').disabled = !(state.phase === 'explore');
    $('#btn-reveal-next').disabled = !inReveal;

    // Голосование доступно после круга, если в раунде есть голосование
    const canVote = need > 0 && state.activeIdx === -1 && (state.phase === 'reveal' || state.phase === 'discussion' || state.phase === 'vote' || state.phase === 'explore');
    // показываем группу голосования только когда есть голосование в этом раунде
    $('#vote-group').classList.toggle('hidden', need === 0);

    // кнопка «начать голосование» совмещена с подтверждением
    const confirmBtn = $('#btn-confirm-vote');
    if (state.phase === 'voted') {
      confirmBtn.textContent = 'Голосование завершено';
      confirmBtn.disabled = true;
      confirmBtn.onclick = null;
    } else if (state.phase === 'vote') {
      confirmBtn.textContent = `Подтвердить изгнание (${state.marked.size}/${need})`;
      confirmBtn.disabled = state.marked.size !== need;
      confirmBtn.onclick = confirmVote;
    } else if (need > 0) {
      confirmBtn.textContent = 'Начать голосование';
      confirmBtn.disabled = state.activeIdx >= 0; // нельзя во время чьего-то хода
      confirmBtn.onclick = startVotePhase;
    }

    // следующий раунд: если голосование не требуется — после круга; если требуется — после изгнания
    const votedThisRound = need > 0 && state.players.filter(p => p.out).length >= cumulativeEliminated(state.round);
    const noVoteRound = need === 0 && state.activeIdx === -1 && state.phase !== 'explore';
    $('#btn-next-round').disabled = !(votedThisRound || noVoteRound);
    $('#btn-next-round').textContent = state.round >= 5 ? 'К финалу →' : 'Следующий раунд →';
  }

  // отдельная ссылка для confirmVote (используется в updateControls)
  function confirmVote() {
    const need = votingsThisRound();
    if (state.marked.size !== need) return;
    stopTimer();
    const outNames = [];
    for (const i of state.marked) { state.players[i].out = true; outNames.push(state.players[i].name); }
    state.marked.clear();

    // Сначала — состояние и управление (не зависят от завершения озвучки!),
    // иначе при «зависшей» речи в браузере игра встанет.
    state.phase = 'voted';
    $('#phase-label').textContent = 'Изгнание свершилось';
    $('#stage-prompt').classList.remove('hidden');
    $('#stage-prompt').textContent = outNames.length === 1
      ? `${outNames[0]} — изгнан(а) из бункера.`
      : `Изгнаны: ${outNames.join(', ')}.`;
    renderPlayers();
    updateControls();

    // Затем — драматичное объявление (фоном, последовательно, ничего не блокирует).
    announceEliminations(outNames);
  }

  function announceEliminations(names) {
    // имена изгнанных показаны на экране; ведущий объявляет общим мужским голосом
    Audio.stinger();
    announce('eliminated');
  }

  function cumulativeEliminated(round) {
    let sum = 0;
    for (let r = 0; r < round; r++) sum += state.table.votings[r];
    return sum;
  }

  // ═══════════════ ТАЙМЕР ═══════════════
  function startTimer(seconds, caption, onDone) {
    stopTimer();
    state.timer = { remaining: seconds, onDone };
    $('#timer-wrap').classList.remove('hidden');
    $('#timer-caption').textContent = caption || '';
    renderTimer();
    Audio.startTick(1000);
    $('#btn-add-10').disabled = false;
    $('#btn-add-20').disabled = false;
    $('#btn-stop').disabled = false;
    state.timer.id = setInterval(() => {
      state.timer.remaining--;
      renderTimer();
      if (state.timer.remaining <= 0) {
        const done = state.timer.onDone;
        stopTimer();
        Audio.stinger();
        if (done) done();
      }
    }, 1000);
  }

  function renderTimer() {
    const t = state.timer; if (!t) return;
    const m = Math.floor(t.remaining / 60);
    const s = t.remaining % 60;
    const el = $('#timer');
    el.textContent = `${m}:${String(s).padStart(2, '0')}`;
    el.classList.toggle('urgent', t.remaining <= 5);
  }

  function stopTimer() {
    if (state.timer && state.timer.id) clearInterval(state.timer.id);
    state.timer = null;
    Audio.stopTick();
    $('#btn-add-10').disabled = true;
    $('#btn-add-20').disabled = true;
    $('#btn-stop').disabled = true;
    $('#timer')?.classList.remove('urgent');
  }

  $('#btn-add-10').addEventListener('click', () => addTime(10));
  $('#btn-add-20').addEventListener('click', () => addTime(20));
  function addTime(sec) {
    if (!state.timer) return;
    state.timer.remaining += sec;
    renderTimer();
    announce('time-added');
  }

  $('#btn-stop').addEventListener('click', () => {
    stopTimer();
    $('#timer-wrap').classList.add('hidden');
    // если останавливаем во время хода игрока — это просто завершение реплики
  });

  // ═══════════════ ФИНАЛ ═══════════════
  function enterFinale() {
    stopTimer();
    const survivors = state.players.filter(p => !p.out).map(p => p.name);
    const eliminated = state.players.filter(p => p.out).map(p => p.name);
    $('#finale-survivors').innerHTML = survivors.map(n => `<li class="s">${n}</li>`).join('');
    $('#finale-eliminated').innerHTML = eliminated.map(n => `<li class="e">${n}</li>`).join('');
    show('screen-finale');
    announce('finale-intro').then(() => announce('finale-survivors'));
  }

  $('#btn-restart').addEventListener('click', () => {
    Audio.stopMusic();
    Audio.stopSpeaking();
    show('screen-setup');
  });
  $('#btn-quit').addEventListener('click', () => {
    if (!confirm('Выйти из игры? Прогресс будет потерян.')) return;
    stopTimer(); Audio.stopMusic(); Audio.stopSpeaking();
    show('screen-setup');
  });

  // ——— Утилита склонения ———
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
    return many;
  }

  // ——— Старт ———
  loadData().then(() => {
    // показать подсказку про звук
    $('#audio-note').classList.remove('hidden');
  }).catch(err => {
    $('#setup-error').textContent = 'Ошибка загрузки данных: ' + err.message;
  });
})();
