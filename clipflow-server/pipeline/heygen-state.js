// HeyGen job persistence — survives server restarts
'use strict';
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../heygen_jobs.json');

function load() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function save(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Save a pending HeyGen job so we can resume after restart
function saveJob(jobId, clipIdx, translateId, dubbedPath, captionPath, settings) {
  const state = load();
  state[translateId] = { jobId, clipIdx, translateId, dubbedPath, captionPath, settings, savedAt: Date.now() };
  save(state);
}

// Mark a HeyGen job as complete
function completeJob(translateId) {
  const state = load();
  delete state[translateId];
  save(state);
}

// Get all pending HeyGen jobs (for resume on startup)
function getPending() {
  const state = load();
  // Remove stale jobs older than 24h
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let changed = false;
  for (const [id, job] of Object.entries(state)) {
    if (job.savedAt < cutoff) { delete state[id]; changed = true; }
  }
  if (changed) save(state);
  return Object.values(state);
}

module.exports = { saveJob, completeJob, getPending };
