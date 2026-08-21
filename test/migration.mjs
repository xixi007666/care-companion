import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(import.meta.dirname, '..');
const tempDir = await mkdtemp(path.join(tmpdir(), 'care-companion-migration-'));
const databasePath = path.join(tempDir, 'legacy.sqlite');
const key = crypto.randomBytes(32);
const encryptionKey = key.toString('base64');
function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ciphertext.toString('base64')}`;
}
function open(sealed) {
  const [iv64, tag64, cipher64] = sealed.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(cipher64, 'base64')), decipher.final()]).toString('utf8'));
}
async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Migration server did not start.');
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
}

let server;
try {
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE profiles (user_id TEXT PRIMARY KEY, data_encrypted TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE care_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, occurred_at INTEGER NOT NULL, data_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE screenings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, result_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE reports (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, data_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE care_plans (user_id TEXT PRIMARY KEY, data_encrypted TEXT NOT NULL, updated_at INTEGER NOT NULL);
  `);
  const userId = 'legacy-user';
  legacy.prepare('INSERT INTO users (id, email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, 'legacy@example.com', 'salt', 'hash', 1);
  legacy.prepare('INSERT INTO profiles (user_id, data_encrypted, updated_at) VALUES (?, ?, ?)').run(userId, seal({ alias: '外婆', scene: 'senior', segment: '60 岁以上 · 日常用药与生活支持' }), 2);
  legacy.prepare('INSERT INTO care_events (id, user_id, occurred_at, data_encrypted, created_at) VALUES (?, ?, ?, ?, ?)').run('legacy-event', userId, 3, seal({ category: '用药记录', mood: '已按计划服用', note: '旧记录', keywords: ['medication'], details: { kind: 'medication_log' } }), 3);
  legacy.prepare('INSERT INTO care_plans (user_id, data_encrypted, updated_at) VALUES (?, ?, ?)').run(userId, seal({ id: 'legacy-plan', tasks: [] }), 4);
  legacy.close();

  server = spawn('node', ['server.js'], { cwd: root, env: { ...process.env, PORT: '4313', DATABASE_PATH: databasePath, APP_ENCRYPTION_KEY: encryptionKey }, stdio: 'pipe' });
  server.stderr.on('data', chunk => process.stderr.write(chunk));
  await waitFor('http://127.0.0.1:4313/health');
  await stop(server);

  const migrated = new DatabaseSync(databasePath);
  const recipient = migrated.prepare('SELECT id, data_encrypted FROM care_recipients WHERE user_id = ?').get(userId);
  assert.equal(recipient.id, `legacy-${userId}`);
  const profile = open(recipient.data_encrypted);
  assert.equal(profile.segment, '75–84 岁 · 日常协助支持');
  assert.equal(profile.template, 'senior_assisted');
  assert.equal(migrated.prepare('SELECT recipient_id FROM care_events WHERE id = ?').get('legacy-event').recipient_id, recipient.id);
  assert.equal(migrated.prepare('SELECT recipient_id FROM recipient_care_plans WHERE user_id = ?').get(userId).recipient_id, recipient.id);
  migrated.close();
  console.log('Migration passed: legacy profile, records, and plan stay attached to the original recipient.');
} finally {
  if (server) await stop(server);
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
