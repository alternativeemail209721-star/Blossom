// game.js — everything the browser page does.
// Sections: viewport fix, socket, mochi board, secret-word slots, length chips,
// bonus words, leaderboard, diagnostics, toast + celebration, modes,
// fullscreen + hide-controls, offline/test/host controls, and the socket
// event wiring at the bottom.

// viewport — fixes mobile browsers reporting the wrong 100vh
function setViewportHeight() {
  document.documentElement.style.setProperty('--vh', (window.innerHeight * 0.01) + 'px');
}
setViewportHeight();
window.addEventListener('resize', setViewportHeight);
window.addEventListener('orientationchange', setViewportHeight);
document.addEventListener('fullscreenchange', function () { setTimeout(setViewportHeight, 50); });
document.addEventListener('webkitfullscreenchange', function () { setTimeout(setViewportHeight, 50); });

const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// socket — connects to the server
const socket = io();

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
  if (reduceMotion) return;
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
  const el = document.getElementById('lengthChips');
  el.innerHTML = '';
  s.lengthSummary.forEach(function (row) {
    let found = 0;
    s.slots.forEach(function (sl) { if (sl.len === row.len && sl.word) found++; });
    const chip = document.createElement('span');
    chip.className = 'chip len-' + row.len + (found === row.count ? ' done' : '');
    chip.innerHTML = '<b>' + row.len + '</b> letters <span>' + found + '/' + row.count + '</span>';
    el.appendChild(chip);
  });
  if (s.slots.some(function (sl) { return sl.pangram; })) {
    const star = document.createElement('span');
    star.className = 'chip star';
    star.textContent = '\u2605 uses all 7 letters';
    el.appendChild(star);
  }
}

// ---------------- SECRET WORD SLOTS ----------------
// Each slot is one secret word. Until it is found it only shows how many
// letters it has (a badge number + one dot per letter).
function renderSlots(slots) {
  const slotsEl = document.getElementById('slots');

  if (slotsEl.children.length !== slots.length) {
    slotsEl.innerHTML = '';
    slots.forEach(function () {
      const s = document.createElement('div');
      s.className = 'slot';
      s.innerHTML = '<span class="badge"></span><span class="dots"></span><span class="word"></span>';
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
    chip.textContent = b.word;
    chip.title = b.by;
    list.appendChild(chip);
  });
}

// ---------------- LEADERBOARD ----------------
function renderLeaderboard(entries) {
  const el = document.getElementById('leaderboard');
  el.innerHTML = '';
  entries.forEach(function (row) {
    const li = document.createElement('li');
    li.textContent = row.user + ' \u2014 ' + row.points + ' pts';
    el.appendChild(li);
  });
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
  if (reduceMotion) return;
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

document.getElementById('liveConnectBtn').addEventListener('click', function () {
  const username = document.getElementById('liveUsernameInput').value.trim().replace(/^@+/, '');
  if (!username) { showToast('Enter a TikTok username first'); return; }
  fetch('/api/start-live', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username })
  })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.ok) showToast('Live connect failed: ' + data.error);
      else showToast('Connecting to @' + username + '...');
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

// Keyboard: F = fullscreen, H = hide/show controls (ignored while typing).
document.addEventListener('keydown', function (e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const k = (e.key || '').toLowerCase();
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
  setTimeout(function () { skipBtn.disabled = false; }, 800);
  socket.emit('hostAction', { type: 'skipRound' });
});

document.getElementById('hostHint').addEventListener('click', function () {
  if (!ensureConnected()) return;
  socket.emit('hostAction', { type: 'hint' });
});

// ---------------- SOCKET EVENTS ----------------
let currentCenter = '';

function applyState(s) {
  if (!s) return;
  currentMode = s.mode;
  currentCenter = s.center;
  if (s.mode === 'live') liveTabOpen = false;
  // Stay on the Live tab while the person is typing a username, even if other
  // screens cause a state update in the meantime.
  setActiveModeButton(liveTabOpen ? 'live' : s.mode);
  document.getElementById('roundNumber').textContent = s.roundNumber;
  document.getElementById('roundTotal').textContent = s.totalRounds;
  renderBoard(s.letters, s.center);
  renderRules(s);
  renderLengthChips(s);
  renderSlots(s.slots);
  renderBonus(s.bonusCount, s.bonusRecent);
  renderLeaderboard(s.leaderboard);
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
  if (data.secret) {
    showToast(data.user + ' found ' + data.word + ' (+' + data.points + ')');
  } else {
    showToast('Bonus! ' + data.user + ' found ' + data.word + ' (+' + data.points + ')');
  }
});

socket.on('roundComplete', function (s) {
  applyState(s);
  showCelebration();
});

// A new round started (auto after a win, or the host skipped): show it right away.
socket.on('newRound', function (s) {
  document.getElementById('celebration').classList.add('hidden');
  if (celebrationTimer) clearTimeout(celebrationTimer);
  applyState(s);
  showToast('New round!');
});

socket.on('hint', function (data) {
  showToast('Hint: starts with ' + data.letter + ', ' + data.length + ' letters', 5000);
});

socket.on('notice', function (data) {
  showToast(data.message);
});

// Explains why a typed guess was not accepted (chat guesses stay silent).
socket.on('guessRejected', function (data) {
  const word = data.word || '';
  const messages = {
    tooShort: 'Words need at least 4 letters',
    alreadyFound: word + ' was already found',
    wrongLetters: 'Use only the 7 letters on the board',
    missingCenter: 'Every word must use the center letter (' + currentCenter + ')',
    notAWord: word + ' is not in the dictionary'
  };
  showToast(messages[data.reason] || 'Guess not accepted');
});

socket.on('diagnostics', function (data) {
  document.getElementById('rawCount').textContent = data.rawEventCount;
  document.getElementById('lastReceived').textContent = data.lastReceived
    ? (data.lastReceived.user + ': ' + data.lastReceived.text)
    : '(none yet)';
});
