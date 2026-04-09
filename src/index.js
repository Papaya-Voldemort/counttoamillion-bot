require('dotenv').config();
const { App } = require('@slack/bolt');
const { parseCount } = require('./validator');
const { loadState, saveState } = require('./state');

// ---------------------------------------------------------------------------
// App initialisation
// ---------------------------------------------------------------------------

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: process.env.SOCKET_MODE === 'true',
  appToken: process.env.SLACK_APP_TOKEN,
  port: parseInt(process.env.PORT || '3000', 10),
});

/** Slack channel ID for #counttoamillion (used when fetching history). */
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!CHANNEL_ID) {
  console.error('CHANNEL_ID environment variable is required.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let state = loadState();

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const GOAL = 1_000_000;
const MEDALS = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:'];

/** Returns userCounts sorted descending by count. */
function getSortedLeaderboard() {
  return Object.entries(state.userCounts)
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Formats the top-N leaderboard as Slack mrkdwn.
 * @param {number} [limit=10]
 */
function formatLeaderboard(limit = 10) {
  const board = getSortedLeaderboard().slice(0, limit);
  if (board.length === 0) {
    return ':warning: No stats recorded yet. Run `/ctm sync` to build stats from channel history.';
  }
  const lines = board.map(({ userId, count }, i) => {
    const prefix = MEDALS[i] || `${i + 1}.`;
    return `${prefix} <@${userId}> — *${count.toLocaleString()}* count${count === 1 ? '' : 's'}`;
  });
  return (
    `*:1234: #counttoamillion Leaderboard* (top ${board.length})\n` +
    `Current count: *${state.currentCount.toLocaleString()}* / ${GOAL.toLocaleString()}\n\n` +
    lines.join('\n')
  );
}

/**
 * Formats stats for a single user as Slack mrkdwn.
 * @param {string} userId  Slack user ID
 */
function formatUserStats(userId) {
  const userCount = state.userCounts[userId] || 0;
  if (userCount === 0) {
    return `<@${userId}> hasn't contributed any counts yet.`;
  }
  const board = getSortedLeaderboard();
  const rank = board.findIndex((e) => e.userId === userId) + 1;
  const total = board.reduce((s, e) => s + e.count, 0);
  const pct = total > 0 ? ((userCount / total) * 100).toFixed(1) : '0.0';
  return (
    `*:bar_chart: Stats for <@${userId}>*\n` +
    `:1234: Counts posted: *${userCount.toLocaleString()}*\n` +
    `:trophy: Rank: *#${rank}* of ${board.length}\n` +
    `:chart_with_upwards_trend: Share of all counts: *${pct}%*`
  );
}

/** Formats overall channel progress as Slack mrkdwn. */
function formatProgress() {
  const current = state.currentCount;
  const remaining = GOAL - current;
  const pct = ((current / GOAL) * 100).toFixed(2);
  const totalContributors = Object.keys(state.userCounts).length;
  const filledBars = Math.round((current / GOAL) * 20);
  const progressBar = '\u2588'.repeat(filledBars) + '\u2591'.repeat(20 - filledBars);

  return (
    `*:rocket: #counttoamillion Progress*\n\n` +
    `\`${progressBar}\` ${pct}%\n\n` +
    `:round_pushpin: Current count: *${current.toLocaleString()}* / ${GOAL.toLocaleString()}\n` +
    `:checkered_flag: Remaining: *${remaining.toLocaleString()}*\n` +
    `:busts_in_silhouette: Contributors: *${totalContributors}*`
  );
}

/** Formats a help message listing available commands. */
function formatHelp() {
  return (
    `*:wave: counttoamillion Stats Bot — Commands*\n\n` +
    `*/ctm leaderboard* — Top 10 counters\n` +
    `*/ctm leaderboard [N]* — Top N counters (e.g. \`/ctm leaderboard 25\`)\n` +
    `*/ctm stats* — Your personal counting stats\n` +
    `*/ctm stats @user* — Stats for another user\n` +
    `*/ctm progress* — Overall channel progress toward 1,000,000\n` +
    `*/ctm sync* — Resync stats from channel history _(admin, runs in background)_\n\n` +
    `You can also mention me: \`@CountBot leaderboard\`, \`@CountBot stats\`, \`@CountBot progress\``
  );
}

// ---------------------------------------------------------------------------
// Channel history sync
// ---------------------------------------------------------------------------

let syncInProgress = false;

/**
 * Fetches all messages from the counting channel and rebuilds userCounts from scratch.
 * Runs in the background — posts a status message when done.
 *
 * @param {object} client           Slack Web API client
 * @param {string} responseChannel  Where to post the completion notice
 */
async function syncHistory(client, responseChannel) {
  if (syncInProgress) {
    await client.chat.postMessage({
      channel: responseChannel,
      text: ':hourglass: A sync is already in progress. Please wait for it to finish.',
    });
    return;
  }

  syncInProgress = true;
  console.log('Starting channel history sync...');

  const freshCounts = {};
  let highestCount = 0;
  let cursor;
  let pagesFetched = 0;
  let messagesParsed = 0;

  try {
    do {
      const result = await client.conversations.history({
        channel: CHANNEL_ID,
        limit: 200,
        cursor,
      });

      for (const msg of result.messages || []) {
        // Skip subtypes (edits, joins), bots, and thread replies
        if (msg.subtype) continue;
        if (msg.bot_id) continue;
        if (msg.thread_ts && msg.thread_ts !== msg.ts) continue;

        const number = parseCount(msg.text);
        if (number !== null && msg.user) {
          freshCounts[msg.user] = (freshCounts[msg.user] || 0) + 1;
          if (number > highestCount) highestCount = number;
          messagesParsed++;
        }
      }

      cursor = result.response_metadata && result.response_metadata.next_cursor;
      pagesFetched++;
    } while (cursor);

    state.userCounts = freshCounts;
    state.currentCount = highestCount;
    saveState(state);

    const userCount = Object.keys(freshCounts).length;
    console.log(`Sync complete: ${messagesParsed} counts across ${userCount} users.`);

    await client.chat.postMessage({
      channel: responseChannel,
      text:
        `:white_check_mark: Sync complete! Processed *${messagesParsed.toLocaleString()}* count messages ` +
        `from *${userCount}* contributors across *${pagesFetched}* pages of history.\n` +
        `Highest count seen: *${highestCount.toLocaleString()}*.`,
    });
  } catch (err) {
    console.error('Sync failed:', err.message);
    await client.chat.postMessage({
      channel: responseChannel,
      text: `:x: Sync failed: ${err.message}`,
    }).catch(() => {});
  } finally {
    syncInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Passive message listener — silently updates stats, no reactions or replies
// ---------------------------------------------------------------------------

app.message(async ({ message }) => {
  // Only track messages from the configured counting channel
  if (message.channel !== CHANNEL_ID) return;

  // Skip subtypes (edits, joins), bots, and thread replies
  if (message.subtype) return;
  if (message.bot_id) return;
  if (message.thread_ts && message.thread_ts !== message.ts) return;
  if (!message.text || !message.user) return;

  const number = parseCount(message.text);
  if (number === null) return;

  // Silently update stats — no reactions, no replies, completely invisible
  state.userCounts[message.user] = (state.userCounts[message.user] || 0) + 1;
  if (number > state.currentCount) state.currentCount = number;
  saveState(state);
});

// ---------------------------------------------------------------------------
// Slash command: /ctm — dispatches sub-commands
// ---------------------------------------------------------------------------

app.command('/ctm', async ({ command, ack, respond, client }) => {
  await ack();

  const parts = (command.text || '').trim().split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();

  switch (sub) {
    case 'leaderboard': {
      const limit = parseInt(parts[1], 10);
      const safeLimit = Number.isNaN(limit) || limit < 1 ? 10 : Math.min(limit, 50);
      await respond({ response_type: 'in_channel', text: formatLeaderboard(safeLimit) });
      break;
    }

    case 'stats': {
      // Resolve a user mention like <@U1234|name> → U1234, or fall back to caller
      let targetUserId = command.user_id;
      if (parts[1]) {
        const mentionMatch = parts[1].match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/i);
        targetUserId = mentionMatch ? mentionMatch[1] : command.user_id;
      }
      await respond({ response_type: 'ephemeral', text: formatUserStats(targetUserId) });
      break;
    }

    case 'progress': {
      await respond({ response_type: 'in_channel', text: formatProgress() });
      break;
    }

    case 'sync': {
      await respond({
        response_type: 'ephemeral',
        text: ":arrows_counterclockwise: Starting a full history sync in the background. This may take a while for large channels. I'll post a message here when it's done.",
      });
      // Fire-and-forget — runs in background
      syncHistory(client, command.channel_id).catch((err) =>
        console.error('Sync error:', err.message)
      );
      break;
    }

    case 'help':
    default: {
      await respond({ response_type: 'ephemeral', text: formatHelp() });
      break;
    }
  }
});

// ---------------------------------------------------------------------------
// App mention handler
// ---------------------------------------------------------------------------

app.event('app_mention', async ({ event, client }) => {
  const text = (event.text || '').toLowerCase();

  let reply;
  if (text.includes('leaderboard')) {
    reply = formatLeaderboard();
  } else if (text.includes('progress')) {
    reply = formatProgress();
  } else if (text.includes('stats')) {
    reply = formatUserStats(event.user);
  } else {
    reply = formatHelp();
  }

  await client.chat.postMessage({
    channel: event.channel,
    thread_ts: event.ts,
    text: reply,
  }).catch((err) => console.error('mention reply error:', err.message));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async () => {
  await app.start();
  console.log(`⚡️ counttoamillion stats bot is running (port ${process.env.PORT || 3000})`);
  console.log(`   Channel: ${CHANNEL_ID}`);
  console.log(`   Stored contributors: ${Object.keys(state.userCounts).length}`);
  console.log(`   Current count: ${state.currentCount}`);
})();
