const os = require('os');
const path = require('path');
const fs = require('fs');
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
} = require('../src/db');

let db;
let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctam-db-test-'));
  db = openDb(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Schema / open
// ---------------------------------------------------------------------------

test('openDb creates tables and returns a working db', () => {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name);
  expect(tables).toContain('counts');
  expect(tables).toContain('meta');
});

// ---------------------------------------------------------------------------
// upsertCount
// ---------------------------------------------------------------------------

test('upsertCount inserts a row', () => {
  upsertCount(db, '1000000.000001', 'U001', 1);
  const row = db.prepare('SELECT * FROM counts').get();
  expect(row.user_id).toBe('U001');
  expect(row.count_number).toBe(1);
  expect(row.slack_ts).toBe('1000000.000001');
});

test('upsertCount is idempotent on duplicate slack_ts', () => {
  upsertCount(db, '1000000.000001', 'U001', 1);
  upsertCount(db, '1000000.000001', 'U001', 1); // duplicate — should be ignored
  const count = db.prepare('SELECT COUNT(*) AS n FROM counts').get().n;
  expect(count).toBe(1);
});

// ---------------------------------------------------------------------------
// bulkUpsertCounts
// ---------------------------------------------------------------------------

test('bulkUpsertCounts inserts many rows in one transaction', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    slackTs: `${1_000_000 + i}.000000`,
    userId: `U${String(i).padStart(3, '0')}`,
    number: i + 1,
  }));
  bulkUpsertCounts(db, rows);
  const n = db.prepare('SELECT COUNT(*) AS n FROM counts').get().n;
  expect(n).toBe(100);
});

// ---------------------------------------------------------------------------
// clearAll
// ---------------------------------------------------------------------------

test('clearAll removes all counts and meta', () => {
  upsertCount(db, '1000000.000001', 'U001', 1);
  setMeta(db, 'last_sync_at', 'Apr 9, 2026');
  clearAll(db);
  const n = db.prepare('SELECT COUNT(*) AS n FROM counts').get().n;
  expect(n).toBe(0);
  expect(getMeta(db, 'last_sync_at')).toBeNull();
});

// ---------------------------------------------------------------------------
// getLeaderboard
// ---------------------------------------------------------------------------

test('getLeaderboard returns top users ordered by count desc', () => {
  upsertCount(db, '1.000001', 'UAAA', 1);
  upsertCount(db, '2.000001', 'UBBB', 2);
  upsertCount(db, '3.000001', 'UAAA', 3);
  upsertCount(db, '4.000001', 'UCCC', 4);

  const board = getLeaderboard(db, 10);
  expect(board[0].userId).toBe('UAAA');
  expect(board[0].count).toBe(2);
  expect(board[1].count).toBe(1);
});

test('getLeaderboard respects limit', () => {
  for (let i = 0; i < 20; i++) {
    upsertCount(db, `${1_000_000 + i}.000000`, `U${String(i).padStart(3, '0')}`, i + 1);
  }
  const board = getLeaderboard(db, 5);
  expect(board.length).toBe(5);
});

test('getLeaderboard returns empty array when no data', () => {
  expect(getLeaderboard(db)).toEqual([]);
});

// ---------------------------------------------------------------------------
// getUserStats
// ---------------------------------------------------------------------------

test('getUserStats returns null for unknown user', () => {
  expect(getUserStats(db, 'UNOBODY')).toBeNull();
});

test('getUserStats returns correct rank and count', () => {
  upsertCount(db, '1.000001', 'UAAA', 1);
  upsertCount(db, '2.000001', 'UAAA', 2);
  upsertCount(db, '3.000001', 'UBBB', 3);

  const stats = getUserStats(db, 'UAAA');
  expect(stats.userCount).toBe(2);
  expect(stats.rank).toBe(1);
  expect(stats.totalCount).toBe(3);
  expect(stats.totalContributors).toBe(2);

  const statsB = getUserStats(db, 'UBBB');
  expect(statsB.rank).toBe(2);
});

// ---------------------------------------------------------------------------
// getProgress
// ---------------------------------------------------------------------------

test('getProgress returns zeroes when empty', () => {
  const p = getProgress(db);
  expect(p.highestCount).toBe(0);
  expect(p.totalCounts).toBe(0);
  expect(p.totalContributors).toBe(0);
});

test('getProgress returns correct values', () => {
  upsertCount(db, '1.000001', 'UAAA', 100);
  upsertCount(db, '2.000001', 'UAAA', 200);
  upsertCount(db, '3.000001', 'UBBB', 300);

  const p = getProgress(db);
  expect(p.highestCount).toBe(300);
  expect(p.totalCounts).toBe(3);
  expect(p.totalContributors).toBe(2);
});

// ---------------------------------------------------------------------------
// getLatestTs
// ---------------------------------------------------------------------------

test('getLatestTs returns null when empty', () => {
  expect(getLatestTs(db)).toBeNull();
});

test('getLatestTs returns the ts with the highest posted_at', () => {
  // Older timestamp
  upsertCount(db, '1000000.000000', 'UAAA', 1);
  // Newer timestamp
  upsertCount(db, '1999999.000000', 'UBBB', 2);

  expect(getLatestTs(db)).toBe('1999999.000000');
});

// ---------------------------------------------------------------------------
// meta helpers
// ---------------------------------------------------------------------------

test('getMeta returns null for unknown key', () => {
  expect(getMeta(db, 'nonexistent')).toBeNull();
});

test('setMeta / getMeta round-trips a value', () => {
  setMeta(db, 'last_sync_at', 'Apr 9, 2026');
  expect(getMeta(db, 'last_sync_at')).toBe('Apr 9, 2026');
});

test('setMeta overwrites existing value', () => {
  setMeta(db, 'key', 'first');
  setMeta(db, 'key', 'second');
  expect(getMeta(db, 'key')).toBe('second');
});
