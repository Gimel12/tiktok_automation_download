'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = path.join(__dirname, 'users.json');

function load() {
  if (!fs.existsSync(DB_FILE)) return { users: {} };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: {} }; }
}

function save(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ── Users ──────────────────────────────────────────────────────────────
function getUser(email) {
  const db = load();
  return db.users[email.toLowerCase()] || null;
}

function upsertUser(email, updates = {}) {
  const db  = load();
  const key = email.toLowerCase();
  db.users[key] = { email: key, credits: 0, plan: 'free', createdAt: Date.now(), ...db.users[key], ...updates };
  save(db);
  return db.users[key];
}

function addCredits(email, amount) {
  const db  = load();
  const key = email.toLowerCase();
  if (!db.users[key]) db.users[key] = { email: key, credits: 0, plan: 'free', createdAt: Date.now() };
  db.users[key].credits = (db.users[key].credits || 0) + amount;
  save(db);
  return db.users[key];
}

function deductCredit(email) {
  const db  = load();
  const key = email.toLowerCase();
  const user = db.users[key];
  if (!user) return false;
  if (user.plan === 'unlimited') return true; // unlimited plan never deducts
  if ((user.credits || 0) <= 0) return false;
  user.credits--;
  save(db);
  return true;
}

// ── Magic link tokens ──────────────────────────────────────────────────
function createLoginToken(email) {
  const db    = load();
  const token = crypto.randomBytes(32).toString('hex');
  if (!db.tokens) db.tokens = {};
  // Clean expired tokens
  const now = Date.now();
  Object.keys(db.tokens).forEach(t => { if (db.tokens[t].exp < now) delete db.tokens[t]; });
  db.tokens[token] = { email: email.toLowerCase(), exp: now + 15 * 60 * 1000 }; // 15 min
  save(db);
  return token;
}

function verifyLoginToken(token) {
  const db = load();
  if (!db.tokens) return null;
  const entry = db.tokens[token];
  if (!entry || entry.exp < Date.now()) return null;
  delete db.tokens[token]; // one-time use
  save(db);
  return entry.email;
}

// ── Session tokens ─────────────────────────────────────────────────────
function createSession(email) {
  const db    = load();
  const token = crypto.randomBytes(32).toString('hex');
  if (!db.sessions) db.sessions = {};
  db.sessions[token] = { email: email.toLowerCase(), createdAt: Date.now() };
  save(db);
  return token;
}

function verifySession(token) {
  const db = load();
  if (!db.sessions || !token) return null;
  const entry = db.sessions[token];
  return entry ? entry.email : null;
}

function deleteSession(token) {
  const db = load();
  if (db.sessions) delete db.sessions[token];
  save(db);
}

module.exports = { getUser, upsertUser, addCredits, deductCredit, createLoginToken, verifyLoginToken, createSession, verifySession, deleteSession };
