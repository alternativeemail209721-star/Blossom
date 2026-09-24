// viewport.js — fixes mobile browsers reporting the wrong 100vh
function setViewportHeight() {
  document.documentElement.style.setProperty('--vh', (window.innerHeight * 0.01) + 'px');
}
setViewportHeight();
window.addEventListener('resize', setViewportHeight);
window.addEventListener('orientationchange', setViewportHeight);

// socketClient.js — connects to the server and dispatches events
const socket = io();

// flower.js — renders the 7-letter Blossom flower (1 center + 6 petals)
function renderFlower(letters, center) {
  const flowerEl = document.getElementById('flower');
  flowerEl.innerHTML = '';

  const petals = letters.filter(function (l) { return l !== center; });
  const radius = 34; // percent of the flower box
  const cx = 50, cy = 50;

  petals.forEach(function (letter, i) {
    const angle = (Math.PI * 2 * i) / petals.length - Math.PI / 2;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    const el = document.createElement('div');
    el.className = 'petal';
    el.style.left = (x - 15) + '%';
    el.style.top = (y - 15) + '%';
    el.textContent = letter;
    flowerEl.appendChild(el);
  });

  const centerEl = document.createElement('div');
  centerEl.className = 'center-letter';
  centerEl.textContent = center;
  flowerEl.appendChild(centerEl);

  document.getElementById('centerCallout').textContent = 'center letter (' + center + ')';
}

// slots.js — renders the 20 word slots; slots fill in the order words are found
function renderSlots(slotsTotal, foundWords) {
  const slotsEl = document.getElementById('slots');
  const prevCount = slotsEl.children.length;
  if (prevCount !== slotsTotal) {
    slotsEl.innerHTML = '';
    for (let i = 0; i < slotsTotal; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      slotsEl.appendChild(s);
    }
  }
  const children = slotsEl.children;
  for (let i = 0; i < children.length; i++) {
    const entry = foundWords[i];
    if (entry) {
      children[i].textContent = entry.word;
      children[i].classList.add('found');
    } else {
      children[i].textContent = '';
      children[i].classList.remove('found');
    }
  }
}

// leaderboard.js — renders the Top 10 high scores list
function renderLeaderboard(entries) {
  const el = document.getElementById('leaderboard');
  el.innerHTML = '';
  entries.forEach(function (row) {
    const li = document.createElement('li');
    li.textContent = row.user + ' — ' + row.points + ' pts';
    el.appendChild(li);
  });
}

// diagnostics.js — on-screen debug readout so a non-coder can see events arriving
function renderDiagnostics(rawEventCount, lastReceived, liveConnected, liveUsername) {
  document.getElementById('rawCount').textContent = rawEventCount;
  document.getElementById('lastReceived').textContent = lastReceived
    ? (lastReceived.user + ': ' + lastReceived.text)
    : '(none yet)';
  const liveStatusEl = document.getElementById('liveStatus');
  if (liveUsername) {
    liveStatusEl.textContent = 'Live target: @' + liveUsername + ' — ' + (liveConnected ? 'connected' : 'not connected');
  } else {
    liveStatusEl.textContent = '';
  }
}

// toastCelebration.js — small popup for hints/points + the round-complete overlay
let toastTimer = null;
function showToast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    el.classList.add('hidden');
  }, 2200);
}

function showCelebration() {
  const el = document.getElementById('celebration');
  el.classList.remove('hidden');
  setTimeout(function () {
    el.classList.add('hidden');
  }, 4500);
}

// modes.js — Offline / Test / Live mode switching
let currentMode = 'offline';

function setActiveModeButton(mode) {
  document.querySelectorAll('.modeBtn').forEach(function (btn) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  document.getElementById('modeLabel').textContent = mode.toUpperCase();
  document.getElementById('offlinePanel').classList.toggle('visible', mode === 'offline');
  document.getElementById('testPanel').classList.toggle('visible', mode === 'test');
  document.getElementById('livePanel').classList.toggle('visible', mode === 'live');
}

document.querySelectorAll('.modeBtn').forEach(function (btn) {
  btn.addEventListener('click', function () {
    const mode = btn.dataset.mode;
    if (mode === 'live') {
      setActiveModeButton(mode);
      return; // actual connect happens via the Connect button
    }
    fetch('/api/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode })
    }).catch(function (err) { console.error(err); });
  });
});

document.getElementById('liveConnectBtn').addEventListener('click', function () {
  const username = document.getElementById('liveUsernameInput').value.trim();
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

document.getElementById('liveDisconnectBtn').addEventListener('click', function () {
  fetch('/api/stop-live', { method: 'POST' }).catch(function (err) { console.error(err); });
});

// offlineTest.js — Offline manual-guess box + Test mode simulate buttons
let lastKnownRound = null;

document.getElementById('offlineSubmit').addEventListener('click', function () {
  const input = document.getElementById('offlineInput');
  if (!input.value.trim()) return;
  socket.emit('guess', { text: input.value, user: 'You' });
  input.value = '';
});
document.getElementById('offlineInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('offlineSubmit').click();
});

document.getElementById('testAutoBtn').addEventListener('click', function () {
  if (!lastKnownRound) return;
  const remaining = lastKnownRound.remainingWords || [];
  if (!remaining.length) { showToast('No words left to simulate'); return; }
  const word = remaining[Math.floor(Math.random() * remaining.length)];
  const fakeUser = 'TestViewer' + Math.floor(Math.random() * 999);
  socket.emit('guess', { text: word, user: fakeUser });
});

document.getElementById('testCustomBtn').addEventListener('click', function () {
  const input = document.getElementById('testCustomInput');
  if (!input.value.trim()) return;
  const fakeUser = 'TestViewer' + Math.floor(Math.random() * 999);
  socket.emit('guess', { text: input.value, user: fakeUser });
  input.value = '';
});

// hostControls.js — lets the streamer type/override comments directly on screen
document.getElementById('hostSubmit').addEventListener('click', function () {
  const input = document.getElementById('hostInput');
  if (!input.value.trim()) return;
  socket.emit('guess', { text: input.value, user: 'Host' });
  input.value = '';
});
document.getElementById('hostInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') document.getElementById('hostSubmit').click();
});

document.getElementById('hostSkip').addEventListener('click', function () {
  socket.emit('hostAction', { type: 'skipRound' });
});

document.getElementById('hostHint').addEventListener('click', function () {
  socket.emit('hostAction', { type: 'hint' });
});

// main.js — wires all socket events to the render functions above
socket.on('state', function (s) {
  currentMode = s.mode;
  setActiveModeButton(s.mode);
  document.getElementById('roundNumber').textContent = s.roundNumber;
  document.getElementById('roundTotal').textContent = s.totalRounds;
  renderFlower(s.letters, s.center);
  renderSlots(s.slotsTotal, s.foundWords);
  renderLeaderboard(s.leaderboard);
  renderDiagnostics(s.rawEventCount, s.lastReceived, s.liveConnected, s.liveUsername);

  const foundSet = new Set(s.foundWords.map(function (f) { return f.word; }));
  lastKnownRound = { remainingWords: [] };
  // remainingWords is filled in from the round word list on the server in a
  // future upgrade if you want Test Mode to always guess a truly valid word;
  // for now Test Mode also works by typing any text into the custom box.
});

socket.on('wordFound', function (data) {
  showToast(data.user + ' found ' + data.word + ' (+' + data.points + ')');
});

socket.on('roundComplete', function () {
  showCelebration();
});

socket.on('newRound', function () {
  showToast('New round!');
});

socket.on('hint', function (data) {
  showToast('Hint: starts with ' + data.letter + ', ' + data.length + ' letters');
});

socket.on('diagnostics', function (data) {
  document.getElementById('rawCount').textContent = data.rawEventCount;
  document.getElementById('lastReceived').textContent = data.lastReceived
    ? (data.lastReceived.user + ': ' + data.lastReceived.text)
    : '(none yet)';
});
