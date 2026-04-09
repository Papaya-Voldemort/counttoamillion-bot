require('dotenv').config();
const { App } = require('@slack/bolt');
const { parseCount, validateCount } = require('./validator');
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

/** The Slack channel ID the bot moderates (required). */
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!CHANNEL_ID) {
  console.error('CHANNEL_ID environment variable is required.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// In-memory state (persisted to disk after each change)
// ---------------------------------------------------------------------------

let state = loadState();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a sorted leaderboard array from userCounts.
 * @returns {{ userId: string, count: number }[]}
 */
function getLeaderboard() {
  return Object.entries(state.userCounts)
    .map(([userId, count]) => ({ userId, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Builds a leaderboard message string (Slack mrkdwn).
 * @param {number} [limit=10]
 * @returns {string}
 */
function formatLeaderboard(limit = 10) {
  const board = getLeaderboard().slice(0, limit);
  if (board.length === 0) {
    return 'No counts recorded yet!';
  }
  const medals = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:'];
  const lines = board.map(({ userId, count }, i) => {
    const prefix = medals[i] || `${i + 1}.`;
    return `${prefix} <@${userId}> — ${count.toLocaleString()} count${count === 1 ? '' : 's'}`;
  });
  return (
    `*:1234: #counttoamillion Leaderboard* (top ${board.length})\n` +
    `Current count: *${state.currentCount.toLocaleString()}* / 1,000,000\n\n` +
    lines.join('\n')
  );
}

// ---------------------------------------------------------------------------
// Message event: validate counts
// ---------------------------------------------------------------------------

app.message(async ({ message, client }) => {
  // Only process messages from the configured counting channel
  if (message.channel !== CHANNEL_ID) return;

  // Ignore edits, deletions, bot messages, and thread replies
  if (message.subtype) return;
  if (message.thread_ts && message.thread_ts !== message.ts) return;
  if (!message.text) return;

  const number = parseCount(message.text);
  if (number === null) return; // Not a count message, ignore

  const expectedCount = state.currentCount + 1;
  const validation = validateCount(number, expectedCount, message.user, state.lastCounterUserId);

  if (validation.valid) {
    // --- Valid count ---
    state.currentCount = number;
    state.lastCounterUserId = message.user;
    state.userCounts[message.user] = (state.userCounts[message.user] || 0) + 1;
    saveState(state);

    await client.reactions.add({
      channel: message.channel,
      timestamp: message.ts,
      name: 'white_check_mark',
    }).catch((err) => console.error('react error:', err.message));

    // Celebrate milestones (every 1000)
    if (number % 1000 === 0) {
      await client.chat.postMessage({
        channel: message.channel,
        text: `:tada: Congratulations! We've reached *${number.toLocaleString()}*! :tada:\nOnly *${(1_000_000 - number).toLocaleString()}* to go!`,
      }).catch((err) => console.error('milestone error:', err.message));
    }
  } else {
    // --- Invalid count ---
    await client.reactions.add({
      channel: message.channel,
      timestamp: message.ts,
      name: 'bangbang',
    }).catch((err) => console.error('react error:', err.message));

    let errorText;
    if (validation.error === 'consecutive') {
      errorText = "You can't count twice in a row, minion.";
    } else {
      errorText = `That's the wrong number, minion, it should be ${validation.expected}.`;
    }

    await client.chat.postEphemeral({
      channel: message.channel,
      user: message.user,
      text: errorText,
    }).catch((err) => console.error('ephemeral error:', err.message));
  }
});

// ---------------------------------------------------------------------------
// Slash command: /count — show current count and leaderboard
// ---------------------------------------------------------------------------

app.command('/count', async ({ command, ack, respond }) => {
  await ack();
  await respond({
    response_type: 'in_channel',
    text: formatLeaderboard(),
  });
});

// ---------------------------------------------------------------------------
// App mention: show current count
// ---------------------------------------------------------------------------

app.event('app_mention', async ({ event, client }) => {
  const text = event.text || '';

  if (text.toLowerCase().includes('leaderboard') || text.toLowerCase().includes('stats')) {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: formatLeaderboard(),
    }).catch((err) => console.error('mention reply error:', err.message));
  } else {
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: `The current count is *${state.currentCount.toLocaleString()}*. Only *${(1_000_000 - state.currentCount).toLocaleString()}* left to reach 1,000,000! Mention me with "leaderboard" to see the top counters.`,
    }).catch((err) => console.error('mention reply error:', err.message));
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async () => {
  await app.start();
  console.log(`⚡️ counttoamillion bot is running (port ${process.env.PORT || 3000})`);
  console.log(`   Monitoring channel: ${CHANNEL_ID}`);
  console.log(`   Current count: ${state.currentCount}`);
})();
