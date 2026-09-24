// server.js — Blossom TikTok LIVE Game Server
// This single file wires together the web server, the game logic, the word
// database, and the TikTok LIVE connection.
// Run with: npm install && npm start
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

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

// ---------------- WORD DATABASE ----------------
// Any word in this database is accepted as a valid guess (as long as it uses
// the round's letters and the center letter). The list is built by
// scripts/build-dictionary.js — see README.md.
const DATA_DIR = path.join(__dirname, 'data');
const MIN_WORD_LENGTH = 4;
const DICTIONARY_GOAL = 400000;

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (e) {
    return [];
  }
}

const blocked = new Set(
  readLines(path.join(DATA_DIR, 'blocked-words.txt'))
    .map(function (l) { return l.trim().toLowerCase(); })
    .filter(function (l) { return l && l[0] !== '#'; })
);

const dictionary = new Set();

function loadDictionary() {
  ['words-base.txt', 'words-full.txt', 'extra-words.txt'].forEach(function (name) {
    const lines = readLines(path.join(DATA_DIR, name));
    for (let i = 0; i < lines.length; i++) {
      const w = lines[i].trim().toLowerCase();
      if (w.length >= MIN_WORD_LENGTH && /^[a-z]+$/.test(w) && !blocked.has(w)) dictionary.add(w);
    }
  });
}
loadDictionary();

// ---------------- ROUNDS ----------------
// Each round: 7 letters, 1 center letter, and 20 SECRET words that fill the
// board. Every other real word from the dictionary is a BONUS word.
function isPangram(word, letters) {
  const wset = new Set(word.split(''));
  for (const l of letters) { if (!wset.has(l)) return false; }
  return true;
}

function loadRounds() {
  let raw = [];
  try {
    raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rounds.json'), 'utf8'));
  } catch (e) {
    console.error('Could not read data/rounds.json — run "npm run build-rounds".', e.message);
  }
  return raw.map(function (r) {
    const letters = (r.letters || []).map(function (l) { return String(l).toUpperCase(); });
    const center = String(r.center || '').toUpperCase();
    const letterSet = new Set(letters);
    const seen = new Set();
    const words = [];
    (r.words || []).forEach(function (w) {
      const word = String(w).toUpperCase().replace(/[^A-Z]/g, '');
      if (word.length < MIN_WORD_LENGTH || seen.has(word)) return;
      if (blocked.has(word.toLowerCase())) return;
      if (word.indexOf(center) === -1) return;
      for (const ch of word) { if (!letterSet.has(ch)) return; }
      seen.add(word);
      words.push(word);
      dictionary.add(word.toLowerCase()); // secret words are always accepted
    });
    words.sort(function (a, b) { return a.length - b.length || (a < b ? -1 : 1); });
    const pangrams = new Set(words.filter(function (w) { return isPangram(w, letters); }));
    return { letters: letters, center: center, letterSet: letterSet, words: words, wordSet: new Set(words), pangrams: pangrams };
  }).filter(function (r) { return r.letters.length === 7 && r.words.length > 0; });
}

const ROUNDS = loadRounds();
if (!ROUNDS.length) {
  console.error('No usable rounds found in data/rounds.json. Run "npm run build-rounds" and restart.');
  process.exit(1);
}

console.log('Word database: ' + dictionary.size.toLocaleString() + ' words loaded (' + blocked.size + ' words on the blocked list are never accepted).');
if (dictionary.size < DICTIONARY_GOAL) {
  console.log('NOTE: that is under ' + DICTIONARY_GOAL.toLocaleString() + ' words. Run "npm run build-words" with internet access to download the big lists (see README.md).');
}
console.log('Rounds loaded: ' + ROUNDS.length);

// ---------------- GAME STATE ----------------
const state = {
  mode: 'offline', // 'offline' | 'test' | 'live'
  roundIndex: 0,
  foundSecret: new Map(), // SECRET WORD -> who found it
  bonusWords: [],         // [{ word, by }] valid dictionary words that are not secret words
  usedWords: new Set(),   // every word already found this round (secret + bonus)
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

  // One slot per secret word. Unfound slots only reveal how long the word is.
  const slots = round.words.map(function (w) {
    const slot = { len: w.length, pangram: round.pangrams.has(w) };
    if (state.foundSecret.has(w)) {
      slot.word = w;
      slot.by = state.foundSecret.get(w);
    }
    return slot;
  });

  const lengthCounts = {};
  round.words.forEach(function (w) { lengthCounts[w.length] = (lengthCounts[w.length] || 0) + 1; });
  const lengthSummary = Object.keys(lengthCounts)
    .map(function (k) { return { len: Number(k), count: lengthCounts[k] }; })
    .sort(function (a, b) { return a.len - b.len; });

  return {
    mode: state.mode,
    roundNumber: (state.roundIndex % ROUNDS.length) + 1,
    totalRounds: ROUNDS.length,
    letters: round.letters,
    center: round.center,
    slotsTotal: round.words.length,
    slots: slots,
    lengthSummary: lengthSummary,
    minLen: round.words[0].length,
    maxLen: round.words[round.words.length - 1].length,
    foundCount: state.foundSecret.size,
    bonusCount: state.bonusWords.length,
    bonusRecent: state.bonusWords.slice(-8),
    dictionarySize: dictionary.size,
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
  state.foundSecret = new Map();
  state.bonusWords = [];
  state.usedWords = new Set();
}

let advancingRound = false;
let roundTimer = null;

function nextRound() {
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null; }
  advancingRound = false;
  state.roundIndex = (state.roundIndex + 1) % ROUNDS.length;
  resetRoundState();
  io.emit('newRound', publicState());
}

// onReject (optional) is called with (reason, word) when a guess is not accepted.
// Chat guesses stay silent; the on-screen guess boxes use it to explain why.
function handleGuess(rawText, user, onReject) {
  function reject(reason, word) {
    if (typeof onReject === 'function') onReject(reason, word);
  }
  try {
    state.rawEventCount += 1;
    state.lastReceived = { user: user || 'Unknown', text: rawText || '' };
    io.emit('diagnostics', { rawEventCount: state.rawEventCount, lastReceived: state.lastReceived });

    const round = currentRound();
    const guess = cleanGuess(rawText);
    if (!guess || guess.length < MIN_WORD_LENGTH) return reject('tooShort', guess);
    if (state.usedWords.has(guess)) return reject('alreadyFound', guess);

    for (const ch of guess) { if (!round.letterSet.has(ch)) return reject('wrongLetters', guess); }
    if (guess.indexOf(round.center) === -1) return reject('missingCenter', guess);

    const isSecret = round.wordSet.has(guess);
    if (!isSecret && !dictionary.has(guess.toLowerCase())) return reject('notAWord', guess);

    const who = user || 'Unknown';
    let points = scoreForWord(guess, round.letters);
    if (!isSecret) points = Math.ceil(points / 2); // bonus words are worth half

    state.usedWords.add(guess);
    if (isSecret) {
      state.foundSecret.set(guess, who);
    } else {
      state.bonusWords.push({ word: guess, by: who });
    }
    state.scores[who] = (state.scores[who] || 0) + points;

    io.emit('wordFound', {
      word: guess, user: who, points: points, secret: isSecret,
      found: state.foundSecret.size, total: round.words.length,
      bonusCount: state.bonusWords.length
    });
    broadcastState();

    if (isSecret && state.foundSecret.size >= round.words.length && !advancingRound) {
      advancingRound = true;
      io.emit('roundComplete', publicState());
      roundTimer = setTimeout(function () {
        roundTimer = null;
        nextRound();
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
    handleGuess(text, user, function (reason, word) {
      socket.emit('guessRejected', { reason: reason, word: word });
    });
  });

  socket.on('hostAction', function (payload) {
    try {
      if (!payload || !payload.type) return;
      const round = currentRound();
      const remaining = round.words.filter(function (w) { return !state.foundSecret.has(w); });

      if (payload.type === 'skipRound') {
        nextRound();
      } else if (payload.type === 'hint') {
        if (remaining.length) {
          const pick = remaining[Math.floor(Math.random() * remaining.length)];
          socket.emit('hint', { letter: pick[0], length: pick.length });
        }
      } else if (payload.type === 'simulate') {
        // Test mode: pretend a random viewer just typed one of the secret words.
        if (!remaining.length) {
          socket.emit('notice', { message: 'No secret words left to simulate' });
        } else {
          const pick = remaining[Math.floor(Math.random() * remaining.length)];
          handleGuess(pick, 'TestViewer' + Math.floor(Math.random() * 999));
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
