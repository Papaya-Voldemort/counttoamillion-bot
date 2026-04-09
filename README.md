# counttoamillion-bot

A **pure stats bot** for the `#counttoamillion` Slack channel. Completely invisible during normal counting — no reactions, no replies, nothing. It only responds when you explicitly call it.

> **This bot does not moderate or validate counting.** Count Drakula handles that. This bot tracks who has counted how many times and surfaces leaderboards and stats on demand.

Stats are stored in a **SQLite database** on a persistent Railway Volume — fast indexed queries even with 300k+ messages, and data survives deploys.

---

## Commands

| Command | Visibility | Description |
|---------|-----------|-------------|
| `/ctm leaderboard` | Public | Top 10 counters with % share |
| `/ctm leaderboard [N]` | Public | Top N counters (max 50) |
| `/ctm stats` | Private | Your personal counting stats |
| `/ctm stats @user` | Private | Stats for another user |
| `/ctm progress` | Public | Visual progress bar toward 1,000,000 |
| `/ctm sync` | Private | Full history rebuild from Slack _(runs in background, updates status in-place)_ |
| `/ctm sync incremental` | Private | Only sync new messages since last sync |
| `/ctm help` | Private | List all commands |

You can also `@mention` the bot:

- `@CountBot leaderboard` — leaderboard
- `@CountBot stats` — your stats
- `@CountBot progress` — progress toward the goal
- `@CountBot` (anything else) — shows the help message

---

## How it works

1. **Passive listener** — silently reads every message in `#counttoamillion` and inserts valid count messages into the SQLite DB. No reactions, no replies; the bot is completely invisible.
2. **Commands** — query the DB instantly via indexed SQL. No scanning required at command time.
3. **First-run sync** — on initial deploy, run `/ctm sync` once to backfill the full channel history. This paginates through Slack's API, bulk-inserts all count messages, and posts a live progress update.
4. **Incremental sync** — `/ctm sync incremental` fetches only messages newer than the most recent row in the DB, for fast catch-ups after downtime.

---

## Setup

### 1. Create a Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App → From scratch**.
2. Name it (e.g. *Count Stats*) and choose your workspace.

### 2. Add OAuth scopes

Under **OAuth & Permissions → Bot Token Scopes**, add:

| Scope | Why |
|-------|-----|
| `channels:history` | Read message history for sync and passive listening |
| `chat:write` | Post leaderboards and sync status messages |
| `commands` | Receive slash commands |

### 3. Enable Events

Under **Event Subscriptions**:

1. Toggle **Enable Events** on.
2. Set the **Request URL** to:
   ```
   https://<your-railway-app>.railway.app/slack/events
   ```
   _(You'll get this URL after your first deploy — see the Railway section below.)_
3. Under **Subscribe to Bot Events**, add:
   - `message.channels` — passively track new counts
   - `app_mention` — respond to `@CountBot ...`

### 4. Create the `/ctm` slash command

Under **Slash Commands → Create New Command**:

| Field | Value |
|-------|-------|
| Command | `/ctm` |
| Request URL | `https://<your-railway-app>.railway.app/slack/events` |
| Short Description | `counttoamillion stats` |
| Usage Hint | `leaderboard \| stats [@user] \| progress \| sync [incremental] \| help` |

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
3. Railway detects the `Procfile` and runs `node src/index.js` automatically.

### Environment variables

In your Railway service, go to **Variables** and set:

| Variable | Value |
|----------|-------|
| `SLACK_BOT_TOKEN` | `xoxb-…` from step 5 |
| `SLACK_SIGNING_SECRET` | From **Basic Information → App Credentials** |
| `CHANNEL_ID` | The Slack channel ID _(right-click channel → Copy link → last path segment, e.g. `C08XXXXXXXX`)_ |
| `DB_FILE` | `/data/ctm.db` _(see Volume section below)_ |
| `PORT` | Leave unset — Railway sets this automatically |

### Attach a Volume for persistent storage

The SQLite database must survive deploys. On Railway:

1. Go to your service → **Volumes → Add Volume**.
2. Mount it at `/data`.
3. Set `DB_FILE=/data/ctm.db` in your service Variables.

Without a Volume, the database resets on every deploy and you'd need to re-run `/ctm sync`.

### Get the Railway URL

After the first deploy, Railway shows your URL under **Settings → Domains** (e.g. `https://counttoamillion-bot-production.up.railway.app`).

Go back to your Slack app and update:
- **Event Subscriptions → Request URL** → `https://<your-url>/slack/events`
- **Slash Commands → /ctm → Request URL** → same URL

Slack verifies the endpoint immediately — it passes as soon as the bot is running.

### First-time data import

In `#counttoamillion` (or any channel the bot is in), run:

```
/ctm sync
```

The bot paginates through the full channel history (200 messages per API call), bulk-inserts all valid count messages into SQLite, and updates a status message in place as it goes. For a channel with ~336k messages this takes a few minutes. When complete it posts a summary with total counts, contributors, and the highest number seen.

After that, the passive listener keeps the DB up to date automatically. If the bot was offline for a while, run `/ctm sync incremental` to catch up.

---

## Local development

```bash
# Install dependencies (including native better-sqlite3)
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

Tests use in-memory temporary directories — no cleanup needed.

---

## Project structure

```
src/
  index.js      Main Slack Bolt app — passive listener, commands, sync
  db.js         SQLite layer — schema, queries, bulk insert, meta table
  validator.js  parseCount() — extracts a count number from a message string
__tests__/
  db.test.js        Tests for all db.js functions
  validator.test.js Tests for parseCount()
data/           Created at runtime; gitignored (contains ctm.db)
Procfile        Railway entry point: web: node src/index.js
.env.example    Template for required environment variables
```

### Database schema

```sql
-- Every valid count message, keyed by Slack timestamp (idempotent upserts)
CREATE TABLE counts (
  slack_ts     TEXT PRIMARY KEY,  -- "1712345678.123456"
  user_id      TEXT NOT NULL,     -- "U0123456789"
  count_number INTEGER NOT NULL,  -- 336608
  posted_at    INTEGER NOT NULL   -- Unix seconds (from slack_ts)
);

-- Arbitrary key/value store (last sync time, mode, etc.)
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Indexed on `user_id`, `count_number`, and `posted_at` for fast leaderboard, progress, and incremental-sync queries.
