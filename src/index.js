require('dotenv').config();
const { App } = require('@slack/bolt');
const { parseCount } = require('./validator');
const {
  openDb,
  upsertCount,
  bulkUpsertCounts,
  clearAll,
  getLeaderboard,
  getUserStats,
  getProgress,
  getLatestTs,
  getMeta,
  setMeta,
} = require('./db');

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

const CHANNEL_ID = process.env.CHANNEL_ID;
if (!CHANNEL_ID) {
  console.error('CHANNEL_ID environment variable is required.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const db = openDb();

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const GOAL = 1_000_000;
const MEDALS = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:'];

/** Returns the current time as Unix seconds. */
function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

/** Formats a Unix timestamp as a short date string. */
function fmtDate(unixSec) {
  return new Date(unixSec * 1000).toLocaleDateString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric',
  });
}

/**
 * Builds a mrkdwn leaderboard string.
 * @param {number} [limit=10]
 */
function formatLeaderboard(limit = 10) {
  const board = getLeaderboard(db, limit);
  if (board.length === 0) {
    return ':warning: No stats recorded yet. Run `/ctm sync` to build stats from channel history.';
  }

  const { highestCount, totalCounts } = getProgress(db);
  const lastSync = getMeta(db, 'last_sync_at');
  const syncNote = lastSync ? `_Last synced: ${lastSync}_` : '_Run `/ctm sync` to backfill history_';

  const lines = board.map(({ userId, count }, i) => {
    const prefix = MEDALS[i] || `${i + 1}.`;
    const pct = totalCounts > 0 ? ((count / totalCounts) * 100).toFixed(1) : '0.0';
    return `${prefix} <@${userId}> — *${count.toLocaleString()}* counts (${pct}%)`;
  });

  return [
    `*:1234: #counttoamillion Leaderboard* (top ${board.length})`,
    `Progress: *${highestCount.toLocaleString()}* / ${GOAL.toLocaleString()} — ${totalCounts.toLocaleString()} total counts recorded`,
    '',
    lines.join('\n'),
    '',
    syncNote,
  ].join('\n');
}

/**
 * Builds a mrkdwn stats string for one user.
 * @param {string} userId
 */
function formatUserStats(userId) {
  const stats = getUserStats(db, userId);
  if (!stats) {
    return `<@${userId}> hasn't contributed any counts yet.`;
  }

  const { userCount, rank, totalCount, totalContributors } = stats;
  const pct = totalCount > 0 ? ((userCount / totalCount) * 100).toFixed(1) : '0.0';

  return [
    `*:bar_chart: Stats for <@${userId}>*`,
    `:1234: Counts posted: *${userCount.toLocaleString()}*`,
    `:trophy: Rank: *#${rank}* of ${totalContributors.toLocaleString()} contributors`,
    `:chart_with_upwards_trend: Share of all counts: *${pct}%*`,
  ].join('\n');
}

/** Builds a mrkdwn progress string. */
function formatProgress() {
  const { highestCount, totalCounts, totalContributors } = getProgress(db);
  const remaining = GOAL - highestCount;
  const pct = ((highestCount / GOAL) * 100).toFixed(2);
  const filledBars = Math.min(20, Math.round((highestCount / GOAL) * 20));
  const bar = '\u2588'.repeat(filledBars) + '\u2591'.repeat(20 - filledBars);

  return [
    '*:rocket: #counttoamillion Progress*',
    '',
    `\`${bar}\` ${pct}%`,
    '',
    `:round_pushpin: Current count: *${highestCount.toLocaleString()}* / ${GOAL.toLocaleString()}`,
    `:checkered_flag: Remaining: *${remaining.toLocaleString()}*`,
    `:memo: Total count messages: *${totalCounts.toLocaleString()}*`,
    `:busts_in_silhouette: Contributors: *${totalContributors.toLocaleString()}*`,
  ].join('\n');
}

/** Builds a mrkdwn help string. */
function formatHelp() {
  return [
    '*:wave: counttoamillion Stats Bot — Commands*',
    '',
    '*/ctm leaderboard* — Top 10 counters (public)',
    '*/ctm leaderboard [N]* — Top N counters, e.g. `/ctm leaderboard 25` (max 50)',
    '*/ctm stats* — Your personal counting stats (private)',
    '*/ctm stats @user* — Stats for another user (private)',
    '*/ctm progress* — Visual progress bar toward 1,000,000 (public)',
    '*/ctm sync* — Full history sync from Slack _(runs in background)_',
    '*/ctm sync incremental* — Sync only new messages since last sync',
    '*/ctm help* — This message',
    '',
    'You can also `@mention` me: `leaderboard`, `stats`, or `progress`',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// History sync
// ---------------------------------------------------------------------------

let syncInProgress = false;

/**
 * Fetches messages from the counting channel and inserts them into SQLite.
 *
 * When `incremental` is true, only messages newer than the latest DB entry
 * are fetched — much faster for routine catch-ups.
 *
 * @param {object}  client
 * @param {string}  responseChannel
 * @param {boolean} [incremental=false]
 */
async function syncHistory(client, responseChannel, incremental = false) {
  if (syncInProgress) {
    await client.chat.postMessage({
      channel: responseChannel,
      text: ':hourglass: A sync is already running. Please wait.',
    });
    return;
  }

  syncInProgress = true;

  const mode = incremental ? 'incremental' : 'full';
  const latestTs = incremental ? getLatestTs(db) : null;
  console.log(`Starting ${mode} history sync (since ts: ${latestTs || 'beginning'})…`);

  const batch = [];
  let cursor;
  let pagesFetched = 0;
  let messagesParsed = 0;
  let highestNewCount = 0;

  try {
    if (!incremental) {
      clearAll(db);
    }

    // Status message — update in place
    const statusMsg = await client.chat.postMessage({
      channel: responseChannel,
      text: `:arrows_counterclockwise: ${incremental ? 'Incremental' : 'Full'} sync started…`,
    });

    const FLUSH_BATCH = 1000; // insert every N messages
    const editStatus = async (text) => {
      await client.chat.update({
        channel: responseChannel,
        ts: statusMsg.ts,
        text,
      }).catch(() => {});
    };

    do {
      const params = { channel: CHANNEL_ID, limit: 200, cursor };
      if (latestTs) params.oldest = latestTs;

      const result = await client.conversations.history(params);

      for (const msg of result.messages || []) {
        if (msg.subtype) continue;
        if (msg.bot_id) continue;
        if (msg.thread_ts && msg.thread_ts !== msg.ts) continue;

        const number = parseCount(msg.text);
        if (number !== null && msg.user) {
          batch.push({ slackTs: msg.ts, userId: msg.user, number });
          if (number > highestNewCount) highestNewCount = number;
          messagesParsed++;
        }
      }

      // Flush to DB in batches to keep memory low
      if (batch.length >= FLUSH_BATCH) {
        bulkUpsertCounts(db, batch);
        batch.length = 0;
      }

      cursor = result.response_metadata && result.response_metadata.next_cursor;
      pagesFetched++;

      // Update status every 10 pages (~2000 messages)
      if (pagesFetched % 10 === 0) {
        await editStatus(
          `:arrows_counterclockwise: Sync in progress… ${messagesParsed.toLocaleString()} count messages processed (${pagesFetched} pages fetched)`
        );
      }
    } while (cursor);

    // Flush remaining rows
    if (batch.length > 0) {
      bulkUpsertCounts(db, batch);
    }

    const syncAt = fmtDate(nowUnix());
    setMeta(db, 'last_sync_at', syncAt);
    setMeta(db, 'last_sync_mode', mode);

    const { totalCounts, totalContributors, highestCount } = getProgress(db);
    console.log(`Sync complete: ${messagesParsed} new count messages across ${pagesFetched} pages.`);

    await editStatus(
      [
        `:white_check_mark: *${incremental ? 'Incremental' : 'Full'} sync complete!*`,
        `:inbox_tray: New count messages processed: *${messagesParsed.toLocaleString()}*`,
        `:1234: Total in DB: *${totalCounts.toLocaleString()}* from *${totalContributors.toLocaleString()}* contributors`,
        `:round_pushpin: Highest count seen: *${highestCount.toLocaleString()}*`,
        `:calendar: Synced at: ${syncAt}`,
      ].join('\n')
    );
  } catch (err) {
    console.error('Sync failed:', err.message);
    try {
      await client.chat.postMessage({
        channel: responseChannel,
        text: `:x: Sync failed: ${err.message}`,
      });
    } catch (_) {}
  } finally {
    syncInProgress = false;
  }
}

// ---------------------------------------------------------------------------
// Passive message listener — completely silent, just writes to DB
// ---------------------------------------------------------------------------

app.message(async ({ message }) => {
  if (message.channel !== CHANNEL_ID) return;
  if (message.subtype) return;
  if (message.bot_id) return;
  if (message.thread_ts && message.thread_ts !== message.ts) return;
  if (!message.text || !message.user) return;

  const number = parseCount(message.text);
  if (number === null) return;

  upsertCount(db, message.ts, message.user, number);
});

// ---------------------------------------------------------------------------
// Slash command: /ctm
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
      let targetUserId = command.user_id;
      if (parts[1]) {
        const m = parts[1].match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/i);
        targetUserId = m ? m[1] : command.user_id;
      }
      await respond({ response_type: 'ephemeral', text: formatUserStats(targetUserId) });
      break;
    }

    case 'progress': {
      await respond({ response_type: 'in_channel', text: formatProgress() });
      break;
    }

    case 'sync': {
      const incremental = (parts[1] || '').toLowerCase() === 'incremental';
      await respond({
        response_type: 'ephemeral',
        text: incremental
          ? ':arrows_counterclockwise: Starting an incremental sync (new messages only)…'
          : ':arrows_counterclockwise: Starting a full history sync — this may take a few minutes for large channels…',
      });
      syncHistory(client, command.channel_id, incremental).catch((err) =>
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
  const { totalCounts, totalContributors, highestCount } = getProgress(db);
  console.log(`⚡️ counttoamillion stats bot running (port ${process.env.PORT || 3000})`);
  console.log(`   Channel:      ${CHANNEL_ID}`);
  console.log(`   DB:           ${process.env.DB_FILE || 'data/ctm.db'}`);
  console.log(`   Contributors: ${totalContributors}`);
  console.log(`   Total counts: ${totalCounts}`);
  console.log(`   Highest #:    ${highestCount}`);
})();
