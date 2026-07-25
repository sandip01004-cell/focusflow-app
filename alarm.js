/* ================================================================
   FocusFlow — Alarm Engine
   alarm.js

   Manages the timer completion alarm:
   - Stores a custom alarm file in IndexedDB (key = "alarm")
   - Plays alarm sound (custom file or built-in preset) in a
     bounded loop — stops automatically after settings.alarmDuration
   - Exposes: alarm.start(), alarm.stop(), alarm.testPlay(),
              alarm.setFile(file), alarm.clear(), alarm.init()

   Design notes:
   - Mirrors the `music` object pattern from app.js
   - Uses setTimeout loop (not setInterval) for playback so we can
     cleanly bound the duration using timestamps
   - Does NOT introduce any new setInterval-based timer — all timing
     uses Date.now() comparison against alarmStartTs, consistent with
     the existing timestamp-based timer architecture
   ================================================================ */

'use strict';

/* ────────────────────────────────────────────────────────────
   INDEXEDDB — ALARM FILE STORAGE
   Reuses the same ff_music_db database as the music engine
   but stores the alarm file under the key "alarm" instead of
   "current", keeping both blobs cleanly separated.
──────────────────────────────────────────────────────────── */

const ALARM_IDB_NAME  = 'ff_music_db'; // same DB as music engine
const ALARM_IDB_STORE = 'tracks';       // same object store
const ALARM_IDB_KEY   = 'alarm';        // separate key from "current"

function openAlarmDB() {
  return new Promise((resolve, reject) => {
    // Version 1 — onupgradeneeded only fires if DB doesn't exist yet.
    // If the music engine already opened v1, this resolves immediately.
    const req = indexedDB.open(ALARM_IDB_NAME, 1);
    req.onupgradeneeded = (e) => e.target.result.createObjectStore(ALARM_IDB_STORE);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = ()  => reject(req.error);
  });
}

async function saveAlarmBlob(file) {
  const db = await openAlarmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ALARM_IDB_STORE, 'readwrite');
    tx.objectStore(ALARM_IDB_STORE).put(file, ALARM_IDB_KEY);
    tx.oncomplete = () => { resolve(); db.close(); };
    tx.onerror    = () => { reject(tx.error); db.close(); };
  });
}

async function getAlarmBlob() {
  const db = await openAlarmDB();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(ALARM_IDB_STORE, 'readonly');
    const req = tx.objectStore(ALARM_IDB_STORE).get(ALARM_IDB_KEY);
    req.onsuccess = () => { resolve(req.result); db.close(); };
    req.onerror   = () => { reject(req.error); db.close(); };
  });
}

async function deleteAlarmBlob() {
  const db = await openAlarmDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ALARM_IDB_STORE, 'readwrite');
    tx.objectStore(ALARM_IDB_STORE).delete(ALARM_IDB_KEY);
    tx.oncomplete = () => { resolve(); db.close(); };
    tx.onerror    = () => { reject(tx.error); db.close(); };
  });
}

/* ────────────────────────────────────────────────────────────
   ALARM ENGINE OBJECT
──────────────────────────────────────────────────────────── */

const alarm = {
  // The <Audio> element used to play a custom alarm file
  audio:       null,
  // Revocable object URL for the loaded Blob
  objectUrl:   null,
  // setTimeout handle for the playback loop
  _loopTimer:  null,
  // Flag preventing concurrent start() calls
  _ringing:    false,

  /* ── Initialise: load saved alarm file from IndexedDB on startup ── */
  async init() {
    try {
      const blob = await getAlarmBlob();
      if (blob) this._attachBlob(blob);
    } catch (e) { /* no saved alarm — silent fail */ }
    updateAlarmUI();

    // If the timer was in alarm state when the page loaded (e.g. woke from
    // sleep), start() and showCompletionScreen() are called from init() in
    // app.js AFTER this method, so we don't need to duplicate that here.
  },

  /* ── Wire a File/Blob to the Audio element ── */
  _attachBlob(blob) {
    this._cleanupAudio();
    this.objectUrl = URL.createObjectURL(blob);
    this.audio = new Audio(this.objectUrl);
    // Do NOT loop the Audio element directly — we control the loop
    // ourselves with setTimeout so we can enforce alarmDuration.
    this.audio.loop = false;
  },

  /* ── User selected a new alarm file ── */
  async setFile(file) {
    this._attachBlob(file);
    await saveAlarmBlob(file);
    state.settings.alarmFileName = file.name;
    state.settings.alarmType     = 'custom';
    persist(STORE.SETTINGS, state.settings);
    updateAlarmUI();
  },

  /* ── Remove the custom alarm file ── */
  async clear() {
    this._cleanupAudio();
    await deleteAlarmBlob();
    state.settings.alarmFileName = null;
    state.settings.alarmType     = 'builtin';
    persist(STORE.SETTINGS, state.settings);
    updateAlarmUI();
  },

  /* ── Start the alarm ringing loop ──
     Called when a session completes (or when the page wakes from sleep
     while the timer was already in alarmActive state).

     - Records alarmStartTs on state.timer if not already set
     - Plays the configured alarm sound
     - Schedules the next repetition after the clip ends
     - Automatically stops once alarmDuration seconds have elapsed
  ── */
  start() {
    if (!state.settings.sound) return; // respect the master sound toggle

    // Prevent double-starting (e.g. visibilitychange fires multiple times)
    if (this._ringing) return;
    this._ringing = true;

    // Record when the alarm started (use existing timestamp if waking from sleep)
    const t = state.timer;
    if (!t.alarmStartTs) {
      t.alarmStartTs = Date.now();
      persist(STORE.TIMER, t);
    }

    this._playOnce();
  },

  /* ── Internal: play one cycle of the alarm sound, then schedule next ── */
  _playOnce() {
    if (!this._ringing) return;

    const t        = state.timer;
    const duration = (state.settings.alarmDuration || 60) * 1000; // ms
    const elapsed  = Date.now() - (t.alarmStartTs || Date.now());

    // Stop automatically once the maximum duration is reached
    if (elapsed >= duration) {
      this._ringing = false;
      // Auto-dismiss: clear the alarm state but keep session as completed
      // so History retains the record. The completion UI stays visible for
      // the user to manually dismiss the overlay.
      t.alarmActive = false;
      persist(STORE.TIMER, t);
      // Hide just the ringing indicator (countdown reaches 0)
      _onAlarmExpired();
      return;
    }

    // Play the chosen sound
    if (state.settings.alarmType === 'custom' && this.audio) {
      // Custom file: reset and play from start
      this.audio.currentTime = 0;
      this.audio.play().catch(() => {
        // Autoplay blocked (e.g. no user gesture yet) — fall back to built-in
        this._playBuiltin();
      });

      // Schedule next ring after the clip finishes (or after 6s max to avoid silence gaps)
      const clipDuration = (this.audio.duration && isFinite(this.audio.duration))
        ? (this.audio.duration * 1000)
        : 6000;
      const nextIn = Math.min(clipDuration + 500, 6500); // brief gap between rings
      this._loopTimer = setTimeout(() => this._playOnce(), nextIn);

    } else {
      // Built-in preset sound (uses Web Audio API, fires once)
      this._playBuiltin();
      // Built-in sounds are short (~1.5–3.5s) — repeat every 5s
      this._loopTimer = setTimeout(() => this._playOnce(), 5000);
    }
  },

  /* ── Play the built-in sound preset via Web Audio API ── */
  _playBuiltin() {
    try {
      const ctx = getAudio(); // defined in app.js
      const preset = state.settings.soundPreset || 'bell';
      ({ bell: playBell, soft: playSoft, deep: playDeep, ding: playDing }[preset] || playBell)(ctx);
    } catch (e) { /* silently ignore audio errors */ }
  },

  /* ── Stop the alarm immediately ── */
  stop() {
    this._ringing = false;
    clearTimeout(this._loopTimer);
    this._loopTimer = null;
    if (this.audio) {
      this.audio.pause();
      this.audio.currentTime = 0;
    }
    // Clear alarm state on the timer
    const t = state.timer;
    t.alarmActive  = false;
    t.alarmStartTs = null;
    persist(STORE.TIMER, t);
  },

  /* ── One-shot test play for the Settings preview button ── */
  testPlay() {
    if (state.settings.alarmType === 'custom' && this.audio) {
      this.audio.currentTime = 0;
      this.audio.play().catch(() => this._playBuiltin());
    } else {
      this._playBuiltin();
    }
  },

  /* ── Release Audio element and object URL ── */
  _cleanupAudio() {
    if (this.audio)     { this.audio.pause(); this.audio = null; }
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
  },
};

/* ────────────────────────────────────────────────────────────
   ALARM UI SYNC
──────────────────────────────────────────────────────────── */

/** Sync the alarm settings card UI to current state */
function updateAlarmUI() {
  const s       = state.settings;
  const hasFile = !!(s.alarmFileName && s.alarmType === 'custom');

  const elFileName   = document.getElementById('alarm-file-name');
  const elClearBtn   = document.getElementById('btn-clear-alarm');
  const elDuration   = document.getElementById('alarmDuration');
  const elPresetRow  = document.getElementById('sound-preset-row');

  if (elFileName)  elFileName.textContent  = hasFile ? s.alarmFileName : 'No file chosen';
  if (elClearBtn)  elClearBtn.style.display = hasFile ? '' : 'none';
  if (elDuration)  elDuration.value         = String(s.alarmDuration || 60);

  // Show/hide built-in preset selector based on alarm type
  if (elPresetRow) {
    elPresetRow.style.display = (s.sound && s.alarmType !== 'custom') ? '' : 'none';
  }
}
