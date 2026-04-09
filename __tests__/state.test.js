const os = require('os');
const path = require('path');
const fs = require('fs');

describe('state module', () => {
  let tmpDir;
  let originalStateFile;
  let originalInitialCount;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctam-test-'));
    originalStateFile = process.env.STATE_FILE;
    originalInitialCount = process.env.INITIAL_COUNT;
    process.env.STATE_FILE = path.join(tmpDir, 'state.json');
    // Re-require fresh module each test
    jest.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalStateFile === undefined) {
      delete process.env.STATE_FILE;
    } else {
      process.env.STATE_FILE = originalStateFile;
    }
    if (originalInitialCount === undefined) {
      delete process.env.INITIAL_COUNT;
    } else {
      process.env.INITIAL_COUNT = originalInitialCount;
    }
    jest.resetModules();
  });

  test('loadState returns default state when file does not exist', () => {
    const { loadState } = require('../src/state');
    const state = loadState();
    expect(state.currentCount).toBe(0);
    expect(state.lastCounterUserId).toBeNull();
    expect(state.userCounts).toEqual({});
  });

  test('loadState seeds currentCount from INITIAL_COUNT env var', () => {
    process.env.INITIAL_COUNT = '336000';
    const { loadState } = require('../src/state');
    const state = loadState();
    expect(state.currentCount).toBe(336000);
  });

  test('saveState then loadState round-trips the state', () => {
    const { loadState, saveState } = require('../src/state');
    const saved = { currentCount: 42, lastCounterUserId: 'U123', userCounts: { U123: 3 } };
    saveState(saved);
    const loaded = loadState();
    expect(loaded).toEqual(saved);
  });

  test('loadState gracefully handles corrupt JSON', () => {
    fs.writeFileSync(process.env.STATE_FILE, 'not-json');
    const { loadState } = require('../src/state');
    const state = loadState();
    expect(state.currentCount).toBe(0);
  });
});
