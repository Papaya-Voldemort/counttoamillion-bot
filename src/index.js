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
  getLastChannelTs,
  setLastChannelTs,
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

// CHANNEL_ID and the database are resolved after the HTTP server starts so
// that Slack's URL-verification challenge can succeed even when env vars are
// still being configured on the first deploy.
let CHANNEL_ID;
let db;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GOAL = 1_000_000;
const MEDALS = [':first_place_medal:', ':second_place_medal:', ':third_place_medal:'];

/**
 * Maximum pages fetched during a *silent* auto-sync triggered by a leaderboard
 * or stats command.  Each page holds up to 999 messages (Slack's API max).
 * If the DB is more than this many pages behind, we stop and tell the user to
 * run /ctm sync manually.
 */
const MAX_AUTO_SYNC_PAGES = 10; // ~10 000 messages

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

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
 * @param {number}  [limit=10]
 * @param {boolean} [staleWarning=false]  Show a warning that data may be partial
 */
function formatLeaderboard(limit = 10, staleWarning = false) {
  const board = getLeaderboard(db, limit);
  if (board.length === 0) {
    return ':warning: No stats recorded yet. Run `/ctm sync` to build stats from channel history.';
  }

  const { highestCount, totalCounts } = getProgress(db);
  const lastSync = getMeta(db, 'last_sync_at');
  const syncNote = lastSync ? `_Last synced: ${lastSync}_` : '_Run `/ctm sync` to backfill full history_';

  const lines = board.map(({ userId, count }, i) => {
    const prefix = MEDALS[i] || `${i + 1}.`;
    const pct = totalCounts > 0 ? ((count / totalCounts) * 100).toFixed(1) : '0.0';
    return `${prefix} <@${userId}> — *${count.toLocaleString()}* counts (${pct}%)`;
  });

  const parts = [
    `*:1234: #counttoamillion Leaderboard* (top ${board.length})`,
    `Progress: *${highestCount.toLocaleString()}* / ${GOAL.toLocaleString()} — ${totalCounts.toLocaleString()} total counts recorded`,
    '',
    lines.join('\n'),
    '',
    syncNote,
  ];

  if (staleWarning) {
    parts.push(':warning: _The DB is far behind. Run `/ctm sync` for a full catch-up._');
  }

  return parts.join('\n');
}

/**
 * Builds a mrkdwn stats string for one user.
 * @param {string}  userId
 * @param {boolean} [staleWarning=false]
 */
function formatUserStats(userId, staleWarning = false) {
  const stats = getUserStats(db, userId);
  if (!stats) {
    return `<@${userId}> hasn't contributed any counts yet.`;
  }

  const { userCount, rank, totalCount, totalContributors } = stats;
  const pct = totalCount > 0 ? ((userCount / totalCount) * 100).toFixed(1) : '0.0';

  const lines = [
    `*:bar_chart: Stats for <@${userId}>*`,
    `:1234: Counts posted: *${userCount.toLocaleString()}*`,
    `:trophy: Rank: *#${rank}* of ${totalContributors.toLocaleString()} contributors`,
    `:chart_with_upwards_trend: Share of all counts: *${pct}%*`,
  ];

  if (staleWarning) {
    lines.push(':warning: _The DB is far behind. Run `/ctm sync` for a full catch-up._');
  }

  return lines.join('\n');
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
    '*/ctm sync* — Catch up on missed messages (full rebuild if DB is empty)',
    '*/ctm sync full* — Force a full rebuild from scratch _(use to fix corrupt data)_',
    '*/ctm help* — This message',
    '',
    '_Leaderboard and stats auto-sync from the channel before responding._',
    '',
    'You can also `@mention` me: `leaderboard`, `stats`, or `progress`',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Sync engine
// ---------------------------------------------------------------------------

let syncInProgress = false;

/**
 * Core sync function.  Fetches messages from the counting channel and inserts
 * them into SQLite.
 *
 * @param {object}  client
 * @param {object}  opts
 * @param {'full'|'incremental'} opts.mode
 *   'full'        - clears the DB then fetches all history from scratch
 *   'incremental' - fetches only messages newer than the latest row in the DB
 * @param {string|null} opts.statusChannel
 *   Slack channel to post live progress updates.  Null = silent (auto-sync).
 * @param {number} [opts.pageLimit=Infinity]
 *   Stop after this many pages (used for capped auto-syncs).
 * @returns {Promise<{ messagesParsed: number, pagesFetched: number, capped: boolean }>}
 */
async function runSync(client, { mode = 'incremental', statusChannel = null, pageLimit = Infinity } = {}) {
  if (syncInProgress) {
    if (statusChannel) {
      await client.chat.postMessage({
        channel: statusChannel,
        text: ':hourglass: A sync is already running. Please wait for it to finish.',
      });
    }
    return { messagesParsed: 0, pagesFetched: 0, capped: false, skipped: true };
  }

  syncInProgress = true;

  const since = mode === 'incremental' ? getLatestTs(db) : null;
  console.log(`Sync start (${mode}, since: ${since || 'beginning'}, limit: ${pageLimit})`);

  const batch = [];
  let cursor;
  let pagesFetched = 0;
  let messagesParsed = 0;
  let capped = false;

  // Inline helper that edits the status message (no-op when statusChannel is null)
  let statusTs = null;
  const editStatus = async (text) => {
    if (!statusChannel) return;
    if (!statusTs) return;
    await client.chat.update({ channel: statusChannel, ts: statusTs, text }).catch(() => {});
  };

  try {
    if (mode === 'full') {
      clearAll(db);
    }

    if (statusChannel) {
      const posted = await client.chat.postMessage({
        channel: statusChannel,
        text: `:arrows_counterclockwise: *${mode === 'full' ? 'Full' : 'Incremental'} sync started…* fetching history`,
      });
      statusTs = posted.ts;
    }

    do {
      const params = { channel: CHANNEL_ID, limit: 999, cursor };
      if (since) params.oldest = since;

      const result = await client.conversations.history(params);

      for (const msg of result.messages || []) {
        if (msg.subtype) continue;
        if (msg.bot_id) continue;
        if (msg.thread_ts && msg.thread_ts !== msg.ts) continue;

        const number = parseCount(msg.text);
        if (number !== null && msg.user) {
          batch.push({ slackTs: msg.ts, userId: msg.user, number });
          messagesParsed++;
        }
      }

      // Flush to DB every 1000 rows to keep memory flat
      if (batch.length >= 1000) {
        bulkUpsertCounts(db, batch);
        batch.length = 0;
      }

      cursor = result.response_metadata && result.response_metadata.next_cursor;
      pagesFetched++;

      // Post live progress every 5 pages (~5,000 messages)
      if (statusChannel && pagesFetched % 5 === 0) {
        await editStatus(
          `:arrows_counterclockwise: Sync in progress… *${messagesParsed.toLocaleString()}* counts processed (${pagesFetched} pages)`
        );
      }

      // Cap auto-syncs so they don't block indefinitely
      if (pagesFetched >= pageLimit && cursor) {
        capped = true;
        cursor = null;
        break;
      }
    } while (cursor);

    // Final flush
    if (batch.length > 0) {
      bulkUpsertCounts(db, batch);
    }

    const syncAt = fmtDate(nowUnix());
    if (!capped) {
      setMeta(db, 'last_sync_at', syncAt);
      setMeta(db, 'last_sync_mode', mode);
    }

    const { totalCounts, totalContributors, highestCount } = getProgress(db);
    console.log(`Sync done: ${messagesParsed} new counts, ${pagesFetched} pages, capped=${capped}`);

    if (statusChannel) {
      await editStatus(
        [
          `:white_check_mark: *${mode === 'full' ? 'Full' : 'Incremental'} sync complete!*`,
          `:inbox_tray: New count messages: *${messagesParsed.toLocaleString()}*`,
          `:1234: Total in DB: *${totalCounts.toLocaleString()}* from *${totalContributors.toLocaleString()}* contributors`,
          `:round_pushpin: Highest count: *${highestCount.toLocaleString()}*`,
          `:calendar: ${syncAt}`,
        ].join('\n')
      );
    }
  } catch (err) {
    console.error('Sync failed:', err.message);
    if (statusChannel) {
      await client.chat.postMessage({
        channel: statusChannel,
        text: `:x: Sync failed: ${err.message}`,
      }).catch(() => {});
    }
  } finally {
    syncInProgress = false;
  }

  return { messagesParsed, pagesFetched, capped };
}

// ---------------------------------------------------------------------------
// Auto-sync (called before leaderboard / stats)
// ---------------------------------------------------------------------------

/**
 * Checks whether the local DB is stale relative to the Slack channel and runs
 * a silent incremental sync if needed.
 *
 * Staleness is determined by comparing the latest message ts in the channel
 * (fetched with a single API call) against the last ts recorded by the passive
 * listener (`last_channel_ts` in the meta table).
 *
 * Returns an object indicating whether a sync ran and whether it was capped.
 *
 * @param {object} client  Slack Web API client
 * @returns {Promise<{ synced: boolean, capped: boolean }>}
 */
async function ensureFresh(client) {
  if (!CHANNEL_ID || !db) return { synced: false, capped: false };
  if (syncInProgress) return { synced: false, capped: false };

  // Fast check: fetch the single latest message in the channel
  let latestChannelTs;
  try {
    const result = await client.conversations.history({ channel: CHANNEL_ID, limit: 1 });
    const msgs = result.messages || [];
    if (!msgs.length) return { synced: false, capped: false };
    latestChannelTs = msgs[0].ts;
  } catch (err) {
    console.warn('ensureFresh: could not read channel:', err.message);
    return { synced: false, capped: false };
  }

  // Compare against the most recent ts the passive listener has seen
  // (falls back to latest count ts in case last_channel_ts was never set)
  const lastSeenTs = getLastChannelTs(db) || getLatestTs(db);

  if (!lastSeenTs) {
    // DB is completely empty — auto-sync would be a full history fetch, which
    // could take many minutes. Let the user trigger that explicitly with /ctm sync.
    return { synced: false, capped: false };
  }

  if (parseFloat(latestChannelTs) <= parseFloat(lastSeenTs)) {
    // Already up to date
    return { synced: false, capped: false };
  }

  // New messages exist — run a capped silent incremental sync
  console.log(`Auto-sync: channel ahead of DB (channel=${latestChannelTs}, db=${lastSeenTs})`);
  const { capped } = await runSync(client, {
    mode: 'incremental',
    statusChannel: null,
    pageLimit: MAX_AUTO_SYNC_PAGES,
  });

  if (capped) {
    console.warn(`Auto-sync capped at ${MAX_AUTO_SYNC_PAGES} pages — user should run /ctm sync`);
  }

  return { synced: true, capped };
}

// ---------------------------------------------------------------------------
// Passive message listener — completely silent, just writes to DB
// ---------------------------------------------------------------------------

app.message(async ({ message }) => {
  if (!CHANNEL_ID || !db) return;
  if (message.channel !== CHANNEL_ID) return;
  if (message.subtype) return;
  if (message.bot_id) return;
  if (message.thread_ts && message.thread_ts !== message.ts) return;
  if (!message.text || !message.user) return;

  // Record the latest ts we've seen in the channel (includes non-counts).
  // This is used by ensureFresh() so it can tell immediately whether the DB
  // is stale without counting rows.
  setLastChannelTs(db, message.ts);

  const number = parseCount(message.text);
  if (number === null) return;

  upsertCount(db, message.ts, message.user, number);
});

// ---------------------------------------------------------------------------
// Slash command: /ctm
// ---------------------------------------------------------------------------

app.command('/ctm', async ({ command, ack, respond, client }) => {
  await ack();

  if (!db) {
    await respond({ response_type: 'ephemeral', text: ':x: Bot is still initializing. Please try again in a moment.' });
    return;
  }

  const parts = (command.text || '').trim().split(/\s+/);
  const sub = (parts[0] || '').toLowerCase();

  switch (sub) {
    case 'leaderboard': {
      const limit = parseInt(parts[1], 10);
      const safeLimit = Number.isNaN(limit) || limit < 1 ? 10 : Math.min(limit, 50);
      const { capped } = await ensureFresh(client);
      await respond({ response_type: 'in_channel', text: formatLeaderboard(safeLimit, capped) });
      break;
    }

    case 'stats': {
      let targetUserId = command.user_id;
      if (parts[1]) {
        const m = parts[1].match(/^<@([A-Z0-9]+)(?:\|[^>]+)?>$/i);
        targetUserId = m ? m[1] : command.user_id;
      }
      const { capped } = await ensureFresh(client);
      await respond({ response_type: 'ephemeral', text: formatUserStats(targetUserId, capped) });
      break;
    }

    case 'progress': {
      await ensureFresh(client);
      await respond({ response_type: 'in_channel', text: formatProgress() });
      break;
    }

    case 'sync': {
      const sub2 = (parts[1] || '').toLowerCase();
      const forceFull = sub2 === 'full';

      // Smart default: full if DB is empty, incremental otherwise
      const mode = forceFull || !getLatestTs(db) ? 'full' : 'incremental';

      await respond({
        response_type: 'ephemeral',
        text:
          mode === 'full'
            ? ':arrows_counterclockwise: Starting a full history sync — this may take a few minutes…'
            : ':arrows_counterclockwise: Catching up on new messages…',
      });

      runSync(client, { mode, statusChannel: command.channel_id }).catch((err) =>
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
  if (!db) return;
  const text = (event.text || '').toLowerCase();

  let reply;
  if (text.includes('leaderboard')) {
    await ensureFresh(client);
    reply = formatLeaderboard();
  } else if (text.includes('progress')) {
    await ensureFresh(client);
    reply = formatProgress();
  } else if (text.includes('stats')) {
    const { capped } = await ensureFresh(client);
    reply = formatUserStats(event.user, capped);
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
  // Start the HTTP server first so Slack's URL-verification challenge is
  // answered immediately, even before env vars are fully configured.
  await app.start();
  console.log(`⚡️ counttoamillion stats bot running on port ${process.env.PORT || 3000}`);

  // Validate required env vars after the server is up.
  CHANNEL_ID = process.env.CHANNEL_ID;
  if (!CHANNEL_ID) {
    console.error('⚠️  CHANNEL_ID environment variable is required. The bot is running but will not process any events until CHANNEL_ID is set and the app is restarted.');
    return;
  }

  db = openDb();

  const { totalCounts, totalContributors, highestCount } = getProgress(db);
  console.log(`   Channel:      ${CHANNEL_ID}`);
  console.log(`   DB:           ${process.env.DB_FILE || 'data/ctm.db'}`);
  console.log(`   Contributors: ${totalContributors}`);
  console.log(`   Total counts: ${totalCounts}`);
  console.log(`   Highest #:    ${highestCount}`);
})();
