# Blossom TikTok LIVE Game — Deployment-Ready

This folder is a complete, working game. Push it to GitHub and deploy it
on Render.com.

## 1. Run it on your own computer first (recommended)

1. Install Node.js from https://nodejs.org if you have not already.
2. Open a terminal in this folder.
3. Run: `npm install`
4. Copy `.env.example` to `.env` and, if you want LIVE mode, paste in a
   free API key from https://www.eulerstream.com.
5. Run: `npm start`
6. Open http://localhost:3000 in your browser.

You can fully play the game in **Offline** and **Test** mode without any
API key at all.

## 2. Deploy to Render.com

1. Create a free GitHub account if you don't have one, and push this
   folder to a new GitHub repository (GitHub Desktop is the easiest way
   if you are not comfortable with the command line).
2. Go to https://render.com, sign up, and choose "New +" -> "Web
   Service".
3. Connect your GitHub repository.
4. Settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Under "Environment", add an environment variable named
   `EULERSTREAM_API_KEY` with your key (only needed for Live mode).
6. Click "Create Web Service". Render will give you a public URL — that
   is the link you open on your streaming device/browser source.

## 3. Getting a TikTok LIVE signing key (for Live mode)

1. Go to https://www.eulerstream.com and create a free account.
2. Create an API key.
3. Put it in the `EULERSTREAM_API_KEY` environment variable (locally in
   `.env`, or in Render's Environment settings).

Without this key, Live mode will show a clear on-screen error, but
Offline and Test modes always work.

## 4. How the game works

- 10 rounds are hardcoded in `rounds.js`. Each round has 7 letters, 1
  center letter, and exactly 20 accepted words.
- The audience (or you, in Offline mode) types words in chat. Words must
  be 4+ letters, use only the 7 shown letters, and include the center
  letter.
- Finding all 20 words triggers a celebration and the next round loads
  automatically after a few seconds, looping back to round 1 after the
  10th round.
- Longer words and pangrams (words using all 7 letters) score more
  points. The Top 10 leaderboard tracks total points per viewer.

## 5. If you want to change something later

Use the `2_Source_For_Future_Upgrades` folder instead of this one — it
is split into small, heavily-commented files. Upload the relevant
file(s) back to Claude and describe the change you want.
