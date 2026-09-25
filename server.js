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

// tiktok-live-connector v2+ ships as an ES Module only (no more CommonJS
// support), so a plain require('tiktok-live-connector') throws
// "ERR_REQUIRE_ESM" — which the old code silently turned into the misleading
// "is not installed" message even though npm install worked fine. A dynamic
// import() can load an ESM package from CommonJS code, so we use that
// instead and keep a ready-promise that startLive() awaits before connecting.
let TikTokLiveConnection = null;
let tiktokLiveConnectorLoadError = null;
const tiktokLiveConnectorReady = import('tiktok-live-connector').then(function (mod) {
  TikTokLiveConnection = mod.TikTokLiveConnection || mod.WebcastPushConnection || (mod.default && (mod.default.TikTokLiveConnection || mod.default.WebcastPushConnection));
  if (!TikTokLiveConnection) throw new Error('tiktok-live-connector loaded, but no TikTokLiveConnection export was found (the package API may have changed again).');
}).catch(function (e) {
  tiktokLiveConnectorLoadError = e;
  console.error('tiktok-live-connector could not be loaded:', e && e.message ? e.message : e);
});

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

// Real words that are valid guesses, but too obscure/abbreviated/technical to
// ever be picked automatically as a SECRET word. They still work as bonus
// words. See data/secret-exclude.txt.
const secretExclude = new Set(
  readLines(path.join(DATA_DIR, 'secret-exclude.txt'))
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
  theme: 'candy',                 // see THEME_OPTIONS below for the full list
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
  // Auto-advance ("auto next") is switchable per mode. When it is off for the
  // mode you are in, a finished round stays on screen until a host presses
  // Skip Round.
  autoAdvanceLive: true,        // Live Mode
  autoAdvanceOffline: true,     // Offline Mode
  autoAdvanceEnabled: true,     // Test Mode (name kept so older saved settings still work)
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
const THEME_OPTIONS = [
  'candy', 'mint', 'sunset', 'ocean', 'sky', 'meadow', 'blossom',
  'lavender', 'honey', 'cream', 'light', 'dark', 'midnight'
];
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
  // Older versions had one auto-advance switch for every mode. If it was
  // turned off, keep Live and Offline off too until the host changes them.
  if (saved.autoAdvanceEnabled === false) {
    if (!('autoAdvanceLive' in saved)) saved.autoAdvanceLive = false;
    if (!('autoAdvanceOffline' in saved)) saved.autoAdvanceOffline = false;
  }
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
// Each round: 7 letters, 1 center letter, and 20 SECRET-word SLOTS, each
// slot just a target length (e.g. five 4-letter slots, six 5-letter
// slots...). There is no fixed list of exact secret words: at play time,
// ANY real word from the dictionary that (a) is the right length for an
// open slot, (b) uses only this round's letters, and (c) includes the
// center letter fills that slot. Every other real word from the dictionary
// is a BONUS word instead.
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

    // Back-compat: an older rounds.json (pre-dynamic-secrets) stored an
    // explicit "words" list instead of "slotLengths" — derive the lengths
    // from it so old data files still load fine.
    let slotLengths = Array.isArray(r.slotLengths) ? r.slotLengths.slice() : null;
    if (!slotLengths && Array.isArray(r.words)) {
      slotLengths = r.words.map(function (w) { return String(w).length; });
    }
    slotLengths = (slotLengths || [])
      .map(function (n) { return Math.floor(Number(n)); })
      .filter(function (n) { return isFinite(n) && n >= 3 && n <= 24; })
      .sort(function (a, b) { return a - b; });

    const lengthCounts = {};
    slotLengths.forEach(function (n) { lengthCounts[n] = (lengthCounts[n] || 0) + 1; });

    return {
      letters: letters,
      center: center,
      letterSet: letterSet,
      slotLengths: slotLengths,
      lengthCounts: lengthCounts,
      lengths: Object.keys(lengthCounts).map(Number).sort(function (a, b) { return a - b; }),
      _candByLen: {}   // lazily-built cache: length -> [valid dictionary words], see candidatesForLength()
    };
  }).filter(function (r) { return r.letters.length === 7 && r.slotLengths.length > 0; });
}

const ROUNDS = loadRounds();
if (!ROUNDS.length) {
  console.error('No usable rounds found in data/rounds.json. Run "npm run build-rounds" and restart.');
  process.exit(1);
}

// All dictionary words of a given length that are legal for this round
// (built only from this round's letters, and containing the center letter),
// with any secret-exclude words left out. Computed once per round+length and
// cached on the round object, since scanning the whole dictionary is not
// something we want to do on every guess.
function candidatesForLength(round, len) {
  if (round._candByLen[len]) return round._candByLen[len];
  const list = [];
  dictionary.forEach(function (w) {
    if (w.length !== len) return;
    if (secretExclude.has(w)) return;
    const upper = w.toUpperCase();
    if (upper.indexOf(round.center) === -1) return;
    for (const ch of upper) { if (!round.letterSet.has(ch)) return; }
    list.push(upper);
  });
  round._candByLen[len] = list;
  return list;
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
  foundByLength: {}, // length -> [{ word, by, avatar }] slots of that length filled so far, in fill order
  bonusWords: [],    // [{ word, by, avatar }] valid dictionary words that are not secret words
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

// How many secret slots are filled so far this round, across all lengths.
function totalFoundCount() {
  let n = 0;
  Object.keys(state.foundByLength).forEach(function (len) { n += state.foundByLength[len].length; });
  return n;
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

  // One slot per length, in ascending length order. Within a length, filled
  // slots (in the order they were found) come first, then empty ones.
  // Unfound slots only reveal how long the word is.
  const slots = [];
  round.lengths.forEach(function (len) {
    const found = state.foundByLength[len] || [];
    const total = round.lengthCounts[len];
    for (let i = 0; i < total; i++) {
      if (i < found.length) {
        const f = found[i];
        slots.push({ len: len, word: f.word, by: f.by, avatar: avatarFor(f.by), pangram: isPangram(f.word, round.letters) });
      } else {
        slots.push({ len: len });
      }
    }
  });

  const lengthSummary = round.lengths.map(function (len) {
    return { len: len, count: round.lengthCounts[len] };
  });

  const minLen = round.slotLengths[0];
  const maxLen = round.slotLengths[round.slotLengths.length - 1];

  return {
    mode: state.mode,
    roundNumber: (state.roundIndex % ROUNDS.length) + 1,
    totalRounds: ROUNDS.length,
    letters: round.letters,
    center: round.center,
    slotsTotal: round.slotLengths.length,
    slots: slots,
    lengthSummary: lengthSummary,
    minLen: minLen,
    maxLen: maxLen,
    foundCount: totalFoundCount(),
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
  state.foundByLength = {};
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

// Is auto-advance switched on for the mode the game is in right now?
function autoAdvanceOnForMode() {
  const st = state.settings;
  if (state.mode === 'live') return !!st.autoAdvanceLive;
  if (state.mode === 'offline') return !!st.autoAdvanceOffline;
  return !!st.autoAdvanceEnabled;   // test mode
}

// Keeps a COMPLETED round in step with the auto-advance switch: turning it on
// while a finished round is waiting starts the countdown, turning it off
// during the countdown cancels it. Does nothing while a round is in progress.
function syncRoundAdvance() {
  if (!advancingRound) return;
  if (autoAdvanceOnForMode()) {
    if (!roundTimer) {
      roundTimer = setTimeout(function () {
        roundTimer = null;
        nextRound();
      }, state.settings.autoAdvanceDelayMs);
    }
  } else if (roundTimer) {
    clearTimeout(roundTimer);
    roundTimer = null;
  }
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
//
// Every viewer keeps their own running score: `who` (their TikTok uniqueId,
// or the name passed in for Offline/Test/host guesses) is the ONLY key ever
// used to credit points, and points are always ADDED to whatever that viewer
// already has in state.scores / state.roundScores — never overwritten and
// never redirected to whoever guessed most recently. Two different guesses
// from two different viewers always accumulate under two separate names.
function handleGuess(rawText, user, avatar, onReject) {
  function reject(reason, word) {
    if (typeof onReject === 'function') onReject(reason, word);
  }
  try {
    const who = String(user || 'Unknown').trim() || 'Unknown';
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
    if (!dictionary.has(guess.toLowerCase())) return reject('notAWord', guess);

    // SECRET vs BONUS is decided live: any dictionary word is a secret word
    // if there is still an open slot of exactly its length (and it is not on
    // the secret-exclude list) — it does not have to match any pre-chosen
    // word. Once every slot of that length is full, the same word (or any
    // other word of that length) just becomes a bonus word instead.
    const len = guess.length;
    const totalForLen = round.lengthCounts[len] || 0;
    const filledForLen = (state.foundByLength[len] || []).length;
    const isSecret = totalForLen > 0 && filledForLen < totalForLen && !secretExclude.has(guess.toLowerCase());

    if (!isSecret && !state.settings.bonusWordsEnabled) return reject('bonusDisabled', guess);

    let points = scoreForWord(guess, round.letters);
    if (!isSecret) points = Math.ceil(points / 2); // bonus words are worth half
    points = Math.max(1, Math.round(points * state.settings.pointsMultiplier));

    state.usedWords.add(guess);
    if (isSecret) {
      if (!state.foundByLength[len]) state.foundByLength[len] = [];
      state.foundByLength[len].push({ word: guess, by: who, avatar: avatarFor(who) });
    } else {
      state.bonusWords.push({ word: guess, by: who, avatar: avatarFor(who) });
    }
    // Accumulate — never assign/overwrite — so every viewer keeps building
    // on their own total across every guess they make, all round (and all
    // session) long.
    state.scores[who] = (state.scores[who] || 0) + points;
    state.roundScores[who] = (state.roundScores[who] || 0) + points;

    state.recentGuesses.unshift({
      user: who, word: guess, points: points, secret: isSecret,
      avatar: avatarFor(who), ts: Date.now()
    });
    if (state.recentGuesses.length > MAX_RECENT_GUESSES) state.recentGuesses.length = MAX_RECENT_GUESSES;

    const foundNow = totalFoundCount();
    io.emit('wordFound', {
      word: guess, user: who, points: points, secret: isSecret, avatar: avatarFor(who),
      found: foundNow, total: round.slotLengths.length,
      bonusCount: state.bonusWords.length
    });
    broadcastState();

    if (isSecret && foundNow >= round.slotLengths.length && !advancingRound) {
      advancingRound = true;
      io.emit('roundComplete', publicState());
      // Starts the countdown only if auto-advance is on for the current mode
      // (Live / Offline / Test). When it is off, the round stays "complete"
      // (celebration shown, no new guesses can fill it since every slot is
      // found) until the host presses Skip Round to move on manually.
      syncRoundAdvance();
    }
  } catch (err) {
    console.error('handleGuess error:', err);
  }
}

// Picks a random still-open secret-word length for the current round, then a
// random real dictionary word of exactly that length that is legal for the
// round (built from this round's letters, includes the center letter, not
// on the secret-exclude list, and not already used this round). Returns
// null if nothing is available (e.g. every possible word for every open
// length has already been found/guessed — rare, but possible late in a
// round). Used by Hint, "Simulate Random Correct Guess", and the auto-bot.
function pickOpenSecretWord(round) {
  const openLens = round.lengths.filter(function (len) {
    return (state.foundByLength[len] || []).length < round.lengthCounts[len];
  });
  const shuffledLens = openLens.slice().sort(function () { return Math.random() - 0.5; });
  for (let i = 0; i < shuffledLens.length; i++) {
    const len = shuffledLens[i];
    const candidates = candidatesForLength(round, len).filter(function (w) { return !state.usedWords.has(w); });
    if (candidates.length) return candidates[Math.floor(Math.random() * candidates.length)];
  }
  return null;
}

// A small, fixed pool of pretend-viewer names for Offline/Test-mode
// simulation, so repeated simulated guesses land on the SAME handful of
// viewers and their scores visibly accumulate — instead of each simulated
// guess minting a brand-new one-off name that only ever has one guess to
// its name (which used to make the leaderboard look like points were going
// to "whoever answered most recently" rather than building up per viewer).
const SIMULATED_VIEWER_POOL = [
  'TestViewer_Ava', 'TestViewer_Beck', 'TestViewer_Cleo',
  'TestViewer_Drew', 'TestViewer_Enzo', 'TestViewer_Fay'
];
function randomSimulatedViewer() {
  return SIMULATED_VIEWER_POOL[Math.floor(Math.random() * SIMULATED_VIEWER_POOL.length)];
}

// ---------------- TEST MODE: AUTO-ANSWER BOT ----------------
// When Test Mode is active and "autoBotEnabled" is on, this keeps picking a
// random open secret slot and a random real word that fills it, at a steady
// pace, until the round is complete — handy for demoing the game without
// typing anything. It only ever acts while state.mode === 'test', so it can
// never interfere with Offline or Live play. Always credited to the same
// 'AutoBot' name, so its score accumulates normally too.
const AUTO_BOT_INTERVAL_MS = 1600;
setInterval(function () {
  try {
    if (state.mode !== 'test') return;
    if (!state.settings.autoBotEnabled) return;
    if (state.settings.paused) return;
    if (advancingRound) return; // round just completed — wait for the next one
    const round = currentRound();
    const pick = pickOpenSecretWord(round);
    if (!pick) return;
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

// Finds the viewer's real TikTok profile picture URL in whatever shape the
// event arrives in. Prefers a URL the browser can actually display (jpeg/png/
// webp) over .heic, which most browsers cannot render.
function pickAvatarUrl(data) {
  if (!data) return null;
  const candidates = [];
  function add(v) {
    if (!v) return;
    if (typeof v === 'string') candidates.push(v);
    else if (Array.isArray(v)) v.forEach(add);
    else if (typeof v === 'object') { add(v.urlList); add(v.urls); add(v.url); }
  }
  const u = data.user || {};
  const d = data.userDetails || {};
  add(data.profilePictureUrl); add(u.profilePictureUrl);
  add(d.profilePictureUrls); add(d.profilePictureUrl);
  add(u.profilePicture); add(data.profilePicture);
  add(u.avatarThumb); add(data.avatarThumb);
  add(u.avatarMedium); add(data.avatarMedium);
  add(u.avatarLarger); add(data.avatarLarger);
  const urls = candidates.filter(function (x) { return typeof x === 'string' && /^https?:\/\//i.test(x); });
  if (!urls.length) return null;
  const displayable = urls.filter(function (x) { return !/\.heic(\?|$)/i.test(x); });
  return (displayable[0] || urls[0]);
}

function extractChat(data) {
  // Fallback chain, because the exact field names have shifted between
  // library versions and TikTok payload variants.
  const user = (data && (data.uniqueId || (data.user && data.user.uniqueId) || data.nickname)) || 'Unknown';
  const text = (data && (data.comment || data.text || data.content)) || '';
  const avatar = pickAvatarUrl(data);
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
  return tiktokLiveConnectorReady.then(function () {
    return startLiveInner(username, typedKey);
  });
}

function startLiveInner(username, typedKey) {
  if (!TikTokLiveConnection) {
    const msg = 'tiktok-live-connector failed to load'
      + (tiktokLiveConnectorLoadError ? ': ' + tiktokLiveConnectorLoadError.message : ' (unknown reason)')
      + '. Check the server logs; this usually means the package version in package.json '
      + 'is broken or incompatible, or "npm install" did not finish. Try redeploying.';
    return Promise.reject(new Error(msg));
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
  syncRoundAdvance();
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
        tiktokConnection = new TikTokLiveConnection(username, {
          signApiKey: apiKey,
          // Give the sign server a bit more time on a slow/free connection
          // instead of failing fast and burning a retry.
          webClientOptions: { timeout: 15000 },
          wsClientOptions: { timeout: 15000 }
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
      syncRoundAdvance();
      state.liveUsername = null;
      broadcastState();
    }
    throw explainLiveError(err, username);
  });
}

// Turns the raw "Failed to sign request: ... status code XXX" error from the
// sign server into something a non-coder can actually act on. The most
// common causes, in order of likelihood, are listed in the message.
function explainLiveError(err, username) {
  const raw = (err && err.message) || String(err);
  const m = raw.match(/status code (\d+)/i);
  const code = m ? m[1] : null;
  let hint = '';
  if (code === '403') {
    hint = ' This almost always means one of: (1) your Euler Stream API key is '
      + 'invalid, expired, or its free-tier daily quota is used up — check '
      + 'https://www.eulerstream.com dashboard; (2) the TikTok account "' + username
      + '" is not live right now — double-check the username and that you can see '
      + 'the LIVE badge on their profile; or (3) TikTok is blocking requests from '
      + 'this server\'s IP address, which is common on Render\'s shared/free IPs — '
      + 'this is a TikTok-side block Euler Stream cannot always route around, and '
      + 'may resolve itself later or need a paid Euler Stream plan with better routing.';
  } else if (code === '429') {
    hint = ' This means you have hit a rate limit — either Euler Stream\'s free-tier '
      + 'request limit for the day, or TikTok itself. Wait a while before retrying, '
      + 'or upgrade your Euler Stream plan.';
  } else if (/timeout/i.test(raw)) {
    hint = ' The sign server took too long to respond. This is usually temporary — '
      + 'wait a moment and press Connect again.';
  }
  if (hint) {
    const wrapped = new Error(raw + hint);
    wrapped.needsKey = err && err.needsKey;
    return wrapped;
  }
  return err;
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
  syncRoundAdvance();
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
  syncRoundAdvance();
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
  syncRoundAdvance();
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
        } else {
          const pick = pickOpenSecretWord(round);
          if (pick) {
            state.lastHintAt = now;
            // Sent to every screen, so the streamed display shows it too.
            io.emit('hint', { letter: pick[0], length: pick.length, durationMs: state.settings.hintDurationMs });
          } else {
            socket.emit('notice', { message: 'No secret words left to hint' });
          }
        }
      } else if (payload.type === 'simulate') {
        // Test mode: pretend one of a small, recurring pool of fake viewers
        // just typed a word that fills an open secret slot — so, just like
        // real viewers, their simulated score keeps accumulating guess after
        // guess instead of starting over at a new name each click.
        const pick = pickOpenSecretWord(round);
        if (!pick) {
          socket.emit('notice', { message: 'No secret words left to simulate' });
        } else {
          handleGuess(pick, randomSimulatedViewer(), null);
        }
      } else if (payload.type === 'overrideReveal') {
        handleGuess(payload.word, 'Host', null);
      } else if (payload.type === 'updateSettings') {
        state.settings = sanitizeSettings(Object.assign({}, state.settings, payload.settings || {}));
        saveSettings();
        syncRoundAdvance();
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
