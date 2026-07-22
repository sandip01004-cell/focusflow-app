/* ================================================================
   FocusFlow — Application Logic
   app.js
   ================================================================ */

'use strict';

// ────────────────────────────────────────────────────────────
// CONSTANTS
// ────────────────────────────────────────────────────────────

const STORE = {
  TASKS: 'ff_tasks',
  SESSIONS: 'ff_sessions',
  TIMER: 'ff_timer',
  SETTINGS: 'ff_settings',
};

const TAB_ORDER = ['pomodoro', 'todo', 'history', 'settings'];
const RING_CIRC = 326.73; // 2π × 52

// ────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ────────────────────────────────────────────────────────────

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function persist(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { }
}

// ────────────────────────────────────────────────────────────
// UTILITY FUNCTIONS
// ────────────────────────────────────────────────────────────

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Parse #tag tokens from a string. Returns unique lowercase array. */
function parseTags(text) {
  const raw = (text || '').match(/#([a-zA-Z]\w*)/g) || [];
  return [...new Set(raw.map(t => t.slice(1).toLowerCase()))];
}

/** Format total seconds → "25m", "1h 5m", "45s" */
function fmtDur(secs) {
  secs = Math.max(0, Math.floor(secs));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  if (m > 0 && s > 0) return `${m}m ${s}s`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

/** Format remaining seconds → "MM:SS" */
function fmtTime(secs) {
  secs = Math.max(0, Math.ceil(secs));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Format a timestamp for History rows */
function fmtTimestamp(ts) {
  const d = new Date(ts);
  const now = new Date();
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayMid = todayMid - 86_400_000;
  const sessionMid = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  if (sessionMid === todayMid) return timeStr;
  if (sessionMid === yesterdayMid) return `Yesterday · ${timeStr}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · ' + timeStr;
}

/** Format a date for History group dividers */
function fmtDateGroup(ts) {
  const d = new Date(ts);
  const now = new Date();
  const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayMid = todayMid - 86_400_000;
  const sessionMid = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

  if (sessionMid === todayMid) return 'Today';
  if (sessionMid === yesterdayMid) return 'Yesterday';
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
}

/** Sum study seconds from an array of session objects */
function sumStudySecs(sessions) {
  return sessions
    .filter(s => s.type === 'study')
    .reduce((acc, s) => acc + (s.duration || 0), 0);
}

// ────────────────────────────────────────────────────────────
// DEFAULT STATE
// ────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  theme: 'dark',
  liquidGlass: false,
  sound: true,
  soundPreset: 'bell',
  notifications: true,
};

const DEFAULT_TIMER = {
  active: false,
  running: false,
  type: 'study',    // 'study' | 'break'
  startTs: null,       // Date.now() when last resumed
  targetSecs: 1500,       // duration of current segment
  elapsed: 0,          // seconds accumulated before last pause
  cycle: 1,
  totalCycles: 4,
  studyMinutes: 25,
  breakMinutes: 5,
  autoMode: false,
  linkedTaskId: null,
  pauses: 0,
  sessionStart: null,       // when this study segment began (wall time)
};

// ────────────────────────────────────────────────────────────
// APPLICATION STATE
// ────────────────────────────────────────────────────────────

const state = {
  tab: 'pomodoro',
  tasks: load(STORE.TASKS) || [],
  sessions: load(STORE.SESSIONS) || [],
  settings: { ...DEFAULT_SETTINGS, ...(load(STORE.SETTINGS) || {}) },
  timer: { ...DEFAULT_TIMER, ...(load(STORE.TIMER) || {}) },
  // filters
  todoTagFilter: 'all',
  todoPriorityFilter: 'all',
  showCompleted: false,
  histTagFilter: 'all',
  // modal
  editingTaskId: null,
};

// ── If page was reloaded while timer was running, compute elapsed since then ──
if (state.timer.running && state.timer.startTs) {
  const away = (Date.now() - state.timer.startTs) / 1000;
  state.timer.elapsed = Math.min(state.timer.elapsed + away, state.timer.targetSecs);
  state.timer.running = false;
  state.timer.startTs = null;
  persist(STORE.TIMER, state.timer);
}

// ────────────────────────────────────────────────────────────
// DOM CACHE
// ────────────────────────────────────────────────────────────

const $ = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];

// Nav
const navTabs = $$('.nav-tab');
const navSessionInfo = $('#nav-session-info');
const sessionNavLbl = $('#session-nav-label');

// Pomodoro
const elStatusPhase = $('#status-phase');
const elStatusTime = $('#status-time');
const elStatusCycle = $('#status-cycle');
const elRingProgress = $('#ring-progress');
const elStatusGlow = $('#status-glow');
const elBtnStart = $('#btn-start');
const elBtnStartLbl = $('#btn-start-label');
const elBtnReset = $('#btn-reset');
const elStudyMins = $('#studyMinutes');
const elBreakMins = $('#breakMinutes');
const elTotalCycles = $('#totalCycles');
const elAutoMode = $('#autoMode');
const elLinkedDisp = $('#linked-task-display');
const elBtnLinkTask = $('#btn-link-task');
const elBtnEndSession = $('#btn-end-session');
const elPauseCard = $('#pause-stats-card');
const elPauseCount = $('#pause-count');
const elPausePhaseLbl = $('#pause-phase-label');

// Fullscreen
const elFs = $('#fullscreen-timer');
const elFsPhase = $('#fs-phase');
const elFsCycle = $('#fs-cycle');
const elFsTime = $('#fs-time');
const elFsTask = $('#fs-task');

// Todo
const elTaskList = $('#task-list');
const elTodoEmpty = $('#todo-empty');
const elTagFilterChips = $('#tag-filter-chips');
const elPriorityFilter = $('#priority-filter');
const elShowCompleted = $('#show-completed');
const elBtnAddTask = $('#btn-add-task');

// History
const elMetricToday = $('#metric-today');
const elMetricTodayCnt = $('#metric-today-count');
const elMetricWeek = $('#metric-week');
const elMetricWeekCnt = $('#metric-week-count');
const elMetricAlltime = $('#metric-alltime');
const elMetricAlltimeCnt = $('#metric-alltime-count');
const elSessionList = $('#session-list');
const elHistoryEmpty = $('#history-empty');
const elHistTagChips = $('#history-tag-chips');
const elTagTotalsSection = $('#tag-totals-section');
const elTagTotalsList = $('#tag-totals-list');

// Settings
const elThemeDark = $('#theme-dark');
const elThemeLight = $('#theme-light');
const elLiquidGlass = $('#liquidGlass');
const elSoundEnabled = $('#soundEnabled');
const elNotifEnabled = $('#notificationsEnabled');
const elSoundPreset = $('#soundPreset');
const elBtnTestSound = $('#btn-test-sound');
const elSoundPresetRow = $('#sound-preset-row');
const elBtnClearHistory = $('#btn-clear-history');
const elBtnClearAll = $('#btn-clear-all');

// Task modal
const elModalBackdrop = $('#modal-backdrop');
const elModalTitle = $('#modal-title');
const elTaskForm = $('#task-form');
const elTaskTitle = $('#task-title');
const elTaskDesc = $('#task-description');
const elTagPreview = $('#tag-preview');
const elModalSubmit = $('#modal-submit');
const elModalClose = $('#modal-close');
const elModalCancel = $('#modal-cancel');

// Link modal
const elLinkBackdrop = $('#link-modal-backdrop');
const elLinkTaskList = $('#link-task-list');
const elLinkModalClose = $('#link-modal-close');
const elLinkModalCancel = $('#link-modal-cancel');
const elBtnUnlink = $('#btn-unlink-task');

// ────────────────────────────────────────────────────────────
// AUDIO ENGINE
// ────────────────────────────────────────────────────────────

let audioCtx = null;

function getAudio() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function playSound(preset) {
  if (!state.settings.sound) return;
  preset = preset || state.settings.soundPreset || 'bell';
  try {
    const ctx = getAudio();
    ({ bell: playBell, soft: playSoft, deep: playDeep, ding: playDing }[preset] || playBell)(ctx);
  } catch (e) { /* silently ignore audio errors */ }
}

function playBell(ctx) {
  [[523.25, 0, 0.18], [1046.5, 0.06, 0.11], [1568.3, 0.12, 0.07], [2093, 0.18, 0.04]].forEach(([freq, delay, vol]) => {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.value = freq;
    const t = ctx.currentTime + delay;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(vol, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 3.2);
    osc.start(t); osc.stop(t + 3.5);
  });
}

function playSoft(ctx) {
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type = 'sine'; osc.frequency.value = 440;
  gain.gain.setValueAtTime(0.14, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 2.5);
  osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 2.5);
}

function playDeep(ctx) {
  [[80, 0.22], [160, 0.10]].forEach(([freq, vol]) => {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sine'; osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 4);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 4);
  });
}

function playDing(ctx) {
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.connect(gain); gain.connect(ctx.destination);
  osc.type = 'sine'; osc.frequency.value = 1760;
  gain.gain.setValueAtTime(0.12, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 1.4);
  osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 1.4);
}

// ────────────────────────────────────────────────────────────
// NOTIFICATIONS
// ────────────────────────────────────────────────────────────

async function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

function notify(title, body) {
  if (!state.settings.notifications) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try { new Notification(title, { body }); } catch { }
}

// ────────────────────────────────────────────────────────────
// NAVIGATION
// ────────────────────────────────────────────────────────────

function navigate(to) {
  if (to === state.tab) return;

  const fromIdx = TAB_ORDER.indexOf(state.tab);
  const toIdx = TAB_ORDER.indexOf(to);
  const forward = toIdx > fromIdx;

  const fromEl = document.getElementById(`page-${state.tab}`);
  const toEl = document.getElementById(`page-${to}`);

  // Position incoming page without transition
  toEl.style.transition = 'none';
  toEl.classList.remove('page-active', 'page-above');
  if (!forward) toEl.classList.add('page-above'); // start above for backward nav

  void toEl.offsetHeight; // force reflow

  toEl.style.transition = ''; // re-enable transition

  // Animate outgoing
  fromEl.classList.remove('page-active');
  if (forward) fromEl.classList.add('page-above'); // slide outgoing upward

  // Animate incoming
  toEl.classList.remove('page-above');
  toEl.classList.add('page-active');

  state.tab = to;

  // Update nav highlights
  navTabs.forEach(t => t.classList.toggle('active', t.dataset.tab === to));

  // Trigger page-specific renders
  if (to === 'history') renderHistory();
  if (to === 'todo') renderTasks();
}

// ────────────────────────────────────────────────────────────
// ■■■ TIMER ENGINE ■■■
// ────────────────────────────────────────────────────────────

let rafId = null;

/** Compute remaining seconds based on timestamps (works after sleep) */
function getRemaining() {
  const t = state.timer;
  let elapsed = t.elapsed;
  if (t.running && t.startTs) elapsed += (Date.now() - t.startTs) / 1000;
  return Math.max(0, t.targetSecs - elapsed);
}

/** Compute 0→1 progress fraction */
function getProgress() {
  const t = state.timer;
  let elapsed = t.elapsed;
  if (t.running && t.startTs) elapsed += (Date.now() - t.startTs) / 1000;
  return Math.min(1, elapsed / t.targetSecs);
}

/**
 * End the current session early but count it as completed.
 * Saves the elapsed portion to history, then resets the timer cleanly.
 */
function endSession() {
  const t = state.timer;
  if (!t.active) return;

  // Only save study sessions (not breaks) to history
  if (t.type === 'study' && t.elapsed > 0) {
    saveSession(t);
    playSound();
    notify('FocusFlow', `Session saved — ${fmtDur(t.elapsed)} logged. ✅`);
  }

  // Full reset keeping config
  const prev = state.timer;
  state.timer = {
    ...DEFAULT_TIMER,
    studyMinutes: prev.studyMinutes,
    breakMinutes: prev.breakMinutes,
    totalCycles: prev.totalCycles,
    autoMode: prev.autoMode,
    linkedTaskId: prev.linkedTaskId,
    targetSecs: prev.studyMinutes * 60,
  };

  persist(STORE.TIMER, state.timer);
  hideFullscreen();
  updatePomStatus();
  updatePomControls();
  updateNavBadge();
  elPauseCard.style.display = 'none';
}


/** Called on Start / Resume */
function startTimer() {
  const t = state.timer;

  if (!t.active) {
    // Fresh session — initialize all fields from config inputs
    t.active = true;
    t.type = 'study';
    t.cycle = 1;
    t.elapsed = 0;
    t.pauses = 0;
    t.sessionStart = Date.now();
    t.targetSecs = t.studyMinutes * 60;
  }


  t.running = true;
  t.startTs = Date.now();

  persist(STORE.TIMER, t);

  showFullscreen();
  tick();
  updateNavBadge();
  updatePomControls();
  updatePauseStats();
}

/** Tap-to-pause — called when user clicks fullscreen */
function pauseTimer() {
  const t = state.timer;
  if (!t.running) return;

  if (t.startTs) t.elapsed += (Date.now() - t.startTs) / 1000;
  t.running = false;
  t.startTs = null;
  t.pauses++;

  persist(STORE.TIMER, t);

  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  hideFullscreen();
  updatePomStatus();
  updatePomControls();
  updateNavBadge();
  updatePauseStats();
}

/** Hard reset — clears session */
function resetTimer() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  // Preserve config values
  const prev = state.timer;
  state.timer = {
    ...DEFAULT_TIMER,
    studyMinutes: prev.studyMinutes,
    breakMinutes: prev.breakMinutes,
    totalCycles: prev.totalCycles,
    autoMode: prev.autoMode,
    linkedTaskId: prev.linkedTaskId,
    targetSecs: prev.studyMinutes * 60,
  };

  persist(STORE.TIMER, state.timer);

  hideFullscreen();
  updatePomStatus();
  updatePomControls();
  updateNavBadge();
  elPauseCard.style.display = 'none';
}

/** RAF tick — timestamp-based, accurate after sleep */
function tick() {
  if (!state.timer.running) return;

  const remaining = getRemaining();
  const progress = getProgress();

  // Update fullscreen display
  elFsTime.textContent = fmtTime(remaining);

  // Update ring & status card (visible when FS is hidden after pause)
  updateRing(progress);
  elStatusTime.textContent = fmtTime(remaining);

  if (remaining <= 0) {
    onSegmentComplete();
    return;
  }

  rafId = requestAnimationFrame(tick);
}

/** Segment (study or break) has finished */
function onSegmentComplete() {
  const t = state.timer;

  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }

  // Finalize elapsed
  if (t.startTs) t.elapsed += (Date.now() - t.startTs) / 1000;
  t.running = false;
  t.startTs = null;

  // Save study session to history
  if (t.type === 'study') saveSession(t);

  // Flash fullscreen
  flashFullscreen();

  // Play sound + notify
  playSound();

  if (t.type === 'study') {
    notify('FocusFlow', `Study session ${t.cycle}/${t.totalCycles} complete! Take a break. 🎉`);

    if (t.autoMode) {
      const isLast = t.cycle >= t.totalCycles;
      if (isLast) {
        notify('FocusFlow', 'All cycles complete — great work! 🏆');
        setTimeout(() => finishAllCycles(), 1400);
      } else {
        setTimeout(() => beginBreak(), 700);
      }
    } else {
      setTimeout(() => finishSession(), 800);
    }
  } else {
    // Break finished
    notify('FocusFlow', 'Break over — time to focus! ▶');
    if (t.autoMode) {
      t.cycle++;
      setTimeout(() => beginNextStudy(), 700);
    } else {
      setTimeout(() => finishSession(), 800);
    }
  }
}

function beginBreak() {
  const t = state.timer;
  t.type = 'break';
  t.elapsed = 0;
  t.targetSecs = t.breakMinutes * 60;
  t.running = true;
  t.startTs = Date.now();
  t.pauses = 0;
  t.sessionStart = Date.now();

  persist(STORE.TIMER, t);
  updateFsPhase();
  tick();
}

function beginNextStudy() {
  const t = state.timer;
  t.type = 'study';
  t.elapsed = 0;
  t.targetSecs = t.studyMinutes * 60;
  t.running = true;
  t.startTs = Date.now();
  t.pauses = 0;
  t.sessionStart = Date.now();

  persist(STORE.TIMER, t);
  updateFsPhase();
  tick();
}

function finishSession() {
  const prev = state.timer;
  state.timer = {
    ...DEFAULT_TIMER,
    studyMinutes: prev.studyMinutes,
    breakMinutes: prev.breakMinutes,
    totalCycles: prev.totalCycles,
    autoMode: prev.autoMode,
    linkedTaskId: prev.linkedTaskId,
    targetSecs: prev.studyMinutes * 60,
  };

  persist(STORE.TIMER, state.timer);
  hideFullscreen();
  updatePomStatus();
  updatePomControls();
  updateNavBadge();
  elPauseCard.style.display = 'none';
}

function finishAllCycles() {
  finishSession();
}

/** Persist session record to history */
function saveSession(t) {
  const task = t.linkedTaskId
    ? state.tasks.find(tk => tk.id === t.linkedTaskId)
    : null;

  const session = {
    id: uid(),
    taskId: task ? task.id : null,
    taskTitle: task ? task.title.replace(/#\w+/g, '').trim() : null,
    type: t.type,
    startedAt: t.sessionStart || (Date.now() - t.elapsed * 1000),
    endedAt: Date.now(),
    duration: Math.floor(Math.max(0, t.elapsed)),
    pauses: t.pauses,
    cycle: t.cycle,
    totalCycles: t.totalCycles,
    tags: task ? (task.tags || []) : [],
  };

  state.sessions.unshift(session);
  persist(STORE.SESSIONS, state.sessions);

  if (state.tab === 'history') renderHistory();
}

// ────────────────────────────────────────────────────────────
// POMODORO PAGE UI
// ────────────────────────────────────────────────────────────

function updateRing(progress) {
  const offset = RING_CIRC * (1 - (progress || 0));
  elRingProgress.style.strokeDashoffset = offset;
}

function updatePomStatus() {
  const t = state.timer;
  const remaining = getRemaining();
  const progress = getProgress();

  elStatusTime.textContent = t.active ? fmtTime(remaining) : '--:--';
  elStatusPhase.textContent = t.active ? (t.type === 'study' ? 'STUDY' : 'BREAK') : 'READY';
  elStatusCycle.textContent = t.active
    ? `${t.cycle} / ${t.totalCycles}`
    : `― / ${t.totalCycles}`;

  updateRing(t.active ? progress : 0);

  if (t.type === 'break') {
    elRingProgress.classList.add('break-ring');
    elStatusGlow.classList.add('break');
  } else {
    elRingProgress.classList.remove('break-ring');
    elStatusGlow.classList.remove('break');
  }
}

function updatePomControls() {
  const t = state.timer;
  const locked = t.active; // disable config when session active

  elStudyMins.disabled = locked;
  elBreakMins.disabled = locked;
  elTotalCycles.disabled = locked;
  elAutoMode.disabled = locked;

  $$('.num-btn').forEach(btn => { btn.disabled = locked; });

  // Paused = active but not running
  const isPaused = t.active && !t.running;

  // Show "End & Save" only when paused (so user can cut session short)
  elBtnEndSession.style.display = isPaused ? '' : 'none';

  if (!t.active) {
    elBtnStartLbl.textContent = 'Start Session';
    elBtnStart.style.opacity = '';
    elBtnStart.querySelector('.btn-icon').textContent = '▶';
  } else if (t.running) {
    elBtnStartLbl.textContent = 'Running…';
    elBtnStart.style.opacity = '0.55';
    elBtnStart.querySelector('.btn-icon').textContent = '▶';
  } else {
    elBtnStartLbl.textContent = 'Resume';
    elBtnStart.style.opacity = '';
    elBtnStart.querySelector('.btn-icon').textContent = '▶';
  }
}

function updateNavBadge() {
  const t = state.timer;
  if (t.active) {
    navSessionInfo.classList.add('visible');
    sessionNavLbl.textContent = t.running
      ? (t.type === 'study' ? 'Studying' : 'On break')
      : 'Paused';
  } else {
    navSessionInfo.classList.remove('visible');
  }
}

function updatePauseStats() {
  const t = state.timer;
  if (!t.active) { elPauseCard.style.display = 'none'; return; }
  elPauseCard.style.display = 'flex';
  elPauseCount.textContent = t.pauses;
  elPausePhaseLbl.textContent = t.type === 'study' ? 'Study' : 'Break';
}

function updateLinkedTaskDisplay() {
  const t = state.timer;
  const task = t.linkedTaskId ? state.tasks.find(tk => tk.id === t.linkedTaskId) : null;

  if (task) {
    const cleanTitle = task.title.replace(/#\w+/g, '').trim();
    const tagsHtml = (task.tags || [])
      .map(tag => `<span class="tag-chip">#${tag}</span>`)
      .join('');
    elLinkedDisp.innerHTML = `
      <div class="linked-task-info">
        <span class="priority-badge ${task.priority}">${task.priority}</span>
        <span class="linked-task-title">${escHtml(cleanTitle)}</span>
        <div style="display:flex;gap:4px;flex-wrap:wrap">${tagsHtml}</div>
      </div>`;
  } else {
    elLinkedDisp.innerHTML =
      '<span class="no-task-text">No task linked — sessions will be saved as unnamed</span>';
  }
}

// ────────────────────────────────────────────────────────────
// FULLSCREEN TIMER UI
// ────────────────────────────────────────────────────────────

// Stored card rect at the moment morph started (used for reverse morph)
let _morphRect = null;

function showFullscreen() {
  updateFsPhase();

  const card = document.querySelector('.timer-status-card');
  const rect = card.getBoundingClientRect();
  _morphRect = rect; // save for reverse

  const fs = elFs;
  const ease = 'cubic-bezier(0.4, 0, 0.2, 1)';

  // ── Step 1: snap to card position instantly (no transition) ──
  fs.style.transition = 'none';
  fs.style.top = rect.top + 'px';
  fs.style.left = rect.left + 'px';
  fs.style.width = rect.width + 'px';
  fs.style.height = rect.height + 'px';
  fs.style.borderRadius = '16px';
  fs.style.opacity = '1';
  fs.classList.add('fs-active');
  fs.classList.remove('content-ready');

  void fs.offsetHeight; // force reflow

  // ── Step 2: animate to full viewport ──
  const T = '520ms';
  fs.style.transition = [
    `top ${T} ${ease}`,
    `left ${T} ${ease}`,
    `width ${T} ${ease}`,
    `height ${T} ${ease}`,
    `border-radius ${T} ${ease}`
  ].join(', ');

  fs.style.top = '0px';
  fs.style.left = '0px';
  fs.style.width = '100vw';
  fs.style.height = '100vh';
  fs.style.borderRadius = '0px';
  fs.style.pointerEvents = 'all';

  // ── Step 3: fade in text content after morph finishes ──
  setTimeout(() => { fs.classList.add('content-ready'); }, 540);

  document.body.style.overflow = 'hidden';
}

function hideFullscreen() {
  const fs = elFs;

  // ── Step 1: fade out text content first ──
  fs.classList.remove('content-ready');
  fs.style.pointerEvents = 'none';

  const ease = 'cubic-bezier(0.4, 0, 0.2, 1)';

  // ── Step 2: wait for text fade, then morph back ──
  setTimeout(() => {
    // Re-measure card in case layout shifted (e.g., timer finished on another tab)
    const card = document.querySelector('.timer-status-card');
    const rect = (state.tab === 'pomodoro')
      ? card.getBoundingClientRect()
      : (_morphRect || { top: window.innerHeight / 2, left: window.innerWidth / 2, width: 0, height: 0 });

    const T = '420ms';
    fs.style.transition = [
      `top ${T} ${ease}`,
      `left ${T} ${ease}`,
      `width ${T} ${ease}`,
      `height ${T} ${ease}`,
      `border-radius ${T} ${ease}`,
      `opacity 180ms ease 280ms`
    ].join(', ');

    fs.style.top = rect.top + 'px';
    fs.style.left = rect.left + 'px';
    fs.style.width = rect.width + 'px';
    fs.style.height = rect.height + 'px';
    fs.style.borderRadius = '16px';
    fs.style.opacity = '0';

    // ── Step 3: clean up after animation ──
    setTimeout(() => {
      fs.classList.remove('fs-active');
      document.body.style.overflow = '';
    }, 480);
  }, 180); // wait for fs-content opacity out (300ms transition, start morph at 180ms)
}

function updateFsPhase() {
  const t = state.timer;
  const study = t.type === 'study';

  elFsPhase.textContent = study ? 'STUDY' : 'BREAK';
  elFsPhase.className = `fs-phase ${study ? 'study' : 'brk'}`;
  elFsTime.className = `fs-time  ${study ? 'study' : 'brk'}`;
  elFsCycle.textContent = `Cycle ${t.cycle} of ${t.totalCycles}`;

  const task = t.linkedTaskId ? state.tasks.find(tk => tk.id === t.linkedTaskId) : null;
  elFsTask.textContent = task
    ? task.title.replace(/#\w+/g, '').trim()
    : '';

  elFsTime.textContent = fmtTime(t.targetSecs - t.elapsed);
}

// ────────────────────────────────────────────────────────────
// SECURITY HELPER
// ────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ────────────────────────────────────────────────────────────
// ■■■ TO-DO PAGE ■■■
// ────────────────────────────────────────────────────────────

function getAllTagsFromTasks() {
  const set = new Set();
  state.tasks.forEach(t => (t.tags || []).forEach(tag => set.add(tag)));
  return [...set].sort();
}

function renderTagFilterChips() {
  const tags = getAllTagsFromTasks();
  elTagFilterChips.innerHTML =
    `<button class="filter-chip chip-todo ${state.todoTagFilter === 'all' ? 'active' : ''}" data-filter="all">All</button>` +
    tags.map(tag =>
      `<button class="filter-chip chip-todo ${state.todoTagFilter === tag ? 'active' : ''}" data-filter="${escHtml(tag)}">#${escHtml(tag)}</button>`
    ).join('');
}

function getFilteredTasks() {
  return state.tasks.filter(task => {
    if (!state.showCompleted && task.completed) return false;
    if (state.todoTagFilter !== 'all' && !(task.tags || []).includes(state.todoTagFilter)) return false;
    if (state.todoPriorityFilter !== 'all' && task.priority !== state.todoPriorityFilter) return false;
    return true;
  });
}

function renderTasks() {
  renderTagFilterChips();
  const tasks = getFilteredTasks();

  // Remove existing cards
  $$('.task-card', elTaskList).forEach(el => el.remove());

  elTodoEmpty.style.display = tasks.length === 0 ? 'flex' : 'none';

  tasks.forEach((task, idx) => {
    elTaskList.appendChild(buildTaskCard(task, idx));
  });
}

function buildTaskCard(task, idx) {
  const cleanTitle = task.title.replace(/#\w+/g, '').trim();
  const isLinked = state.timer.linkedTaskId === task.id;

  const card = document.createElement('div');
  card.className = `task-card ${task.completed ? 'completed' : ''}`;
  card.dataset.taskId = task.id;
  card.style.animationDelay = `${idx * 35}ms`;

  const tagsHtml = (task.tags || [])
    .map(tag => `<span class="tag-chip" data-tag="${escHtml(tag)}">#${escHtml(tag)}</span>`)
    .join('');

  const descHtml = task.description
    ? `<div class="task-description">${escHtml(task.description)}</div>`
    : '';

  card.innerHTML = `
    <div class="task-checkbox ${task.completed ? 'checked' : ''}" data-task-id="${task.id}" role="checkbox" aria-checked="${task.completed}" tabindex="0"></div>
    <div class="task-body">
      <div class="task-header-row">
        <span class="task-title">${escHtml(cleanTitle)}</span>
        <span class="priority-badge ${task.priority}">${task.priority}</span>
      </div>
      ${descHtml}
      ${task.tags && task.tags.length ? `<div class="task-tags">${tagsHtml}</div>` : ''}
    </div>
    <div class="task-actions" aria-label="Task actions">
      <button class="task-action-btn ${isLinked ? 'link-active' : ''}" data-action="link" data-task-id="${task.id}" title="${isLinked ? 'Unlink from session' : 'Link to Pomodoro session'}">🍅</button>
      <button class="task-action-btn" data-action="edit" data-task-id="${task.id}" title="Edit task">✎</button>
      <button class="task-action-btn" data-action="delete" data-task-id="${task.id}" title="Delete task">✕</button>
    </div>`;

  return card;
}

function handleTaskListClick(e) {
  const checkbox = e.target.closest('.task-checkbox');
  const actionBtn = e.target.closest('[data-action]');
  const tagChip = e.target.closest('.tag-chip[data-tag]');

  if (checkbox) {
    toggleTaskDone(checkbox.dataset.taskId);
    return;
  }
  if (actionBtn) {
    const { action, taskId } = actionBtn.dataset;
    if (action === 'link') toggleLinkTask(taskId);
    if (action === 'edit') openEditTaskModal(taskId);
    if (action === 'delete') deleteTask(taskId);
    return;
  }
  if (tagChip) {
    state.todoTagFilter = tagChip.dataset.tag;
    renderTasks();
  }
}

function toggleTaskDone(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  task.completed = !task.completed;
  persist(STORE.TASKS, state.tasks);
  renderTasks();
}

function deleteTask(taskId) {
  state.tasks = state.tasks.filter(t => t.id !== taskId);
  if (state.timer.linkedTaskId === taskId) {
    state.timer.linkedTaskId = null;
    persist(STORE.TIMER, state.timer);
    updateLinkedTaskDisplay();
  }
  persist(STORE.TASKS, state.tasks);
  renderTasks();
}

function toggleLinkTask(taskId) {
  state.timer.linkedTaskId = state.timer.linkedTaskId === taskId ? null : taskId;
  persist(STORE.TIMER, state.timer);
  updateLinkedTaskDisplay();
  renderTasks();
}

// ────────────────────────────────────────────────────────────
// TASK MODAL
// ────────────────────────────────────────────────────────────

function openNewTaskModal() {
  state.editingTaskId = null;
  elModalTitle.textContent = 'New Task';
  elModalSubmit.textContent = 'Add Task';
  elTaskForm.reset();
  elTagPreview.innerHTML = '';
  // Default priority = medium
  const medRadio = elTaskForm.querySelector('input[value="medium"]');
  if (medRadio) medRadio.checked = true;
  openModal();
}

function openEditTaskModal(taskId) {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) return;
  state.editingTaskId = taskId;
  elModalTitle.textContent = 'Edit Task';
  elModalSubmit.textContent = 'Save Changes';
  elTaskTitle.value = task.title;
  elTaskDesc.value = task.description || '';
  const radio = elTaskForm.querySelector(`input[value="${task.priority}"]`);
  if (radio) radio.checked = true;
  updateTagPreview();
  openModal();
}

function openModal() {
  elModalBackdrop.classList.add('open');
  setTimeout(() => elTaskTitle.focus(), 60);
}

function closeModal() {
  elModalBackdrop.classList.remove('open');
  state.editingTaskId = null;
}

function updateTagPreview() {
  const tags = [
    ...parseTags(elTaskTitle.value),
    ...parseTags(elTaskDesc.value),
  ];
  const unique = [...new Set(tags)];
  elTagPreview.innerHTML = unique
    .map(t => `<span class="tag-chip">#${escHtml(t)}</span>`)
    .join('');
}

function handleTaskFormSubmit(e) {
  e.preventDefault();
  const title = elTaskTitle.value.trim();
  if (!title) { elTaskTitle.focus(); return; }

  const description = elTaskDesc.value.trim();
  const priorityEl = elTaskForm.querySelector('input[name="priority"]:checked');
  const priority = priorityEl ? priorityEl.value : 'medium';
  const tags = [...new Set([...parseTags(title), ...parseTags(description)])];

  if (state.editingTaskId) {
    const task = state.tasks.find(t => t.id === state.editingTaskId);
    if (task) Object.assign(task, { title, description, priority, tags });
  } else {
    state.tasks.unshift({ id: uid(), title, description, priority, tags, completed: false, createdAt: Date.now() });
  }

  persist(STORE.TASKS, state.tasks);
  closeModal();
  renderTasks();
  updateLinkedTaskDisplay();
}

// ────────────────────────────────────────────────────────────
// LINK TASK MODAL (from Pomodoro tab)
// ────────────────────────────────────────────────────────────

function openLinkModal() {
  const available = state.tasks.filter(t => !t.completed);

  if (available.length === 0) {
    elLinkTaskList.innerHTML =
      '<div style="padding:24px;text-align:center;font-size:13px;color:var(--text2)">No incomplete tasks.<br>Add tasks on the To-Do tab first.</div>';
  } else {
    elLinkTaskList.innerHTML = available.map(task => {
      const cleanTitle = task.title.replace(/#\w+/g, '').trim();
      const selected = state.timer.linkedTaskId === task.id;
      const tagsHtml = (task.tags || []).slice(0, 4)
        .map(tag => `<span class="tag-chip" style="font-size:10px">#${escHtml(tag)}</span>`)
        .join('');
      return `
        <div class="link-task-item ${selected ? 'selected' : ''}" data-task-id="${task.id}">
          <span class="priority-badge ${task.priority}" style="font-size:9px">${task.priority}</span>
          <span class="link-task-item-title">${escHtml(cleanTitle)}</span>
          <div style="display:flex;gap:3px;flex-wrap:wrap">${tagsHtml}</div>
          ${selected ? '<span class="link-selected-mark">✓ linked</span>' : ''}
        </div>`;
    }).join('');
  }

  elLinkBackdrop.classList.add('open');
}

function closeLinkModal() {
  elLinkBackdrop.classList.remove('open');
}

// ────────────────────────────────────────────────────────────
// ■■■ HISTORY PAGE ■■■
// ────────────────────────────────────────────────────────────

function renderHistory() {
  const allStudy = state.sessions.filter(s => s.type === 'study');

  // ── Metrics ──
  const now = Date.now();
  const todayMid = new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  const weekMid = todayMid - 6 * 86_400_000;

  const todaySess = allStudy.filter(s => s.startedAt >= todayMid);
  const weekSess = allStudy.filter(s => s.startedAt >= weekMid);

  elMetricToday.textContent = fmtDur(sumStudySecs(todaySess)) || '0m';
  elMetricTodayCnt.textContent = `${todaySess.length} session${todaySess.length !== 1 ? 's' : ''}`;
  elMetricWeek.textContent = fmtDur(sumStudySecs(weekSess)) || '0m';
  elMetricWeekCnt.textContent = `${weekSess.length} session${weekSess.length !== 1 ? 's' : ''}`;
  elMetricAlltime.textContent = fmtDur(sumStudySecs(allStudy)) || '0m';
  elMetricAlltimeCnt.textContent = `${allStudy.length} session${allStudy.length !== 1 ? 's' : ''}`;

  // ── Tag chips ──
  const allTags = new Set();
  allStudy.forEach(s => (s.tags || []).forEach(t => allTags.add(t)));

  elHistTagChips.innerHTML =
    `<button class="filter-chip chip-history ${state.histTagFilter === 'all' ? 'active' : ''}" data-htag="all">All</button>` +
    [...allTags].sort().map(tag =>
      `<button class="filter-chip chip-history ${state.histTagFilter === tag ? 'active' : ''}" data-htag="${escHtml(tag)}">#${escHtml(tag)}</button>`
    ).join('');

  // ── Tag totals ──
  if (allTags.size > 0) {
    elTagTotalsSection.style.display = 'block';
    const tagMap = {};
    allStudy.forEach(s => {
      (s.tags || []).forEach(tag => { tagMap[tag] = (tagMap[tag] || 0) + (s.duration || 0); });
    });
    elTagTotalsList.innerHTML = Object.entries(tagMap)
      .sort((a, b) => b[1] - a[1])
      .map(([tag, secs]) =>
        `<div class="tag-total-item">
           <span class="tag-total-name">#${escHtml(tag)}</span>
           <span class="tag-total-time">${fmtDur(secs)}</span>
         </div>`
      ).join('');
  } else {
    elTagTotalsSection.style.display = 'none';
  }

  // ── Session list ──
  const filtered = state.histTagFilter === 'all'
    ? allStudy
    : allStudy.filter(s => (s.tags || []).includes(state.histTagFilter));

  $$('.session-row, .date-divider', elSessionList).forEach(el => el.remove());

  if (filtered.length === 0) {
    elHistoryEmpty.style.display = 'flex';
    return;
  }
  elHistoryEmpty.style.display = 'none';

  let lastGroup = null;
  filtered.forEach((session, idx) => {
    const group = fmtDateGroup(session.startedAt);
    if (group !== lastGroup) {
      const div = document.createElement('div');
      div.className = 'date-divider';
      div.textContent = group;
      elSessionList.appendChild(div);
      lastGroup = group;
    }
    elSessionList.appendChild(buildSessionRow(session, idx));
  });
}

function buildSessionRow(session, idx) {
  const row = document.createElement('div');
  row.className = 'session-row';
  row.style.animationDelay = `${idx * 28}ms`;

  const taskName = session.taskTitle || 'Unnamed Session';
  const tagsHtml = (session.tags || []).slice(0, 4)
    .map(tag =>
      `<span style="font-size:10px;background:var(--accent-todo-dim);color:var(--accent-todo-light);padding:1px 7px;border-radius:10px">#${escHtml(tag)}</span>`
    ).join('');

  row.innerHTML = `
    <div class="session-dot ${session.type}"></div>
    <div class="session-timestamp">${fmtTimestamp(session.startedAt)}</div>
    <div class="session-info">
      <div class="session-task-name">${escHtml(taskName)}</div>
      <div class="session-meta">Cycle ${session.cycle}/${session.totalCycles} ${tagsHtml}</div>
    </div>
    <div class="session-dur">${fmtDur(session.duration)}</div>
    <div class="session-pauses" title="Pauses during session">⏸ ${session.pauses}</div>`;

  return row;
}

// ────────────────────────────────────────────────────────────
// ■■■ SETTINGS ■■■
// ────────────────────────────────────────────────────────────

function applySettings() {
  const s = state.settings;
  document.documentElement.dataset.theme = s.theme;
  document.documentElement.dataset.glass = String(s.liquidGlass);

  elThemeDark.classList.toggle('active', s.theme === 'dark');
  elThemeLight.classList.toggle('active', s.theme === 'light');
  elLiquidGlass.checked = s.liquidGlass;
  elSoundEnabled.checked = s.sound;
  elNotifEnabled.checked = s.notifications;
  elSoundPreset.value = s.soundPreset;

  elSoundPresetRow.style.display = s.sound ? '' : 'none';
}

function saveSetting(key, val) {
  state.settings[key] = val;
  persist(STORE.SETTINGS, state.settings);
  applySettings();
}

// ────────────────────────────────────────────────────────────
// EVENT LISTENERS
// ────────────────────────────────────────────────────────────

// ── Navigation ──
navTabs.forEach(tab => {
  tab.addEventListener('click', () => navigate(tab.dataset.tab));
});

// ── Pomodoro: number controls ──
$$('.num-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    const field = btn.dataset.field;
    const dir = parseInt(btn.dataset.dir, 10);
    const input = document.getElementById(field);
    let val = parseInt(input.value, 10) + dir;
    val = Math.max(parseInt(input.min, 10), Math.min(parseInt(input.max, 10), val));
    input.value = val;
    state.timer[field] = val;
    if (field === 'studyMinutes' && !state.timer.active) {
      state.timer.targetSecs = val * 60;
    }
    persist(STORE.TIMER, state.timer);
    updatePomStatus();
  });
});

// ── Number inputs direct edit ──
[elStudyMins, elBreakMins, elTotalCycles].forEach(input => {
  input.addEventListener('change', () => {
    let val = Math.max(parseInt(input.min, 10), Math.min(parseInt(input.max, 10), parseInt(input.value, 10) || 1));
    input.value = val;
    state.timer[input.id] = val;
    if (input.id === 'studyMinutes' && !state.timer.active) {
      state.timer.targetSecs = val * 60;
    }
    persist(STORE.TIMER, state.timer);
    updatePomStatus();
  });
});

// ── Auto mode ──
elAutoMode.addEventListener('change', () => {
  state.timer.autoMode = elAutoMode.checked;
  persist(STORE.TIMER, state.timer);
});

// ── Start / Resume ──
elBtnStart.addEventListener('click', () => {
  getAudio(); // init AudioContext on user gesture
  if (state.timer.running) { showFullscreen(); return; }
  if (state.settings.notifications) requestNotifPermission();
  startTimer();
});

// ── Reset ──
elBtnReset.addEventListener('click', () => {
  if (state.timer.active && !window.confirm('Reset the current session?')) return;
  resetTimer();
});

// ── End & Save: mark paused session as completed ──
elBtnEndSession.addEventListener('click', () => { endSession(); });

// ── Fullscreen: tap to pause ──
elFs.addEventListener('click', () => pauseTimer());

// ── Link task button ──
elBtnLinkTask.addEventListener('click', openLinkModal);

// ── Task list: delegated clicks ──
elTaskList.addEventListener('click', handleTaskListClick);

// ── Keyboard: checkbox enter/space ──
elTaskList.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.classList.contains('task-checkbox')) {
    e.preventDefault();
    toggleTaskDone(e.target.dataset.taskId);
  }
});

// ── Add task button ──
elBtnAddTask.addEventListener('click', openNewTaskModal);

// ── Task modal close ──
elModalClose.addEventListener('click', closeModal);
elModalCancel.addEventListener('click', closeModal);
elModalBackdrop.addEventListener('click', e => { if (e.target === elModalBackdrop) closeModal(); });

// ── Task form submit ──
elTaskForm.addEventListener('submit', handleTaskFormSubmit);

// ── Live tag preview ──
elTaskTitle.addEventListener('input', updateTagPreview);
elTaskDesc.addEventListener('input', updateTagPreview);

// ── Tag filter chips (todo) ──
elTagFilterChips.addEventListener('click', e => {
  const chip = e.target.closest('.filter-chip');
  if (chip) { state.todoTagFilter = chip.dataset.filter; renderTasks(); }
});

// ── Priority filter ──
elPriorityFilter.addEventListener('change', () => {
  state.todoPriorityFilter = elPriorityFilter.value;
  renderTasks();
});

// ── Show completed toggle ──
elShowCompleted.addEventListener('change', () => {
  state.showCompleted = elShowCompleted.checked;
  renderTasks();
});

// ── History tag chips ──
elHistTagChips.addEventListener('click', e => {
  const chip = e.target.closest('.filter-chip');
  if (chip) { state.histTagFilter = chip.dataset.htag; renderHistory(); }
});

// ── Link modal ──
elLinkModalClose.addEventListener('click', closeLinkModal);
elLinkModalCancel.addEventListener('click', closeLinkModal);
elLinkBackdrop.addEventListener('click', e => { if (e.target === elLinkBackdrop) closeLinkModal(); });

elBtnUnlink.addEventListener('click', () => {
  state.timer.linkedTaskId = null;
  persist(STORE.TIMER, state.timer);
  updateLinkedTaskDisplay();
  renderTasks();
  closeLinkModal();
});

elLinkTaskList.addEventListener('click', e => {
  const item = e.target.closest('.link-task-item');
  if (!item) return;
  const taskId = item.dataset.taskId;
  state.timer.linkedTaskId = state.timer.linkedTaskId === taskId ? null : taskId;
  persist(STORE.TIMER, state.timer);
  updateLinkedTaskDisplay();
  renderTasks();
  closeLinkModal();
});

// ── Settings ──
elThemeDark.addEventListener('click', () => saveSetting('theme', 'dark'));
elThemeLight.addEventListener('click', () => saveSetting('theme', 'light'));
elLiquidGlass.addEventListener('change', () => saveSetting('liquidGlass', elLiquidGlass.checked));
elSoundEnabled.addEventListener('change', () => saveSetting('sound', elSoundEnabled.checked));
elNotifEnabled.addEventListener('change', () => saveSetting('notifications', elNotifEnabled.checked));
elSoundPreset.addEventListener('change', () => saveSetting('soundPreset', elSoundPreset.value));

elBtnTestSound.addEventListener('click', () => {
  getAudio();
  playSound(elSoundPreset.value);
});

elBtnClearHistory.addEventListener('click', () => {
  if (!window.confirm('Clear all session history? This cannot be undone.')) return;
  state.sessions = [];
  persist(STORE.SESSIONS, state.sessions);
  if (state.tab === 'history') renderHistory();
});

elBtnClearAll.addEventListener('click', () => {
  if (!window.confirm('Reset ALL data — tasks, history, and settings? This cannot be undone.')) return;
  Object.values(STORE).forEach(k => localStorage.removeItem(k));
  window.location.reload();
});

// ── Global keyboard shortcuts ──
document.addEventListener('keydown', e => {
  // Space = pause when fullscreen is visible
  if (e.code === 'Space' && elFs.classList.contains('fs-active')) {
    e.preventDefault();
    pauseTimer();
    return;
  }
  // Escape = close topmost modal
  if (e.key === 'Escape') {
    if (elLinkBackdrop.classList.contains('open')) { closeLinkModal(); return; }
    if (elModalBackdrop.classList.contains('open')) { closeModal(); return; }
  }
});

// ── Visibility change: recalculate elapsed when tab becomes visible ──
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.timer.running) {
    // The next tick() call will naturally pick up the correct remaining time.
    // If time ran out while hidden, onSegmentComplete() handles it.
    if (!rafId) tick();
  }
});

// ────────────────────────────────────────────────────────────
// SCROLL-BASED PAGE NAVIGATION
// ────────────────────────────────────────────────────────────

/**
 * Scroll wheel at the boundary of a page triggers navigation to the
 * adjacent tab. Requires intentional over-scroll (accumulated deltaY ≥ 130px)
 * plus a 900ms cooldown so rapid/accidental navigation is prevented.
 */
function setupScrollNav() {
  let locked = false;   // cooldown flag
  let accum = 0;       // accumulated over-scroll
  let resetTimerId = null;    // resets accum when user pauses

  const THRESHOLD = 130;  // px of overscroll needed
  const COOLDOWN = 900;  // ms before next nav allowed
  const RESET_MS = 380;  // ms of scroll pause to reset accumulator

  document.querySelectorAll('.page').forEach(page => {
    page.addEventListener('wheel', (e) => {
      if (locked) return;

      const atTop = page.scrollTop <= 2;
      const atBottom = page.scrollTop + page.clientHeight >= page.scrollHeight - 2;
      const down = e.deltaY > 0;
      const up = e.deltaY < 0;

      const canNavDown = down && atBottom;
      const canNavUp = up && atTop;

      if (canNavDown || canNavUp) {
        // Accumulate overscroll delta
        accum += Math.abs(e.deltaY);

        // Reset if user pauses scrolling
        clearTimeout(resetTimerId);
        resetTimerId = setTimeout(() => { accum = 0; }, RESET_MS);

        if (accum >= THRESHOLD) {
          accum = 0;
          locked = true;

          const idx = TAB_ORDER.indexOf(state.tab);
          if (canNavDown && idx < TAB_ORDER.length - 1) {
            navigate(TAB_ORDER[idx + 1]);
          } else if (canNavUp && idx > 0) {
            navigate(TAB_ORDER[idx - 1]);
          }

          setTimeout(() => { locked = false; }, COOLDOWN);
        }
      } else {
        // Normal page scroll — reset overscroll accumulator
        clearTimeout(resetTimerId);
        accum = 0;
      }
    }, { passive: true });
  });
}
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js");
}
function init() {
  // Apply persisted settings
  applySettings();

  // Restore config inputs from saved timer state
  const t = state.timer;
  elStudyMins.value = t.studyMinutes;
  elBreakMins.value = t.breakMinutes;
  elTotalCycles.value = t.totalCycles;
  elAutoMode.checked = t.autoMode;

  // Update all Pomodoro UI
  updatePomStatus();
  updatePomControls();
  updateLinkedTaskDisplay();
  updateNavBadge();
  updatePauseStats();

  // Render tab pages
  renderTasks();
  renderHistory();

  // If timer was paused mid-session, show the resume UI
  if (t.active && !t.running) {
    updatePomStatus();
    updatePomControls();
  }

  // Scroll-based page navigation
  setupScrollNav();

  // Periodic heartbeat: keep ring / status time fresh during a paused state
  // and re-syncs display every second while running
  setInterval(() => {
    if (state.timer.active) {
      updatePomStatus();
      updatePauseStats();
    }
  }, 1000);
}

init();
