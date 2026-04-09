# counttoamillion-bot

A **pure stats bot** for the `#counttoamillion` Slack channel. It is completely invisible during normal counting — no reactions, no replies, nothing. It only responds when you explicitly call it with a slash command or `@mention`.

> **This bot does not moderate or validate counting.** Count Drakula handles that. This bot just tracks who has counted how many times and surfaces leaderboards and stats on demand.

---

## Commands

| Command | Visibility | Description |
|---------|-----------|-------------|
| `/ctm leaderboard` | Public | Top 10 counters |
| `/ctm leaderboard 25` | Public | Top N counters (max 50) |
| `/ctm stats` | Private | Your personal counting stats |
| `/ctm stats @user` | Private | Stats for another user |
| `/ctm progress` | Public | Visual progress bar toward 1,000,000 |
| `/ctm sync` | Private | Rebuild stats from full channel history |
| `/ctm help` | Private | List all commands |

You can also `@mention` the bot:

- `@CountBot leaderboard` — leaderboard
- `@CountBot stats` — your stats
- `@CountBot progress` — progress toward the goal
- `@CountBot` (anything else) — shows the help message

---

## How it works

The bot silently listens to `#counttoamillion` in the background to keep its stats current as counting happens — but it **never** reacts to messages or posts anything unless a command is called.

On first deploy (or after a wipe), run `/ctm sync` once to build stats from the full channel history. After that, the bot keeps itself up to date automatically.

Stats are stored in `data/state.json` and persisted across restarts.

---

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**.
2. Name it (e.g. *Count Stats*) and choose your workspace.

### 2. Add OAuth scopes

Under **OAuth & Permissions → Bot Token Scopes**, add:

| Scope | Why |
|-------|-----|
| `channels:history` | Read message history for `/ctm sync` and passive listening |
| `chat:write` | Post leaderboards and sync results |
| `commands` | Receive slash commands |

### 3. Enable Events

Under **Event Subscriptions**:

1. Toggle **Enable Events** on.
2. Set the **Request URL** to:
   ```
   https://<your-railway-app>.railway.app/slack/events
   ```
   (Railway gives you this URL after your first deploy — see step 7 below.)
3. Under **Subscribe to Bot Events**, add:
   - `message.channels` — so the bot can passively track new counts
   - `app_mention` — so `@CountBot ...` works

### 4. Create the `/ctm` slash command

Under **Slash Commands** → **Create New Command**:

| Field | Value |
|-------|-------|
| Command | `/ctm` |
| Request URL | `https://<your-railway-app>.railway.app/slack/events` |
| Short Description | `counttoamillion stats` |
| Usage Hint | `leaderboard \| stats [@user] \| progress \| sync \| help` |

### 5. Install the app

**Install App → Install to Workspace**. Copy the **Bot User OAuth Token** (starts with `xoxb-`).

Also note the **Signing Secret** from **Basic Information → App Credentials**.

### 6. Invite the bot to the channel

In Slack, open `#counttoamillion` and run:
```
/invite @CountBot
```

---

## Deploy to Railway

### One-click deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app)

1. Push this repository to GitHub.
2. In [Railway](https://railway.app), click **New Project → Deploy from GitHub repo** and select this repo.
3. Railway will detect the `Procfile` and start `node src/index.js` automatically.

### Environment variables

In your Railway project, go to **Variables** and add:

| Variable | Value |
|----------|-------|
| `SLACK_BOT_TOKEN` | `xoxb-…` from step 5 |
| `SLACK_SIGNING_SECRET` | From **Basic Information → App Credentials** |
| `CHANNEL_ID` | The Slack channel ID for `#counttoamillion` *(right-click channel → Copy link → last path segment, e.g. `C08XXXXXXXX`)* |
| `PORT` | Leave unset — Railway sets this automatically |

### Persist stats across deploys (recommended)

By default, `data/state.json` is written to the container filesystem and lost on each redeploy. To persist it:

1. In Railway, go to your service → **Volumes → Add Volume**.
2. Mount it at `/data`.
3. Add the environment variable: `STATE_FILE=/data/state.json`.

### Get the Railway URL

After the first deploy, Railway shows your app URL under **Settings → Domains** (e.g. `https://counttoamillion-bot-production.up.railway.app`).

Go back to your Slack app and update:
- **Event Subscriptions → Request URL** → `https://<your-url>/slack/events`
- **Slash Commands → /ctm → Request URL** → same URL

Slack will verify the endpoint — if the bot is running, it passes immediately.

---

## Local development

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env

# Run with auto-reload
npm run dev
```

### Run tests

```bash
npm test
```

### First-time stats build

Once the bot is running and connected to Slack, go to `#counttoamillion` and run:

```
/ctm sync
```

This fetches the entire channel history and builds stats for every user. For a channel with hundreds of thousands of messages this will take a few minutes — the bot will post a message when it finishes.

---

## Project structure

```
src/
  index.js      Main Slack Bolt app — commands, passive listener, history sync
  validator.js  parseCount(): extracts a count number from a message string
  state.js      loadState() / saveState() — JSON file persistence
__tests__/
  validator.test.js
  state.test.js
data/           Created at runtime; gitignored (contains state.json)
Procfile        Railway entry point: web: node src/index.js
.env.example    Template for required environment variables
```
