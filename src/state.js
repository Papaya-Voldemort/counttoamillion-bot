const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '../data/state.json');

/**
 * Default state shape.
 * @type {{ currentCount: number, lastCounterUserId: string|null, userCounts: Object.<string,number> }}
 */
const DEFAULT_STATE = {
  currentCount: 0,
  lastCounterUserId: null,
  userCounts: {},
};

/**
 * Loads the bot state from disk.  Returns defaults if the file doesn't exist or is corrupt.
 * @returns {{ currentCount: number, lastCounterUserId: string|null, userCounts: Object.<string,number> }}
 */
function loadState() {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      return { ...DEFAULT_STATE, ...JSON.parse(data) };
    }
  } catch (err) {
    console.error('Error loading state, starting fresh:', err.message);
  }
  // Allow the starting count to be seeded via environment variable
  const seedCount = parseInt(process.env.INITIAL_COUNT || '0', 10);
  return { ...DEFAULT_STATE, currentCount: Number.isNaN(seedCount) ? 0 : seedCount };
}

/**
 * Persists the bot state to disk.
 * @param {{ currentCount: number, lastCounterUserId: string|null, userCounts: Object.<string,number> }} state
 */
function saveState(state) {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Error saving state:', err.message);
  }
}

module.exports = { loadState, saveState };
