# Blossom LIVE — mochi edition

A word game for TikTok LIVE chat. Seven cute mochi friends hold the letters
(the one with the bow is the **center letter**). Viewers type words in chat.

This one folder is everything: game, word database, and deploy settings.

## How the game works

- Each round shows 7 letters. Every word must be **4+ letters**, use only those
  letters (repeats allowed), and **include the center letter**.
- There are **20 secret words** per round, each 4 to 8 letters long. The screen
  tells viewers how long they are: a colored chip per length ("5 letters 2/6")
  and a number badge plus one dot per letter on every unfound slot.
  A ★ marks a word that uses all 7 letters (15 points).
- **Any other real English word** from the word database is accepted as a
  **bonus word** for half points. Bonus words do not fill slots.
- Points by length: 4 letters = 1, 5 = 3, 6 = 5, 7+ = 8, all-7-letters = 15.
- Find all 20 secret words to win the round; the next round starts on its own.
  There are 40 rounds and the game loops.

## Host controls, fullscreen and clean view

- **Skip Round** jumps to the next round on every connected screen. It ignores
  a double-click so you never skip two rounds by accident.
- **Hint** shows the first letter and length of a random unfound secret word
  on every screen for 5 seconds.
- **Fullscreen** button (top right) or press **F**. On iPhone Safari real
  fullscreen is not allowed for web pages, so the button switches to a clean
  full-screen-style layout instead; use "Add to Home Screen" for a true
  full-screen app.
- **Hide controls** (eye button, or press **H**) hides the mode bar, host
  controls and diagnostics for a clean stream picture. A small gear button in the
  corner (or **H** again) brings them back.
- On wide or landscape screens (laptop, TV, fullscreen) the game switches to a
  two-column layout: board on the left, secret words and leaderboard on the right.
- Click anywhere on the "Round Complete!" celebration to dismiss it early.
- If the server is asleep or the connection drops, a message appears and the
  buttons warn you instead of silently doing nothing.

## 1. Try it on your computer

1. Install Node.js from https://nodejs.org (version 18 or newer).
2. Open a terminal in this folder and run: `npm install`
   (this also builds the big word database, see below)
3. Copy `.env.example` to `.env`. For LIVE mode, paste a free key from
   https://www.eulerstream.com after `EULERSTREAM_API_KEY=`.
4. Run: `npm start` and open http://localhost:3000

Offline and Test mode work without any key.
Files starting with a dot (`.env.example`, `.gitignore`) are hidden on
Windows/Mac. They are in the folder; that is normal.

## 2. Deploy on Render.com

1. Push this folder to a new GitHub repository (GitHub Desktop is easiest).
2. On https://render.com choose New + > Web Service and connect the repository.
3. Build Command: `npm install`   Start Command: `npm start`
4. Environment: add `EULERSTREAM_API_KEY` (only needed for Live mode).
5. Deploy. The public URL Render gives you is the link for your streaming
   device or browser source.

## 3. The word database

The game checks every guess against a Set of real words.

- `data/words-base.txt` is bundled: about 111,000 everyday English words
  (expanded from the Hunspell en_US dictionary, including plurals, past tenses
  and -ing forms).
- Each time you run `npm install` (also on Render), `scripts/build-dictionary.js`
  downloads large public word lists, merges them with the bundled list and
  your own words, removes blocked words, and saves `data/words-full.txt`.
  It prints the final count, for example `Word database ready: 385,000 words`.
  The same count is shown at the bottom of the game screen ("Word database").
- If a download fails, the game still starts with the words it has.
- The target is 400,000+. If your count is lower, add words to
  `data/extra-words.txt` (one per line) or add more list links in
  `scripts/build-dictionary.js`, then run `npm run build-words` (or redeploy).

Good to know: standard Scrabble dictionaries have roughly 180,000 to 280,000
words. Going past 400,000 means including rare, old and technical words, and
some entries in the giant public lists are not everyday English.

### Blocked words

`data/blocked-words.txt` lists profanity and slurs. They are never accepted and
never shown on stream. Add your own lines any time.

## 4. Changing rounds

- `data/rounds.json` holds the 40 rounds (7 letters, center letter, 20 secret
  words each). `npm run build-rounds` rebuilds them from `data/common-words.txt`
  (everyday words only, so secret words are guessable). Add `60` after the
  command for more rounds: `node scripts/build-rounds.js 60`.
- To ban a word from being a secret word (it still works as a bonus word), add
  it to `data/secret-exclude.txt` and rebuild.

## Health check

`/healthz` returns a small JSON status (useful for Render's health checks).

## Folder map

```
server.js                  game logic, word checking, TikTok connection
package.json               dependencies and scripts
.env.example  .gitignore
public/                    what the browser loads
  index.html  style.css  game.js
data/
  words-base.txt           bundled word list
  words-full.txt           built on install (big list)
  extra-words.txt          your words
  blocked-words.txt        never accepted
  common-words.txt         pool for secret words
  secret-exclude.txt       words kept out of secret slots
  rounds.json              the 40 rounds
scripts/
  build-dictionary.js      builds words-full.txt
  build-rounds.js          builds rounds.json
```

Thanks: the bundled list comes from Hunspell's en_US dictionary (SCOWL).
