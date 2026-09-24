// game.js — everything the browser page does.
// Sections: viewport fix, socket, avatars, mochi board, secret-word slots,
// length chips, bonus words, leaderboard, live feed, leaderboard modal, diagnostics, toast +
// celebration, sound effects, settings panel, modes, fullscreen + hide
// controls, offline/test/host controls, and the socket event wiring at the
// bottom.

// viewport — fixes mobile browsers reporting the wrong 100vh
function setViewportHeight() {
  document.documentElement.style.setProperty('--vh', (window.innerHeight * 0.01) + 'px');
}
setViewportHeight();
window.addEventListener('resize', setViewportHeight);
window.addEventListener('orientationchange', setViewportHeight);
document.addEventListener('fullscreenchange', function () { setTimeout(setViewportHeight, 50); });
document.addEventListener('webkitfullscreenchange', function () { setTimeout(setViewportHeight, 50); });

let reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// socket — connects to the server
const socket = io();

// current settings, filled in as soon as the server sends state. Sensible
// defaults here just avoid a flash of the wrong UI before the first 'state'.
let settings = {
  theme: 'candy', showAvatars: true, avatarSize: 'medium', boardAnimationEnabled: true,
  confettiEnabled: true, compactMode: false, showDiagnostics: true, showRecentFeed: true,
  recentFeedSize: 12, feedItemDurationMs: 4000, leaderboardSize: 10, bonusWordsEnabled: true, pointsMultiplier: 1,
  minGuessLength: 4, hintCooldownMs: 8000, hintDurationMs: 5000, skipCooldownMs: 600,
  autoAdvanceEnabled: true, autoAdvanceDelayMs: 5000, autoBotEnabled: false,
  paused: false, soundEnabled: true, soundVolume: 0.5
};

// ---------------- AVATARS ----------------
// Real TikTok avatars are used automatically whenever the server has one for
// a viewer. Everyone else (offline/test/host, or a viewer TikTok gave no
// picture for) gets a deterministic colorful initials avatar instead, so the
// UI never shows a broken image.
const AVATAR_PALETTE = ['#ff6fae', '#ffb15e', '#8ee6c8', '#8ed2ff', '#c9b6ff', '#ff9ec6', '#5eceb0', '#f0a8ff'];
function hashUser(name) {
  let h = 0;
  const s = String(name || '?');
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return h;
}
function initialsFor(name) {
  const s = String(name || '?').trim();
  if (!s) return '?';
  const parts = s.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  if (!parts.length) return s[0].toUpperCase();
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
function avatarSizeClass() {
  return 'size-' + (settings.avatarSize || 'medium');
}
// Returns a DOM element: a real <img> when a URL is known, otherwise a
// colored circle with initials. Always circular via the shared .avatar class.
function makeAvatar(user, url) {
  const sizeClass = avatarSizeClass();
  if (url) {
    const img = document.createElement('img');
    img.className = 'avatar ' + sizeClass;
    img.src = url;
    img.alt = user || '';
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.onerror = function () {
      const fallback = makeAvatar(user, null);
      if (img.parentNode) img.parentNode.replaceChild(fallback, img);
    };
    return img;
  }
  const div = document.createElement('div');
  div.className = 'avatar ' + sizeClass;
  div.style.background = AVATAR_PALETTE[hashUser(user) % AVATAR_PALETTE.length];
  div.textContent = initialsFor(user);
  div.title = user || '';
  return div;
}

// ---------------- MOCHI BOARD (7 letters: 1 center + 6 friends) ----------------
const MOCHI_COLORS = ['mint', 'lavender', 'peach', 'sky', 'butter', 'bubble'];
let boardKey = '';

function makeMochi(letter, colorClass, delay) {
  const el = document.createElement('div');
  el.className = 'mochi ' + colorClass;
  el.style.setProperty('--d', delay + 's');
  el.innerHTML =
    '<span class="ground"></span>' +
    '<div class="body">' +
      '<i class="eye l"></i><i class="eye r"></i>' +
      '<i class="cheek l"></i><i class="cheek r"></i>' +
      '<i class="mouth"></i>' +
      '<b class="ch"></b>' +
    '</div>';
  el.querySelector('.ch').textContent = letter;
  return el;
}

function renderBoard(letters, center) {
  const key = letters.join('') + center;
  if (key === boardKey) return;   // same letters: keep the animations running
  boardKey = key;

  const flowerEl = document.getElementById('flower');
  flowerEl.innerHTML = '';

  const friends = letters.filter(function (l) { return l !== center; });
  const ring = 33;      // distance from the middle, in % of the board
  const size = 28;      // size of each friend, in % of the board

  friends.forEach(function (letter, i) {
    const angle = (Math.PI * 2 * i) / friends.length - Math.PI / 2;
    const x = 50 + ring * Math.cos(angle);
    const y = 50 + ring * Math.sin(angle);
    const el = makeMochi(letter, MOCHI_COLORS[i % MOCHI_COLORS.length], (i * 0.45).toFixed(2));
    el.style.width = size + '%';
    el.style.height = size + '%';
    el.style.left = (x - size / 2) + '%';
    el.style.top = (y - size / 2) + '%';
    flowerEl.appendChild(el);
  });

  const mid = makeMochi(center, 'center', 0.2);
  mid.style.width = '34%';
  mid.style.height = '34%';
  mid.style.left = '33%';
  mid.style.top = '33%';
  const bow = document.createElement('div');
  bow.className = 'bow';
  bow.innerHTML = '<i></i><i></i><b></b>';
  mid.appendChild(bow);
  flowerEl.appendChild(mid);
}

// every mochi does a happy squish when a word is found
function boingBoard() {
  if (reduceMotion || !settings.boardAnimationEnabled) return;
  const bodies = document.querySelectorAll('#flower .body');
  bodies.forEach(function (b, i) {
    b.classList.remove('boing');
    void b.offsetWidth; // restart the animation
    b.style.animationDelay = (i * 0.04) + 's';
    b.classList.add('boing');
  });
}

// ---------------- RULES + PROGRESS ----------------
function renderRules(s) {
  document.getElementById('centerCallout').textContent = s.center;
  document.getElementById('slotsTotalText').textContent = s.slotsTotal;
  document.getElementById('slotsTotalText2').textContent = s.slotsTotal;
  document.getElementById('lenRange').textContent = s.minLen === s.maxLen ? String(s.minLen) : (s.minLen + ' to ' + s.maxLen);
  document.getElementById('foundCount').textContent = s.foundCount;
  document.getElementById('progressFill').style.width = (s.slotsTotal ? (100 * s.foundCount / s.slotsTotal) : 0) + '%';
}

// ---------------- LENGTH CHIPS: "how long are the secret words?" ----------------
function renderLengthChips(s) {
  // One row, never scrolls: every chip shares the row equally and stacks a
  // tiny "N letters" caption above its found/total count.
  const el = document.getElementById('lengthChips');
  el.innerHTML = '';
  s.lengthSummary.forEach(function (row) {
    let found = 0;
    s.slots.forEach(function (sl) { if (sl.len === row.len && sl.word) found++; });
    const chip = document.createElement('span');
    chip.className = 'chip len-' + row.len + (found === row.count ? ' done' : '');
    chip.title = row.len + '-letter secret words: ' + found + ' of ' + row.count + ' found';
    chip.innerHTML = '<em><b>' + row.len + '</b> letters</em><span>' + found + '/' + row.count + '</span>';
    el.appendChild(chip);
  });
  if (s.slots.some(function (sl) { return sl.pangram; })) {
    const star = document.createElement('span');
    star.className = 'chip star';
    star.title = 'A secret word that uses all 7 letters';
    star.innerHTML = '<em>all 7</em><span>\u2605</span>';
    el.appendChild(star);
  }
}

// ---------------- SECRET WORD SLOTS ----------------
// Each slot is one secret word. Until it is found it only shows how many
// letters it has (a badge number + one dot per letter). Once found, a small
// circular avatar of whoever found it sits on the slot's corner.
function renderSlots(slots) {
  const slotsEl = document.getElementById('slots');

  if (slotsEl.children.length !== slots.length) {
    slotsEl.innerHTML = '';
    slots.forEach(function () {
      const s = document.createElement('div');
      s.className = 'slot';
      s.innerHTML = '<span class="badge"></span><span class="dots"></span><span class="word"></span><span class="slot-avatar"></span>';
      slotsEl.appendChild(s);
    });
  }

  slots.forEach(function (slot, i) {
    const el = slotsEl.children[i];
    const found = slot.word || '';
    const prevFound = el.dataset.word || '';
    const prevLen = el.dataset.len || '';

    if (String(slot.len) !== prevLen) {
      el.dataset.len = String(slot.len);
      el.querySelector('.badge').textContent = slot.len;
      const dots = el.querySelector('.dots');
      dots.innerHTML = '';
      for (let d = 0; d < slot.len; d++) dots.appendChild(document.createElement('i'));
      el.setAttribute('aria-label', slot.len + ' letter secret word');
    }

    el.className = 'slot len-' + slot.len + (slot.pangram ? ' pangram' : '') + (found ? ' found' : '');
    el.querySelector('.word').textContent = found;

    const avatarSlot = el.querySelector('.slot-avatar');
    if (found && settings.showAvatars) {
      avatarSlot.innerHTML = '';
      avatarSlot.appendChild(makeAvatar(slot.by, slot.avatar));
    } else {
      avatarSlot.innerHTML = '';
    }

    if (found && found !== prevFound && !reduceMotion) {
      el.classList.add('pop');
    }
    el.dataset.word = found;
  });
}

// ---------------- BONUS WORDS ----------------
function renderBonus(count, recent) {
  document.getElementById('bonusCount').textContent = count;
  const list = document.getElementById('bonusList');
  list.innerHTML = '';
  recent.forEach(function (b) {
    const chip = document.createElement('span');
    chip.className = 'bonusChip';
    chip.title = b.by;
    if (settings.showAvatars) chip.appendChild(makeAvatar(b.by, b.avatar));
    const text = document.createElement('span');
    text.textContent = b.word;
    chip.appendChild(text);
    list.appendChild(chip);
  });
}

// ---------------- LEADERBOARD (This Round vs All-Time) ----------------
let leaderboardView = 'round';   // 'round' | 'allTime'
let lastRoundLeaderboard = [];
let lastAllTimeLeaderboard = [];

function currentLeaderboardEntries() {
  return leaderboardView === 'allTime' ? lastAllTimeLeaderboard : lastRoundLeaderboard;
}

function fillLeaderboardList(el, entries) {
  el.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('li');
    empty.className = 'lbEmpty';
    empty.textContent = leaderboardView === 'allTime' ? 'No points yet' : 'No points yet this round';
    el.appendChild(empty);
    return;
  }
  entries.forEach(function (row, i) {
    const li = document.createElement('li');
    const rank = document.createElement('span');
    rank.className = 'rank';
    rank.textContent = (i + 1) + '.';
    li.appendChild(rank);
    if (settings.showAvatars) li.appendChild(makeAvatar(row.user, row.avatar));
    const name = document.createElement('span');
    name.className = 'lbName';
    name.textContent = row.user;
    li.appendChild(name);
    const pts = document.createElement('span');
    pts.className = 'lbPts';
    pts.textContent = row.points + ' pts';
    li.appendChild(pts);
    el.appendChild(li);
  });
}

function renderLeaderboard(entries) {
  const viewName = leaderboardView === 'allTime' ? 'All-Time' : 'This Round';
  document.getElementById('leaderboardSizeLabel').textContent = settings.leaderboardSize;
  document.getElementById('leaderboardViewLabel').textContent = viewName;
  document.getElementById('lbModalViewLabel').textContent = viewName;
  document.querySelectorAll('.lbViewBtn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.view === leaderboardView);
  });
  fillLeaderboardList(document.getElementById('leaderboard'), entries);
  fillLeaderboardList(document.getElementById('lbModalList'), entries);
}

// ---------------- LIVE GUESS FEED (docked, one at a time) ----------------
// Only ever one guess is shown, in the docked panel between the instructions
// and the letters. New guesses queue up (oldest dropped first if the queue
// grows past the "max queued" setting) and each one fades out after
// "feedItemDurationMs" before the next fades in.
let feedQueue = [];
let feedShowing = false;
let feedHideTimer = null;

function queueFeedItem(row) {
  if (!settings.showRecentFeed) return;
  feedQueue.push(row);
  const cap = Math.max(1, settings.recentFeedSize || 12);
  while (feedQueue.length > cap) feedQueue.shift();
  processFeedQueue();
}

function renderFeedRow(row) {
  const panel = document.getElementById('liveFeedPanel');
  const list = document.getElementById('liveFeedList');
  list.innerHTML = '';                 // guarantees only ONE guess exists at a time
  panel.classList.add('has-item');
  const item = document.createElement('div');
  item.className = 'feedRow' + (row.secret ? '' : ' bonus');
  if (settings.showAvatars) item.appendChild(makeAvatar(row.user, row.avatar));
  const user = document.createElement('span');
  user.className = 'feedUser';
  user.textContent = row.user;
  item.appendChild(user);
  const word = document.createElement('span');
  word.className = 'feedWord';
  word.textContent = row.word;
  item.appendChild(word);
  const pts = document.createElement('span');
  pts.className = 'feedPts';
  pts.textContent = '+' + row.points + (row.points === 1 ? ' pt' : ' pts');
  item.appendChild(pts);
  list.appendChild(item);
  return item;
}

function processFeedQueue() {
  if (feedShowing || !feedQueue.length || !settings.showRecentFeed) return;
  feedShowing = true;
  const row = feedQueue.shift();
  const el = renderFeedRow(row);
  const duration = Math.max(1000, settings.feedItemDurationMs || 4000);
  if (feedHideTimer) clearTimeout(feedHideTimer);
  feedHideTimer = setTimeout(function () {
    const panel = document.getElementById('liveFeedPanel');
    function finish() {
      el.remove();
      panel.classList.remove('has-item');
      feedShowing = false;
      feedHideTimer = null;
      processFeedQueue();
    }
    if (reduceMotion) { finish(); return; }
    el.classList.add('feedOut');
    feedHideTimer = setTimeout(finish, 360);   // matches the 0.35s fade-out
  }, duration);
}

function clearFeed() {
  feedQueue = [];
  feedShowing = false;
  if (feedHideTimer) { clearTimeout(feedHideTimer); feedHideTimer = null; }
  document.getElementById('liveFeedList').innerHTML = '';
  document.getElementById('liveFeedPanel').classList.remove('has-item');
}

// ---------------- DIAGNOSTICS ----------------
function renderDiagnostics(rawEventCount, lastReceived, liveConnected, liveUsername, dictionarySize) {
  document.getElementById('rawCount').textContent = rawEventCount;
  document.getElementById('lastReceived').textContent = lastReceived
    ? (lastReceived.user + ': ' + lastReceived.text)
    : '(none yet)';
  document.getElementById('dictSize').textContent = Number(dictionarySize || 0).toLocaleString();
  const liveStatusEl = document.getElementById('liveStatus');
  if (liveUsername) {
    liveStatusEl.textContent = 'Live target: @' + liveUsername + ' \u2014 ' + (liveConnected ? 'connected' : 'not connected');
  } else {
    liveStatusEl.textContent = '';
  }
}

// ---------------- SOUND EFFECTS ----------------
// Small synthesized beeps via the Web Audio API — no sound files needed, so
// this always works the moment sound is enabled in Settings.
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}
function beep(freq, durationMs, type) {
  if (!settings.soundEnabled) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || 'sine';
  osc.frequency.value = freq;
  const vol = Math.max(0, Math.min(1, settings.soundVolume));
  gain.gain.setValueAtTime(vol * 0.25, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + durationMs / 1000);
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + durationMs / 1000);
}
function playCorrectSound(isSecret) {
  beep(isSecret ? 880 : 660, 160, 'triangle');
}
function playRoundCompleteSound() {
  [523, 659, 784, 1046].forEach(function (f, i) {
    setTimeout(function () { beep(f, 220, 'triangle'); }, i * 110);
  });
}
function playHintSound() { beep(440, 120, 'sine'); }

// ---------------- TOAST + CELEBRATION ----------------
let toastTimer = null;
function showToast(message, ms) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    el.classList.add('hidden');
  }, ms || 2400);
}

function launchConfetti() {
  if (reduceMotion || !settings.confettiEnabled) return;
  const box = document.getElementById('confetti');
  box.innerHTML = '';
  const colors = ['#ff6fae', '#ffd75e', '#8ee6c8', '#8ed2ff', '#c9b6ff', '#ffb58a'];
  for (let i = 0; i < 44; i++) {
    const bit = document.createElement('i');
    bit.style.left = (Math.random() * 100) + '%';
    bit.style.background = colors[i % colors.length];
    bit.style.animationDuration = (2.2 + Math.random() * 2) + 's';
    bit.style.animationDelay = (Math.random() * 0.8) + 's';
    box.appendChild(bit);
  }
}

let celebrationTimer = null;
function showCelebration() {
  const el = document.getElementById('celebration');
  el.classList.remove('hidden');
  launchConfetti();
  playRoundCompleteSound();
  if (celebrationTimer) clearTimeout(celebrationTimer);
  celebrationTimer = setTimeout(function () {
    el.classList.add('hidden');
  }, 4500);
}

document.getElementById('celebration').addEventListener('click', function () {
  if (celebrationTimer) clearTimeout(celebrationTimer);
  this.classList.add('hidden');
});

// ---------------- CONNECTION AWARENESS ----------------
// If the game server is asleep or the network drops, buttons would silently do
// nothing. This makes that visible, and lets actions warn instead of failing.
function ensureConnected() {
  if (socket.connected) return true;
  showToast('Not connected to the game server yet. Reconnecting...', 3000);
  return false;
}

// ---------------- MODES (Offline / Test / Live) ----------------
let currentMode = 'offline';   // the mode the SERVER is really in
let liveTabOpen = false;       // the person opened the Live tab to type a username

// tab = which tab/panel is showing; the label always shows the server's real mode.
function setActiveModeButton(tab) {
  document.querySelectorAll('.modeBtn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.mode === tab);
  });
  document.getElementById('modeLabel').textContent = currentMode.toUpperCase();
  document.getElementById('offlinePanel').classList.toggle('visible', tab === 'offline');
  document.getElementById('testPanel').classList.toggle('visible', tab === 'test');
  document.getElementById('livePanel').classList.toggle('visible', tab === 'live');
}

document.querySelectorAll('.modeBtn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const mode = btn.dataset.mode;
    if (mode === 'live') {
      liveTabOpen = true;
      setActiveModeButton('live');
      return; // actual connect happens via the Connect button
    }
    liveTabOpen = false;
    fetch('/api/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode })
    }).catch(function (err) { console.error(err); });
  });
});

// ---- Euler Stream API key (needed for Live mode) ----
// The key box lives in the Live tab. The key is remembered in this browser
// (localStorage) and, after a successful connect, on the server too, so the
// host normally only has to paste it once. The server never sends the key back
// to any screen; it only says whether it has one (hasApiKey / apiKeySource).
const KEY_STORAGE = 'blossomEulerApiKey';
const keyInput = document.getElementById('liveKeyInput');
const keyToggleBtn = document.getElementById('liveKeyToggle');
const keyForgetBtn = document.getElementById('liveKeyForget');
const keyStatusEl = document.getElementById('liveKeyStatus');
let serverHasKey = false;
let serverKeySource = null;

function readStoredKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
}
function writeStoredKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch (e) { /* private mode etc.: the server still remembers it */ }
}
keyInput.value = readStoredKey();

function renderKeyStatus() {
  const hasTyped = !!keyInput.value.trim();
  let html;
  if (hasTyped) {
    html = 'Key ready. It is saved after a successful connect.';
  } else if (serverHasKey && serverKeySource === 'env') {
    html = '\u2713 The server already has a key (from its environment settings). Leave this box empty to use it.';
  } else if (serverHasKey) {
    html = '\u2713 A key is saved on the server. Leave this box empty to use it.';
  } else {
    html = 'No key saved yet. Paste your Euler Stream API key above.';
  }
  keyStatusEl.innerHTML = html;   // static text only, no user input in here
  keyInput.placeholder = serverHasKey ? 'Euler key (optional, server has one)' : 'Euler Stream API key';
  keyForgetBtn.style.display = (hasTyped || serverKeySource === 'saved') ? '' : 'none';
}
keyInput.addEventListener('input', renderKeyStatus);

keyToggleBtn.addEventListener('click', function () {
  const showing = keyInput.type === 'text';
  keyInput.type = showing ? 'password' : 'text';
  keyToggleBtn.textContent = showing ? 'Show' : 'Hide';
});

keyForgetBtn.addEventListener('click', function () {
  keyInput.value = '';
  writeStoredKey('');
  fetch('/api/forget-api-key', { method: 'POST' })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      serverHasKey = !!data.hasApiKey;
      serverKeySource = data.apiKeySource || null;
      renderKeyStatus();
      showToast(serverHasKey ? 'Saved key removed (the server still has its own key)' : 'Euler key removed');
    })
    .catch(function (err) { showToast('Could not remove the key'); console.error(err); });
});

keyInput.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('liveConnectBtn').click();
});

document.getElementById('liveConnectBtn').addEventListener('click', function () {
  const username = document.getElementById('liveUsernameInput').value.trim().replace(/^@+/, '');
  if (!username) { showToast('Enter a TikTok username first'); return; }
  const apiKey = keyInput.value.trim();
  if (!apiKey && !serverHasKey) {
    showToast('Paste your Euler Stream API key in the key box first (free at eulerstream.com)', 4500);
    keyInput.focus();
    return;
  }
  showToast('Connecting to @' + username + '...');
  fetch('/api/start-live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username, apiKey: apiKey })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) {
        showToast('Live connect failed: ' + data.error, 5000);
        if (data.needsKey) keyInput.focus();
      } else {
        if (apiKey) writeStoredKey(apiKey);   // it worked, so remember it on this device
        showToast('Connected to @' + username);
      }
    })
    .catch(function (err) { showToast('Live connect failed'); console.error(err); });
});

document.getElementById('liveUsernameInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('liveConnectBtn').click();
});

document.getElementById('liveDisconnectBtn').addEventListener('click', function () {
  fetch('/api/stop-live', { method: 'POST' })
    .then(function () { showToast('Disconnected from TikTok LIVE'); })
    .catch(function (err) { console.error(err); });
});

// ---------------- FULLSCREEN + HIDE CONTROLS ----------------
// Real fullscreen where the browser allows it (desktop, Android). iPhone Safari
// cannot fullscreen a web page, so there the button switches to "immersive" mode:
// the same clean layout with the browser bar hidden as far as the phone allows
// (add the page to the Home Screen for a true full-screen app).
const rootEl = document.documentElement;
const fsBtn = document.getElementById('fsBtn');

function realFullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}
function canRealFullscreen() {
  return !!(rootEl.requestFullscreen || rootEl.webkitRequestFullscreen);
}
function syncFullscreenUi() {
  const on = !!realFullscreenElement() || rootEl.classList.contains('immersive');
  rootEl.classList.toggle('fs', on);
  fsBtn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Enter fullscreen');
  fsBtn.title = (on ? 'Exit fullscreen' : 'Fullscreen') + ' (F)';
  fsBtn.classList.toggle('on', on);
  setViewportHeight();
}
function toggleFullscreen() {
  if (realFullscreenElement()) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    return;
  }
  if (rootEl.classList.contains('immersive')) {
    rootEl.classList.remove('immersive');
    syncFullscreenUi();
    return;
  }
  if (canRealFullscreen()) {
    // Fullscreen the whole page (not one element) so toasts and the
    // celebration overlay stay visible.
    const req = (rootEl.requestFullscreen || rootEl.webkitRequestFullscreen).call(rootEl);
    if (req && typeof req.catch === 'function') {
      req.catch(function () {
        rootEl.classList.add('immersive');   // browser refused: fall back
        syncFullscreenUi();
      });
    }
  } else {
    rootEl.classList.add('immersive');
    syncFullscreenUi();
    window.scrollTo(0, 1);
  }
}
fsBtn.addEventListener('click', toggleFullscreen);
document.addEventListener('fullscreenchange', syncFullscreenUi);
document.addEventListener('webkitfullscreenchange', syncFullscreenUi);

// Clean view: hides the mode bar, host controls and diagnostics so only the game shows.
function setControlsHidden(hidden) {
  rootEl.classList.toggle('hide-controls', hidden);
  setViewportHeight();
  if (hidden) showToast('Controls hidden. Press H or tap the gear to bring them back.', 3200);
}
document.getElementById('hideBtn').addEventListener('click', function () { setControlsHidden(true); });
document.getElementById('showControlsBtn').addEventListener('click', function () { setControlsHidden(false); });

// Keyboard: F = fullscreen, H = hide/show controls, L = leaderboard (ignored while typing).
document.addEventListener('keydown', function (e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const k = (e.key || '').toLowerCase();
  if (k === 'l') { e.preventDefault(); if (lbOverlay.classList.contains('hidden')) openLeaderboard(); else closeLeaderboard(); return; }
  if (k === 'f') { e.preventDefault(); toggleFullscreen(); }
  else if (k === 'h') { e.preventDefault(); setControlsHidden(!rootEl.classList.contains('hide-controls')); }
});

// ---------------- OFFLINE + TEST CONTROLS ----------------
document.getElementById('offlineSubmit').addEventListener('click', function () {
  const input = document.getElementById('offlineInput');
  if (!input.value.trim() || !ensureConnected()) return;
  socket.emit('guess', { text: input.value, user: 'You' });
  input.value = '';
});
document.getElementById('offlineInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('offlineSubmit').click();
});

// The server picks a random unfound secret word and "types" it as a fake viewer.
document.getElementById('testAutoBtn').addEventListener('click', function () {
  if (!ensureConnected()) return;
  socket.emit('hostAction', { type: 'simulate' });
});

document.getElementById('testCustomBtn').addEventListener('click', function () {
  const input = document.getElementById('testCustomInput');
  if (!input.value.trim() || !ensureConnected()) return;
  const fakeUser = 'TestViewer' + Math.floor(Math.random() * 999);
  socket.emit('guess', { text: input.value, user: fakeUser });
  input.value = '';
});
document.getElementById('testCustomInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('testCustomBtn').click();
});

// ---------------- HOST CONTROLS ----------------
document.getElementById('hostSubmit').addEventListener('click', function () {
  const input = document.getElementById('hostInput');
  if (!input.value.trim() || !ensureConnected()) return;
  socket.emit('guess', { text: input.value, user: 'Host' });
  input.value = '';
});
document.getElementById('hostInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('hostSubmit').click();
});

// Skip: the server moves to the next round and pushes the new state to every
// screen. The button pauses briefly so a double-click cannot skip two rounds.
const skipBtn = document.getElementById('hostSkip');
skipBtn.addEventListener('click', function () {
  if (skipBtn.disabled || !ensureConnected()) return;
  skipBtn.disabled = true;
  setTimeout(function () { skipBtn.disabled = false; }, Math.max(200, settings.skipCooldownMs || 600) + 200);
  socket.emit('hostAction', { type: 'skipRound' });
});

document.getElementById('hostHint').addEventListener('click', function () {
  if (!ensureConnected()) return;
  socket.emit('hostAction', { type: 'hint' });
});

document.getElementById('hostPause').addEventListener('click', function () {
  if (!ensureConnected()) return;
  socket.emit('hostAction', { type: 'togglePause' });
});

document.getElementById('hostGotoBtn').addEventListener('click', function () {
  const input = document.getElementById('hostGotoRound');
  const n = parseInt(input.value, 10);
  if (!n || !ensureConnected()) return;
  socket.emit('hostAction', { type: 'gotoRound', index: n });
  input.value = '';
});
document.getElementById('hostGotoRound').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('hostGotoBtn').click();
});

document.getElementById('hostReset').addEventListener('click', function () {
  if (!ensureConnected()) return;
  if (!window.confirm('Reset the ALL-TIME leaderboard to zero for every viewer? This cannot be undone.')) return;
  socket.emit('hostAction', { type: 'resetScores' });
});

document.getElementById('hostExport').addEventListener('click', function () {
  window.open('/api/export-leaderboard', '_blank');
});

document.getElementById('hostResetRound').addEventListener('click', function () {
  if (!ensureConnected()) return;
  if (!window.confirm('Reset THIS ROUND\'s leaderboard to zero? All-time scores are not affected.')) return;
  socket.emit('hostAction', { type: 'resetRoundScores' });
});

document.querySelectorAll('.lbViewBtn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    leaderboardView = btn.dataset.view;
    renderLeaderboard(currentLeaderboardEntries());
  });
});

// ---------------- LEADERBOARD MODAL (top toolbar trophy button) ----------------
const lbOverlay = document.getElementById('lbOverlay');
function openLeaderboard() {
  renderLeaderboard(currentLeaderboardEntries());
  lbOverlay.classList.remove('hidden');
}
function closeLeaderboard() { lbOverlay.classList.add('hidden'); }
document.getElementById('leaderboardBtn').addEventListener('click', openLeaderboard);
document.getElementById('lbCloseBtn').addEventListener('click', closeLeaderboard);
lbOverlay.addEventListener('click', function (e) { if (e.target === lbOverlay) closeLeaderboard(); });
// the modal's action buttons reuse the host-panel handlers (same confirmations)
document.getElementById('lbResetRoundBtn').addEventListener('click', function () { document.getElementById('hostResetRound').click(); });
document.getElementById('lbResetAllBtn').addEventListener('click', function () { document.getElementById('hostReset').click(); });
document.getElementById('lbExportBtn').addEventListener('click', function () { document.getElementById('hostExport').click(); });

// ---------------- TEST MODE: AUTO-ANSWER BOT TOGGLE ----------------
document.getElementById('testAutoBotBtn').addEventListener('click', function () {
  if (!ensureConnected()) return;
  socket.emit('hostAction', { type: 'toggleAutoBot' });
});

// ---------------- SETTINGS PANEL ----------------
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsFields = {
  theme: document.getElementById('setTheme'),
  showAvatars: document.getElementById('setShowAvatars'),
  avatarSize: document.getElementById('setAvatarSize'),
  boardAnimationEnabled: document.getElementById('setBoardAnim'),
  confettiEnabled: document.getElementById('setConfetti'),
  compactMode: document.getElementById('setCompact'),
  showDiagnostics: document.getElementById('setDiagnostics'),
  showRecentFeed: document.getElementById('setShowFeed'),
  recentFeedSize: document.getElementById('setFeedSize'),
  feedItemDurationMs: document.getElementById('setFeedItemDuration'), // seconds in UI
  leaderboardSize: document.getElementById('setLeaderboardSize'),
  bonusWordsEnabled: document.getElementById('setBonusEnabled'),
  pointsMultiplier: document.getElementById('setPointsMultiplier'),
  minGuessLength: document.getElementById('setMinGuessLength'),
  hintCooldownMs: document.getElementById('setHintCooldown'),     // seconds in UI
  hintDurationMs: document.getElementById('setHintDuration'),     // seconds in UI
  skipCooldownMs: document.getElementById('setSkipCooldown'),
  autoAdvanceEnabled: document.getElementById('setAutoAdvanceEnabled'),
  autoAdvanceDelayMs: document.getElementById('setAutoAdvance'),  // seconds in UI
  autoBotEnabled: document.getElementById('setAutoBotEnabled'),
  soundEnabled: document.getElementById('setSoundEnabled'),
  soundVolume: document.getElementById('setSoundVolume')
};
const MS_TO_SEC_FIELDS = ['hintCooldownMs', 'hintDurationMs', 'autoAdvanceDelayMs', 'feedItemDurationMs'];

let suppressSettingsEvents = false;
function populateSettingsForm() {
  suppressSettingsEvents = true;
  Object.keys(settingsFields).forEach(function (key) {
    const field = settingsFields[key];
    if (!field) return;
    let val = settings[key];
    if (MS_TO_SEC_FIELDS.indexOf(key) !== -1) val = Math.round(val / 1000);
    if (field.type === 'checkbox') field.checked = !!val;
    else field.value = val;
  });
  suppressSettingsEvents = false;
}

function applySettingsToDom() {
  document.documentElement.setAttribute('data-theme', settings.theme || 'candy');
  document.documentElement.setAttribute('data-avatar', settings.avatarSize || 'medium');
  document.documentElement.classList.toggle('hide-avatars', !settings.showAvatars);
  document.documentElement.classList.toggle('no-board-anim', !settings.boardAnimationEnabled);
  document.documentElement.classList.toggle('compact', !!settings.compactMode);
  const feedWasHidden = document.documentElement.classList.contains('hide-feed');
  document.documentElement.classList.toggle('hide-feed', !settings.showRecentFeed);
  if (!settings.showRecentFeed && !feedWasHidden) clearFeed();
  document.getElementById('diagnostics').style.display = settings.showDiagnostics ? '' : 'none';
  const pauseBtn = document.getElementById('hostPause');
  pauseBtn.textContent = settings.paused ? 'Resume' : 'Pause';
  pauseBtn.classList.toggle('active', !!settings.paused);

  const autoBotBtn = document.getElementById('testAutoBotBtn');
  autoBotBtn.textContent = 'Auto-Answer: ' + (settings.autoBotEnabled ? 'On' : 'Off');
  autoBotBtn.classList.toggle('active', !!settings.autoBotEnabled);
}

function sendSettingsUpdate(partial) {
  if (!ensureConnected()) return;
  socket.emit('hostAction', { type: 'updateSettings', settings: partial });
}

Object.keys(settingsFields).forEach(function (key) {
  const field = settingsFields[key];
  if (!field) return;
  const evt = (field.type === 'checkbox' || field.tagName === 'SELECT') ? 'change' : 'input';
  field.addEventListener(evt, function () {
    if (suppressSettingsEvents) return;
    let val;
    if (field.type === 'checkbox') val = field.checked;
    else if (field.type === 'number' || field.type === 'range') val = parseFloat(field.value);
    else val = field.value;
    if (MS_TO_SEC_FIELDS.indexOf(key) !== -1) val = Math.round(val * 1000);
    const partial = {};
    partial[key] = val;
    sendSettingsUpdate(partial);
    const note = document.getElementById('settingsSavedNote');
    note.textContent = 'Saved';
    setTimeout(function () { note.textContent = ''; }, 1200);
  });
});

document.getElementById('settingsBtn').addEventListener('click', function () {
  populateSettingsForm();
  settingsOverlay.classList.remove('hidden');
});
document.getElementById('settingsCloseBtn').addEventListener('click', function () {
  settingsOverlay.classList.add('hidden');
});
settingsOverlay.addEventListener('click', function (e) {
  if (e.target === settingsOverlay) settingsOverlay.classList.add('hidden');
});

// Escape closes whichever modal is open
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape') return;
  lbOverlay.classList.add('hidden');
  settingsOverlay.classList.add('hidden');
});

// ---------------- SOCKET EVENTS ----------------
let currentCenter = '';

function applyState(s) {
  if (!s) return;
  currentMode = s.mode;
  currentCenter = s.center;
  if (s.settings) settings = s.settings;
  applySettingsToDom();
  serverHasKey = !!s.hasApiKey;
  serverKeySource = s.apiKeySource || null;
  renderKeyStatus();
  if (s.mode === 'live') liveTabOpen = false;
  // Stay on the Live tab while the person is typing a username, even if other
  // screens cause a state update in the meantime.
  setActiveModeButton(liveTabOpen ? 'live' : s.mode);
  renderBoard(s.letters, s.center);
  renderRules(s);
  renderLengthChips(s);
  renderSlots(s.slots);
  renderBonus(s.bonusCount, s.bonusRecent);
  lastRoundLeaderboard = s.roundLeaderboard || [];
  lastAllTimeLeaderboard = s.leaderboard || [];
  renderLeaderboard(currentLeaderboardEntries());
  renderDiagnostics(s.rawEventCount, s.lastReceived, s.liveConnected, s.liveUsername, s.dictionarySize);
}

socket.on('state', applyState);

let wasDisconnected = false;
socket.on('disconnect', function () {
  wasDisconnected = true;
  showToast('Connection lost. Reconnecting...', 4000);
});
socket.on('connect', function () {
  if (wasDisconnected) { wasDisconnected = false; showToast('Reconnected'); }
});

socket.on('wordFound', function (data) {
  boingBoard();
  playCorrectSound(data.secret);
  if (data.secret) {
    showToast(data.user + ' found ' + data.word + ' (+' + data.points + ')');
  } else {
    showToast('Bonus! ' + data.user + ' found ' + data.word + ' (+' + data.points + ')');
  }
  queueFeedItem({ user: data.user, word: data.word, points: data.points, secret: data.secret, avatar: data.avatar });
});

socket.on('roundComplete', function (s) {
  applyState(s);
  showCelebration();
});

// A new round started (auto after a win, or the host skipped): show it right away.
socket.on('newRound', function (s) {
  document.getElementById('celebration').classList.add('hidden');
  if (celebrationTimer) clearTimeout(celebrationTimer);
  clearFeed();
  applyState(s);
  showToast('New round!');
});

socket.on('hint', function (data) {
  playHintSound();
  showToast('Hint: starts with ' + data.letter + ', ' + data.length + ' letters', data.durationMs || 5000);
});

socket.on('notice', function (data) {
  showToast(data.message);
});

// Explains why a typed guess was not accepted (chat guesses stay silent).
socket.on('guessRejected', function (data) {
  const word = data.word || '';
  const messages = {
    tooShort: 'Words need at least ' + settings.minGuessLength + ' letters',
    alreadyFound: word + ' was already found',
    wrongLetters: 'Use only the 7 letters on the board',
    missingCenter: 'Every word must use the center letter (' + currentCenter + ')',
    notAWord: word + ' is not in the dictionary',
    bonusDisabled: 'Bonus words are turned off right now',
    paused: 'The game is paused'
  };
  showToast(messages[data.reason] || 'Guess not accepted');
});

socket.on('diagnostics', function (data) {
  document.getElementById('rawCount').textContent = data.rawEventCount;
  document.getElementById('lastReceived').textContent = data.lastReceived
    ? (data.lastReceived.user + ': ' + data.lastReceived.text)
    : '(none yet)';
});
