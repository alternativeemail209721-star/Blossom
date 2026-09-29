// scripts/add-rounds.js
// APPENDS brand-new, unique rounds to data/rounds.json (it never removes or
// changes the rounds already in the file, unlike build-rounds.js which
// rebuilds the whole file from scratch).
//
// "Unique" here means: no new round has the same 7 letters AND the same
// center letter as any round already in the file or any other new round.
// Fresh letter sets are used first (one round each). If more rounds are
// wanted than there are fresh letter sets, the remaining rounds re-use a
// letter set with a DIFFERENT center letter, which is a genuinely different
// puzzle (a different word pool and different answers). No letter set is
// ever used with more than 2 different centers by this script.
//
// Every added round passes the same fairness checks as build-rounds.js
// (enough everyday 4/5/6/7+ letter words that use only the round's letters
// and include the center letter), using data/words-base.txt.
//
// Run:  npm run add-rounds            (adds 10,000 rounds)
//       node scripts/add-rounds.js 5000   (adds 5,000 rounds)

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const ADD_COUNT = parseInt(process.argv[2], 10) || 10000;
const SECRET_PER_ROUND = 20;
const MAX_CENTERS_PER_SET = 2;

function readList(file) {
  try {
    return fs.readFileSync(path.join(DATA, file), 'utf8')
      .split(/\r?\n/).map(function (l) { return l.trim().toLowerCase(); })
      .filter(function (l) { return l && l[0] !== '#'; });
  } catch (e) { return []; }
}

const blocked = new Set(readList('blocked-words.txt'));
const excluded = new Set(readList('secret-exclude.txt'));
const baseList = readList('words-base.txt').filter(function (w) { return !blocked.has(w); });
const common = Array.from(new Set(baseList.concat(readList('common-words.txt')))).filter(function (w) {
  return !blocked.has(w) && !excluded.has(w) && w.length >= 4 && w.length <= 8;
});

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
function isPlainForm(w) {
  return !(w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is'));
}
function maskOf(w) {
  let m = 0;
  for (let i = 0; i < w.length; i++) m |= 1 << (w.charCodeAt(i) - 97);
  return m;
}
function popcount(x) { let n = 0; while (x) { x &= x - 1; n++; } return n; }

// ---- existing rounds ----
const roundsFile = path.join(DATA, 'rounds.json');
let existing = [];
try { existing = JSON.parse(fs.readFileSync(roundsFile, 'utf8')); } catch (e) {
  console.error('Could not read data/rounds.json: ' + e.message);
  process.exit(1);
}
function setKey(letters) { return letters.map(function (l) { return String(l).toLowerCase(); }).sort().join(''); }
const usedPairs = new Set();
const centersPerSet = {};
const centerUse = {};
existing.forEach(function (r) {
  const k = setKey(r.letters);
  const c = String(r.center).toLowerCase();
  usedPairs.add(k + '|' + c);
  centersPerSet[k] = (centersPerSet[k] || 0) + 1;
  centerUse[c] = (centerUse[c] || 0) + 1;
});
console.log('Existing rounds: ' + existing.length);

// ---- candidate (letter set, center) pairs ----
const RARE = /[qjxz]/;
const words = common.map(function (w) {
  return { w: w, mask: maskOf(w), len: w.length, plain: isPlainForm(w) };
});
const seedMasks = new Map();
words.forEach(function (o) {
  if (o.len < 7 || RARE.test(o.w)) return;
  if (popcount(o.mask) !== 7) return;
  if (!seedMasks.has(o.mask)) seedMasks.set(o.mask, o.w);
});
console.log('Letter sets available: ' + seedMasks.size);

const sets = []; // { key, letters, centers: [{center, pool, b4,b5,b6,b7}] }
seedMasks.forEach(function (seedWord, mask) {
  const letters = Array.from(new Set(seedWord.split(''))).sort();
  const playable = words.filter(function (o) { return o.plain && (o.mask & ~mask) === 0; });
  const centers = [];
  letters.forEach(function (center) {
    const cb = 1 << (center.charCodeAt(0) - 97);
    const withCenter = playable.filter(function (o) { return (o.mask & cb) !== 0; }).map(function (o) { return o.w; });
    const b4 = withCenter.filter(function (x) { return x.length === 4; });
    const b5 = withCenter.filter(function (x) { return x.length === 5; });
    const b6 = withCenter.filter(function (x) { return x.length === 6; });
    const b7 = withCenter.filter(function (x) { return x.length >= 7; });
    if (b4.length < 3 || b5.length < 4 || b6.length < 3 || b7.length < 1) return;
    if (withCenter.length < SECRET_PER_ROUND) return;
    centers.push({ center: center, pool: withCenter, b4: b4, b5: b5, b6: b6, b7: b7 });
  });
  if (centers.length) sets.push({ key: letters.join(''), letters: letters, seedWord: seedWord, centers: centers });
});
sets.sort(function (a, b) { return hashStr(a.key) - hashStr(b.key); });
console.log('Letter sets with at least one fair center: ' + sets.length);

// ---- choose which (set, center) pairs to add ----
const picks = [];
function pickFor(s) {
  const options = s.centers.filter(function (c) { return !usedPairs.has(s.key + '|' + c.center); });
  if (!options.length) return false;
  // Prefer the center letter used least so far, so centers stay well spread out.
  options.sort(function (a, b) {
    return (centerUse[a.center] || 0) - (centerUse[b.center] || 0) ||
      hashStr(s.key + a.center) - hashStr(s.key + b.center);
  });
  const c = options[0];
  usedPairs.add(s.key + '|' + c.center);
  centersPerSet[s.key] = (centersPerSet[s.key] || 0) + 1;
  centerUse[c.center] = (centerUse[c.center] || 0) + 1;
  picks.push({ set: s, c: c });
  return true;
}
for (let pass = 0; pass < MAX_CENTERS_PER_SET && picks.length < ADD_COUNT; pass++) {
  for (let i = 0; i < sets.length && picks.length < ADD_COUNT; i++) {
    // Pass 0 = sets with no rounds yet. Later passes = sets that have exactly `pass` rounds.
    if ((centersPerSet[sets[i].key] || 0) !== pass) continue;
    pickFor(sets[i]);
  }
}

// ---- build slot lengths the same way build-rounds.js does ----
const added = [];
picks.forEach(function (p) {
  const c = p.c;
  useSeed(p.set.key + c.center);
  const secret = new Set();
  c.b7.filter(function (x) { return new Set(x.split('')).size === 7; }).slice(0, 2)
    .forEach(function (x) { secret.add(x); });
  if (!secret.size && c.b7.indexOf(p.set.seedWord) !== -1) secret.add(p.set.seedWord);
  function take(list, n) {
    shuffle(list).forEach(function (x) { if (n > 0 && !secret.has(x)) { secret.add(x); n--; } });
  }
  take(c.b4, 5);
  take(c.b5, 6);
  take(c.b6, 5);
  take(c.b7, 4 - Math.min(secret.size, 4));
  take(shuffle(c.pool), SECRET_PER_ROUND - secret.size);
  const ws = Array.from(secret).slice(0, SECRET_PER_ROUND);
  if (ws.length < SECRET_PER_ROUND) return;
  const slotLengths = ws.map(function (x) { return x.length; }).sort(function (a, b) { return a - b; });
  added.push({
    letters: shuffle(p.set.letters).map(function (l) { return l.toUpperCase(); }),
    center: c.center.toUpperCase(),
    slotLengths: slotLengths
  });
});

// ---- write (one round per line keeps the file small and easy to diff) ----
const all = existing.concat(added);
const out = '[\n' + all.map(function (r) { return ' ' + JSON.stringify(r); }).join(',\n') + '\n]\n';
fs.writeFileSync(roundsFile, out);
console.log('Added ' + added.length + ' new rounds. data/rounds.json now has ' + all.length + ' rounds.');
if (added.length < ADD_COUNT) {
  console.log('(Only ' + added.length + ' of the requested ' + ADD_COUNT + ' fair, unique rounds could be made from the current word list.)');
}
