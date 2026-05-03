const STORAGE_KEYS = {
  settings: 'ytFocusSettings',
  stats: 'ytFocusStats',
  /** Unix ms; extension effects off until this time */
  goodFaithSnoozeUntil: 'ytFocusGoodFaithSnoozeUntil',
};

const GOOD_FAITH_PHRASE = 'Good Faith';
const GOOD_FAITH_SNOOZE_MS = 15 * 60 * 1000;

const DEFAULT_SETTINGS = {
  enabled: true,
  limitType: 'time',
  timeLimitMinutes: 30,
  videoLimitCount: 10,
  bufferSeconds: 12,
  commentUnlockBufferSeconds: 12,
  useBufferFriction: true,
  playbackBufferMessage: 'Daily limit reached — simulating slow buffering',
  stickToLowestQuality: false,
  capMaxPlaybackQuality: true,
  qualityCap: 'small',
  lowerBrowseThumbnails: true,
  browseThumbnailTier: 'default',
};

const QUALITY_CAPS = ['tiny', 'small', 'medium', 'large', 'hd720', 'hd1080'];
const THUMB_TIER_TARGETS = ['default', 'mqdefault', 'hqdefault', 'hq720', 'sddefault'];

function todayKey() {
  return new Date().toLocaleDateString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

function mergeSettings(raw) {
  const r = raw || {};
  let capMax = r.capMaxPlaybackQuality;
  if (capMax === undefined && r.useQualityCap !== undefined) {
    capMax = r.useQualityCap;
  }
  const m = {
    ...DEFAULT_SETTINGS,
    ...r,
    capMaxPlaybackQuality: capMax !== false,
    stickToLowestQuality: r.stickToLowestQuality === true,
    lowerBrowseThumbnails: r.lowerBrowseThumbnails !== false,
  };
  if (!['time', 'videos', 'both'].includes(m.limitType)) {
    m.limitType = DEFAULT_SETTINGS.limitType;
  }
  if (!THUMB_TIER_TARGETS.includes(m.browseThumbnailTier)) {
    m.browseThumbnailTier = DEFAULT_SETTINGS.browseThumbnailTier;
  }
    let pbm =
      typeof m.playbackBufferMessage === 'string'
        ? m.playbackBufferMessage.slice(0, 280)
        : DEFAULT_SETTINGS.playbackBufferMessage;
    m.playbackBufferMessage = pbm;
  delete m.usePlayerWindowCap;
  delete m.playerWindowPercent;
  delete m.useQualityCap;
  return m;
}

function normalizeStats(raw) {
  const day = todayKey();
  if (!raw || raw.dayKey !== day) {
    return { dayKey: day, secondsWatched: 0, videosWatched: 0 };
  }
  return {
    dayKey: raw.dayKey,
    secondsWatched: Number(raw.secondsWatched) || 0,
    videosWatched: Number(raw.videosWatched) || 0,
  };
}

function formatStats(settings, stats) {
  const mins = Math.floor(stats.secondsWatched / 60);
  const secs = stats.secondsWatched % 60;
  const timeStr = `${mins}m ${secs}s`;
  const vidLabel = `${stats.videosWatched} video${stats.videosWatched === 1 ? '' : 's'}`;
  const summary =
    settings.limitType === 'videos'
      ? `${vidLabel} · ${timeStr} playback`
      : `${timeStr} · ${vidLabel}`;
  let limitLine;
  if (settings.limitType === 'videos') {
    limitLine = `Cap: ${settings.videoLimitCount} videos/day`;
  } else if (settings.limitType === 'time') {
    limitLine = `Cap: ${settings.timeLimitMinutes} minutes/day`;
  } else {
    limitLine = `Caps: ${settings.timeLimitMinutes} min/day · ${settings.videoLimitCount} videos/day`;
  }
  return { summary, limitLine };
}

function isOverLimit(settings, stats) {
  const overTime = stats.secondsWatched >= settings.timeLimitMinutes * 60;
  const overVideos = stats.videosWatched >= settings.videoLimitCount;
  if (settings.limitType === 'videos') return overVideos;
  if (settings.limitType === 'both') return overTime || overVideos;
  return overTime;
}

function loadAll(cb) {
  chrome.storage.local.get(
    [STORAGE_KEYS.settings, STORAGE_KEYS.stats, STORAGE_KEYS.goodFaithSnoozeUntil],
    (result) => {
      const settings = mergeSettings(result[STORAGE_KEYS.settings] || {});
      const stats = normalizeStats(result[STORAGE_KEYS.stats]);
      const snoozeUntil = Number(result[STORAGE_KEYS.goodFaithSnoozeUntil]) || 0;
      cb(settings, stats, snoozeUntil);
    }
  );
}

function saveSettings(settings, onDone) {
  chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings }, onDone);
}

function saveStats(stats, onDone) {
  chrome.storage.local.set({ [STORAGE_KEYS.stats]: stats }, onDone);
}

function flash(msg, isError) {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  setTimeout(() => {
    el.textContent = '';
    el.classList.remove('error');
  }, 2200);
}

/** @type {ReturnType<typeof setInterval> | null} */
let goodFaithStatusIntervalId = null;

function applyForm(settings, stats, snoozeUntilMs) {
  if (goodFaithStatusIntervalId) {
    clearInterval(goodFaithStatusIntervalId);
    goodFaithStatusIntervalId = null;
  }

  document.getElementById('enabled').checked = !!settings.enabled;
  document.getElementById('limit-time').checked = settings.limitType === 'time';
  document.getElementById('limit-videos').checked = settings.limitType === 'videos';
  document.getElementById('limit-both').checked = settings.limitType === 'both';
  document.getElementById('timeLimit').value = settings.timeLimitMinutes;
  document.getElementById('videoLimit').value = settings.videoLimitCount;
  document.getElementById('bufferSeconds').value = settings.bufferSeconds;
  document.getElementById('commentUnlockBufferSeconds').value = settings.commentUnlockBufferSeconds;
  document.getElementById('playbackBufferMessage').value =
    typeof settings.playbackBufferMessage === 'string'
      ? settings.playbackBufferMessage
      : DEFAULT_SETTINGS.playbackBufferMessage;
  document.getElementById('useBufferFriction').checked = settings.useBufferFriction !== false;
  document.getElementById('stickToLowestQuality').checked = settings.stickToLowestQuality === true;
  document.getElementById('capMaxPlaybackQuality').checked = settings.capMaxPlaybackQuality !== false;

  const qc = QUALITY_CAPS.includes(settings.qualityCap) ? settings.qualityCap : 'small';
  document.getElementById('qualityCap').value = qc;

  document.getElementById('lowerBrowseThumbnails').checked = settings.lowerBrowseThumbnails !== false;
  const btier = THUMB_TIER_TARGETS.includes(settings.browseThumbnailTier)
    ? settings.browseThumbnailTier
    : DEFAULT_SETTINGS.browseThumbnailTier;
  document.getElementById('browseThumbnailTier').value = btier;

  const stick = settings.stickToLowestQuality === true;
  const capOn = settings.capMaxPlaybackQuality !== false;
  document.getElementById('qualityCap').disabled = stick || !capOn;

  const thumbOn = settings.lowerBrowseThumbnails !== false;
  document.getElementById('browseThumbnailTier').disabled = !thumbOn;

  const { summary, limitLine } = formatStats(settings, stats);
  document.getElementById('stats-summary').textContent = summary;
  document.getElementById('stats-limit').textContent = limitLine;

  const over = isOverLimit(settings, stats);
  document.getElementById('stats-summary').style.color = over ? '#ffb74d' : '#e8eaed';

  const statusEl = document.getElementById('good-faith-status');
  const until = Number(snoozeUntilMs) || 0;
  const updateSnoozeLabel = () => {
    if (until <= Date.now()) {
      statusEl.textContent = '';
      return;
    }
    const leftMin = Math.max(1, Math.ceil((until - Date.now()) / 60000));
    const leftSec = Math.ceil((until - Date.now()) / 1000);
    statusEl.textContent =
      leftSec <= 90
        ? `Break active · ${leftSec}s left`
        : `Break active · about ${leftMin} min left`;
  };
  if (until > Date.now()) {
    updateSnoozeLabel();
    goodFaithStatusIntervalId = setInterval(() => {
      updateSnoozeLabel();
      if (Date.now() >= until) {
        if (goodFaithStatusIntervalId) clearInterval(goodFaithStatusIntervalId);
        goodFaithStatusIntervalId = null;
        statusEl.textContent = '';
      }
    }, 5000);
  } else {
    statusEl.textContent = '';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadAll((settings, stats, snoozeUntil) => applyForm(settings, stats, snoozeUntil));

  function readFormSettings() {
    let limitType = 'time';
    if (document.getElementById('limit-videos').checked) limitType = 'videos';
    else if (document.getElementById('limit-both').checked) limitType = 'both';
    const qcRaw = document.getElementById('qualityCap').value;
    const qualityCap = QUALITY_CAPS.includes(qcRaw) ? qcRaw : 'small';
    const thumbTierRaw = document.getElementById('browseThumbnailTier').value;
    const browseThumbnailTier = THUMB_TIER_TARGETS.includes(thumbTierRaw)
      ? thumbTierRaw
      : DEFAULT_SETTINGS.browseThumbnailTier;
    return {
      enabled: document.getElementById('enabled').checked,
      limitType,
      timeLimitMinutes: Math.max(1, parseInt(document.getElementById('timeLimit').value, 10) || DEFAULT_SETTINGS.timeLimitMinutes),
      videoLimitCount: Math.max(1, parseInt(document.getElementById('videoLimit').value, 10) || DEFAULT_SETTINGS.videoLimitCount),
      bufferSeconds: Math.min(
        120,
        Math.max(3, parseInt(document.getElementById('bufferSeconds').value, 10) || DEFAULT_SETTINGS.bufferSeconds)
      ),
      commentUnlockBufferSeconds: Math.min(
        120,
        Math.max(
          3,
          parseInt(document.getElementById('commentUnlockBufferSeconds').value, 10) ||
            DEFAULT_SETTINGS.commentUnlockBufferSeconds
        )
      ),
      playbackBufferMessage: document
        .getElementById('playbackBufferMessage')
        .value.slice(0, 280),
      useBufferFriction: document.getElementById('useBufferFriction').checked,
      stickToLowestQuality: document.getElementById('stickToLowestQuality').checked,
      capMaxPlaybackQuality: document.getElementById('capMaxPlaybackQuality').checked,
      qualityCap,
      lowerBrowseThumbnails: document.getElementById('lowerBrowseThumbnails').checked,
      browseThumbnailTier,
    };
  }

  function persistFromForm() {
    const settings = readFormSettings();
    saveSettings(settings, () => flash('Saved'));
    loadAll(applyForm);
  }

  [
    'enabled',
    'limit-time',
    'limit-videos',
    'limit-both',
    'timeLimit',
    'videoLimit',
    'bufferSeconds',
    'commentUnlockBufferSeconds',
    'playbackBufferMessage',
    'useBufferFriction',
    'stickToLowestQuality',
    'capMaxPlaybackQuality',
    'qualityCap',
    'lowerBrowseThumbnails',
    'browseThumbnailTier',
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el.tagName === 'TEXTAREA') {
      el.addEventListener('blur', persistFromForm);
      return;
    }
    el.addEventListener('change', persistFromForm);
    if (el.type === 'number') {
      el.addEventListener('blur', persistFromForm);
    }
  });

  document.getElementById('reset-today').addEventListener('click', () => {
    const day = todayKey();
    saveStats({ dayKey: day, secondsWatched: 0, videosWatched: 0 }, () => {
      flash('Today’s counters cleared');
      loadAll(applyForm);
    });
  });

  document.getElementById('good-faith-snooze').addEventListener('click', () => {
    const input = document.getElementById('good-faith-input');
    if (input.value.trim() !== GOOD_FAITH_PHRASE) {
      flash(`Type "${GOOD_FAITH_PHRASE}" to confirm`, true);
      return;
    }
    const until = Date.now() + GOOD_FAITH_SNOOZE_MS;
    chrome.storage.local.set({ [STORAGE_KEYS.goodFaithSnoozeUntil]: until }, () => {
      flash('All features paused for 15 minutes');
      loadAll(applyForm);
    });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (
      changes[STORAGE_KEYS.settings] ||
      changes[STORAGE_KEYS.stats] ||
      changes[STORAGE_KEYS.goodFaithSnoozeUntil]
    ) {
      loadAll(applyForm);
    }
  });
});
