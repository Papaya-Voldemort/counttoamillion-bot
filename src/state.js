const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, '../data/state.json');

/**
 * Default state shape.
 * currentCount: highest count number seen in the channel (used for progress display).
 * userCounts:   map of Slack user ID → number of count messages they have posted.
 *
 * @type {{ currentCount: number, userCounts: Object.<string,number> }}
 */
const DEFAULT_STATE = {
  currentCount: 0,
  userCounts: {},
};

/**
 * Loads the bot state from disk. Returns defaults if the file doesn't exist or is corrupt.
 * @returns {{ currentCount: number, userCounts: Object.<string,number> }}
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
  return { ...DEFAULT_STATE };
}

/**
 * Persists the bot state to disk.
 * @param {{ currentCount: number, userCounts: Object.<string,number> }} state
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
