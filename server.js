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
const DICTIONARY_GOAL = 400000;

// ---------------- EULER STREAM API KEY ----------------
// LIVE mode needs a (free) Euler Stream API key. The host can paste it into the
// Live tab of the game screen — no .env file or server settings required.
// Where the key can come from (first one found wins):
//   1. the key box in the Live tab (kept for next time in data/secrets.json)
//   2. data/secrets.json (saved from an earlier connect)
//   3. the EULERSTREAM_API_KEY environment variable (.env file or Render settings)
// The key itself is NEVER sent back to any browser — screens only learn
// whether a key exists (see publicState).
const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json');

function cleanApiKey(raw) {
  let k = String(raw || '').trim();
  k = k.replace(/^EULERSTREAM_API_KEY\s*=\s*/i, '').trim();   // someone pasted the whole ".env" line
  k = k.replace(/^["'`]+|["'`]+$/g, '').trim();               // ...or pasted it with quotes
  return k;
}
function isPlausibleApiKey(k) {
  return k.length >= 8 && k.length <= 300 && !/\s/.test(k);
}

let savedApiKey = '';
try {
  savedApiKey = cleanApiKey(JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')).eulerApiKey);
} catch (e) { /* nothing saved yet */ }
const envApiKey = cleanApiKey(process.env.EULERSTREAM_API_KEY);

function getApiKey() { return savedApiKey || envApiKey || ''; }
function apiKeySource() { return savedApiKey ? 'saved' : (envApiKey ? 'env' : null); }

function saveApiKey(key) {
  savedApiKey = key;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRETS_FILE, JSON.stringify({ eulerApiKey: key }), { mode: 0o600 });
  } catch (e) {
    console.error('Could not save data/secrets.json (the key still works until the server restarts):', e.message);
  }
}
function forgetApiKey() {
  savedApiKey = '';
  try { fs.unlinkSync(SECRETS_FILE); } catch (e) { /* already gone */ }
}

// Safety net: make sure a key can never leak into an error message or a log line.
function redactKeys(text, extraKey) {
  let out = String(text || '');
  [savedApiKey, envApiKey, extraKey].forEach(function (k) {
    if (k && k.length >= 8) out = out.split(k).join('***');
  });
  return out;
}

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
      if (w.length >= 3 && /^[a-z]+$/.test(w) && !blocked.has(w)) dictionary.add(w);
    }
  });
}
loadDictionary();

// ---------------- SETTINGS ----------------
// Everything here is fully customizable by the host from the in-game Settings
// panel. Changes are broadcast to every connected screen instantly and saved
// to data/settings.json so they survive a server restart.
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const DEFAULT_SETTINGS = {
  // Appearance
  theme: 'candy',                 // candy | mint | sunset | ocean | midnight
  showAvatars: true,
  avatarSize: 'medium',           // small | medium | large
  boardAnimationEnabled: true,
  confettiEnabled: true,
  compactMode: false,
  showDiagnostics: true,
  // Live feed & leaderboard
  showRecentFeed: true,
  recentFeedSize: 12,
  feedItemDurationMs: 4000,
  leaderboardSize: 10,
  // Gameplay
  bonusWordsEnabled: true,
  pointsMultiplier: 1,
  minGuessLength: 4,
  hintCooldownMs: 8000,
  hintDurationMs: 5000,
  skipCooldownMs: 600,
  autoAdvanceEnabled: true,     // turn off to require a manual Skip Round between wins
  autoAdvanceDelayMs: 5000,
  autoBotEnabled: false,        // Test Mode only: keep auto-simulating correct guesses
  paused: false,
  // Sound
  soundEnabled: true,
  soundVolume: 0.5
};

const SETTINGS_LIMITS = {
  recentFeedSize: [1, 50],
  feedItemDurationMs: [1000, 15000],
  leaderboardSize: [3, 30],
  pointsMultiplier: [0.25, 5],
  minGuessLength: [3, 7],
  hintCooldownMs: [0, 60000],
  hintDurationMs: [1000, 15000],
  skipCooldownMs: [0, 5000],
  autoAdvanceDelayMs: [1000, 20000],
  soundVolume: [0, 1]
};
const THEME_OPTIONS = ['candy', 'mint', 'sunset', 'ocean', 'midnight'];
const AVATAR_SIZES = ['small', 'medium', 'large'];

function clampNum(n, range, fallback) {
  const v = Number(n);
  if (!isFinite(v)) return fallback;
  return Math.min(range[1], Math.max(range[0], v));
}

function loadSettings() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (e) { /* no saved settings yet — use defaults */ }
  return sanitizeSettings(Object.assign({}, DEFAULT_SETTINGS, saved));
}

function sanitizeSettings(input) {
  const out = Object.assign({}, DEFAULT_SETTINGS);
  Object.keys(DEFAULT_SETTINGS).forEach(function (key) {
    if (!(key in input)) return;
    const val = input[key];
    if (typeof DEFAULT_SETTINGS[key] === 'boolean') {
      out[key] = !!val;
    } else if (SETTINGS_LIMITS[key]) {
      out[key] = clampNum(val, SETTINGS_LIMITS[key], DEFAULT_SETTINGS[key]);
    } else if (key === 'theme') {
      out[key] = THEME_OPTIONS.indexOf(val) !== -1 ? val : DEFAULT_SETTINGS.theme;
    } else if (key === 'avatarSize') {
      out[key] = AVATAR_SIZES.indexOf(val) !== -1 ? val : DEFAULT_SETTINGS.avatarSize;
    } else {
      out[key] = val;
    }
  });
  return out;
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(state.settings, null, 2));
  } catch (e) {
    console.error('Could not save data/settings.json:', e.message);
  }
}

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
      if (word.length < 3 || seen.has(word)) return;
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
  foundSecret: new Map(),   // SECRET WORD -> who found it
  bonusWords: [],           // [{ word, by, avatar }] valid dictionary words that are not secret words
  usedWords: new Set(),     // every word already found this round (secret + bonus)
  scores: {},               // username -> ALL-TIME points
  roundScores: {},          // username -> points earned THIS ROUND ONLY (reset every round)
  userAvatars: {},          // username -> avatar URL (real TikTok avatar, when known)
  recentGuesses: [],        // newest first: [{ user, word, points, secret, avatar, ts }]
  rawEventCount: 0,
  lastReceived: null,
  liveUsername: null,
  liveConnected: false,
  lastHintAt: 0,
  settings: loadSettings()
};

const MAX_RECENT_GUESSES = 60;

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

function avatarFor(user) {
  return state.userAvatars[user] || null;
}

function topScores(n) {
  return Object.entries(state.scores)
    .map(function (e) { return { user: e[0], points: e[1], avatar: avatarFor(e[0]) }; })
    .sort(function (a, b) { return b.points - a.points; })
    .slice(0, n);
}

function topRoundScores(n) {
  return Object.entries(state.roundScores)
    .map(function (e) { return { user: e[0], points: e[1], avatar: avatarFor(e[0]) }; })
    .sort(function (a, b) { return b.points - a.points; })
    .slice(0, n);
}

function publicState() {
  const round = currentRound();
  const s = state.settings;

  // One slot per secret word. Unfound slots only reveal how long the word is.
  const slots = round.words.map(function (w) {
    const slot = { len: w.length, pangram: round.pangrams.has(w) };
    if (state.foundSecret.has(w)) {
      slot.word = w;
      slot.by = state.foundSecret.get(w);
      slot.avatar = avatarFor(slot.by);
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
    leaderboard: topScores(s.leaderboardSize),
    roundLeaderboard: topRoundScores(s.leaderboardSize),
    recentGuesses: state.recentGuesses.slice(0, s.recentFeedSize),
    liveUsername: state.liveUsername,
    liveConnected: state.liveConnected,
    hasApiKey: !!getApiKey(),
    apiKeySource: apiKeySource(),
    rawEventCount: state.rawEventCount,
    lastReceived: state.lastReceived,
    settings: s
  };
}

function broadcastState() {
  io.emit('state', publicState());
}

function resetRoundState() {
  state.foundSecret = new Map();
  state.bonusWords = [];
  state.usedWords = new Set();
  state.roundScores = {};   // the "this round" leaderboard starts fresh every round
}

let advancingRound = false;
let roundTimer = null;
let lastAdvanceAt = 0;

// Moves to the next round and tells EVERY connected screen about it.
function nextRound() {
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null; }
  advancingRound = false;
  lastAdvanceAt = Date.now();
  state.roundIndex = (state.roundIndex + 1) % ROUNDS.length;
  resetRoundState();
  io.emit('newRound', publicState());
  broadcastState();
}

// Host "skip": ignores a second press within a moment (cooldown is a
// customizable setting) so a double-click cannot skip two rounds by accident.
function skipRound() {
  if (Date.now() - lastAdvanceAt < state.settings.skipCooldownMs) return false;
  nextRound();
  return true;
}

function gotoRound(oneBasedIndex) {
  const n = ROUNDS.length;
  let idx = Math.floor(Number(oneBasedIndex)) - 1;
  if (!isFinite(idx)) return false;
  idx = ((idx % n) + n) % n;
  if (roundTimer) { clearTimeout(roundTimer); roundTimer = null; }
  advancingRound = false;
  lastAdvanceAt = Date.now();
  state.roundIndex = idx;
  resetRoundState();
  io.emit('newRound', publicState());
  broadcastState();
  return true;
}

// Resets the ALL-TIME leaderboard only. The current round's progress and
// this-round leaderboard are untouched.
function resetScores() {
  state.scores = {};
  state.recentGuesses = [];
  broadcastState();
}

// Resets just THIS ROUND's leaderboard (does not touch all-time scores,
// found words, or bonus words).
function resetRoundScores() {
  state.roundScores = {};
  broadcastState();
}

// onReject (optional) is called with (reason, word) when a guess is not accepted.
// Chat guesses stay silent; the on-screen guess boxes use it to explain why.
function handleGuess(rawText, user, avatar, onReject) {
  function reject(reason, word) {
    if (typeof onReject === 'function') onReject(reason, word);
  }
  try {
    const who = user || 'Unknown';
    if (avatar) state.userAvatars[who] = avatar;

    state.rawEventCount += 1;
    state.lastReceived = { user: who, text: rawText || '' };
    io.emit('diagnostics', { rawEventCount: state.rawEventCount, lastReceived: state.lastReceived });

    if (state.settings.paused) return reject('paused', '');

    const round = currentRound();
    const guess = cleanGuess(rawText);
    const minLen = state.settings.minGuessLength;
    if (!guess || guess.length < minLen) return reject('tooShort', guess);
    if (state.usedWords.has(guess)) return reject('alreadyFound', guess);

    for (const ch of guess) { if (!round.letterSet.has(ch)) return reject('wrongLetters', guess); }
    if (guess.indexOf(round.center) === -1) return reject('missingCenter', guess);

    const isSecret = round.wordSet.has(guess);
    if (!isSecret && !state.settings.bonusWordsEnabled) return reject('bonusDisabled', guess);
    if (!isSecret && !dictionary.has(guess.toLowerCase())) return reject('notAWord', guess);

    let points = scoreForWord(guess, round.letters);
    if (!isSecret) points = Math.ceil(points / 2); // bonus words are worth half
    points = Math.max(1, Math.round(points * state.settings.pointsMultiplier));

    state.usedWords.add(guess);
    if (isSecret) {
      state.foundSecret.set(guess, who);
    } else {
      state.bonusWords.push({ word: guess, by: who, avatar: avatarFor(who) });
    }
    state.scores[who] = (state.scores[who] || 0) + points;
    state.roundScores[who] = (state.roundScores[who] || 0) + points;

    state.recentGuesses.unshift({
      user: who, word: guess, points: points, secret: isSecret,
      avatar: avatarFor(who), ts: Date.now()
    });
    if (state.recentGuesses.length > MAX_RECENT_GUESSES) state.recentGuesses.length = MAX_RECENT_GUESSES;

    io.emit('wordFound', {
      word: guess, user: who, points: points, secret: isSecret, avatar: avatarFor(who),
      found: state.foundSecret.size, total: round.words.length,
      bonusCount: state.bonusWords.length
    });
    broadcastState();

    if (isSecret && state.foundSecret.size >= round.words.length && !advancingRound) {
      advancingRound = true;
      io.emit('roundComplete', publicState());
      if (state.settings.autoAdvanceEnabled) {
        roundTimer = setTimeout(function () {
          roundTimer = null;
          nextRound();
        }, state.settings.autoAdvanceDelayMs);
      }
      // When auto-advance is off, the round stays "complete" (celebration
      // shown, no new guesses can fill it since every slot is found) until
      // the host presses Skip Round to move on manually.
    }
  } catch (err) {
    console.error('handleGuess error:', err);
  }
}

// ---------------- TEST MODE: AUTO-ANSWER BOT ----------------
// When Test Mode is active and "autoBotEnabled" is on, this keeps picking a
// random unfound secret word and "guessing" it, at a steady pace, until the
// round is complete — handy for demoing the game without typing anything.
// It only ever acts while state.mode === 'test', so it can never interfere
// with Offline or Live play.
const AUTO_BOT_INTERVAL_MS = 1600;
setInterval(function () {
  try {
    if (state.mode !== 'test') return;
    if (!state.settings.autoBotEnabled) return;
    if (state.settings.paused) return;
    if (advancingRound) return; // round just completed — wait for the next one
    const round = currentRound();
    const remaining = round.words.filter(function (w) { return !state.foundSecret.has(w); });
    if (!remaining.length) return;
    const pick = remaining[Math.floor(Math.random() * remaining.length)];
    handleGuess(pick, 'AutoBot', null);
  } catch (err) {
    console.error('Auto-bot tick error:', err);
  }
}, AUTO_BOT_INTERVAL_MS);

// ---------------- TIKTOK LIVE ----------------
let tiktokConnection = null;
let liveRetryCount = 0;
let liveToken = 0;            // bumped on every connect/disconnect so stale retries stop
const MAX_LIVE_RETRIES = 3;

function extractChat(data) {
  // Fallback chain, because the exact field names have shifted between
  // library versions and TikTok payload variants.
  const user = (data && (data.uniqueId || (data.user && data.user.uniqueId) || data.nickname)) || 'Unknown';
  const text = (data && (data.comment || data.text || data.content)) || '';
  const avatar = (data && (
    data.profilePictureUrl ||
    (data.user && data.user.profilePictureUrl) ||
    (data.user && data.user.avatarThumb && data.user.avatarThumb.urlList && data.user.avatarThumb.urlList[0]) ||
    (data.avatarThumb && data.avatarThumb.urlList && data.avatarThumb.urlList[0]) ||
    (data.avatarLarger && data.avatarLarger.urlList && data.avatarLarger.urlList[0])
  )) || null;
  return { user: user, text: text, avatar: avatar };
}

function stopLive() {
  liveToken += 1;
  if (tiktokConnection) {
    try { tiktokConnection.disconnect(); } catch (e) { /* ignore */ }
  }
  tiktokConnection = null;
  state.liveConnected = false;
  broadcastState();
}

function startLive(username, typedKey) {
  if (!WebcastPushConnection) {
    return Promise.reject(new Error('tiktok-live-connector is not installed.'));
  }

  // A key typed into the Live tab wins; otherwise use the saved / environment key.
  const typed = cleanApiKey(typedKey);
  if (typed && !isPlausibleApiKey(typed)) {
    const bad = new Error('That does not look like an Euler Stream API key. Copy it again from https://www.eulerstream.com (no spaces).');
    bad.needsKey = true;
    return Promise.reject(bad);
  }
  const apiKey = typed || getApiKey();
  if (!apiKey) {
    const missing = new Error('Paste your Euler Stream API key into the key box first. It is free: https://www.eulerstream.com');
    missing.needsKey = true;
    return Promise.reject(missing);
  }

  username = String(username || '').trim().replace(/^@+/, '');   // people often type "@name"
  if (!username) {
    return Promise.reject(new Error('Enter a TikTok username first.'));
  }

  stopLive();
  const myToken = liveToken;
  state.liveUsername = username;
  state.mode = 'live';
  liveRetryCount = 0;

  function attemptConnect() {
    return new Promise(function (resolve, reject) {
      try {
        if (tiktokConnection) {   // never leave an old half-open connection behind
          try { tiktokConnection.disconnect(); } catch (e) { /* ignore */ }
          tiktokConnection = null;
        }
        // Log the raw event shape once per connection so a non-coder can
        // see exactly what TikTok is sending if something looks wrong.
        let loggedSample = false;
        tiktokConnection = new WebcastPushConnection(username, {
          signApiKey: apiKey
        });

        tiktokConnection.on('chat', function (data) {
          try {
            if (!loggedSample) {
              loggedSample = true;
              console.log('Sample raw chat event shape:', JSON.stringify(data).slice(0, 500));
            }
            const parsed = extractChat(data);
            handleGuess(parsed.text, parsed.user, parsed.avatar);
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
          console.error('TikTok connection error:', redactKeys(err && err.message ? err.message : err, apiKey));
        });

        tiktokConnection.connect()
          .then(function (connState) {
            if (myToken !== liveToken) {   // user pressed Disconnect while we were connecting
              try { tiktokConnection.disconnect(); } catch (e) { /* ignore */ }
              return reject(new Error('Connection cancelled.'));
            }
            state.liveConnected = true;
            if (typed && typed !== savedApiKey) saveApiKey(typed);   // it worked: keep it for next time
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
      if (myToken !== liveToken) throw err;   // cancelled: do not retry
      liveRetryCount += 1;
      if (liveRetryCount <= MAX_LIVE_RETRIES) {
        const delay = 1500 * liveRetryCount;
        console.warn('Live connect attempt ' + liveRetryCount + ' failed, retrying in ' + delay + 'ms: ' + redactKeys(err && err.message ? err.message : err, apiKey));
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

  return tryWithRetries().catch(function (err) {
    // Failed for good: leave Live mode instead of showing "LIVE" while disconnected.
    if (myToken === liveToken) {
      state.mode = 'offline';
      state.liveUsername = null;
      broadcastState();
    }
    throw err;
  });
}

// ---------------- ROUTES ----------------
app.post('/api/start-live', async function (req, res) {
  const typedKey = (req.body && req.body.apiKey) || '';
  try {
    const username = ((req.body && req.body.username) || '').trim();
    if (!username) return res.status(400).json({ ok: false, error: 'username required' });
    await startLive(username, typedKey);
    res.json({ ok: true, state: publicState() });
  } catch (err) {
    res.status(err && err.needsKey ? 400 : 500).json({
      ok: false,
      needsKey: !!(err && err.needsKey),
      error: redactKeys(err && err.message ? err.message : String(err), cleanApiKey(typedKey))
    });
  }
});

// Removes the key saved on the server. (A key set through the EULERSTREAM_API_KEY
// environment variable is not touched — that one is managed in your host settings.)
app.post('/api/forget-api-key', function (req, res) {
  forgetApiKey();
  broadcastState();
  res.json({ ok: true, hasApiKey: !!getApiKey(), apiKeySource: apiKeySource() });
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
  const skipped = skipRound();
  res.json({ ok: true, skipped: skipped, state: publicState() });
});

app.get('/api/settings', function (req, res) {
  res.json({ ok: true, settings: state.settings });
});

app.post('/api/settings', function (req, res) {
  state.settings = sanitizeSettings(Object.assign({}, state.settings, req.body || {}));
  saveSettings();
  broadcastState();
  res.json({ ok: true, settings: state.settings });
});

// A simple CSV export of the current leaderboard, for hosts who want to keep
// a record of a session's winners (e.g. for giveaways).
app.get('/api/export-leaderboard', function (req, res) {
  const rows = Object.entries(state.scores)
    .map(function (e) { return { user: e[0], points: e[1] }; })
    .sort(function (a, b) { return b.points - a.points; });
  let csv = 'rank,user,points\n';
  rows.forEach(function (r, i) {
    const safeUser = '"' + String(r.user).replace(/"/g, '""') + '"';
    csv += (i + 1) + ',' + safeUser + ',' + r.points + '\n';
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leaderboard.csv"');
  res.send(csv);
});

// Simple health check (handy for Render).
app.get('/healthz', function (req, res) {
  res.json({ ok: true, round: state.roundIndex + 1, words: dictionary.size });
});

// ---------------- SOCKET.IO ----------------
io.on('connection', function (socket) {
  socket.emit('state', publicState());

  socket.on('guess', function (payload) {
    const text = payload && payload.text;
    const user = (payload && payload.user) || 'Player';
    const avatar = (payload && payload.avatar) || null;
    handleGuess(text, user, avatar, function (reason, word) {
      socket.emit('guessRejected', { reason: reason, word: word });
    });
  });

  socket.on('hostAction', function (payload) {
    try {
      if (!payload || !payload.type) return;
      const round = currentRound();
      const remaining = round.words.filter(function (w) { return !state.foundSecret.has(w); });

      if (payload.type === 'skipRound') {
        skipRound();
      } else if (payload.type === 'gotoRound') {
        gotoRound(payload.index);
      } else if (payload.type === 'resetScores') {
        resetScores();
      } else if (payload.type === 'resetRoundScores') {
        resetRoundScores();
      } else if (payload.type === 'toggleAutoBot') {
        state.settings.autoBotEnabled = !state.settings.autoBotEnabled;
        saveSettings();
        broadcastState();
      } else if (payload.type === 'togglePause') {
        state.settings.paused = !state.settings.paused;
        saveSettings();
        broadcastState();
      } else if (payload.type === 'hint') {
        const now = Date.now();
        const cooldown = state.settings.hintCooldownMs;
        if (now - state.lastHintAt < cooldown) {
          socket.emit('notice', { message: 'Hint is cooling down, try again shortly' });
        } else if (remaining.length) {
          state.lastHintAt = now;
          const pick = remaining[Math.floor(Math.random() * remaining.length)];
          // Sent to every screen, so the streamed display shows it too.
          io.emit('hint', { letter: pick[0], length: pick.length, durationMs: state.settings.hintDurationMs });
        } else {
          socket.emit('notice', { message: 'No secret words left to hint' });
        }
      } else if (payload.type === 'simulate') {
        // Test mode: pretend a random viewer just typed one of the secret words.
        if (!remaining.length) {
          socket.emit('notice', { message: 'No secret words left to simulate' });
        } else {
          const pick = remaining[Math.floor(Math.random() * remaining.length)];
          handleGuess(pick, 'TestViewer' + Math.floor(Math.random() * 999), null);
        }
      } else if (payload.type === 'overrideReveal') {
        handleGuess(payload.word, 'Host', null);
      } else if (payload.type === 'updateSettings') {
        state.settings = sanitizeSettings(Object.assign({}, state.settings, payload.settings || {}));
        saveSettings();
        broadcastState();
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
