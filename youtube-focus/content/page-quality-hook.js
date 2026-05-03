(() => {
  /**
   * Runs in the page context (youtube.com). Controls stream quality only — no CSS,
   * player sizing, or visual scaling (those look like “resolution” but are not).
   *
   * YouTube often ignores setPlaybackQuality; we combine:
   * - yt-player-quality localStorage (same shape as the in-player quality menu)
   * - setPlaybackQualityRange / setPlaybackQuality when the player exposes them
   * - occasional reload via loadVideoById at current time when still above cap (throttled)
   *
   * ## Detection criteria (when limits are active)
   *
   * Limits come from `data-yt-focus-force-lowest` / `data-yt-focus-max-quality` on
   * `<html>`. We **stick** playback to a single ladder rung (same mechanism for both
   * modes — the one that works reliably on today’s player):
   *
   * - **Stick lowest:** target = coarsest rung available (~144p).
   * - **Ceiling / max resolution:** target = sharpest rung still ≤ your selected cap
   *   (e.g. cap “720p” → target `hd720` when available). This mirrors stick-low
   *   (always-on range + localStorage + corrective reload), not a loose `min…max`
   *   band that the player tended to ignore.
   *
   * A **violation** is when either:
   *
   * 1. **Player API** — `getPlaybackQuality()` is not `auto` and its rank is **above**
   *    the target rung’s rank.
   * 2. **Stored menu preference** — `yt-player-quality` JSON `data` is not `auto` and
   *    its rank is **above** the target’s rank.
   *
   * If either (1) or (2) fires, we clamp (API + storage + throttled reload). There is
   * no decoding of bitrate or `videoWidth`; only these symbolic labels.
   *
   * ## When we re-check
   *
   * Interval timer, navigation/player events, `playing`, and occasionally `waiting` on
   * `<video>` (manual quality often stalls into `waiting`). We intentionally do **not**
   * use `loadeddata` — it fires often during normal segmented playback and caused
   * `apply()` to run in a tight loop, which broke YouTube’s quality logic entirely.
   */
  const QUALITY_ORDER = [
    'tiny',
    'small',
    'medium',
    'large',
    'hd720',
    'hd1080',
    'hd1440',
    'hd2160',
    'hd2880',
    'hd4320',
    'highres',
  ];

  const LS_ACTIVE = 'yt-focus-quality-ls-active';
  const LS_BACKUP = 'yt-focus-quality-ls-backup';
  const YT_QUALITY = 'yt-player-quality';
  const QUALITY_TTL_MS = 2419200000;

  let lastReloadMs = 0;
  const RELOAD_COOLDOWN_MS = 32000;

  function normalizeLabel(q) {
    if (!q || typeof q !== 'string') return q;
    const key = q.toLowerCase().replace(/\s/g, '');
    const aliases = {
      hd1080p: 'hd1080',
      hd720p: 'hd720',
      hd480p: 'large',
      hd360p: 'medium',
      hd240p: 'small',
      hd144p: 'tiny',
      hd1440p: 'hd1440',
      hd2160p: 'hd2160',
    };
    return aliases[key] || key;
  }

  function rank(q) {
    const i = QUALITY_ORDER.indexOf(normalizeLabel(q));
    return i === -1 ? 999 : i;
  }

  /** Sharpest rung still ≤ cap. */
  function pickUnderCeiling(available, cap) {
    if (!available || !available.length) return normalizeLabel(cap);
    const capR = rank(cap);
    const normalized = available.map(normalizeLabel);
    const allowed = normalized.filter((q) => rank(q) <= capR);
    if (!allowed.length) {
      return [...normalized].sort((a, b) => rank(a) - rank(b))[0];
    }
    allowed.sort((a, b) => rank(b) - rank(a));
    return allowed[0];
  }

  /** Coarsest rung available. */
  function pickLowest(available) {
    if (!available || !available.length) return 'tiny';
    const normalized = available.map(normalizeLabel);
    normalized.sort((a, b) => rank(a) - rank(b));
    return normalized[0];
  }

  function readYtQualityStorage() {
    try {
      return localStorage.getItem(YT_QUALITY);
    } catch {
      return null;
    }
  }

  /** Quality label saved by YouTube when the user picks a rung in the menu (often outranks API reports). */
  function parseLsQualityLabel() {
    const raw = readYtQualityStorage();
    if (!raw) return null;
    try {
      const o = JSON.parse(raw);
      if (!o || typeof o.data !== 'string') return null;
      const d = o.data.toLowerCase();
      if (d === 'auto') return null;
      return o.data;
    } catch {
      return null;
    }
  }

  function lsRankAbove(maxRank) {
    const label = parseLsQualityLabel();
    if (!label) return false;
    return rank(label) > maxRank;
  }

  function writeYtQualityPreference(level) {
    const now = Date.now();
    try {
      localStorage.setItem(
        YT_QUALITY,
        JSON.stringify({
          data: level,
          creation: now,
          expiration: now + QUALITY_TTL_MS,
        })
      );
    } catch {
      /* ignore */
    }
  }

  function clearYtQualityPreference() {
    try {
      localStorage.removeItem(YT_QUALITY);
    } catch {
      /* ignore */
    }
  }

  function beginLsOverrideIfNeeded() {
    try {
      if (localStorage.getItem(LS_ACTIVE) === '1') return;
      const prev = readYtQualityStorage();
      if (prev) localStorage.setItem(LS_BACKUP, prev);
      else localStorage.removeItem(LS_BACKUP);
      localStorage.setItem(LS_ACTIVE, '1');
    } catch {
      /* ignore */
    }
  }

  function endLsOverride() {
    try {
      if (localStorage.getItem(LS_ACTIVE) !== '1') return;
      clearYtQualityPreference();
      const backup = localStorage.getItem(LS_BACKUP);
      if (backup) {
        localStorage.setItem(YT_QUALITY, backup);
      }
      localStorage.removeItem(LS_BACKUP);
      localStorage.removeItem(LS_ACTIVE);
    } catch {
      /* ignore */
    }
  }

  function getPlayer() {
    const tryEl = (el) => {
      if (!el) return null;
      if (typeof el.getPlaybackQuality === 'function' || typeof el.setPlaybackQuality === 'function') {
        return el;
      }
      return null;
    };

    let p = tryEl(document.getElementById('movie_player'));
    if (p) return p;

    const v = document.querySelector(
      '#movie_player video, ytd-watch-flexy video, ytd-player#ytd-player video, ytd-shorts-player video, ytd-shorts video'
    );
    if (v) {
      for (let n = v; n; n = n.parentElement) {
        p = tryEl(n);
        if (p) return p;
      }
    }

    return tryEl(document.querySelector('ytd-watch-flexy #movie_player'));
  }

  function getAvailableLevels(player) {
    if (typeof player.getAvailableQualityLevels !== 'function') return null;
    try {
      const list = player.getAvailableQualityLevels();
      return Array.isArray(list) && list.length ? list : null;
    } catch {
      return null;
    }
  }

  function getCurrentLevel(player) {
    if (typeof player.getPlaybackQuality !== 'function') return null;
    try {
      return player.getPlaybackQuality();
    } catch {
      return null;
    }
  }

  function callQualityRange(player, minQ, maxQ) {
    const fn = player.setPlaybackQualityRange || player.setPlaybackQualityrange;
    if (typeof fn !== 'function') return false;
    try {
      fn.call(player, minQ, maxQ);
      return true;
    } catch {
      return false;
    }
  }

  function callSetQuality(player, level) {
    if (typeof player.setPlaybackQuality !== 'function') return;
    try {
      player.setPlaybackQuality(level);
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {boolean} [storageOnlyViolation] When true, reload even if API reports `auto` (manual
   *   quality often updates localStorage before `getPlaybackQuality` reflects the new rung).
   */
  function maybeReloadStream(player, reasonCapRank, storageOnlyViolation) {
    const now = Date.now();
    if (now - lastReloadMs < RELOAD_COOLDOWN_MS) return;
    const cur = getCurrentLevel(player);
    if (!storageOnlyViolation) {
      if (!cur || cur === 'auto') return;
      if (rank(cur) <= reasonCapRank) return;
    } else if (cur && cur !== 'auto' && rank(cur) <= reasonCapRank) {
      return;
    }

    if (typeof player.getVideoData !== 'function' || typeof player.getCurrentTime !== 'function') return;
    if (typeof player.loadVideoById !== 'function') return;

    let videoId;
    try {
      const d = player.getVideoData();
      videoId = d && d.video_id;
    } catch {
      return;
    }
    if (!videoId) return;

    let t = 0;
    try {
      t = player.getCurrentTime();
    } catch {
      /* ignore */
    }

    lastReloadMs = now;
    try {
      player.loadVideoById(videoId, t);
    } catch {
      /* ignore */
    }
  }

  function apply() {
    const forceLow = document.documentElement.getAttribute('data-yt-focus-force-lowest');
    const maxQ = document.documentElement.getAttribute('data-yt-focus-max-quality');

    if (forceLow !== '1' && !maxQ) {
      endLsOverride();
      return;
    }

    const player = getPlayer();
    if (!player) return;

    const avail = getAvailableLevels(player);

    const target =
      forceLow === '1' ? pickLowest(avail || []) : pickUnderCeiling(avail || [], maxQ);
    const targetR = rank(target);

    beginLsOverrideIfNeeded();
    callQualityRange(player, target, target);
    callSetQuality(player, target);
    const current = getCurrentLevel(player);
    const apiTooHigh = Boolean(current && current !== 'auto' && rank(current) > targetR);
    const storageTooHigh = lsRankAbove(targetR);
    if (apiTooHigh || storageTooHigh) {
      callSetQuality(player, target);
      maybeReloadStream(player, targetR, storageTooHigh && !apiTooHigh);
    }
    writeYtQualityPreference(target);
  }

  function isEnforcementActive() {
    const fl = document.documentElement.getAttribute('data-yt-focus-force-lowest');
    const mq = document.documentElement.getAttribute('data-yt-focus-max-quality');
    return fl === '1' || !!mq;
  }

  function tick() {
    try {
      apply();
    } catch {
      /* ignore */
    }
  }

  /** Only while limits are on. Do not use `loadeddata` — it spams during DASH playback. */
  let lastBufferApplyMs = 0;
  const BUFFER_APPLY_MIN_MS = 900;
  let bufferFollowUpId = 0;

  function tickOnBufferSignal() {
    if (!isEnforcementActive()) return;
    const now = Date.now();
    if (now - lastBufferApplyMs < BUFFER_APPLY_MIN_MS) return;
    lastBufferApplyMs = now;
    tick();
    if (bufferFollowUpId) clearTimeout(bufferFollowUpId);
    bufferFollowUpId = setTimeout(() => {
      bufferFollowUpId = 0;
      if (isEnforcementActive()) tick();
    }, 320);
  }

  const intervalMs = 550;
  setInterval(tick, intervalMs);
  document.addEventListener('yt-page-data-updated', tick);
  window.addEventListener('popstate', tick);
  document.addEventListener(
    'playing',
    (e) => {
      if (e.target && e.target.tagName === 'VIDEO') tick();
    },
    true
  );
  document.addEventListener(
    'waiting',
    (e) => {
      if (e.target && e.target.tagName === 'VIDEO') tickOnBufferSignal();
    },
    true
  );
  tick();
})();
