// server.js — Blossom TikTok LIVE Game Server
// This single file wires together the web server, the game logic, and
// the TikTok LIVE connection. Run with: npm install && npm start
require('dotenv').config();
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const ROUNDS = require('./rounds.js');

let WebcastPushConnection = null;
try {
  WebcastPushConnection = require('tiktok-live-connector').WebcastPushConnection;
} catch (e) {
  console.error('tiktok-live-connector is not installed. Run "npm install" first.');
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ---------------- GAME STATE ----------------
const state = {
  mode: 'offline', // 'offline' | 'test' | 'live'
  roundIndex: 0,
  foundWords: [],
  foundBy: {},
  scores: {},
  rawEventCount: 0,
  lastReceived: null,
  liveUsername: null,
  liveConnected: false
};

function currentRound() {
  return ROUNDS[state.roundIndex % ROUNDS.length];
}

function cleanGuess(text) {
  if (!text) return '';
  return String(text).toUpperCase().replace(/[^A-Z]/g, '');
}

function isPangram(word, letters) {
  const set = new Set(letters);
  const wset = new Set(word.split(''));
  for (const l of set) { if (!wset.has(l)) return false; }
  return true;
}

function scoreForWord(word, letters) {
  if (isPangram(word, letters)) return 15;
  const len = word.length;
  if (len <= 4) return 1;
  if (len === 5) return 3;
  if (len === 6) return 5;
  return 8;
}

function topScores(n) {
  return Object.entries(state.scores)
    .map(function (e) { return { user: e[0], points: e[1] }; })
    .sort(function (a, b) { return b.points - a.points; })
    .slice(0, n);
}

function publicState() {
  const round = currentRound();
  return {
    mode: state.mode,
    roundNumber: (state.roundIndex % ROUNDS.length) + 1,
    totalRounds: ROUNDS.length,
    letters: round.letters,
    center: round.center,
    slotsTotal: round.words.length,
    foundWords: state.foundWords.map(function (w) {
      return { word: w, by: state.foundBy[w] || '' };
    }),
    leaderboard: topScores(10),
    liveUsername: state.liveUsername,
    liveConnected: state.liveConnected,
    rawEventCount: state.rawEventCount,
    lastReceived: state.lastReceived
  };
}

function broadcastState() {
  io.emit('state', publicState());
}

function resetRoundState() {
  state.foundWords = [];
  state.foundBy = {};
}

function nextRound() {
  state.roundIndex = (state.roundIndex + 1) % ROUNDS.length;
  resetRoundState();
  io.emit('newRound', publicState());
}

let advancingRound = false;

function handleGuess(rawText, user) {
  try {
    state.rawEventCount += 1;
    state.lastReceived = { user: user || 'Unknown', text: rawText || '' };
    io.emit('diagnostics', { rawEventCount: state.rawEventCount, lastReceived: state.lastReceived });

    const round = currentRound();
    const guess = cleanGuess(rawText);
    if (!guess || guess.length < 4) return;
    if (state.foundWords.indexOf(guess) !== -1) return;
    if (round.words.indexOf(guess) === -1) return;

    const allowed = new Set(round.letters);
    for (const ch of guess) { if (!allowed.has(ch)) return; }
    if (guess.indexOf(round.center) === -1) return;

    const points = scoreForWord(guess, round.letters);
    const who = user || 'Unknown';
    state.foundWords.push(guess);
    state.foundBy[guess] = who;
    state.scores[who] = (state.scores[who] || 0) + points;

    io.emit('wordFound', {
      word: guess, user: who, points: points,
      found: state.foundWords.length, total: round.words.length
    });
    broadcastState();

    if (state.foundWords.length >= round.words.length && !advancingRound) {
      advancingRound = true;
      io.emit('roundComplete', publicState());
      setTimeout(function () {
        nextRound();
        advancingRound = false;
      }, 5000);
    }
  } catch (err) {
    console.error('handleGuess error:', err);
  }
}

// ---------------- TIKTOK LIVE ----------------
let tiktokConnection = null;
let liveRetryCount = 0;
const MAX_LIVE_RETRIES = 3;

function extractChat(data) {
  // Fallback chain, because the exact field names have shifted between
  // library versions and TikTok payload variants.
  const user = (data && (data.uniqueId || (data.user && data.user.uniqueId) || data.nickname)) || 'Unknown';
  const text = (data && (data.comment || data.text || data.content)) || '';
  return { user: user, text: text };
}

function stopLive() {
  if (tiktokConnection) {
    try { tiktokConnection.disconnect(); } catch (e) { /* ignore */ }
  }
  tiktokConnection = null;
  state.liveConnected = false;
  broadcastState();
}

function startLive(username) {
  if (!WebcastPushConnection) {
    return Promise.reject(new Error('tiktok-live-connector is not installed.'));
  }
  if (!process.env.EULERSTREAM_API_KEY) {
    return Promise.reject(new Error('Missing EULERSTREAM_API_KEY. Get one free at https://www.eulerstream.com and put it in your .env file.'));
  }

  stopLive();
  state.liveUsername = username;
  state.mode = 'live';
  liveRetryCount = 0;

  function attemptConnect() {
    return new Promise(function (resolve, reject) {
      try {
        // Log the raw event shape once per connection so a non-coder can
        // see exactly what TikTok is sending if something looks wrong.
        let loggedSample = false;
        tiktokConnection = new WebcastPushConnection(username, {
          signApiKey: process.env.EULERSTREAM_API_KEY
        });

        tiktokConnection.on('chat', function (data) {
          try {
            if (!loggedSample) {
              loggedSample = true;
              console.log('Sample raw chat event shape:', JSON.stringify(data).slice(0, 500));
            }
            const parsed = extractChat(data);
            handleGuess(parsed.text, parsed.user);
          } catch (err) {
            console.error('Error handling chat event:', err);
          }
        });

        tiktokConnection.on('streamEnd', function () {
          console.log('Live stream ended.');
          stopLive();
        });

        tiktokConnection.on('disconnected', function () {
          state.liveConnected = false;
          broadcastState();
        });

        tiktokConnection.on('error', function (err) {
          console.error('TikTok connection error:', err && err.message ? err.message : err);
        });

        tiktokConnection.connect()
          .then(function (connState) {
            state.liveConnected = true;
            broadcastState();
            resolve(connState);
          })
          .catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  }

  function tryWithRetries() {
    return attemptConnect().catch(function (err) {
      liveRetryCount += 1;
      if (liveRetryCount <= MAX_LIVE_RETRIES) {
        const delay = 1500 * liveRetryCount;
        console.warn('Live connect attempt ' + liveRetryCount + ' failed, retrying in ' + delay + 'ms: ' + (err && err.message ? err.message : err));
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            tryWithRetries().then(resolve).catch(reject);
          }, delay);
        });
      }
      state.liveConnected = false;
      throw err;
    });
  }

  return tryWithRetries();
}

// ---------------- ROUTES ----------------
app.post('/api/start-live', async function (req, res) {
  try {
    const username = ((req.body && req.body.username) || '').trim();
    if (!username) return res.status(400).json({ ok: false, error: 'username required' });
    await startLive(username);
    res.json({ ok: true, state: publicState() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
});

app.post('/api/stop-live', function (req, res) {
  stopLive();
  state.mode = 'offline';
  broadcastState();
  res.json({ ok: true });
});

app.post('/api/mode', function (req, res) {
  const mode = req.body && req.body.mode;
  if (['offline', 'test', 'live'].indexOf(mode) === -1) {
    return res.status(400).json({ ok: false, error: 'invalid mode' });
  }
  if (mode !== 'live') stopLive();
  state.mode = mode;
  broadcastState();
  res.json({ ok: true, state: publicState() });
});

app.post('/api/skip-round', function (req, res) {
  nextRound();
  res.json({ ok: true, state: publicState() });
});

// ---------------- SOCKET.IO ----------------
io.on('connection', function (socket) {
  socket.emit('state', publicState());

  socket.on('guess', function (payload) {
    const text = payload && payload.text;
    const user = (payload && payload.user) || 'Player';
    handleGuess(text, user);
  });

  socket.on('hostAction', function (payload) {
    try {
      if (!payload || !payload.type) return;
      if (payload.type === 'skipRound') {
        nextRound();
      } else if (payload.type === 'hint') {
        const round = currentRound();
        const remaining = round.words.filter(function (w) {
          return state.foundWords.indexOf(w) === -1;
        });
        if (remaining.length) {
          const pick = remaining[Math.floor(Math.random() * remaining.length)];
          socket.emit('hint', { letter: pick[0], length: pick.length });
        }
      } else if (payload.type === 'overrideReveal') {
        handleGuess(payload.word, 'Host');
      }
    } catch (err) {
      console.error('hostAction error:', err);
    }
  });
});

// ---------------- CRASH PREVENTION ----------------
process.on('uncaughtException', function (err) {
  console.error('Uncaught exception (server kept running):', err);
});
process.on('unhandledRejection', function (reason) {
  console.error('Unhandled promise rejection (server kept running):', reason);
});

server.listen(PORT, function () {
  console.log('Blossom TikTok LIVE Game running on http://localhost:' + PORT);
});
