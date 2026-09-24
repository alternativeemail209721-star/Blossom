// scripts/build-rounds.js
// Builds data/rounds.json — the puzzle rounds the game cycles through.
//
// Each round = 7 letters (one is the "center" letter every word must use)
// plus 20 SECRET words the audience is hunting for. Every secret word is
// picked from data/common-words.txt so viewers are asked for words they
// can realistically guess. (Any other real English word from the big
// dictionary is still accepted as a BONUS word during play.)
//
// Run:  npm run build-rounds
// Options:  node scripts/build-rounds.js 60      (make 60 rounds, default 40)

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const ROUND_COUNT = parseInt(process.argv[2], 10) || 40;
const SECRET_PER_ROUND = 20;

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
const base = new Set(readList('words-base.txt').filter(function (w) { return !blocked.has(w); }));
const common = readList('common-words.txt').filter(function (w) {
  return base.has(w) && !blocked.has(w) && !excluded.has(w) && w.length >= 4 && w.length <= 8;
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
  if ((centerUse[c.center] || 0) >= 5) return;
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

  chosen.push({
    letters: shuffle(c.letters).map(function (l) { return l.toUpperCase(); }),
    center: c.center.toUpperCase(),
    words: words.map(function (x) { return x.toUpperCase(); })
  });
});

fs.writeFileSync(path.join(DATA, 'rounds.json'), JSON.stringify(chosen, null, 1) + '\n');
console.log('Wrote data/rounds.json with ' + chosen.length + ' rounds.');
if (chosen.length < ROUND_COUNT) {
  console.log('(Fewer than ' + ROUND_COUNT + ' rounds matched the quality filters.)');
}
