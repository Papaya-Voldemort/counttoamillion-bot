const os = require('os');
const path = require('path');
const fs = require('fs');

describe('state module', () => {
  let tmpDir;
  let originalStateFile;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctam-test-'));
    originalStateFile = process.env.STATE_FILE;
    process.env.STATE_FILE = path.join(tmpDir, 'state.json');
    jest.resetModules();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalStateFile === undefined) {
      delete process.env.STATE_FILE;
    } else {
      process.env.STATE_FILE = originalStateFile;
    }
    jest.resetModules();
  });

  test('loadState returns default state when file does not exist', () => {
    const { loadState } = require('../src/state');
    const state = loadState();
    expect(state.currentCount).toBe(0);
    expect(state.userCounts).toEqual({});
    // lastCounterUserId is no longer part of state
    expect(state.lastCounterUserId).toBeUndefined();
  });

  test('saveState then loadState round-trips the state', () => {
    const { loadState, saveState } = require('../src/state');
    const saved = { currentCount: 336000, userCounts: { U123: 500, U456: 200 } };
    saveState(saved);
    const loaded = loadState();
    expect(loaded).toEqual(saved);
  });

  test('loadState gracefully handles corrupt JSON', () => {
    fs.writeFileSync(process.env.STATE_FILE, 'not-json');
    const { loadState } = require('../src/state');
    const state = loadState();
    expect(state.currentCount).toBe(0);
    expect(state.userCounts).toEqual({});
  });

  test('loadState merges persisted state with defaults', () => {
    const { loadState, saveState } = require('../src/state');
    // Save partial state (missing userCounts)
    fs.writeFileSync(process.env.STATE_FILE, JSON.stringify({ currentCount: 42 }));
    const state = loadState();
    expect(state.currentCount).toBe(42);
    expect(state.userCounts).toEqual({});
  });
});
