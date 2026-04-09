# counttoamillion-bot

A Slack bot for the **#counttoamillion** channel. It validates every counting message, reacts with ✅ for correct counts and ‼️ for rule violations, sends ephemeral error messages explaining what went wrong, tracks per-user count totals, and celebrates milestones.

## Rules enforced

| Rule | Behaviour |
|------|-----------|
| Numbers must be sequential (count by 1) | ‼️ + ephemeral "That's the wrong number, minion, it should be N." |
| No user may count twice in a row | ‼️ + ephemeral "You can't count twice in a row, minion." |
| Non-number messages are silently ignored | No reaction |

Valid count formats (per channel rules):

```
336017
336017 some chat
336017 - some chat
336017
some chat on a new line
```

## Commands

| Trigger | Response |
|---------|----------|
| `/count` | Posts the current count and leaderboard (top 10 counters) |
| `@BotName` | Replies with the current count |
| `@BotName leaderboard` | Replies with the leaderboard |
| `@BotName stats` | Alias for leaderboard |

## Setup

### 1. Create a Slack App

1. Go to <https://api.slack.com/apps> and click **Create New App → From scratch**.
2. Give it a name (e.g. *Count Bot*) and pick your workspace.

### 2. Configure OAuth scopes

Under **OAuth & Permissions → Bot Token Scopes**, add:

- `channels:history`
- `chat:write`
- `reactions:write`
- `commands`

### 3. Enable Events

Under **Event Subscriptions**, enable events and add the **Request URL**:

```
https://<your-railway-app>.railway.app/slack/events
```

Subscribe to the following **Bot Events**:

- `message.channels`
- `app_mention`

### 4. Create the `/count` slash command

Under **Slash Commands**, create `/count` pointing to:

```
https://<your-railway-app>.railway.app/slack/events
```

### 5. Install the app

Go to **Install App** and install it into your workspace. Copy the **Bot User OAuth Token** (starts with `xoxb-`).

### 6. Configure environment variables

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-…`) |
| `SLACK_SIGNING_SECRET` | Found under **Basic Information → App Credentials** |
| `CHANNEL_ID` | Slack channel ID for `#counttoamillion` (right-click channel → Copy link, last path segment) |
| `PORT` | HTTP port (Railway sets this automatically) |
| `INITIAL_COUNT` | Seed the bot with the current count if recovering (default `0`) |

### 7. Deploy to Railway

1. Push this repository to GitHub.
2. In [Railway](https://railway.app), create a new project → **Deploy from GitHub repo**.
3. Add the environment variables from your `.env`.
4. Add a **Railway Volume** mounted at `/app/data` so state survives deploys (optional but recommended).  Set `STATE_FILE=/app/data/state.json` in your environment.
5. Railway will detect the `Procfile` and run `node src/index.js`.

### Local development

```bash
npm install
cp .env.example .env   # fill in real values
npm run dev            # uses node --watch for auto-reload
```

Run the tests:

```bash
npm test
```

## Architecture

```
src/
  index.js      – Slack Bolt app: event listeners, command handlers, milestone posts
  validator.js  – Pure functions: parseCount() and validateCount()
  state.js      – Load/save JSON state (currentCount, lastCounterUserId, userCounts)
__tests__/
  validator.test.js
  state.test.js
data/           – Created at runtime; gitignored (contains state.json)
```

State is persisted to `data/state.json` after every valid count so the bot survives restarts without losing progress.