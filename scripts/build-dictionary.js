// scripts/build-dictionary.js
// Builds data/words-full.txt — the big word database the game checks guesses against.
//
// What it does:
//   1. Starts from data/words-base.txt  (bundled, about 111,000 everyday English words)
//   2. Adds data/extra-words.txt        (optional — your own extra words, one per line)
//   3. Downloads large public English word lists and merges them in
//   4. Removes anything in data/blocked-words.txt, de-duplicates, and saves the result
//
// It runs automatically after "npm install" (on your computer AND on Render).
// It never stops the install: if a download fails it just tells you and moves on,
// and the game still works with whatever words it could gather.
//
// Run by hand any time:  npm run build-words

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data');
const TARGET = 400000;
const MIN_LEN = 4;   // the game only accepts words of 4+ letters
const MAX_LEN = 24;

// Large public English word lists (plain text, one word per line).
// You can swap or add lists here, or override them without editing this file:
//   WORD_SOURCE_URLS="https://a.example/list1.txt,https://b.example/list2.txt"
const DEFAULT_SOURCES = [
  { name: 'dwyl english-words, letters-only (about 370k)', url: 'https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt' },
  { name: 'dwyl english-words, full file (about 466k lines)', url: 'https://raw.githubusercontent.com/dwyl/english-words/master/words.txt' },
  { name: 'ENABLE word list (about 173k)', url: 'https://raw.githubusercontent.com/dolph/dictionary/master/enable1.txt' },
  { name: 'SOWPODS / Collins Scrabble (about 267k)', url: 'https://raw.githubusercontent.com/jesstess/Scrabble/master/sowpods.txt' }
];

function getSources() {
  const override = (process.env.WORD_SOURCE_URLS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (override.length) {
    return override.map(function (u, i) { return { name: 'custom list ' + (i + 1), url: u }; });
  }
  return DEFAULT_SOURCES;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/);
  } catch (e) {
    return [];
  }
}

const blocked = new Set(
  readLines(path.join(DATA, 'blocked-words.txt'))
    .map(function (l) { return l.trim().toLowerCase(); })
    .filter(function (l) { return l && l[0] !== '#'; })
);

const all = new Set();

// Adds every clean word from a list of lines. Returns how many were new.
function addWords(lines) {
  let added = 0;
  for (let i = 0; i < lines.length; i++) {
    const w = lines[i].trim().toLowerCase();
    if (w.length < MIN_LEN || w.length > MAX_LEN) continue;
    if (!/^[a-z]+$/.test(w)) continue;   // letters only: no hyphens, apostrophes, digits
    if (blocked.has(w)) continue;
    if (!all.has(w)) { all.add(w); added++; }
  }
  return added;
}

async function download(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function main() {
  console.log('--- Building the word database ---');

  const baseCount = addWords(readLines(path.join(DATA, 'words-base.txt')));
  console.log('Bundled base list: ' + baseCount.toLocaleString() + ' words');

  const extraCount = addWords(readLines(path.join(DATA, 'extra-words.txt')));
  if (extraCount) console.log('Your extra-words.txt: +' + extraCount.toLocaleString() + ' new words');

  let downloaded = 0;
  const sources = getSources();
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    try {
      const text = await download(src.url);
      const added = addWords(text.split(/\r?\n/));
      downloaded++;
      console.log('Downloaded ' + src.name + ': +' + added.toLocaleString() + ' new words');
    } catch (err) {
      console.log('Could not download ' + src.name + ' (' + (err && err.message ? err.message : err) + ') - skipped.');
    }
  }

  const sorted = Array.from(all).sort();
  fs.writeFileSync(path.join(DATA, 'words-full.txt'), sorted.join('\n') + '\n');

  console.log('Word database ready: ' + sorted.length.toLocaleString() + ' words saved to data/words-full.txt');
  if (downloaded === 0) {
    console.log('NOTE: no online lists could be downloaded, so only the bundled + extra words are in use.');
    console.log('      Check your internet connection and run "npm run build-words" again.');
  }
  if (sorted.length < TARGET) {
    console.log('NOTE: that is under ' + TARGET.toLocaleString() + ' words. To add more, put extra words (one per line)');
    console.log('      in data/extra-words.txt and run "npm run build-words" again.');
  }
}

main()
  .catch(function (err) {
    console.log('Word database build hit a problem (the game will still start): ' + (err && err.message ? err.message : err));
  })
  .then(function () {
    process.exit(0);
  });
