// scripts/build-rounds.js
// Builds data/rounds.json — the puzzle rounds the game cycles through.
//
// Each round = 7 letters (one is the "center" letter every word must use)
// plus a LENGTH for each of the 20 secret-word slots (e.g. five 4-letter
// slots, six 5-letter slots, ...). The game does NOT store which exact word
// fills each slot — at play time, ANY real word from the word database that
// (a) is the right length for an open slot, (b) uses only this round's
// letters, and (c) includes the center letter is accepted and fills that
// slot. This file only has to prove a round is *fair*: that enough
// everyday words actually exist for each length, using data/words-base.txt
// (the same "everyday English words" list the live game itself is built on,
// merged with the small hand-picked data/common-words.txt) as the "is this
// realistically guessable" check. (Any other real English word from the big
// dictionary is still accepted as a BONUS word during play, and
// data/secret-exclude.txt keeps overly obscure words out of the secret
// slots even at play time.)
//
// The game needs a big, non-repetitive rotation of rounds for long TikTok
// LIVE sessions, so this script targets at least 1000 unique rounds by
// default — comfortably more than fit in a single stream — using the full
// ~111k-word base list as the candidate pool (rather than only the ~2,460
// words in common-words.txt, which alone can only support a few dozen fair
// rounds) and by no longer hard-capping how many rounds may share a center
// letter to a flat 5.
//
// Run:  npm run build-rounds
// Options:  node scripts/build-rounds.js 1500      (make 1500 rounds, default 1000)

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const ROUND_COUNT = parseInt(process.argv[2], 10) || 1000;
const SECRET_PER_ROUND = 20;
// How many rounds may share the same center letter. Scales with how many
// rounds are requested so the deck stays varied instead of one letter (e.g.
// "E") crowding out the rest, but never blocks reaching ROUND_COUNT the way
// a flat cap of 5 used to (26 letters x 5 = 130 rounds max, however many
// were asked for).
const MAX_PER_CENTER = Math.max(20, Math.ceil(ROUND_COUNT / 10));

function readList(file) {
  try {
    return fs.readFileSync(path.join(DATA, file), 'utf8')
      .split(/\r?\n/).map(function (l) { return l.trim().toLowerCase(); })
      .filter(function (l) { return l && l[0] !== '#'; });
  } catch (e) { return []; }
}

const blocked = new Set(readList('blocked-words.txt'));
// Words that are real but too obscure / abbreviated / technical to be a SECRET word.
// (They are still accepted as bonus words in the game.)
const excluded = new Set(readList('secret-exclude.txt'));
const baseList = readList('words-base.txt').filter(function (w) { return !blocked.has(w); });
// The candidate pool for building/proving rounds: the full everyday base
// list plus anything extra in common-words.txt (in practice common-words.txt
// is already a subset of words-base.txt, but a user's own additions there
// are picked up too), filtered to the lengths a secret slot can be.
const common = Array.from(new Set(baseList.concat(readList('common-words.txt')))).filter(function (w) {
  return !blocked.has(w) && !excluded.has(w) && w.length >= 4 && w.length <= 8;
});

// Small seeded random generator. Each round gets its own seed (built from its
// letters), so the same command always gives the same rounds, and editing the
// exclude list only changes the rounds that contained an excluded word.
function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
let seed = 1;
function useSeed(str) { seed = hashStr(str) || 1; }
function rnd() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// Skip plural / verb "-s" forms so rounds are not full of boring plurals.
function isPlainForm(w) {
  return !(w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is'));
}

const RARE = /[qjxz]/;
const seen = new Set();
const candidates = [];

// A "seed" word uses exactly 7 different letters. Its letters become the flower.
common.forEach(function (w) {
  if (w.length < 7 || RARE.test(w)) return;
  const letters = Array.from(new Set(w.split(''))).sort();
  if (letters.length !== 7) return;
  const key = letters.join('');
  if (seen.has(key)) return;
  seen.add(key);

  const setL = new Set(letters);
  const playable = common.filter(function (x) {
    if (!isPlainForm(x)) return false;
    for (const ch of x) { if (!setL.has(ch)) return false; }
    return true;
  });

  letters.forEach(function (center) {
    const withCenter = playable.filter(function (x) { return x.indexOf(center) !== -1; });
    const b4 = withCenter.filter(function (x) { return x.length === 4; });
    const b5 = withCenter.filter(function (x) { return x.length === 5; });
    const b6 = withCenter.filter(function (x) { return x.length === 6; });
    const b7 = withCenter.filter(function (x) { return x.length >= 7; });
    if (b4.length < 3 || b5.length < 4 || b6.length < 3 || b7.length < 1) return;
    if (withCenter.length < SECRET_PER_ROUND) return;
    candidates.push({ seedWord: w, letters: letters, center: center, pool: withCenter, b4: b4, b5: b5, b6: b6, b7: b7 });
  });
});

console.log('Candidate rounds found: ' + candidates.length);

// Pick rounds: one per letter set, spread the center letters out.
const centerUse = {};
const usedSets = new Set();
const chosen = [];
candidates.sort(function (a, b) {
  return hashStr(a.letters.join('') + a.center) - hashStr(b.letters.join('') + b.center);
});
candidates.forEach(function (c) {
  if (chosen.length >= ROUND_COUNT) return;
  const key = c.letters.join('');
  if (usedSets.has(key)) return;
  if ((centerUse[c.center] || 0) >= MAX_PER_CENTER) return;
  useSeed(key + c.center);
  usedSets.add(key);
  centerUse[c.center] = (centerUse[c.center] || 0) + 1;

  // Always include the 7-letter pangram(s) the letters came from.
  const secret = new Set();
  c.b7.filter(function (x) { return new Set(x.split('')).size === 7; }).slice(0, 2)
    .forEach(function (x) { secret.add(x); });
  if (!secret.size && c.b7.indexOf(c.seedWord) !== -1) secret.add(c.seedWord);

  function take(list, n) {
    shuffle(list).forEach(function (x) { if (n > 0 && !secret.has(x)) { secret.add(x); n--; } });
  }
  take(c.b4, 5);
  take(c.b5, 6);
  take(c.b6, 5);
  take(c.b7, 4 - Math.min(secret.size, 4) + 0);
  take(shuffle(c.pool), SECRET_PER_ROUND - secret.size); // top up if a bucket ran short

  const words = Array.from(secret).slice(0, SECRET_PER_ROUND).sort(function (a, b) {
    return a.length - b.length || (a < b ? -1 : 1);
  });
  if (words.length < SECRET_PER_ROUND) return;

  // We only keep the LENGTH of each sample word, not the word itself — the
  // sample just proves 20 words of this length distribution genuinely exist
  // for this letter set. Which exact word fills each slot is decided live,
  // from the full dictionary, when someone actually guesses it.
  const slotLengths = words.map(function (x) { return x.length; }).sort(function (a, b) { return a - b; });

  chosen.push({
    letters: shuffle(c.letters).map(function (l) { return l.toUpperCase(); }),
    center: c.center.toUpperCase(),
    slotLengths: slotLengths
  });
});

fs.writeFileSync(path.join(DATA, 'rounds.json'), JSON.stringify(chosen, null, 1) + '\n');
console.log('Wrote data/rounds.json with ' + chosen.length + ' rounds.');
if (chosen.length < ROUND_COUNT) {
  console.log('(Fewer than ' + ROUND_COUNT + ' rounds matched the quality filters.)');
}
