(() => {
  const STORAGE_SETTINGS = 'ytFocusSettings';
  const STORAGE_STATS = 'ytFocusStats';
  const STORAGE_GOOD_FAITH_SNOOZE_UNTIL = 'ytFocusGoodFaithSnoozeUntil';

  const DEFAULT_SETTINGS = {
    enabled: true,
    limitType: 'time',
    timeLimitMinutes: 30,
    videoLimitCount: 10,
    bufferSeconds: 12,
    /** Wait for unlocking comments over limit (independent of playback buffer). */
    commentUnlockBufferSeconds: 12,
    useBufferFriction: true,
    /** Fullscreen message before play when over limit (max 280 chars in merge). */
    playbackBufferMessage: 'Daily limit reached — simulating slow buffering',
    /** Hard friction: always push player toward the lowest ladder rung (~144p). Separate from ceiling. */
    stickToLowestQuality: false,
    /** Preferred: never exceed this tier (dropdown); respects manual quality within that ceiling less aggressively than stick-lowest */
    capMaxPlaybackQuality: true,
    qualityCap: 'small',
    /** When over limit, swap homepage / feed ytimg thumbs to at most browseThumbnailTier */
    lowerBrowseThumbnails: true,
    browseThumbnailTier: 'default',
  };

  /** Low → high for standard i.ytimg.com /vi still names */
  const THUMB_TIER_LADDER = ['default', 'mqdefault', 'hqdefault', 'hq720', 'sddefault', 'maxresdefault'];
  const THUMB_TIER_TARGETS = ['default', 'mqdefault', 'hqdefault', 'hq720', 'sddefault'];

  /** @type {typeof DEFAULT_SETTINGS} */
  let settings = { ...DEFAULT_SETTINGS };
  /** @type {{ dayKey: string, secondsWatched: number, videosWatched: number }} */
  let stats = { dayKey: '', secondsWatched: 0, videosWatched: 0 };

  /** Unix ms — extension effects off until this instant when > Date.now() */
  let goodFaithSnoozeUntilMs = 0;

  let frictionBypass = false;
  /** Bump to cancel pending buffer friction (`runFriction`) so we never `play()` a stale player after SPA navigation */
  let frictionEpoch = 0;
  let hookedVideo = null;
  let lastTickMs = Date.now();
  /** Cleared when leaving watch/shorts so returning to the same video counts again */
  let lastWatchSignature = null;
  let statsDirty = false;
  let saveTimer = null;
  let qualityPageHookInjected = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let watchIntervalId = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let pollIntervalId = null;

  const THUMB_ORIG_SRC = 'data-yt-focus-thumb-orig-src';
  const THUMB_ORIG_SRCSET = 'data-yt-focus-thumb-orig-srcset';
  /** @type {MutationObserver | null} */
  let thumbnailObserver = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let thumbnailScanTimer = null;
  let lastBrowseThumbnailFrictionKey = '';

  /** Visit sig (`watch:videoId`) once user pays buffer to show comments for this video while over limit */
  let commentsUnlockedForSig = null;
  /** @type {MutationObserver | null} */
  let commentsGateObserver = null;
  let commentsUnlockInProgress = false;

  function isExtensionCtxAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function teardown() {
    if (watchIntervalId) clearInterval(watchIntervalId);
    if (pollIntervalId) clearInterval(pollIntervalId);
    if (saveTimer) clearTimeout(saveTimer);
    disconnectThumbnailObserver();
    disconnectCommentsGateObserver();
    removeCommentsGate();
    watchIntervalId = null;
    pollIntervalId = null;
    saveTimer = null;
  }

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

  function goodFaithSnoozeActive() {
    return Number(goodFaithSnoozeUntilMs) > Date.now();
  }

  /** When false: no counting, friction, quality hooks, or thumbnail changes */
  function extensionApplying() {
    return settings.enabled && !goodFaithSnoozeActive();
  }

  function isTrackedPage() {
    const p = location.pathname;
    return p === '/watch' || p.startsWith('/watch') || p.startsWith('/shorts/');
  }

  function isWatchPageForComments() {
    const p = location.pathname;
    return p === '/watch' || p.startsWith('/watch');
  }

  function findCommentsHost() {
    return (
      document.querySelector('ytd-comments#comments') || document.querySelector('ytd-comments')
    );
  }

  function thumbTierRank(tier) {
    const i = THUMB_TIER_LADDER.indexOf(String(tier).toLowerCase());
    return i >= 0 ? i : -1;
  }

  function browseThumbnailsFrictionOn() {
    return (
      extensionApplying() &&
      isOverLimit() &&
      isBrowseThumbnailSurface() &&
      settings.lowerBrowseThumbnails !== false
    );
  }

  /** Home, subscriptions, search grids, etc. — not the watch/shorts player surfaces */
  function isBrowseThumbnailSurface() {
    const p = location.pathname;
    if (p === '/watch' || p.startsWith('/watch')) return false;
    if (p.startsWith('/shorts/')) return false;
    return true;
  }

  /**
   * If URL uses a thumb tier above settings.browseThumbnailTier, rewrite to that tier.
   * @param {string} url
   * @returns {string | null}
   */
  function downgradedYtimgThumbUrl(url) {
    if (!url || typeof url !== 'string') return null;
    const targetTier = THUMB_TIER_TARGETS.includes(settings.browseThumbnailTier)
      ? settings.browseThumbnailTier
      : DEFAULT_SETTINGS.browseThumbnailTier;
    let u;
    try {
      u = new URL(url, location.href);
    } catch {
      return null;
    }
    if (!u.hostname.endsWith('ytimg.com')) return null;
    const path = u.pathname;
    const webpM = path.match(
      /^\/vi_webp\/([\w-]{11})\/(maxresdefault|sddefault|hqdefault|hq720|mqdefault|default)\.webp$/i
    );
    const jpgM =
      webpM ? null : path.match(
        /^\/vi\/([\w-]{11})\/(maxresdefault|sddefault|hqdefault|hq720|mqdefault|default)\.(jpg|jpeg|webp)$/i
      );
    const m = webpM || jpgM;
    if (!m) return null;
    const id = m[1];
    const currentTier = m[2].toLowerCase();
    if (thumbTierRank(currentTier) <= thumbTierRank(targetTier)) return null;
    if (webpM) {
      return `${u.origin}/vi_webp/${id}/${targetTier}.webp${u.search}`;
    }
    return `${u.origin}/vi/${id}/${targetTier}.jpg${u.search}`;
  }

  /**
   * @param {string} srcset
   * @returns {string | null}
   */
  function downgradedSrcset(srcset) {
    const parts = srcset.split(',').map((s) => s.trim()).filter(Boolean);
    let changed = false;
    const out = parts.map((part) => {
      const space = part.indexOf(' ');
      const urlPart = (space === -1 ? part : part.slice(0, space)).trim();
      const desc = space === -1 ? '' : part.slice(space);
      const low = downgradedYtimgThumbUrl(urlPart);
      if (low && low !== urlPart) {
        changed = true;
        return `${low}${desc}`;
      }
      return part;
    });
    return changed ? out.join(', ') : null;
  }

  /**
   * @param {HTMLImageElement | HTMLSourceElement} el
   */
  function downgradeThumbnailElement(el) {
    if (!browseThumbnailsFrictionOn()) return;

    if (el instanceof HTMLImageElement) {
      const src = el.getAttribute('src');
      if (src && src.includes('ytimg.com')) {
        const low = downgradedYtimgThumbUrl(src);
        if (low) {
          if (!el.hasAttribute(THUMB_ORIG_SRC)) el.setAttribute(THUMB_ORIG_SRC, src);
          el.setAttribute('src', low);
        }
      }
      const srcset = el.getAttribute('srcset');
      if (srcset && srcset.includes('ytimg.com')) {
        const next = downgradedSrcset(srcset);
        if (next) {
          if (!el.hasAttribute(THUMB_ORIG_SRCSET)) el.setAttribute(THUMB_ORIG_SRCSET, srcset);
          el.setAttribute('srcset', next);
        }
      }
      return;
    }

    if (el instanceof HTMLSourceElement) {
      const srcset = el.getAttribute('srcset');
      if (srcset && srcset.includes('ytimg.com')) {
        const next = downgradedSrcset(srcset);
        if (next) {
          if (!el.hasAttribute(THUMB_ORIG_SRCSET)) el.setAttribute(THUMB_ORIG_SRCSET, srcset);
          el.setAttribute('srcset', next);
        }
      }
    }
  }

  function scanDowngradeThumbnails() {
    document
      .querySelectorAll('img[src*="ytimg.com"], img[srcset*="ytimg.com"], source[srcset*="ytimg.com"]')
      .forEach((n) => downgradeThumbnailElement(/** @type {HTMLElement} */ (n)));
  }

  function restoreThumbnailElements() {
    const sel = `[${THUMB_ORIG_SRC}], [${THUMB_ORIG_SRCSET}]`;
    document.querySelectorAll(sel).forEach((el) => {
      if (!(el instanceof HTMLImageElement) && !(el instanceof HTMLSourceElement)) return;
      const os = el.getAttribute(THUMB_ORIG_SRC);
      const oss = el.getAttribute(THUMB_ORIG_SRCSET);
      if (os) {
        el.setAttribute('src', os);
        el.removeAttribute(THUMB_ORIG_SRC);
      }
      if (oss) {
        el.setAttribute('srcset', oss);
        el.removeAttribute(THUMB_ORIG_SRCSET);
      }
    });
  }

  function disconnectThumbnailObserver() {
    if (thumbnailScanTimer) {
      clearTimeout(thumbnailScanTimer);
      thumbnailScanTimer = null;
    }
    if (thumbnailObserver) {
      thumbnailObserver.disconnect();
      thumbnailObserver = null;
    }
  }

  function scheduleThumbnailScanDebounced() {
    if (thumbnailScanTimer) return;
    thumbnailScanTimer = setTimeout(() => {
      thumbnailScanTimer = null;
      scanDowngradeThumbnails();
    }, 120);
  }

  function ensureThumbnailObserver() {
    if (thumbnailObserver) return;
    thumbnailObserver = new MutationObserver(() => {
      if (!browseThumbnailsFrictionOn()) return;
      scheduleThumbnailScanDebounced();
    });
    thumbnailObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset'],
    });
  }

  function syncBrowseThumbnailFriction() {
    const on = browseThumbnailsFrictionOn();
    const key = on ? `${settings.lowerBrowseThumbnails}:${settings.browseThumbnailTier}` : '';
    if (on) {
      ensureThumbnailObserver();
      if (key !== lastBrowseThumbnailFrictionKey) {
        lastBrowseThumbnailFrictionKey = key;
        restoreThumbnailElements();
      }
      scanDowngradeThumbnails();
    } else {
      lastBrowseThumbnailFrictionKey = '';
      disconnectThumbnailObserver();
      restoreThumbnailElements();
    }
  }

  function getWatchVideoId() {
    try {
      const u = new URL(location.href);
      if (u.pathname === '/watch' || u.pathname.startsWith('/watch')) {
        const v = u.searchParams.get('v');
        return v && /^[\w-]{11}$/.test(v) ? v : null;
      }
      if (u.pathname.startsWith('/shorts/')) {
        const raw = u.pathname.split('/')[2] || '';
        const id = raw.split('?')[0];
        return id && id.length >= 11 ? id.slice(0, 11) : null;
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function getMainVideo() {
    const nodes = document.querySelectorAll(
      '#movie_player video, ytd-watch-flexy video, ytd-player#ytd-player video, ytd-shorts-player video, ytd-shorts video'
    );
    /** @type {HTMLVideoElement[]} */
    const videos = [...nodes].filter((v) => v instanceof HTMLVideoElement);
    if (!videos.length) return null;

    const playing = videos.find((v) => !v.paused && !v.ended);
    if (playing) return playing;

    const areaOf = (v) => {
      const w = v.videoWidth || v.clientWidth || 0;
      const h = v.videoHeight || v.clientHeight || 0;
      return w * h;
    };

    const inMoviePlayer = videos.filter((v) => v.closest('#movie_player'));
    const pool = inMoviePlayer.length ? inMoviePlayer : videos;
    return pool.reduce((best, v) => (areaOf(v) > areaOf(best) ? v : best));
  }

  function isOverLimit() {
    if (!settings.enabled) return false;
    const overTime = stats.secondsWatched >= settings.timeLimitMinutes * 60;
    const overVideos = stats.videosWatched >= settings.videoLimitCount;
    if (settings.limitType === 'videos') return overVideos;
    if (settings.limitType === 'both') return overTime || overVideos;
    return overTime;
  }

  function scheduleSave() {
    if (!isExtensionCtxAlive()) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushStats, 2000);
  }

  function flushStats() {
    saveTimer = null;
    if (!statsDirty) return;
    if (!isExtensionCtxAlive()) {
      teardown();
      return;
    }
    try {
      chrome.storage.local.set({ [STORAGE_STATS]: { ...stats } }, () => {
        if (!isExtensionCtxAlive()) teardown();
        else void chrome.runtime?.lastError;
      });
      statsDirty = false;
    } catch {
      teardown();
    }
  }

  function bumpVideoCount() {
    stats.videosWatched += 1;
    statsDirty = true;
    flushStats();
  }

  function accumulateWatchSeconds(delta) {
    if (delta <= 0) return;
    stats.secondsWatched += delta;
    statsDirty = true;
    scheduleSave();
  }

  /** Removes legacy sizing CSS from older builds — stream quality is capped via page hook only */
  function removeLegacyQualityVisualCss() {
    document.getElementById('yt-focus-quality-visual')?.remove();
  }

  function ensureQualityPageHook() {
    if (qualityPageHookInjected) return;
    if (!isExtensionCtxAlive()) return;
    let url;
    try {
      url = chrome.runtime.getURL('content/page-quality-hook.js');
    } catch {
      return;
    }
    qualityPageHookInjected = true;
    const s = document.createElement('script');
    s.src = url;
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  function syncLimitFrictionToDom() {
    removeLegacyQualityVisualCss();
    ensureQualityPageHook();

    const root = document.documentElement;
    const frictionOn = extensionApplying() && isOverLimit();

    const allowed = ['tiny', 'small', 'medium', 'large', 'hd720', 'hd1080'];
    const capLabel =
      allowed.includes(settings.qualityCap) ? settings.qualityCap : 'small';

    root.removeAttribute('data-yt-focus-force-lowest');
    root.removeAttribute('data-yt-focus-max-quality');
    root.removeAttribute('data-yt-focus-quality-cap');
    document.getElementById('yt-focus-player-window')?.remove();
    root.removeAttribute('data-yt-focus-player-window');

    syncBrowseThumbnailFriction();
    syncCommentsFriction();

    if (!frictionOn) {
      return;
    }

    if (settings.stickToLowestQuality === true) {
      root.setAttribute('data-yt-focus-force-lowest', '1');
      return;
    }

    if (settings.capMaxPlaybackQuality !== false) {
      root.setAttribute('data-yt-focus-max-quality', capLabel);
    }
  }

  function injectOverlayStyles() {
    let s = document.getElementById('yt-focus-styles');
    if (!s) {
      s = document.createElement('style');
      s.id = 'yt-focus-styles';
      document.documentElement.appendChild(s);
    }
    s.textContent = `
      #yt-focus-buffer-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        background: rgba(15, 15, 15, 0.94);
        color: #f1f1f1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        font-family: system-ui, -apple-system, sans-serif;
        text-align: center;
        padding: 48px 32px;
      }
      #yt-focus-buffer-overlay .ring {
        width: 76px;
        height: 76px;
        border: 5px solid #3ea6ff33;
        border-top-color: #3ea6ff;
        border-radius: 50%;
        animation: yt-focus-spin 0.9s linear infinite;
        margin-bottom: 26px;
      }
      #yt-focus-buffer-overlay .yt-focus-buffer-msg {
        max-width: 36rem;
        font-size: 1.65rem;
        font-weight: 600;
        line-height: 1.4;
      }
      #yt-focus-buffer-overlay .count {
        font-size: 3rem;
        font-weight: 700;
        margin-top: 18px;
        letter-spacing: -0.02em;
      }
      @keyframes yt-focus-spin {
        to { transform: rotate(360deg); }
      }
    `;
  }

  function removeOverlay() {
    document.getElementById('yt-focus-buffer-overlay')?.remove();
  }

  function playbackBufferSeconds() {
    return Math.min(120, Math.max(3, Number(settings.bufferSeconds) || 12));
  }

  function playbackBufferOverlayMessage() {
    const raw = settings.playbackBufferMessage;
    const s = typeof raw === 'string' ? raw.slice(0, 280) : '';
    const trimmed = s.trim();
    return trimmed.length ? trimmed : DEFAULT_SETTINGS.playbackBufferMessage;
  }

  function commentUnlockBufferSecondsValue() {
    return Math.min(
      120,
      Math.max(
        3,
        Number(settings.commentUnlockBufferSeconds) || DEFAULT_SETTINGS.commentUnlockBufferSeconds
      )
    );
  }

  /**
   * Full-screen countdown (playback friction or paying comment unlock).
   * @param {string} message
   * @param {number} seconds
   * @param {{ shouldCancel?: () => boolean }} [opts]
   */
  async function runBufferCountdown(message, seconds, opts) {
    const shouldCancel = opts && typeof opts.shouldCancel === 'function' ? opts.shouldCancel : null;
    injectOverlayStyles();
    removeOverlay();
    const root = document.createElement('div');
    root.id = 'yt-focus-buffer-overlay';
    const sec = Math.min(120, Math.max(3, Number(seconds) || 12));
    let remaining = sec;
    root.innerHTML =
      '<div class="ring"></div><div class="yt-focus-buffer-msg"></div><div class="count"></div>';
    const msgEl = root.querySelector('.yt-focus-buffer-msg');
    const countEl = root.querySelector('.count');
    if (msgEl) msgEl.textContent = message;
    document.documentElement.appendChild(root);

    const tick = () => {
      if (countEl) countEl.textContent = `${remaining}s`;
    };
    tick();

    if (shouldCancel && shouldCancel()) {
      removeOverlay();
      return;
    }

    await new Promise((resolve) => {
      const id = setInterval(() => {
        if (shouldCancel && shouldCancel()) {
          clearInterval(id);
          resolve(undefined);
          return;
        }
        remaining -= 1;
        tick();
        if (remaining <= 0) {
          clearInterval(id);
          resolve(undefined);
        }
      }, 1000);
    });

    removeOverlay();
  }

  function removeCommentsGate() {
    document.getElementById('yt-focus-comments-gate')?.remove();
  }

  function disconnectCommentsGateObserver() {
    if (commentsGateObserver) {
      commentsGateObserver.disconnect();
      commentsGateObserver = null;
    }
  }

  function ensureCommentsGateObserver() {
    if (commentsGateObserver) return;
    commentsGateObserver = new MutationObserver(() => {
      syncCommentsFriction();
    });
    commentsGateObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function syncCommentsFriction() {
    const gateEligible =
      extensionApplying() && isOverLimit() && isWatchPageForComments();

    if (!gateEligible) {
      commentsUnlockedForSig = null;
      disconnectCommentsGateObserver();
      removeCommentsGate();
      return;
    }

    ensureCommentsGateObserver();

    const sig = getVisitSignature();
    if (!sig || sig.startsWith('shorts:')) {
      removeCommentsGate();
      return;
    }

    if (commentsUnlockedForSig === sig) {
      removeCommentsGate();
      return;
    }

    const comments = findCommentsHost();
    if (!comments) return;

    let gate = document.getElementById('yt-focus-comments-gate');
    if (gate) {
      const gateSig = gate.getAttribute('data-yt-focus-for-sig');
      const gateBuf = gate.getAttribute('data-yt-focus-comment-buffer');
      if (gateSig === sig && gateBuf === String(commentUnlockBufferSecondsValue())) return;
      gate.remove();
      gate = null;
    }

    const cs = comments.style;
    if (!cs.position || cs.position === 'static') cs.position = 'relative';

    gate = document.createElement('div');
    gate.id = 'yt-focus-comments-gate';
    gate.setAttribute('data-yt-focus-for-sig', sig);
    const sec = commentUnlockBufferSecondsValue();
    gate.setAttribute('data-yt-focus-comment-buffer', String(sec));
    gate.innerHTML = `
      <div class="yt-focus-comments-gate-inner">
        <p class="yt-focus-comments-gate-title">Comments hidden — daily limit reached</p>
        <p class="yt-focus-comments-gate-sub">Separate wait from playback unlock (${sec}s). Set both timers in the extension popup.</p>
        <button type="button" class="yt-focus-comments-unlock-btn">Unlock comments (${sec}s)</button>
      </div>
    `;
    gate.style.cssText = [
      'position:absolute',
      'inset:0',
      'z-index:6',
      'box-sizing:border-box',
      'background:#0f0f0f',
      'backdrop-filter:blur(14px)',
      '-webkit-backdrop-filter:blur(14px)',
      'border-radius:12px',
      'display:flex',
      'flex-direction:column',
      'align-items:stretch',
      'justify-content:flex-start',
      'padding:22px 20px 36px',
      'width:100%',
    ].join(';');
    const inner = gate.querySelector('.yt-focus-comments-gate-inner');
    if (inner) {
      inner.style.cssText = [
        'max-width:480px',
        'width:100%',
        'margin:0 auto',
        'text-align:center',
        'font-family:system-ui,-apple-system,sans-serif',
        'color:#f1f1f1',
        'flex-shrink:0',
      ].join(';');
    }
    const title = gate.querySelector('.yt-focus-comments-gate-title');
    if (title) {
      title.style.cssText =
        'margin:0 0 14px;font-size:1.45rem;font-weight:700;line-height:1.3;';
    }
    const sub = gate.querySelector('.yt-focus-comments-gate-sub');
    if (sub) {
      sub.style.cssText =
        'margin:0 0 26px;font-size:1.14rem;color:#c4c4c4;line-height:1.45;';
    }
    const btn = gate.querySelector('.yt-focus-comments-unlock-btn');
    if (btn) {
      btn.style.cssText = [
        'padding:16px 30px',
        'border:none',
        'border-radius:12px',
        'background:#3ea6ff',
        'color:#0f0f0f',
        'font-size:1.08rem',
        'font-weight:600',
        'cursor:pointer',
      ].join(';');
      btn.addEventListener('click', async () => {
        if (commentsUnlockInProgress) return;
        commentsUnlockInProgress = true;
        btn.setAttribute('disabled', 'true');
        try {
          await runBufferCountdown('Paying buffer — unlocking comments', commentUnlockBufferSecondsValue());
          commentsUnlockedForSig = sig;
          removeCommentsGate();
          syncCommentsFriction();
        } finally {
          commentsUnlockInProgress = false;
        }
      });
    }

    comments.appendChild(gate);
  }

  /** Clear play hook when leaving `/watch` or `/shorts` so SPA can't leave stale `<video>` play targets. */
  function detachPlaybackHooks() {
    if (!hookedVideo) return;
    hookedVideo.removeEventListener('play', hookedPlayListener);
    hookedVideo = null;
    frictionEpoch++;
  }

  /** @returns {boolean} true if `video` is still in-document (YouTube hides off-route players instead of destroying them). */
  function isVideoMounted(video) {
    try {
      return Boolean(video && document.contains(video));
    } catch (_) {
      return false;
    }
  }

  /**
   * @param {HTMLVideoElement} video
   */
  async function runFriction(video) {
    const epochStart = frictionEpoch;
    await runBufferCountdown(playbackBufferOverlayMessage(), playbackBufferSeconds(), {
      shouldCancel: () =>
        frictionEpoch !== epochStart ||
        !extensionApplying() ||
        !isTrackedPage() ||
        !isVideoMounted(video),
    });
    if (
      frictionEpoch !== epochStart ||
      !extensionApplying() ||
      !isTrackedPage() ||
      !isVideoMounted(video)
    ) {
      removeOverlay();
      return;
    }
    frictionBypass = true;
    try {
      await video.play();
    } catch (_) {
      /* autoplay / gesture policies */
    } finally {
      frictionBypass = false;
    }
  }

  /**
   * @param {HTMLVideoElement} video
   */
  function onPlay(video) {
    if (!extensionApplying()) return;
    if (!isTrackedPage()) return;
    if (!isOverLimit()) return;
    if (frictionBypass) return;
    if (settings.useBufferFriction === false) return;
    video.pause();
    queueMicrotask(() => runFriction(video));
  }

  /**
   * play often fires before our listener exists (hard refresh / instant autoplay).
   * @param {HTMLVideoElement} video
   */
  function catchAutoplayBeforeHook(video) {
    if (video !== hookedVideo) return;
    if (!extensionApplying() || !isTrackedPage() || !isOverLimit()) return;
    if (settings.useBufferFriction === false) return;
    if (frictionBypass) return;
    if (video.paused || video.ended) return;
    onPlay(video);
  }

  /**
   * @param {HTMLVideoElement} video
   */
  function bindVideo(video) {
    if (!isTrackedPage()) return;
    if (video === hookedVideo) return;
    if (hookedVideo) {
      hookedVideo.removeEventListener('play', hookedPlayListener);
      frictionEpoch++;
    }
    hookedVideo = video;
    lastTickMs = Date.now();
    hookedVideo.addEventListener('play', hookedPlayListener);
    queueMicrotask(() => catchAutoplayBeforeHook(video));
  }

  function hookedPlayListener() {
    if (hookedVideo) onPlay(hookedVideo);
  }

  function pollVideoId() {
    if (!isExtensionCtxAlive()) {
      teardown();
      return;
    }
    rollStatsIfNewDay();
    syncLimitFrictionToDom();

    if (!isTrackedPage()) {
      detachPlaybackHooks();
    } else {
      const vHook = getMainVideo();
      if (vHook) bindVideo(vHook);
    }

    const sig = getVisitSignature();
    if (!sig) {
      lastWatchSignature = null;
      return;
    }
    if (sig !== lastWatchSignature) {
      lastWatchSignature = sig;
      if (extensionApplying()) bumpVideoCount();
    }
  }

  function rollStatsIfNewDay() {
    const day = todayKey();
    if (stats.dayKey === day) return;
    stats = { dayKey: day, secondsWatched: 0, videosWatched: 0 };
    statsDirty = true;
    scheduleSave();
  }

  function getVisitSignature() {
    const id = getWatchVideoId();
    if (!id) return null;
    return location.pathname.startsWith('/shorts/') ? `shorts:${id}` : `watch:${id}`;
  }

  function tickWatchTime() {
    if (!isExtensionCtxAlive()) {
      teardown();
      return;
    }
    rollStatsIfNewDay();
    syncLimitFrictionToDom();

    const now = Date.now();
    const dt = Math.min(45, (now - lastTickMs) / 1000);
    lastTickMs = now;

    if (!isTrackedPage()) detachPlaybackHooks();
    else {
      const vHook = getMainVideo();
      if (vHook) bindVideo(vHook);
    }

    const v = isTrackedPage() ? getMainVideo() : null;

    if (!extensionApplying() || !isTrackedPage()) return;
    if (!v || v.paused || v.ended) return;

    accumulateWatchSeconds(dt);
  }

  function hydrateFromStorage(done) {
    try {
      chrome.storage.local.get([STORAGE_SETTINGS, STORAGE_STATS, STORAGE_GOOD_FAITH_SNOOZE_UNTIL], (result) => {
        if (!isExtensionCtxAlive()) return;
        settings = mergeSettings(result[STORAGE_SETTINGS]);
        stats = normalizeStats(result[STORAGE_STATS]);
        goodFaithSnoozeUntilMs = Number(result[STORAGE_GOOD_FAITH_SNOOZE_UNTIL]) || 0;
        done();
      });
    } catch {
      /* Extension context invalidated */
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (!isExtensionCtxAlive()) return;
    if (area !== 'local') return;
    if (changes[STORAGE_SETTINGS]) {
      settings = mergeSettings(changes[STORAGE_SETTINGS].newValue);
      syncLimitFrictionToDom();
    }
    if (changes[STORAGE_STATS]) {
      stats = normalizeStats(changes[STORAGE_STATS].newValue);
      syncLimitFrictionToDom();
    }
    if (changes[STORAGE_GOOD_FAITH_SNOOZE_UNTIL]) {
      goodFaithSnoozeUntilMs = Number(changes[STORAGE_GOOD_FAITH_SNOOZE_UNTIL].newValue) || 0;
      syncLimitFrictionToDom();
    }
  });

  hydrateFromStorage(() => {
    syncLimitFrictionToDom();
    tickWatchTime();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => tickWatchTime());
    });
    watchIntervalId = setInterval(tickWatchTime, 1000);
    pollIntervalId = setInterval(pollVideoId, 800);
    pollVideoId();
    document.addEventListener('yt-page-data-updated', pollVideoId);
    window.addEventListener('popstate', pollVideoId);

    window.addEventListener('beforeunload', () => {
      if (isExtensionCtxAlive()) flushStats();
    });
  });
})();
