# Blossom LIVE — mochi edition

A word game for TikTok LIVE chat. Seven cute mochi friends hold the letters
(the one with the bow is the **center letter**). Viewers type words in chat.
Every viewer's circular profile picture shows up next to their guesses, on
freshly-found words, and on the leaderboard, and the whole game is tunable
from an in-app Settings panel (theme, sound, points, avatars, and more).

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

## Viewer avatars

Every guess — secret or bonus — carries the viewer's circular profile
picture wherever their name appears: the freshly-found slot, the bonus word
chip, the leaderboard, and the floating live guess feed (see below). In
**Live** mode this is the viewer's real TikTok profile picture. In
**Offline** and **Test** mode (and for any viewer TikTok gives no picture
for) it's a colorful circle with their initials instead, generated on the
fly — nothing ever shows a broken image. Turn avatars off entirely, or
change their size, from Settings.

## The live guess feed

A small docked panel — sitting right below the instructions and above the
seven letters — shows **one guess at a time**: avatar, name, the word, and
the points earned. Each guess fades out a few seconds after it appears, then
the next one (if any came in while it was showing) fades in. It collapses
to almost nothing when there's nothing to show, so the letters and secret
word boxes below it are always fully visible. From Settings you can toggle
it, set how many seconds each guess stays visible, and cap how many can be
queued up if guesses arrive faster than they can be shown (older ones are
dropped).

## Settings panel

Tap the gear icon in the top bar to open **Settings**. Every change is
instant on every connected screen and saved to `data/settings.json`, so it
survives a restart or redeploy. What you can customize:

- **Appearance** — theme (Candy Pink, Minty Fresh, Sunset, Ocean Breeze,
  Midnight), viewer avatars on/off and their size, board animations,
  confetti, compact/stream mode (hides the rules legend and diagnostics
  for a clean overlay), and the diagnostics panel itself.
- **Live feed & leaderboard** — show/hide the docked live feed, how many
  guesses it keeps, and how many names the leaderboard shows.
- **Gameplay** — turn bonus words on/off, a points multiplier, minimum
  guess length, hint cooldown and on-screen duration, the skip-round
  cooldown, whether rounds **auto-advance** at all, how long the game waits
  after a round is won before auto-advancing, and whether **Test Mode**
  keeps auto-answering with a bot until the round is complete.
- **Sound** — on/off and volume for the built-in correct-guess, bonus,
  round-win, and hint sound effects (synthesized in the browser, so there
  are no audio files to manage).

If you turn **auto-advance** off, a finished round stays on screen (with
the celebration) until a host presses **Skip Round** to move on manually —
handy for letting a round's win sink in before continuing.

Test Mode also has its own **Auto-Answer** button next to "Simulate Random
Correct Guess": turn it on and the game keeps simulating correct guesses by
itself, at a steady pace, until every secret word is found — great for
demos or leaving the screen running unattended.

Note: lowering "Minimum guess length" below 4 only matters once your word
database actually contains shorter words — the bundled `words-base.txt`
starts at 4 letters. Add 3-letter words to `data/extra-words.txt` (or run
`npm run build-words` with internet access) if you want 3-letter guesses
to be accepted.

## Extra host controls

Alongside Skip Round and Hint, the host panel has:

- **Pause / Resume** — instantly stop accepting guesses on every screen,
  without disconnecting Live mode.
- **Round #, Go** — jump straight to any round by number.
- **Reset Round Leaderboard** — clears just *this round's* leaderboard
  (asks for confirmation first); all-time scores are untouched.
- **Reset All-Time Leaderboard** — clears the cumulative leaderboard across
  every round (asks for confirmation first).
- **Export CSV** — downloads the current all-time leaderboard as
  `leaderboard.csv`, handy for picking winners after a session.

### Two leaderboards: This Round vs All-Time

The leaderboard panel now tracks **two** sets of scores at once:

- **This Round** — resets to zero every time a new round starts, so it
  always shows who's doing best on the *current* set of letters.
- **All-Time** — keeps accumulating across every round for the whole
  session, until a host resets it.

Use the **This Round / All-Time** toggle above the leaderboard to switch
which one is shown. Each has its own reset button in the host panel (see
above), so you can clear one without touching the other.

## Live mode and the Euler Stream key

LIVE mode reads your TikTok chat through Euler Stream, which needs a free API
key (create an account at https://www.eulerstream.com, then create a key).

1. Tap **Live** in the mode bar at the top.
2. Type your TikTok username (without the @).
3. Paste your key into the **Euler Stream API key** box. **Show** reveals what
   you pasted; pasting the whole `EULERSTREAM_API_KEY=...` line also works.
4. Press **Connect**.

After a successful connect the key is remembered in that browser and saved on
the server (`data/secrets.json`), so next time you only need your username.
**Forget** removes the saved key from both places. The key is never shown back
on any screen, and `data/secrets.json` is in `.gitignore` so it is never
uploaded to GitHub.

The key is looked up in this order: the box in the Live tab, then the key saved
on the server, then the `EULERSTREAM_API_KEY` setting (`.env` file or Render
Environment), which still works if you prefer it.

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
3. Run: `npm start` and open http://localhost:3000
4. For LIVE mode, open the **Live** tab, type your TikTok username, paste your
   free Euler Stream API key (from https://www.eulerstream.com) into the
   **Euler Stream API key** box, and press **Connect** (see "Live mode and the
   Euler Stream key" below).

Offline and Test mode work without any key. You do **not** need a `.env` file.
Files starting with a dot (`.env.example`, `.gitignore`) are hidden on
Windows/Mac. They are in the folder; that is normal.

## 2. Deploy on Render.com

1. Push this folder to a new GitHub repository (GitHub Desktop is easiest).
2. On https://render.com choose New + > Web Service and connect the repository.
3. Build Command: `npm install`   Start Command: `npm start`
4. Deploy. No environment variables are required.
5. Open the public URL Render gives you (it is also the link for your streaming
   device or browser source), go to the **Live** tab, and paste your Euler
   Stream API key into the key box the first time you connect.

Render's free plan wipes the server's files whenever it restarts or redeploys,
so a key saved on the server can disappear. That is fine: the key is also
remembered in the browser you pasted it in, and fills itself back in.
If you would rather set it once on the server, add `EULERSTREAM_API_KEY` under
Environment in Render and leave the key box empty.

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
.env.example  .gitignore   (optional settings; the key box in the Live tab replaces them)
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
  settings.json            saved Settings-panel values (created automatically)
  secrets.json             your saved Euler Stream key (created automatically, never uploaded)
scripts/
  build-dictionary.js      builds words-full.txt
  build-rounds.js          builds rounds.json
```

Thanks: the bundled list comes from Hunspell's en_US dictionary (SCOWL).
