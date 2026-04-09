const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DEFAULT_DB_PATH = path.join(__dirname, '../data/ctm.db');

/**
 * Opens (or creates) the SQLite database, runs schema migrations, and returns
 * the `better-sqlite3` Database instance.
 *
 * Schema
 * ------
 * counts(slack_ts PK, user_id, count_number, posted_at)
 *   - slack_ts    : Slack message timestamp string, e.g. "1712345678.123456"
 *   - user_id     : Slack user ID, e.g. "U0123456789"
 *   - count_number: The integer that was counted (e.g. 336608)
 *   - posted_at   : Unix seconds derived from slack_ts (for date queries)
 *
 * meta(key, value)
 *   - Arbitrary key/value store (e.g. last_sync_ts, last_sync_at)
 *
 * @param {string} [dbPath]
 * @returns {import('better-sqlite3').Database}
 */
function openDb(dbPath) {
  const resolvedPath = dbPath || process.env.DB_FILE || DEFAULT_DB_PATH;

  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(resolvedPath);

  // WAL mode: faster concurrent reads, safe for single-writer bots
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS counts (
      slack_ts     TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL,
      count_number INTEGER NOT NULL,
      posted_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_counts_user   ON counts(user_id);
    CREATE INDEX IF NOT EXISTS idx_counts_number ON counts(count_number DESC);
    CREATE INDEX IF NOT EXISTS idx_counts_posted ON counts(posted_at DESC);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  return db;
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

/**
 * Inserts a count row.  Silently ignores duplicates (idempotent).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} slackTs   Slack message timestamp string
 * @param {string} userId    Slack user ID
 * @param {number} number    The count number
 */
function upsertCount(db, slackTs, userId, number) {
  const postedAt = Math.floor(parseFloat(slackTs));
  db.prepare(`
    INSERT OR IGNORE INTO counts (slack_ts, user_id, count_number, posted_at)
    VALUES (?, ?, ?, ?)
  `).run(slackTs, userId, number, postedAt);
}

/**
 * Bulk-inserts an array of count objects inside a single transaction.
 * Significantly faster than inserting one row at a time.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ slackTs: string, userId: string, number: number }[]} rows
 */
function bulkUpsertCounts(db, rows) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO counts (slack_ts, user_id, count_number, posted_at)
    VALUES (?, ?, ?, ?)
  `);
  const runAll = db.transaction((items) => {
    for (const { slackTs, userId, number } of items) {
      const postedAt = Math.floor(parseFloat(slackTs));
      insert.run(slackTs, userId, number, postedAt);
    }
  });
  runAll(rows);
}

/**
 * Deletes all rows from `counts` and `meta`.
 * @param {import('better-sqlite3').Database} db
 */
function clearAll(db) {
  db.exec('DELETE FROM counts; DELETE FROM meta;');
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Returns the top-N counters ordered by count descending.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} [limit=10]
 * @returns {{ userId: string, count: number }[]}
 */
function getLeaderboard(db, limit = 10) {
  return db.prepare(`
    SELECT user_id AS userId, COUNT(*) AS count
    FROM   counts
    GROUP  BY user_id
    ORDER  BY count DESC
    LIMIT  ?
  `).all(limit);
}

/**
 * Returns the total number of count-rows in the DB, and each user's rank/count.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @returns {{ userCount: number, rank: number, totalCount: number, totalContributors: number } | null}
 */
function getUserStats(db, userId) {
  const row = db.prepare(`
    WITH ranked AS (
      SELECT user_id,
             COUNT(*)                                          AS cnt,
             RANK() OVER (ORDER BY COUNT(*) DESC)             AS rnk
      FROM   counts
      GROUP  BY user_id
    )
    SELECT cnt AS userCount, rnk AS rank
    FROM   ranked
    WHERE  user_id = ?
  `).get(userId);

  if (!row) return null;

  const totals = db.prepare(`
    SELECT COUNT(*)          AS totalCount,
           COUNT(DISTINCT user_id) AS totalContributors
    FROM   counts
  `).get();

  return {
    userCount: row.userCount,
    rank: row.rank,
    totalCount: totals.totalCount,
    totalContributors: totals.totalContributors,
  };
}

/**
 * Returns overall channel progress metrics.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ highestCount: number, totalCounts: number, totalContributors: number }}
 */
function getProgress(db) {
  const row = db.prepare(`
    SELECT COALESCE(MAX(count_number), 0) AS highestCount,
           COUNT(*)                       AS totalCounts,
           COUNT(DISTINCT user_id)        AS totalContributors
    FROM   counts
  `).get();
  return row;
}

/**
 * Returns the slack_ts of the most recent count in the DB, or null if empty.
 * Used for incremental syncs (only fetch messages newer than this).
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {string | null}
 */
function getLatestTs(db) {
  const row = db.prepare('SELECT slack_ts FROM counts ORDER BY posted_at DESC LIMIT 1').get();
  return row ? row.slack_ts : null;
}

// ---------------------------------------------------------------------------
// Meta helpers
// ---------------------------------------------------------------------------

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @returns {string | null}
 */
function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 * @param {string} value
 */
function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

module.exports = {
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
};
