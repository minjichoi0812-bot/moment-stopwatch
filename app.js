(() => {
  'use strict';
  const STORAGE_KEY = 'moment-stopwatch-v1';
  const OUTDOOR_KEY = 'moment-stopwatch-outdoor-v1';
  const LOCK_KEY = 'moment-stopwatch-state-v2';
  const ISOLATED_KEY = 'moment-stopwatch-isolated-v1';
  const $ = (id) => document.getElementById(id);
  const el = {
    hours: $('hours'), minutes: $('minutes'), seconds: $('seconds'), centiseconds: $('centiseconds'),
    toggle: $('toggle-button'), toggleLabel: $('toggle-label'), toggleIcon: $('toggle-icon'),
    lap: $('lap-button'), finish: $('finish-button'), reset: $('reset-button'), outdoor: $('outdoor-toggle'),
    status: $('status'), statusText: $('status-text'), progress: $('progress'),
    list: $('laps-list'), count: $('lap-count'), empty: $('empty-state'), footer: $('lap-footer-text'),
    announcement: $('announcement'), accessibleTime: $('accessible-time'), currentLap: $('current-lap-time'),
    currentLapLabel: $('current-lap-label'), hint: $('control-hint'), notice: $('storage-notice')
  };
  const initialState = () => ({ accumulated: 0, startedAt: null, startedHighRes: null, runId: null, laps: [], finished: false, hasStarted: false, revision: 0 });
  let state = initialState();
  let anchor = null;
  let frame = null;
  let flowResumeTimer = null;
  let reactionTimer = null;
  let queue = Promise.resolve();
  let savedIsolation = null;
  try { savedIsolation = sessionStorage.getItem(ISOLATED_KEY); } catch (_) { /* The notice will report unavailable storage when needed. */ }
  const locksAvailable = !!(navigator.locks && typeof navigator.locks.request === 'function');
  let canSyncTabs = locksAvailable && !savedIsolation;
  let switchedToIsolated = savedIsolation === 'lock-error';
  if (!locksAvailable && !savedIsolation) {
    try { sessionStorage.setItem(ISOLATED_KEY, 'unsupported'); } catch (_) { /* In-memory operation remains available. */ }
  }
  let storageAvailable = true;
  let actionError = '';
  const selectedStorage = () => canSyncTabs ? localStorage : sessionStorage;

  const clock = () => {
    const mono = performance.now();
    return { mono, wall: Date.now(), absolute: Number.isFinite(performance.timeOrigin) ? performance.timeOrigin + mono : null };
  };
  const pad = (n) => String(n).padStart(2, '0');
  function parts(ms) {
    const time = Math.max(0, Math.floor(ms / 10));
    return { h: pad(Math.floor(time / 360000)), m: pad(Math.floor(time / 6000) % 60), s: pad(Math.floor(time / 100) % 60), cs: pad(time % 100) };
  }
  function format(ms) {
    const t = parts(ms);
    return `${t.h}:${t.m}:${t.s}.${t.cs}`;
  }
  function intervalForDisplay(total, previous) {
    return Math.max(0, (Math.floor(total / 10) - Math.floor(previous / 10)) * 10);
  }
  function readState() {
    try {
      let serialized = selectedStorage().getItem(STORAGE_KEY);
      // If Web Locks is unavailable, make an isolated per-tab copy of any old shared record.
      if (serialized === null && !canSyncTabs) {
        try { serialized = localStorage.getItem(STORAGE_KEY); } catch (_) { /* No earlier shared record. */ }
      }
      const raw = JSON.parse(serialized);
      if (!raw || !Number.isFinite(raw.accumulated) || raw.accumulated < 0 || !Array.isArray(raw.laps)) return null;
      if (raw.startedAt !== null && (!Number.isFinite(raw.startedAt) || raw.startedAt < 0)) return null;
      return {
        accumulated: raw.accumulated,
        startedAt: raw.startedAt,
        startedHighRes: Number.isFinite(raw.startedHighRes) ? raw.startedHighRes : null,
        runId: raw.startedAt === null ? null : (typeof raw.runId === 'string' ? raw.runId : `legacy-${raw.startedAt}`),
        laps: raw.laps.filter((lap) => Number.isFinite(lap.total) && Number.isFinite(lap.duration) && lap.total >= 0 && lap.duration >= 0).map((lap) => ({ total: lap.total, duration: lap.duration, kind: lap.kind === 'finish' ? 'finish' : 'lap' })),
        finished: raw.finished === true && raw.startedAt === null,
        hasStarted: raw.hasStarted === true || raw.startedAt !== null || raw.accumulated > 0 || raw.laps.length > 0,
        revision: Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0
      };
    } catch (_) { storageAvailable = false; return null; }
  }
  function adopt(next, point) {
    const sameRun = anchor && state.startedAt !== null && next.startedAt !== null && state.runId === next.runId;
    state = next;
    if (state.startedAt === null) anchor = null;
    else if (!sameRun) {
      // Browsers normally share this monotonic origin across same-origin contexts.
      // It may be reset by a browser restart or a new isolated browsing session.
      const sharedClock = Number.isFinite(state.startedHighRes) && Number.isFinite(point.absolute) && point.absolute >= state.startedHighRes;
      const passed = sharedClock ? point.absolute - state.startedHighRes : point.wall - state.startedAt;
      anchor = { runId: state.runId, mono: point.mono, elapsed: state.accumulated + Math.max(0, passed) };
    }
  }
  function elapsed(point = clock()) {
    if (state.startedAt === null) return state.accumulated;
    if (anchor && anchor.runId === state.runId) return Math.max(0, anchor.elapsed + point.mono - anchor.mono);
    return Math.max(0, state.accumulated + point.wall - state.startedAt);
  }
  function writeState() {
    state.revision += 1;
    try { selectedStorage().setItem(STORAGE_KEY, JSON.stringify(state)); storageAvailable = true; } catch (_) { storageAvailable = false; }
  }
  function announce(message) { el.announcement.textContent = message; }
  function renderTime(ms) {
    const t = parts(ms);
    el.hours.textContent = t.h; el.minutes.textContent = t.m; el.seconds.textContent = t.s; el.centiseconds.textContent = t.cs;
    el.accessibleTime.textContent = format(ms);
    el.progress.style.strokeDasharray = `${(ms % 60000) / 600} 100`;
    const lastLap = state.laps.length ? state.laps[state.laps.length - 1] : null;
    el.currentLapLabel.textContent = state.finished ? '마지막 구간' : '현재 구간';
    const previousTotal = state.finished && lastLap && state.laps.length > 1 ? state.laps[state.laps.length - 2].total : 0;
    el.currentLap.textContent = state.finished && lastLap
      ? format(intervalForDisplay(lastLap.total, previousTotal))
      : format(intervalForDisplay(ms, lastLap ? lastLap.total : 0));
  }
  function renderControls() {
    const running = state.startedAt !== null;
    const hasTime = state.hasStarted || running || state.accumulated > 0 || state.laps.length > 0;
    el.toggleLabel.textContent = state.finished ? '측정 완료' : running ? '일시정지' : hasTime ? '이어서' : '시작하기';
    el.toggle.disabled = state.finished;
    el.toggleIcon.innerHTML = running
      ? '<path d="M7.5 5.5h3v13h-3zm6 0h3v13h-3z" fill="currentColor"/>'
      : '<path d="M8.5 5.5v13l10-6.5-10-6.5Z" fill="currentColor"/>';
    el.statusText.textContent = state.finished ? '측정 완료' : running ? '측정 중' : hasTime ? '일시정지' : '측정 준비';
    el.status.classList.toggle('running', running);
    el.lap.disabled = !running;
    el.finish.disabled = !hasTime || state.finished;
    el.reset.disabled = !hasTime;
    el.hint.textContent = state.finished ? '완주 기록이 저장됐어요. 새 측정은 기록을 초기화해 주세요.'
      : running ? '랩 추가로 구간을 기록하고, 마지막에는 완주 기록을 누르세요.'
      : hasTime ? '이어서 측정하거나, 멈춘 시각을 완주 기록으로 저장할 수 있어요.' : '시작 후 랩을 추가할 수 있어요.';
  }
  function renderLaps() {
    el.count.textContent = state.laps.length;
    el.empty.hidden = state.laps.length > 0;
    el.empty.style.display = state.laps.length ? 'none' : 'flex';
    el.footer.textContent = state.laps.length ? `총 ${state.laps.length}개의 기록` : '기록을 기다리는 중';
    el.list.replaceChildren();
    for (let i = state.laps.length - 1; i >= 0; i--) {
      const lap = state.laps[i];
      const row = document.createElement('li');
      const name = document.createElement('span'); const duration = document.createElement('span'); const total = document.createElement('span');
      name.className = 'lap-name'; name.textContent = `${lap.kind === 'finish' ? '완주' : '랩'} ${pad(i + 1)}`;
      duration.className = 'lap-duration'; duration.textContent = format(intervalForDisplay(lap.total, i ? state.laps[i - 1].total : 0));
      total.className = 'lap-total'; total.textContent = format(lap.total);
      row.append(name, duration, total); el.list.append(row);
    }
  }
  function tick() {
    frame = null;
    renderTime(elapsed());
    if (state.startedAt !== null) frame = requestAnimationFrame(tick);
  }
  function ensureTick() {
    if (state.startedAt !== null && frame === null) frame = requestAnimationFrame(tick);
    if (state.startedAt === null && frame !== null) { cancelAnimationFrame(frame); frame = null; }
  }
  function renderNotice() {
    const message = actionError || (!storageAvailable
      ? '브라우저 저장이 차단돼 있어요. 새로고침하면 기록이 사라져요.'
      : !canSyncTabs ? (switchedToIsolated
        ? '동기화 오류로 이 탭에서만 측정해요. 탭을 닫으면 기록이 사라져요.'
        : '탭마다 별도로 기록돼요. 이 탭을 닫으면 기록이 사라져요.') : '');
    el.notice.textContent = message;
    el.notice.hidden = !message;
  }
  function render() { renderTime(elapsed()); renderControls(); renderLaps(); renderNotice(); ensureTick(); }
  function reactWater() {
    const body = document.body; const filter = $('water-filter-svg');
    clearTimeout(flowResumeTimer); clearTimeout(reactionTimer);
    body.classList.remove('water-reacting', 'water-frozen'); void body.offsetWidth;
    body.classList.add('water-reacting', 'water-frozen');
    try { if (typeof filter.pauseAnimations === 'function') filter.pauseAnimations(); } catch (_) { /* The timer remains usable without SVG animation. */ }
    flowResumeTimer = setTimeout(() => {
      body.classList.remove('water-frozen');
      try { if (typeof filter.unpauseAnimations === 'function') filter.unpauseAnimations(); } catch (_) { /* CSS flow continues. */ }
    }, 1050);
    reactionTimer = setTimeout(() => body.classList.remove('water-reacting'), 3200);
  }
  function apply(action, point) {
    const latest = readState();
    if (latest && latest.revision > state.revision) adopt(latest, point);
    let message = '';
    if (action === 'toggle' && !state.finished) {
      if (state.startedAt === null) {
        state.startedAt = point.wall; state.startedHighRes = point.absolute; state.hasStarted = true;
        state.runId = `${point.wall}-${Math.random().toString(36).slice(2)}`;
        anchor = { runId: state.runId, mono: point.mono, elapsed: state.accumulated };
        message = '시간 측정을 시작했습니다.';
      } else {
        state.accumulated = elapsed(point); state.startedAt = null; state.startedHighRes = null; state.runId = null; anchor = null;
        message = `일시정지했습니다. 경과 시간 ${format(state.accumulated)}.`;
      }
    } else if ((action === 'lap' && state.startedAt !== null) || (action === 'finish' && !state.finished && (state.hasStarted || state.startedAt !== null || state.accumulated > 0 || state.laps.length > 0))) {
      const previous = state.laps.length ? state.laps[state.laps.length - 1].total : 0;
      const total = Math.max(previous, elapsed(point));
      state.laps.push({ total, duration: total - previous, kind: action === 'finish' ? 'finish' : 'lap' });
      if (action === 'finish') {
        state.accumulated = total; state.startedAt = null; state.startedHighRes = null; state.runId = null; state.finished = true; anchor = null;
        message = `완주 기록을 저장했습니다. 총 시간 ${format(total)}.`;
      } else message = `랩 ${state.laps.length}을 추가했습니다. 구간 시간 ${format(intervalForDisplay(total, previous))}.`;
    } else if (action === 'reset') {
      const revision = state.revision;
      state = initialState(); state.revision = revision; anchor = null;
      message = '시간과 모든 랩 기록을 초기화했습니다.';
    } else { render(); return; }
    actionError = ''; writeState(); render(); announce(message);
  }
  function isolateAndApply(action, point) {
    // A rejected shared lock must never prevent stopping an active timer.
    const latest = readState();
    if (latest && latest.revision > state.revision) adopt(latest, point);
    canSyncTabs = false; switchedToIsolated = true;
    try { sessionStorage.setItem(ISOLATED_KEY, 'lock-error'); sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); storageAvailable = true; }
    catch (_) { storageAvailable = false; }
    apply(action, point);
  }
  function transact(action, point) {
    const run = () => {
      if (!canSyncTabs) return apply(action, point);
      let enteredLock = false;
      try {
        return Promise.resolve(navigator.locks.request(LOCK_KEY, () => {
          enteredLock = true;
          return apply(action, point);
        })).catch((error) => {
          if (enteredLock) throw error;
          isolateAndApply(action, point);
        });
      } catch (error) { if (enteredLock) throw error; return isolateAndApply(action, point); }
    };
    queue = queue.then(run, run).catch(() => {
      actionError = '기록을 처리하지 못했어요. 버튼을 다시 눌러 주세요.';
      renderNotice(); announce(actionError);
    });
    return queue;
  }
  function handleToggle() {
    const point = clock(); // Record the press before animation or layout work.
    transact('toggle', point); reactWater();
  }
  function handleFinish() {
    const point = clock();
    transact('finish', point); reactWater();
  }
  function setOutdoor(on) {
    document.body.classList.toggle('outdoor-mode', on);
    el.outdoor.setAttribute('aria-pressed', String(on));
    el.outdoor.setAttribute('aria-label', on ? '야외 고대비 모드 끄기' : '야외 고대비 모드 켜기');
  }
  el.toggle.addEventListener('click', handleToggle);
  el.lap.addEventListener('click', () => transact('lap', clock()));
  el.finish.addEventListener('click', handleFinish);
  el.reset.addEventListener('click', () => {
    if (window.confirm('시간과 모든 랩 기록을 지울까요?')) transact('reset', clock());
  });
  el.outdoor.addEventListener('click', () => {
    const on = el.outdoor.getAttribute('aria-pressed') !== 'true'; setOutdoor(on);
    try { localStorage.setItem(OUTDOOR_KEY, on ? '1' : '0'); } catch (_) { /* The mode still applies for this session. */ }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) renderTime(elapsed()); });
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY && canSyncTabs) {
      const latest = readState();
      if (latest && latest.revision > state.revision) { adopt(latest, clock()); render(); }
    } else if (event.key === OUTDOOR_KEY) setOutdoor(event.newValue === '1');
  });
  const saved = readState();
  if (saved) adopt(saved, clock());
  try { setOutdoor(localStorage.getItem(OUTDOOR_KEY) === '1'); } catch (_) { setOutdoor(false); }
  render();
})();
