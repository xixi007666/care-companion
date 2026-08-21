'use strict';

/*
 * 试运营版服务端：只使用 Node 内置模块与 node:sqlite。
 * 重点：API Key 和照护记录只在服务端保存，均使用 AES-256-GCM 加密。
 * 上线前仍需独立的安全审计、备份策略、隐私/医疗合规审查与专业内容审核。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].trim().replace(/^['"]|['"]$/g, '');
    process.env[match[1]] = value;
  }
}
// No third-party dotenv dependency: load local configuration before reading it.
loadDotEnv();
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = path.resolve(process.env.DATABASE_PATH || path.join(ROOT, 'data', 'care-companion.sqlite'));
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const ALLOW_HTTP_LLM = process.env.ALLOW_HTTP_LLM === 'true';
const AI_CALLS_PER_HOUR = Math.max(1, Math.min(100, Number(process.env.AI_CALLS_PER_HOUR || 20)));
const scrypt = promisify(crypto.scrypt);

function loadEncryptionKey() {
  const value = process.env.APP_ENCRYPTION_KEY;
  if (!value) throw new Error('APP_ENCRYPTION_KEY is required. See .env.example.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('APP_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  return key;
}
const ENCRYPTION_KEY = loadEncryptionKey();

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY, data_encrypted TEXT NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS care_events (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, occurred_at INTEGER NOT NULL,
    data_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS care_events_user_time ON care_events(user_id, occurred_at DESC);
  CREATE TABLE IF NOT EXISTS llm_configs (
    user_id TEXT PRIMARY KEY, base_url TEXT NOT NULL, model TEXT NOT NULL,
    api_key_encrypted TEXT NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS ai_usage (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS ai_usage_user_time ON ai_usage(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
    data_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS screenings (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, result_encrypted TEXT NOT NULL,
    created_at INTEGER NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS screenings_user_time ON screenings(user_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS care_plans (
    user_id TEXT PRIMARY KEY, data_encrypted TEXT NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY, user_id TEXT, action TEXT NOT NULL, created_at INTEGER NOT NULL
  );
`);

function hasColumn(table, column) { return db.prepare(`PRAGMA table_info(${table})`).all().some(item => item.name === column); }
function addColumnOnce(table, column, definition) { if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); }
addColumnOnce('care_events', 'recipient_id', 'TEXT');
addColumnOnce('screenings', 'recipient_id', 'TEXT');
addColumnOnce('reports', 'recipient_id', 'TEXT');
db.exec(`
  CREATE TABLE IF NOT EXISTS care_recipients (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, data_encrypted TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS care_recipients_user_time ON care_recipients(user_id, updated_at DESC);
  CREATE INDEX IF NOT EXISTS care_events_recipient_time ON care_events(user_id, recipient_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS screenings_recipient_time ON screenings(user_id, recipient_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS reports_recipient_time ON reports(user_id, recipient_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS recipient_care_plans (
    user_id TEXT NOT NULL, recipient_id TEXT NOT NULL, data_encrypted TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, recipient_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES care_recipients(id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS care_alerts (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
    data_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES care_recipients(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS care_alerts_recipient_time ON care_alerts(user_id, recipient_id, created_at DESC);
  CREATE TABLE IF NOT EXISTS care_handoffs (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, recipient_id TEXT NOT NULL,
    data_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (recipient_id) REFERENCES care_recipients(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS care_handoffs_recipient_time ON care_handoffs(user_id, recipient_id, created_at DESC);
`);
function legacyRecipientId(userId) { return `legacy-${userId}`; }
function migrateLegacyProfiles() {
  const profiles = db.prepare('SELECT user_id, data_encrypted, updated_at FROM profiles').all();
  for (const profile of profiles) {
    const recipientId = legacyRecipientId(profile.user_id);
    const legacyProfile = open(profile.data_encrypted);
    if (legacyProfile.scene === 'senior' && legacyProfile.segment === '60 岁以上 · 日常用药与生活支持') legacyProfile.segment = '75–84 岁 · 日常协助支持';
    legacyProfile.template = legacyProfile.scene === 'senior' ? 'senior_support' : 'child_preschool';
    db.prepare('INSERT INTO care_recipients (id, user_id, data_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING').run(recipientId, profile.user_id, seal(legacyProfile), profile.updated_at, profile.updated_at);
    db.prepare('UPDATE care_events SET recipient_id = ? WHERE user_id = ? AND recipient_id IS NULL').run(recipientId, profile.user_id);
    db.prepare('UPDATE screenings SET recipient_id = ? WHERE user_id = ? AND recipient_id IS NULL').run(recipientId, profile.user_id);
    db.prepare('UPDATE reports SET recipient_id = ? WHERE user_id = ? AND recipient_id IS NULL').run(recipientId, profile.user_id);
    const plan = db.prepare('SELECT data_encrypted, updated_at FROM care_plans WHERE user_id = ?').get(profile.user_id);
    if (plan) db.prepare('INSERT INTO recipient_care_plans (user_id, recipient_id, data_encrypted, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, recipient_id) DO NOTHING').run(profile.user_id, recipientId, plan.data_encrypted, plan.updated_at);
  }
}
migrateLegacyProfiles();

function id() { return crypto.randomUUID(); }
function tokenHash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function now() { return Date.now(); }
function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ciphertext.toString('base64')}`;
}
function open(sealed) {
  const [iv64, tag64, cipher64] = String(sealed).split('.');
  if (!iv64 || !tag64 || !cipher64) throw new Error('Invalid encrypted payload.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, Buffer.from(iv64, 'base64'));
  decipher.setAuthTag(Buffer.from(tag64, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(cipher64, 'base64')), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}
function audit(userId, action) {
  db.prepare('INSERT INTO audit_logs (id, user_id, action, created_at) VALUES (?, ?, ?, ?)').run(id(), userId || null, action, now());
}
function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin'
  });
  res.end(JSON.stringify(body));
}
function fail(res, status, code, message) { json(res, status, { error: { code, message } }); }
function setSessionCookie(res, token) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=604800'];
  if (COOKIE_SECURE) flags.push('Secure');
  res.setHeader('Set-Cookie', `sid=${token}; ${flags.join('; ')}`);
}
function clearSessionCookie(res) { res.setHeader('Set-Cookie', 'sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); }
function getCookie(req, name) {
  return (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
}
function currentUser(req) {
  const token = getCookie(req, 'sid');
  if (!token) return null;
  const session = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash(token), now());
  if (!session) return null;
  return db.prepare('SELECT id, email, created_at FROM users WHERE id = ?').get(session.user_id) || null;
}
function requireUser(req, res) {
  const user = currentUser(req);
  if (!user) { fail(res, 401, 'AUTH_REQUIRED', '请先登录。'); return null; }
  return user;
}
async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = []; let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}
function text(value, max = 240) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function hasDirectIdentifier(value) {
  return /\b\d{11}\b|[\w.+-]+@[\w-]+\.[\w.-]+|\b\d{17}[\dXx]\b/.test(value);
}
async function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString('base64');
  const hash = await scrypt(password, salt, 64);
  return { salt, hash: hash.toString('base64') };
}
async function passwordMatches(password, salt, expected) {
  const actual = await scrypt(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(expected, 'base64'));
}
function makeSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), userId, now() + 7 * 24 * 60 * 60 * 1000, now());
  return token;
}
function recipientsFor(userId) {
  return db.prepare('SELECT id, data_encrypted, created_at, updated_at FROM care_recipients WHERE user_id = ? ORDER BY updated_at DESC').all(userId).map(row => normalizedRecipientProfile({ id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, ...open(row.data_encrypted) }));
}
function recipientFor(userId, recipientId) {
  if (!recipientId) return null;
  const row = db.prepare('SELECT id, data_encrypted, created_at, updated_at FROM care_recipients WHERE id = ? AND user_id = ?').get(recipientId, userId);
  return row ? normalizedRecipientProfile({ id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, ...open(row.data_encrypted) }) : null;
}
function requestedRecipient(req, userId) {
  const requestedId = text(req.headers['x-care-recipient-id'], 80);
  return requestedId ? recipientFor(userId, requestedId) : recipientsFor(userId)[0] || null;
}
function profileFor(userId, recipientId) { return recipientFor(userId, recipientId); }
function profileSceneLocked(userId, recipientId) {
  if (!recipientId) return false;
  const hasEvents = db.prepare('SELECT 1 FROM care_events WHERE user_id = ? AND recipient_id = ? LIMIT 1').get(userId, recipientId);
  const hasScreenings = db.prepare('SELECT 1 FROM screenings WHERE user_id = ? AND recipient_id = ? LIMIT 1').get(userId, recipientId);
  const hasReports = db.prepare('SELECT 1 FROM reports WHERE user_id = ? AND recipient_id = ? LIMIT 1').get(userId, recipientId);
  return Boolean(hasEvents || hasScreenings || hasReports);
}
function eventsFor(userId, recipientId, limit = 50) {
  if (!recipientId) return [];
  return db.prepare('SELECT id, occurred_at, data_encrypted, created_at FROM care_events WHERE user_id = ? AND recipient_id = ? ORDER BY occurred_at DESC LIMIT ?').all(userId, recipientId, limit).map(row => ({ id: row.id, occurredAt: row.occurred_at, createdAt: row.created_at, ...open(row.data_encrypted) }));
}
function publicLLMConfig(userId) {
  const row = db.prepare('SELECT base_url, model, updated_at FROM llm_configs WHERE user_id = ?').get(userId);
  return row ? { configured: true, baseUrl: row.base_url, model: row.model, updatedAt: row.updated_at } : { configured: false };
}
const CHILD_SCREENING_QUESTIONS = [
  { id: 'sleep', title: '睡眠与作息', prompt: '过去两周里，孩子在固定睡前流程后仍常常难以安稳入睡、夜醒，或第二天明显疲惫。', focus: '睡眠节律', task: '连续 3 天记录上床、入睡与夜醒时间。' },
  { id: 'emotion', title: '情绪恢复', prompt: '遇到不如意时，孩子的强烈情绪常常需要很久或多次帮助才会平复。', focus: '情绪恢复', task: '记录一次情绪前的活动、持续多久，以及哪种安抚有效。' },
  { id: 'transition', title: '活动切换', prompt: '从玩耍到收拾、从家到幼儿园等活动切换时，孩子常常很难配合。', focus: '活动切换', task: '每次切换前提前 5 分钟预告，并记录是否更顺利。' },
  { id: 'peer', title: '同伴互动', prompt: '和同龄孩子一起玩时，孩子常常回避、冲突频繁，或很难继续参与。', focus: '同伴互动', task: '本周记录两次同伴互动：开始方式、持续时间和结束原因。' },
  { id: 'kindergarten', title: '入园适应', prompt: '上幼儿园、分离或集体活动时，孩子的紧张或抗拒反复影响日常安排。', focus: '入园适应', task: '用一句话记录每天入园前、入园后 30 分钟的状态。' },
  { id: 'daily', title: '日常自理', prompt: '穿衣、吃饭、洗漱等日常环节常常需要大量催促或引发冲突。', focus: '日常自理', task: '选一个固定环节，尝试图片步骤或二选一提示，连续记录 3 天。' },
  { id: 'communication', title: '表达与理解', prompt: '在表达需求、理解简单指令或与家人沟通时，孩子常因挫败而出现冲突。', focus: '沟通表达', task: '记录孩子想表达什么、家人如何回应、之后是否被理解。' },
  { id: 'family', title: '家庭照护压力', prompt: '这些情况已经让主要照护者持续焦虑、疲惫，或明显影响家庭日常。', focus: '家庭支持', task: '安排一位家人分担一次固定照护环节，并记录照护者压力变化。' }
];
const INFANT_SCREENING_QUESTIONS = [
  { id: 'sleep', title: '睡眠与作息', prompt: '过去两周里，孩子的入睡、夜醒或白天小睡是否常明显打乱家庭作息？', focus: '睡眠节律', task: '连续 3 天记录入睡、夜醒和小睡的大致时间。' },
  { id: 'feeding', title: '进食与饮水', prompt: '过去两周里，进食、饮水或喂养过程是否较平时更困难，或让照护者反复担心？', focus: '进食记录', task: '连续 3 天记录主要进食时段、接受情况和餐后表现。' },
  { id: 'soothing', title: '安抚与情绪', prompt: '过去两周里，哭闹或不安是否经常需要很久、很多次安抚才缓解？', focus: '安抚方式', task: '记录一次不安前的情境、持续多久和哪种陪伴方式有效。' },
  { id: 'routine', title: '日常节律', prompt: '洗漱、外出、换衣或其他日常环节是否常让孩子明显抗拒，或使家庭流程难以推进？', focus: '日常节律', task: '选一个固定环节，连续 3 天记录前后发生了什么。' },
  { id: 'interaction', title: '互动回应', prompt: '与家人互动、回应呼唤或共同玩耍时，是否出现让照护者持续留意的变化？', focus: '互动回应', task: '记录两次共同活动：开始方式、持续时间和孩子的回应。' },
  { id: 'outdoor', title: '外出与环境变化', prompt: '外出、见陌生人或环境变化时，孩子是否经常明显不安，影响日常安排？', focus: '环境适应', task: '记录一次外出前、过程中和回家后的状态。' },
  { id: 'comfort', title: '身体舒适线索', prompt: '过去两周里，是否反复出现让家人留意的睡不安、哭闹、进食变化或其他不适线索？', focus: '舒适线索', task: '只记录时间、表现和已采取的照护行动；快速加重时先联系医疗服务。' },
  { id: 'family', title: '家庭照护衔接', prompt: '不同照护者之间是否常因作息、喂养或安抚信息不一致而增加压力？', focus: '照护衔接', task: '每天用一句话同步睡眠、进食和情绪是否与平时不同。' }
];
const SCHOOL_AGE_SCREENING_QUESTIONS = [
  { id: 'sleep', title: '睡眠与作息', prompt: '过去两周里，孩子是否常晚睡、难起床或白天明显疲惫，影响上学和家庭安排？', focus: '睡眠节律', task: '连续 3 天记录上床、入睡、起床和白天精神状态。' },
  { id: 'emotion', title: '情绪恢复', prompt: '遇到挫折、作业或同伴问题时，孩子的强烈情绪是否常需要很久或多次帮助才会平复？', focus: '情绪恢复', task: '记录一次情绪前的情境、持续多久和哪种支持有效。' },
  { id: 'school', title: '上学与任务衔接', prompt: '上学、作业或日常任务开始时，孩子是否经常明显拖延、抗拒或难以完成？', focus: '任务衔接', task: '选一项固定任务，连续 3 天记录开始时间、完成情况和需要的帮助。' },
  { id: 'peer', title: '同伴互动', prompt: '和同龄人相处时，孩子是否常回避、冲突频繁，或难以继续参与共同活动？', focus: '同伴互动', task: '记录两次同伴互动：发生场景、持续时间和结束原因。' },
  { id: 'daily', title: '日常自理', prompt: '整理物品、洗漱、按时出门等日常环节是否常需要大量催促或引发冲突？', focus: '日常自理', task: '选一个固定环节，使用清单或二选一提示并连续记录 3 天。' },
  { id: 'communication', title: '表达与沟通', prompt: '表达需求、说明学校经历或与家人沟通时，孩子是否常因挫败、误解而出现冲突？', focus: '沟通表达', task: '记录孩子想表达什么、家人如何回应、之后是否被理解。' },
  { id: 'screen', title: '屏幕与活动切换', prompt: '从屏幕、游戏或喜欢的活动切换到学习、睡眠等安排时，是否经常明显困难？', focus: '活动切换', task: '每次切换前提前约 5 分钟预告，并记录是否更顺利。' },
  { id: 'family', title: '家庭支持', prompt: '这些情况是否已让主要照护者持续焦虑、疲惫，或明显影响家庭日常？', focus: '家庭支持', task: '安排一次明确的家庭分工，并记录照护压力是否有变化。' }
];
const SENIOR_INDEPENDENT_SCREENING_QUESTIONS = [
  { id: 'medication', title: '用药遗漏或不确定', prompt: '过去两周里，是否出现忘记、重复、不确定是否已按计划用药，或需要反复确认的情况？', focus: '用药确认', task: '连续 3 天在每个常用时段标记“已按计划 / 未按计划 / 不确定”。不要自行调整药物或剂量。' },
  { id: 'sleep', title: '睡眠与精神', prompt: '过去两周里，是否常有明显睡不好、白天困倦，或与平时相比精神状态改变？', focus: '睡眠与精神', task: '连续 3 天记录上床、起床和白天精神状态。' },
  { id: 'appetite', title: '食欲与饮水', prompt: '过去两周里，是否较平时明显吃得更少、饮水减少，或进食时需要更多帮助？', focus: '食欲与饮水', task: '连续 3 天记录每餐食欲和饮水情况；如存在吞咽困难等问题，及时联系专业人员。' },
  { id: 'mobility', title: '活动与行走', prompt: '过去两周里，是否较平时更少活动、走路更不稳，或因活动需要更多协助？', focus: '活动与行走', task: '连续 3 天记录活动时段、是否需要协助，以及是否与平时不同。' },
  { id: 'daily', title: '日常自理', prompt: '洗漱、穿衣、如厕、进食等日常环节，是否较平时明显需要更多提醒或帮助？', focus: '日常自理', task: '选择一个日常环节，记录需要帮助的地方与当天是否有变化。' },
  { id: 'mood', title: '情绪与沟通', prompt: '过去两周里，是否更常出现烦躁、低落、沉默，或与家人沟通明显困难？', focus: '情绪与沟通', task: '记录发生前的情境、持续时间，以及陪伴或沟通后是否缓解。' },
  { id: 'pain', title: '身体不适线索', prompt: '过去两周里，是否有反复不适、疼痛、头晕，或其他需要家人持续留意的线索？', focus: '不适线索', task: '仅记录发生时间、表现与是否已寻求专业帮助；快速加重时先联系医疗服务。' },
  { id: 'family', title: '照护衔接', prompt: '照护交接、提醒或陪同安排，是否常因信息不一致而遗漏或增加压力？', focus: '照护衔接', task: '每天用一句话同步“今天是否按计划用药、吃饭和活动是否与平时不同”。' }
];
const SENIOR_ASSISTED_SCREENING_QUESTIONS = [
  { id: 'medication', title: '用药确认与提醒', prompt: '过去两周里，是否出现忘记、重复、不确定是否已按计划用药，或需要家人反复确认的情况？', focus: '用药确认', task: '连续 3 天在每个常用时段标记“已按计划 / 未按计划 / 不确定”。不要自行调整药物或剂量。' },
  { id: 'sleep', title: '睡眠与白天精力', prompt: '过去两周里，是否常有明显睡不好、白天困倦，或与平时相比精力变化影响白天安排？', focus: '睡眠与精力', task: '连续 3 天记录上床、起床和白天精神状态。' },
  { id: 'appetite', title: '食欲与饮水', prompt: '过去两周里，是否较平时明显吃得更少、饮水减少，或需要更多提醒、陪伴才能完成进食？', focus: '食欲与饮水', task: '连续 3 天记录每餐食欲和饮水情况；如存在吞咽困难等问题，及时联系专业人员。' },
  { id: 'mobility', title: '行走与外出稳定性', prompt: '过去两周里，走路、上下台阶或外出时，是否较平时更不稳、更加犹豫，或需要更多陪同？', focus: '活动稳定性', task: '连续 3 天记录一次室内或外出活动：是否需要陪同、是否与平时不同。' },
  { id: 'memory', title: '提醒与日常安排', prompt: '过去两周里，是否较平时更常因忘记日程、物品或步骤而需要家人反复提醒，影响当天安排？', focus: '提醒与安排', task: '选一件固定小事，用纸质清单或一次提醒协助，并记录是否顺利完成。' },
  { id: 'daily', title: '日常自理与协助', prompt: '洗漱、穿衣、购物、出门准备等日常环节，是否较平时需要更多帮助或陪同？', focus: '日常协助', task: '选择一个日常环节，记录需要帮助的地方和当天是否有变化。' },
  { id: 'mood', title: '情绪与社会联结', prompt: '过去两周里，是否更常出现烦躁、低落、沉默，或明显减少与家人朋友的沟通和活动？', focus: '情绪与联结', task: '记录一次发生前的情境、持续时间，以及陪伴、沟通或活动后是否缓解。' },
  { id: 'family', title: '陪同与照护交接', prompt: '家人之间的提醒、陪同、就医或用药信息，是否常因未同步而遗漏或增加压力？', focus: '照护交接', task: '每天用一句话同步“用药、进食、活动和需要陪同的地方是否与平时不同”。' }
];
const SENIOR_HIGH_SUPPORT_SCREENING_QUESTIONS = [
  { id: 'medication', title: '用药确认', prompt: '过去两周里，是否出现忘记、重复、不确定是否已按计划用药，或需要照护者反复确认的情况？', focus: '用药确认', task: '连续 3 天在每个常用时段标记“已按计划 / 未按计划 / 不确定”。不要自行调整药物或剂量。' },
  { id: 'feeding', title: '进食、饮水与吞咽协助', prompt: '过去两周里，进食、饮水或吞咽时，是否较平时需要更多协助，或出现让照护者持续留意的困难？', focus: '进食协助', task: '连续 3 天记录每餐接受情况、饮水和是否需要协助；如出现明显吞咽困难或快速加重，及时联系专业人员。' },
  { id: 'transfer', title: '转移与体位协助', prompt: '从床、椅子、如厕位置之间转移，或起身、坐下、翻身时，是否较平时需要更多协助或出现不稳？', focus: '转移协助', task: '连续 3 天记录一个转移时段：需要几人协助、是否与平时不同；疑似严重受伤时不要强行搬动。' },
  { id: 'toileting', title: '如厕与清洁协助', prompt: '如厕、更换衣物、清洁等环节，是否较平时需要更多协助、交接或提醒？', focus: '日常照护', task: '选择一个固定环节，记录需要帮助的地方和当天是否有变化。' },
  { id: 'sleep', title: '睡眠与休息', prompt: '过去两周里，夜间休息、白天小睡或昼夜节律是否较平时明显改变，增加照护难度？', focus: '休息节律', task: '连续 3 天记录大致休息时段和白天精神状态。' },
  { id: 'alertness', title: '精神与回应', prompt: '过去两周里，是否出现较平时更少回应、明显困倦、烦躁，或需要更多时间才能跟上日常互动？', focus: '精神回应', task: '记录发生时间、与平时相比的表现和已采取的陪伴行动；快速变化时优先寻求实时帮助。' },
  { id: 'comfort', title: '身体舒适线索', prompt: '过去两周里，是否反复出现让照护者留意的疼痛、不安、久坐久卧不适，或其他身体舒适变化？', focus: '舒适线索', task: '只记录时间、表现和已采取的照护行动；快速加重时先联系医疗服务。' },
  { id: 'handoff', title: '多人照护交接', prompt: '不同照护者之间是否常因用药、进食、转移或夜间情况未同步而出现遗漏或增加压力？', focus: '照护交接', task: '每次交接只同步四件事：用药、进食饮水、转移协助、与平时不同的变化。' }
];
const PROFILE_SEGMENTS = {
  child: ['0–2 岁 · 婴幼儿生活节律', '3–6 岁 · 情绪社交期', '7–12 岁 · 学龄适应期'],
  senior: ['60–74 岁 · 自主生活支持', '75–84 岁 · 日常协助支持', '85 岁以上 · 高支持照护']
};
function templateFor(scene, segment) {
  if (scene === 'child') {
    if (segment.startsWith('0–2')) return 'child_infant';
    if (segment.startsWith('7–12')) return 'child_school';
    return 'child_preschool';
  }
  if (segment.startsWith('60–74')) return 'senior_independent';
  if (segment.startsWith('75–84')) return 'senior_assisted';
  return 'senior_high_support';
}
function questionsForTemplate(template) {
  return ({ child_infant: INFANT_SCREENING_QUESTIONS, child_preschool: CHILD_SCREENING_QUESTIONS, child_school: SCHOOL_AGE_SCREENING_QUESTIONS, senior_independent: SENIOR_INDEPENDENT_SCREENING_QUESTIONS, senior_assisted: SENIOR_ASSISTED_SCREENING_QUESTIONS, senior_high_support: SENIOR_HIGH_SUPPORT_SCREENING_QUESTIONS })[template] || CHILD_SCREENING_QUESTIONS;
}
function coreIdsForTemplate(template) {
  if (template === 'senior_independent') return ['medication', 'sleep', 'appetite', 'mobility'];
  if (template === 'senior_assisted') return ['medication', 'memory', 'mobility', 'daily'];
  if (template === 'senior_high_support') return ['medication', 'feeding', 'transfer', 'alertness'];
  if (template === 'child_infant') return ['sleep', 'feeding', 'soothing', 'family'];
  if (template === 'child_school') return ['sleep', 'emotion', 'school', 'peer'];
  return ['sleep', 'emotion', 'transition', 'family'];
}
function templateMeta(template) {
  const meta = {
    child_infant: { label: '0–2 岁 · 婴幼儿生活节律', description: '围绕作息、喂养、安抚和照护衔接建立基线。' },
    child_preschool: { label: '3–6 岁 · 情绪社交期', description: '围绕情绪恢复、活动切换、同伴互动和日常自理建立基线。' },
    child_school: { label: '7–12 岁 · 学龄适应期', description: '围绕上学任务、同伴互动、作息和屏幕切换建立基线。' },
    senior_independent: { label: '60–74 岁 · 自主生活支持', description: '围绕用药、睡眠、食欲和活动，关注保持自主生活的变化。' },
    senior_assisted: { label: '75–84 岁 · 日常协助支持', description: '围绕用药提醒、行走稳定性、日常协助和照护交接，关注维持自主与安全陪同。' },
    senior_high_support: { label: '85 岁以上 · 高支持照护', description: '围绕用药、进食饮水、转移协助、精神回应和多人交接，关注高支持日常照护。' }
  };
  const questions = questionsForTemplate(template); const coreIds = coreIdsForTemplate(template);
  return { ...(meta[template] || meta.child_preschool), coreLabels: coreIds.map(questionId => questions.find(question => question.id === questionId)?.title).filter(Boolean) };
}
const SCREENING_SCALES = {
  child: ['很少或没有', '偶尔出现', '每周多次', '几乎每天 / 明显影响日常'],
  senior: ['从未或无明显变化', '偶有出现', '本周多次', '几乎每天 / 明显影响日常']
};
function sceneFor(userId, recipientId) { return profileFor(userId, recipientId)?.scene === 'senior' ? 'senior' : 'child'; }
function questionsForScene(scene, template = '') { return questionsForTemplate(template || (scene === 'senior' ? 'senior_independent' : 'child_preschool')); }
function screeningHistory(userId, recipientId, template = templateForProfile(profileFor(userId, recipientId)), limit = 8) {
  if (!recipientId) return [];
  return db.prepare('SELECT id, result_encrypted, created_at FROM screenings WHERE user_id = ? AND recipient_id = ? ORDER BY created_at DESC LIMIT 50').all(userId, recipientId)
    .map(row => ({ id: row.id, createdAt: row.created_at, ...open(row.result_encrypted) }))
    .filter(result => !template || (result.template ? result.template === template : (result.scene === 'senior' ? template.startsWith('senior') : template.startsWith('child'))))
    .slice(0, limit);
}
function canonicalSegment(scene, value) {
  const rawSegment = text(value, 40);
  if (rawSegment === '3-6 岁 · 情绪社交期') return '3–6 岁 · 情绪社交期';
  if (scene === 'senior' && rawSegment === '60 岁以上 · 日常用药与生活支持') return '75–84 岁 · 日常协助支持';
  return rawSegment;
}
function normalizedRecipientProfile(profile) {
  if (!profile) return null;
  const scene = profile.scene === 'senior' ? 'senior' : profile.scene === 'child' ? 'child' : '';
  const segment = canonicalSegment(scene, profile.segment);
  if (!scene || !PROFILE_SEGMENTS[scene].includes(segment)) return profile;
  return { ...profile, scene, segment, template: templateFor(scene, segment) };
}
function templateForProfile(profile) { return templateFor(profile?.scene || 'child', canonicalSegment(profile?.scene || 'child', profile?.segment || '3–6 岁 · 情绪社交期')); }
function upgradeRecipientTemplates() {
  for (const row of db.prepare('SELECT id, data_encrypted FROM care_recipients').all()) {
    const stored = open(row.data_encrypted); const normalized = normalizedRecipientProfile(stored);
    if (normalized && (stored.segment !== normalized.segment || stored.template !== normalized.template)) db.prepare('UPDATE care_recipients SET data_encrypted = ? WHERE id = ?').run(seal(normalized), row.id);
  }
}
upgradeRecipientTemplates();
function latestScreening(userId, recipientId, template = templateForProfile(profileFor(userId, recipientId))) { return screeningHistory(userId, recipientId, template, 1)[0] || null; }
function screeningQuestionsFor(userId, recipientId) {
  const profile = profileFor(userId, recipientId); const scene = profile?.scene === 'senior' ? 'senior' : 'child'; const template = templateForProfile(profile); const questionsForCurrentScene = questionsForTemplate(template); const scale = SCREENING_SCALES[scene]; const meta = templateMeta(template);
  const previous = latestScreening(userId, recipientId, template);
  const totalHistory = screeningHistory(userId, recipientId, null, 50).length;
  if (!previous) return { version: `${template}-observation-v1`, scene, template, templateMeta: meta, mode: 'baseline', comparisonAvailable: false, previousCompletedAt: null, baselineNotice: totalHistory ? '该照护对象保留了较早版本的观察记录；因本次年龄支持层级对应的题目已更新，请先用这 8 题建立新的可比较基线。' : '', scale, questions: questionsForCurrentScene.map(({ id: questionId, title, prompt }) => ({ id: questionId, title, prompt, type: 'baseline' })) };
  const coreIds = coreIdsForTemplate(template);
  const availableIds = new Set(questionsForCurrentScene.map(question => question.id));
  const focusIds = [...new Set([...(previous.focus || []).map(item => item.id), ...questionsForCurrentScene.slice().sort((a, b) => Number(previous.answers?.[b.id] || 0) - Number(previous.answers?.[a.id] || 0)).map(question => question.id)])].filter(questionId => availableIds.has(questionId) && !coreIds.includes(questionId)).slice(0, 3);
  const selectedIds = [...coreIds, ...focusIds];
  const recentEvents = eventsFor(userId, recipientId, 50).filter(event => event.occurredAt >= now() - 7 * 24 * 60 * 60 * 1000 && event.details?.kind !== 'safety_incident');
  const tagByQuestion = scene === 'senior'
    ? { medication: 'medication', sleep: 'sleep', appetite: 'food', mobility: 'mobility', memory: 'reminder', daily: 'daily', mood: 'emotion', pain: 'pain', feeding: 'food', transfer: 'mobility', toileting: 'daily', alertness: 'alertness', comfort: 'pain', handoff: 'care_coordination', family: 'care_coordination' }
    : { sleep: 'sleep', feeding: 'food', soothing: 'emotion', routine: 'daily', interaction: 'emotion', outdoor: 'emotion', comfort: 'pain', emotion: 'emotion', transition: 'emotion', peer: 'emotion', kindergarten: 'emotion', school: 'emotion', screen: 'emotion', daily: 'food', communication: 'emotion', family: 'emotion' };
  const questions = selectedIds.map(questionId => {
    const question = questionsForCurrentScene.find(item => item.id === questionId); const previousScore = Number(previous.answers?.[questionId]); const tag = tagByQuestion[questionId];
    const recentTagCount = recentEvents.reduce((count, event) => count + ((event.keywords || []).includes(tag) ? 1 : 0), 0);
    const context = Number.isInteger(previousScore) ? `上次你选择了“${scale[previousScore]}”。` : '';
    const recent = recentTagCount ? `最近 7 天有 ${recentTagCount} 条相关记录。` : '';
    return { id: question.id, title: question.title, prompt: `${context}${recent}${question.prompt}`, type: coreIds.includes(question.id) ? 'core' : 'adaptive', previousScore: Number.isInteger(previousScore) ? previousScore : null, reason: coreIds.includes(question.id) ? '固定对比指标' : '根据上次的重点场景追问' };
  });
  return { version: `${template}-observation-v1`, scene, template, templateMeta: meta, mode: 'follow_up', comparisonAvailable: true, previousCompletedAt: previous.completedAt || previous.createdAt, previousId: previous.id, scale, questions };
}
function planFor(userId, recipientId) {
  if (!recipientId) return null;
  const row = db.prepare('SELECT data_encrypted FROM recipient_care_plans WHERE user_id = ? AND recipient_id = ?').get(userId, recipientId);
  return row ? open(row.data_encrypted) : null;
}
function createScreeningResult(answers, questions, previous = null, profile = { scene: 'child', template: 'child_preschool' }) {
  const scene = profile.scene === 'senior' ? 'senior' : 'child'; const template = templateForProfile(profile);
  const sourceQuestions = questionsForTemplate(template);
  const ranked = questions.map(current => ({ ...sourceQuestions.find(question => question.id === current.id), score: Number(answers[current.id]) })).sort((a, b) => b.score - a.score);
  const total = ranked.reduce((sum, item) => sum + item.score, 0);
  const average = total / Math.max(1, ranked.length);
  const level = average <= 0.75 ? 'routine' : average <= 1.75 ? 'observe' : 'support';
  const copy = scene === 'senior' ? {
    routine: { title: '保持规律记录', summary: '当前更适合维持日常节律，并记录与平时相比的小变化。', professional: '如家人仍然担心，或日常自理、进食、活动等明显受影响，可以主动咨询专业人士。' },
    observe: { title: '建议连续关注', summary: '有一些重复出现的照护场景，建议用 7 天计划记录更具体的事实。', professional: '连续观察后仍频繁影响日常生活，或出现用药不确定、活动明显下降等情况时，建议联系医生、药师或相关专业人士。' },
    support: { title: '建议专业沟通', summary: '多个场景已较频繁影响日常。这个结果不是诊断，建议在记录的同时与专业人士沟通。', professional: '如出现紧急或快速加重的状况，请优先寻求实时医疗或紧急帮助。' }
  }[level] : {
    routine: { title: '常规陪伴', summary: '目前更适合保持规律、记录亮点与小变化。', professional: '如你仍然担心，或日常功能明显受影响，可以主动咨询儿科或相关专业人士。' },
    observe: { title: '建议连续观察', summary: '有一些重复出现的照护场景，建议先用 7 天计划收集更具体的事实。', professional: '连续观察后仍频繁影响睡眠、入园、互动或家庭日常时，建议咨询专业人士。' },
    support: { title: '建议专业沟通', summary: '多个场景已较频繁地影响日常。这个结果不是诊断，建议在记录的同时与专业人士沟通。', professional: '如出现安全风险、快速加重的身体或情绪状况，请优先寻求实时医疗或紧急帮助。' }
  }[level];
  const focus = ranked.filter(item => item.score >= 2).slice(0, 3);
  const selected = focus.length ? focus : ranked.slice(0, 2);
  const comparisonItems = previous ? ranked.map(item => ({ id: item.id, title: item.title, before: Number(previous.answers?.[item.id]), after: item.score })).filter(item => Number.isInteger(item.before)).map(item => ({ ...item, direction: item.after < item.before ? 'less_often' : item.after > item.before ? 'more_often' : 'same' })) : [];
  const deltas = comparisonItems.filter(item => item.direction !== 'same');
  const stable = comparisonItems.filter(item => item.direction === 'same').length;
  const comparison = previous ? { available: true, previousCompletedAt: previous.completedAt || previous.createdAt, items: comparisonItems, changed: deltas, stable } : { available: false, previousCompletedAt: null, items: [], changed: [], stable: 0 };
  const summary = comparison.available ? `${copy.summary} 和上次相比，有 ${deltas.length} 个可比较指标出现变化，${stable} 个指标保持相近。` : copy.summary;
  return { version: `${template}-observation-v1`, scene, template, completedAt: now(), answers, total, average, questionCount: ranked.length, level, ...copy, summary, comparison, questionSnapshot: questions.map(question => ({ id: question.id, title: question.title, type: question.type || 'baseline' })), focus: selected.map(item => ({ id: item.id, title: item.focus, score: item.score, task: item.task })) };
}
function newPlan(result) {
  const tasks = result.focus.map((item, index) => ({ id: `focus-${item.id}`, title: item.task, focus: item.title, completed: false, day: index + 1 }));
  tasks.push({ id: 'shared-note', title: result.scene === 'senior' ? '今晚和家人用一句话同步：是否按计划用药、吃饭和活动是否与平时不同。' : '今晚和家人用一句话同步今天最顺利或最困难的时刻。', focus: '家庭协作', completed: false, day: Math.min(tasks.length + 1, 7) });
  return { id: id(), createdAt: now(), source: 'screening', level: result.level, tasks };
}
function updatePlanTask(userId, recipientId, taskId, completed) {
  const plan = planFor(userId, recipientId);
  if (!plan) return null;
  const task = plan.tasks.find(item => item.id === taskId);
  if (!task) return null;
  task.completed = Boolean(completed); plan.updatedAt = now();
  db.prepare('INSERT INTO recipient_care_plans (user_id, recipient_id, data_encrypted, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, recipient_id) DO UPDATE SET data_encrypted = excluded.data_encrypted, updated_at = excluded.updated_at').run(userId, recipientId, seal(plan), now());
  return plan;
}
function extractKeywords(note) {
  const rules = [['sleep', ['睡不着', '晚睡', '午睡', '夜醒', '入睡']], ['emotion', ['发脾气', '烦躁', '哭', '低落', '焦虑']], ['food', ['挑食', '吃饭', '食欲', '呕吐', '腹泻', '饮水']], ['fever', ['发烧', '发热', '体温']], ['pain', ['疼', '痛', '摔倒', '磕碰', '头晕']], ['breathing', ['咳嗽', '气喘', '呼吸']], ['medication', ['吃药', '服药', '药物']], ['mobility', ['走路', '活动', '起身', '不稳', '转移', '翻身']], ['daily', ['洗漱', '穿衣', '如厕', '清洁']], ['reminder', ['忘记', '遗忘', '漏做', '提醒']], ['alertness', ['嗜睡', '清醒', '反应', '精神']], ['care_coordination', ['交接', '提醒', '家人']]];
  return rules.filter(([, words]) => words.some(word => note.includes(word))).map(([tag]) => tag);
}
function validProfile(input) {
  const scene = input.scene === 'senior' ? 'senior' : input.scene === 'child' ? 'child' : '';
  const segment = canonicalSegment(scene, input.segment);
  const alias = text(input.alias, 30);
  if (!scene || !PROFILE_SEGMENTS[scene].includes(segment) || !alias) return null;
  if (hasDirectIdentifier(alias)) return null;
  return { scene, segment, template: templateFor(scene, segment), alias, updatedAt: now() };
}
function validEvent(input) {
  const category = text(input.category, 30);
  const mood = text(input.mood, 30);
  const note = text(input.note, 240);
  const occurredAt = Number(input.occurredAt);
  if (!category || !mood || !Number.isFinite(occurredAt) || occurredAt > now() + 60 * 1000 || occurredAt < now() - 365 * 24 * 60 * 60 * 1000) return null;
  if (hasDirectIdentifier(note)) return null;
  return { category, mood, note, keywords: extractKeywords(note), provenance: validProvenance(input) };
}
const MEAL_TYPES = ['早餐', '午餐', '晚餐', '加餐'];
const FOOD_GROUPS = ['主食', '优质蛋白', '蔬菜水果'];
const FOOD_COLORS = ['红橙', '绿色', '紫蓝', '白黄'];
const APPETITE_OPTIONS = ['吃得不错', '一般', '不愿尝试', '吃得较少', '无法判断'];
const REACTION_OPTIONS = ['无不适', '待观察', '吞咽或咀嚼不便'];
const INCIDENT_TYPES = ['意识反应异常', '呼吸明显困难', '严重外伤或出血', '跌倒或疑似骨折', '其他需要立即求助的情况'];
const INCIDENT_ACTIONS = ['已联系当地急救或医疗服务', '正在前往医疗服务', '已向专业人员求助'];
const MEDICATION_PERIODS = ['早晨药盒', '午间药盒', '晚间药盒', '睡前药盒', '其他时段'];
const MEDICATION_STATUSES = ['已按计划服用', '未按计划服用', '不确定是否已服'];
const RECORD_REPORTERS = ['primary_caregiver', 'family_caregiver', 'care_worker', 'relayed'];
const RECORD_BASES = ['direct_observation', 'plan_check', 'uncertain'];
const REPORTER_LABELS = { primary_caregiver: '主要照护者现场记录', family_caregiver: '其他家属现场记录', care_worker: '护理人员现场记录', relayed: '事后转述', unspecified: '记录来源未补充' };
const BASIS_LABELS = { direct_observation: '现场观察', plan_check: '对照既有计划/清单', uncertain: '暂不确定', unspecified: '依据未补充' };
const HANDOFF_RECEIVER_ROLES = ['共同照护者', '家庭成员', '护理人员', '暂不需要交接'];
function uniqueOptions(value, options, maximum) {
  return [...new Set((Array.isArray(value) ? value : []).filter(item => options.includes(item)))].slice(0, maximum);
}
function validProvenance(input) {
  const reporter = text(input.reporter, 30);
  const basis = text(input.basis, 30);
  return { reporter: RECORD_REPORTERS.includes(reporter) ? reporter : 'unspecified', basis: RECORD_BASES.includes(basis) ? basis : 'unspecified' };
}
function provenanceFor(event) {
  const value = event?.provenance || {};
  const reporter = RECORD_REPORTERS.includes(value.reporter) ? value.reporter : 'unspecified';
  const basis = RECORD_BASES.includes(value.basis) ? value.basis : 'unspecified';
  return { reporter, basis, reporterLabel: REPORTER_LABELS[reporter], basisLabel: BASIS_LABELS[basis] };
}
function isComparableFact(event) {
  const basis = provenanceFor(event).basis;
  return basis === 'direct_observation' || basis === 'plan_check';
}
function validFoodLog(input) {
  const occurredAt = Number(input.occurredAt); const mealType = text(input.mealType, 12);
  const groups = uniqueOptions(input.groups, FOOD_GROUPS, FOOD_GROUPS.length); const colors = uniqueOptions(input.colors, FOOD_COLORS, FOOD_COLORS.length);
  const appetite = text(input.appetite, 20); const reaction = text(input.reaction, 20); const note = text(input.note, 120);
  if (!MEAL_TYPES.includes(mealType) || !groups.length || !APPETITE_OPTIONS.includes(appetite) || !REACTION_OPTIONS.includes(reaction) || !Number.isFinite(occurredAt) || occurredAt > now() + 60 * 1000 || occurredAt < now() - 365 * 24 * 60 * 60 * 1000 || hasDirectIdentifier(note)) return null;
  return { category: '饮食记录', mood: appetite, note, keywords: [], provenance: validProvenance(input), details: { kind: 'food_log', mealType, groups, colors, appetite, reaction } };
}
function validSafetyIncident(input) {
  const occurredAt = Number(input.occurredAt); const incidentType = text(input.incidentType, 40); const action = text(input.action, 40); const note = text(input.note, 120);
  if (!INCIDENT_TYPES.includes(incidentType) || !INCIDENT_ACTIONS.includes(action) || !Number.isFinite(occurredAt) || occurredAt > now() + 60 * 1000 || occurredAt < now() - 365 * 24 * 60 * 60 * 1000 || hasDirectIdentifier(note)) return null;
  return { category: '紧急情况留存', mood: '已留存', note, keywords: [], provenance: validProvenance(input), details: { kind: 'safety_incident', incidentType, action } };
}
function validMedicationLog(input) {
  const occurredAt = Number(input.occurredAt); const period = text(input.period, 16); const status = text(input.status, 20); const label = text(input.label, 40); const note = text(input.note, 120);
  if (!MEDICATION_PERIODS.includes(period) || !MEDICATION_STATUSES.includes(status) || !Number.isFinite(occurredAt) || occurredAt > now() + 60 * 1000 || occurredAt < now() - 365 * 24 * 60 * 60 * 1000 || hasDirectIdentifier(label) || hasDirectIdentifier(note)) return null;
  return { category: '用药记录', mood: status, note, keywords: ['medication'], provenance: validProvenance(input), details: { kind: 'medication_log', period, status, label } };
}
function saveCareEvent(userId, recipientId, occurredAt, event) {
  const eventId = id();
  db.prepare('INSERT INTO care_events (id, user_id, recipient_id, occurred_at, data_encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(eventId, userId, recipientId, occurredAt, seal(event), now());
  return { id: eventId, occurredAt, ...event };
}
function localDayStart() { const day = new Date(); day.setHours(0, 0, 0, 0); return day.getTime(); }
function foodSummaryFor(userId, recipientId) {
  const records = eventsFor(userId, recipientId, 100).filter(event => event.details?.kind === 'food_log' && event.occurredAt >= localDayStart());
  const colors = [...new Set(records.flatMap(record => record.details.colors || []))];
  return { mealCount: records.length, colorCount: colors.length, colors, records: records.map(record => ({ id: record.id, occurredAt: record.occurredAt, mealType: record.details.mealType, groups: record.details.groups, colors: record.details.colors, appetite: record.details.appetite, reaction: record.details.reaction, provenance: provenanceFor(record) })) };
}
function medicationSummaryFor(userId, recipientId) {
  const records = eventsFor(userId, recipientId, 100).filter(event => event.details?.kind === 'medication_log' && event.occurredAt >= localDayStart());
  const byStatus = Object.fromEntries(MEDICATION_STATUSES.map(status => [status, records.filter(record => record.details.status === status).length]));
  return { total: records.length, onPlan: byStatus['已按计划服用'], missed: byStatus['未按计划服用'], uncertain: byStatus['不确定是否已服'], records: records.map(record => ({ id: record.id, occurredAt: record.occurredAt, period: record.details.period, status: record.details.status, label: record.details.label, provenance: provenanceFor(record) })) };
}
function safetyIncidentsFor(userId, recipientId) {
  return eventsFor(userId, recipientId, 100).filter(event => event.details?.kind === 'safety_incident').slice(0, 10).map(event => ({ id: event.id, occurredAt: event.occurredAt, incidentType: event.details.incidentType, action: event.details.action, note: event.note, provenance: provenanceFor(event) }));
}
function dayKey(timestamp) {
  const value = new Date(timestamp);
  return `${value.getFullYear()}-${value.getMonth() + 1}-${value.getDate()}`;
}
function handoffRecordsFor(userId, recipientId, limit = 10) {
  if (!recipientId) return [];
  return db.prepare('SELECT id, data_encrypted, created_at FROM care_handoffs WHERE user_id = ? AND recipient_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, recipientId, limit)
    .map(row => ({ id: row.id, createdAt: row.created_at, ...open(row.data_encrypted) }));
}
function latestHandoffFor(userId, recipientId) { return handoffRecordsFor(userId, recipientId, 1)[0] || null; }
function evidenceSummaryFor(userId, recipientId) {
  const cutoff = now() - 7 * 24 * 60 * 60 * 1000;
  const records = eventsFor(userId, recipientId, 100).filter(event => event.occurredAt >= cutoff && event.details?.kind !== 'safety_incident');
  const direct = records.filter(event => provenanceFor(event).basis === 'direct_observation');
  const planChecked = records.filter(event => provenanceFor(event).basis === 'plan_check');
  const relayed = records.filter(event => provenanceFor(event).reporter === 'relayed');
  const unknown = records.filter(event => provenanceFor(event).basis === 'unspecified' || provenanceFor(event).basis === 'uncertain');
  const comparable = records.filter(isComparableFact);
  const factDays = new Set(comparable.map(event => dayKey(event.occurredAt))).size;
  const reporterLabels = [...new Set(comparable.map(event => provenanceFor(event).reporterLabel).filter(label => label !== REPORTER_LABELS.unspecified))];
  const latestHandoff = latestHandoffFor(userId, recipientId);
  const level = comparable.length >= 3 && factDays >= 2 ? (latestHandoff ? 'handoff_ready' : 'comparison_ready') : 'collecting';
  const status = {
    collecting: { label: '还在收集事实', detail: '需要至少 3 条“现场观察/计划核对”记录，且覆盖 2 天后，才适合将变化作为连续事实比较。' },
    comparison_ready: { label: '可开始比较', detail: `近 7 天已有 ${comparable.length} 条可比较事实，覆盖 ${factDays} 天；趋势仍只反映家庭记录，不代表医学风险。` },
    handoff_ready: { label: '已形成交接闭环', detail: `近 7 天已有 ${comparable.length} 条可比较事实，并留存过一次交接确认；趋势仍只反映家庭记录。` }
  }[level];
  return {
    windowDays: 7,
    totalRecords: records.length,
    comparableFactCount: comparable.length,
    directObservationCount: direct.length,
    planCheckCount: planChecked.length,
    relayedCount: relayed.length,
    unconfirmedCount: unknown.length,
    factDayCount: factDays,
    reporterLabels,
    level,
    label: status.label,
    detail: status.detail,
    latestHandoff: latestHandoff ? { id: latestHandoff.id, createdAt: latestHandoff.createdAt, receiverRole: latestHandoff.receiverRole, factCount: latestHandoff.facts?.length || 0 } : null
  };
}
function compactHandoffFact(event) {
  const kind = event.details?.kind;
  const content = kind === 'food_log' ? `饮食 · ${event.details.mealType} · ${event.details.appetite}`
    : kind === 'medication_log' ? `用药 · ${event.details.period} · ${event.details.status}`
      : kind === 'safety_incident' ? `紧急留存 · ${event.details.incidentType}`
        : `${event.category} · ${event.mood}`;
  const provenance = provenanceFor(event);
  return { occurredAt: event.occurredAt, content, basis: provenance.basis, basisLabel: provenance.basisLabel, reporterLabel: provenance.reporterLabel };
}
function createHandoff(userId, recipientId, receiverRole) {
  if (!HANDOFF_RECEIVER_ROLES.includes(receiverRole)) return null;
  const cutoff = now() - 24 * 60 * 60 * 1000;
  const facts = eventsFor(userId, recipientId, 50).filter(event => event.occurredAt >= cutoff).slice(0, 6).map(compactHandoffFact);
  if (!facts.length) return null;
  const createdAt = now();
  const record = { id: id(), createdAt, receiverRole, facts, evidence: evidenceSummaryFor(userId, recipientId) };
  db.prepare('INSERT INTO care_handoffs (id, user_id, recipient_id, data_encrypted, created_at) VALUES (?, ?, ?, ?, ?)').run(record.id, userId, recipientId, seal(record), createdAt);
  return record;
}
const ALERT_SOURCE_LABELS = { daily: '日常记录', observation: '连续观察', food: '饮食记录', medication: '用药记录', safety: '紧急留存' };
const ALERT_LEVELS = { urgent: '优先处理', attention: '需要关注', observe: '连续观察' };
function saveCareAlert(userId, recipientId, alert) {
  const createdAt = now();
  const record = { id: id(), createdAt, ...alert };
  db.prepare('INSERT INTO care_alerts (id, user_id, recipient_id, data_encrypted, created_at) VALUES (?, ?, ?, ?, ?)').run(record.id, userId, recipientId, seal(record), createdAt);
  return record;
}
function alertRecordsFor(userId, recipientId, limit = 50) {
  if (!recipientId) return [];
  return db.prepare('SELECT id, data_encrypted, created_at FROM care_alerts WHERE user_id = ? AND recipient_id = ? ORDER BY created_at DESC LIMIT ?').all(userId, recipientId, limit)
    .map(row => ({ id: row.id, createdAt: row.created_at, ...open(row.data_encrypted) }));
}
function uniqueText(values, maximum = 4) { return [...new Set(values.filter(Boolean))].slice(0, maximum); }
function alertSummaryFor(userId, recipientId) {
  const cutoff = now() - 7 * 24 * 60 * 60 * 1000;
  const records = alertRecordsFor(userId, recipientId, 100).filter(alert => alert.createdAt >= cutoff);
  const counts = { urgent: 0, attention: 0, observe: 0 };
  const sourceCounts = Object.fromEntries(Object.keys(ALERT_SOURCE_LABELS).map(source => [source, 0]));
  for (const alert of records) {
    if (counts[alert.level] !== undefined) counts[alert.level] += 1;
    if (sourceCounts[alert.source] !== undefined) sourceCounts[alert.source] += 1;
  }
  const ordered = [...records].sort((a, b) => (b.level === 'urgent') - (a.level === 'urgent') || b.createdAt - a.createdAt);
  const dailyAdvice = uniqueText(ordered.flatMap(alert => Array.isArray(alert.dailyAdvice) ? alert.dailyAdvice : []));
  return {
    windowDays: 7,
    total: records.length,
    urgentCount: counts.urgent,
    attentionCount: counts.attention,
    observeCount: counts.observe,
    sources: Object.entries(sourceCounts).filter(([, count]) => count).map(([source, count]) => ({ source, label: ALERT_SOURCE_LABELS[source], count })),
    alerts: ordered.slice(0, 12).map(alert => ({ id: alert.id, createdAt: alert.createdAt, source: alert.source, sourceLabel: ALERT_SOURCE_LABELS[alert.source] || '照护记录', level: alert.level, levelLabel: ALERT_LEVELS[alert.level] || '连续观察', title: alert.title, evidence: alert.evidence, dailyAdvice: alert.dailyAdvice || [] })),
    dailyAdvice: dailyAdvice.length ? dailyAdvice : ['继续按同一口径记录时间、表现和已采取的照护行动，便于后续比较。']
  };
}
function alertFromEvent(userId, recipientId, event) {
  const created = [];
  const add = alert => created.push(saveCareAlert(userId, recipientId, alert));
  const kind = event.details?.kind;
  if (kind === 'safety_incident') {
    add({ source: 'safety', level: 'urgent', rule: 'safety_incident', title: '已有紧急情况留存', evidence: '已记录一条需要立即求助的情况。', dailyAdvice: ['如当前仍有危险、快速加重、意识或呼吸异常、严重出血等情况，请立即联系当地急救或医疗服务。', '在获得实时帮助后，再补记发生时间、已采取行动和需要交接的事实。'] });
    return created;
  }
  const acute = (event.keywords || []).filter(tag => ['breathing', 'fever', 'pain'].includes(tag));
  if (acute.length) {
    const labels = { breathing: '呼吸相关线索', fever: '发热相关线索', pain: '疼痛、跌倒或不适线索' };
    add({ source: 'daily', level: 'urgent', rule: 'acute_body_signal', title: '出现需要优先核实的身体线索', evidence: `本次日常记录出现：${acute.map(tag => labels[tag]).join('、')}。`, dailyAdvice: ['如果现在出现呼吸困难、意识异常、严重出血或情况快速加重，请立即联系当地急救或医疗服务，不要等待 AI 判断。', '若情况稳定，记录何时开始、表现如何以及已联系或准备联系的人员，便于交接。'] });
  }
  if (kind === 'food_log') {
    if (event.details.reaction === '吞咽或咀嚼不便') add({ source: 'food', level: 'attention', rule: 'food_chewing_swallowing', title: '进食过程出现需要关注的线索', evidence: '本餐被标记为“吞咽或咀嚼不便”。', dailyAdvice: ['下一餐先记录发生在什么食物、进食过程和是否需要协助；不要依据本页自行调整喂养或饮食限制。', '若伴随呛咳、呼吸异常或快速加重，请优先联系当地急救或医疗服务；其他持续问题请及时咨询专业人士。'] });
    const lowAppetiteCount = eventsFor(userId, recipientId, 100).filter(item => item.occurredAt >= now() - 7 * 24 * 60 * 60 * 1000 && isComparableFact(item) && item.details?.kind === 'food_log' && ['不愿尝试', '吃得较少'].includes(item.details.appetite)).length;
    if (lowAppetiteCount === 3) add({ source: 'food', level: 'observe', rule: 'food_acceptance_repeated', title: '进食接受度连续出现变化', evidence: '近 7 天已有 3 次“现场观察/计划核对”的记录为“不愿尝试”或“吃得较少”。', dailyAdvice: ['连续 3 天按同一餐次记录食欲、食物类别和餐后情况，避免只凭一次表现判断。', '如进食变化持续影响日常、饮水或精神状态，请及时咨询专业人士。'] });
  }
  if (kind === 'medication_log' && ['未按计划服用', '不确定是否已服'].includes(event.details.status)) add({ source: 'medication', level: 'attention', rule: `medication_${event.details.status}`, title: '用药状态需要与照护者核对', evidence: `本次被标记为“${event.details.status}”。`, dailyAdvice: ['与照护者核对既有计划和本次记录；不要自行加服、补服、停服或调整剂量。', '涉及漏服、补服或药物调整，请联系医生或药师确认。'] });
  const repeatedTags = { sleep: '睡眠相关情况', emotion: '情绪相关情况', mobility: '活动与行走情况', daily: '日常协助情况', food: '进食相关情况' };
  for (const tag of event.keywords || []) {
    if (!repeatedTags[tag]) continue;
    const count = eventsFor(userId, recipientId, 100).filter(item => item.occurredAt >= now() - 7 * 24 * 60 * 60 * 1000 && isComparableFact(item) && (item.keywords || []).includes(tag)).length;
    if (count === 3) add({ source: 'daily', level: 'observe', rule: `repeated_${tag}`, title: `${repeatedTags[tag]}连续出现`, evidence: `近 7 天已有 3 条“现场观察/计划核对”的相关记录。`, dailyAdvice: ['连续 3 天按同一口径记录发生时间、前后情境、持续多久和之后如何，便于比较变化。', '如频繁影响日常功能，或家人持续担心，可带着这些事实咨询相关专业人士。'] });
  }
  return created;
}
function alertFromScreening(userId, recipientId, result) {
  const highFocus = (result.focus || []).filter(item => Number(item.score) >= 3);
  if (result.level !== 'support' && !highFocus.length) return null;
  const focus = (result.focus || []).filter(item => Number(item.score) >= 2).map(item => item.title).slice(0, 3);
  return saveCareAlert(userId, recipientId, {
    source: 'observation',
    level: result.level === 'support' ? 'attention' : 'observe',
    rule: result.level === 'support' ? 'screening_support' : 'screening_high_focus',
    title: result.level === 'support' ? '本轮观察显示多个场景频繁影响日常' : '本轮观察出现需要连续关注的指标',
    evidence: focus.length ? `本轮重点包括：${focus.join('、')}。` : '本轮观察中有指标被标记为频繁出现或明显影响日常。',
    dailyAdvice: ['从本轮 7 天计划中先完成一项，连续记录相同场景下的时间、表现和照护后是否缓解。', '如这些情况持续影响日常功能，或家人仍然担心，请带着连续记录咨询相关专业人士。']
  });
}
function aggregate(profile, events, screening = null, plan = null) {
  const cutoff = now() - 7 * 24 * 60 * 60 * 1000;
  // Emergency-event notes remain only in the encrypted local record and are never sent to a model.
  const recent = events.filter(event => event.occurredAt >= cutoff && event.details?.kind !== 'safety_incident').slice(0, 30);
  const counts = {};
  for (const event of recent) for (const tag of event.keywords || []) counts[tag] = (counts[tag] || 0) + 1;
  const medicationRecords = recent.filter(event => event.details?.kind === 'medication_log');
  const directFacts = recent.filter(event => provenanceFor(event).basis === 'direct_observation');
  const planChecked = recent.filter(event => provenanceFor(event).basis === 'plan_check');
  const relayed = recent.filter(event => provenanceFor(event).reporter === 'relayed');
  const factDays = new Set([...directFacts, ...planChecked].map(event => dayKey(event.occurredAt))).size;
  return {
    care_scene: profile.scene,
    segment: profile.segment,
    window_days: 7,
    event_count: recent.length,
    data_quality: {
      direct_fact_count: directFacts.length,
      plan_checked_count: planChecked.length,
      relayed_count: relayed.length,
      comparable_fact_days: factDays,
      limitation: '所有信息均来自家庭记录或对既有计划的核对，不代表临床测量或医学风险评分。'
    },
    tag_counts: counts,
    screening: screening ? { level: screening.level, focus: screening.focus.map(item => item.title) } : null,
    care_plan: plan ? { completed_tasks: plan.tasks.filter(task => task.completed).length, total_tasks: plan.tasks.length } : null,
    medication_summary: profile.scene === 'senior' ? {
      logged_count: medicationRecords.length,
      on_plan_count: medicationRecords.filter(event => event.details.status === '已按计划服用').length,
      not_on_plan_count: medicationRecords.filter(event => event.details.status === '未按计划服用').length,
      uncertain_count: medicationRecords.filter(event => event.details.status === '不确定是否已服').length
    } : null,
    events: recent.map(event => ({ category: event.category, mood: event.mood, time_bucket: new Date(event.occurredAt).getHours() < 12 ? 'morning' : new Date(event.occurredAt).getHours() < 18 ? 'afternoon' : 'evening', evidence_basis: provenanceFor(event).basis, tags: event.keywords || [] }))
  };
}
function fallbackAnalysis(summary) {
  const tags = summary.tag_counts;
  const urgent = (tags.fever || 0) + (tags.pain || 0) + (tags.breathing || 0) > 0;
  const observations = [];
  if (summary.care_scene === 'senior' && (summary.medication_summary?.not_on_plan_count || 0) >= 1) observations.push({ title: '存在未按计划用药的记录', evidence: [`7 天内有 ${summary.medication_summary.not_on_plan_count} 次标记为“未按计划服用”`], limitations: '记录无法判断具体原因，也不能据此调整用药方案。', suggested_action: '与照护者核对当日记录和既有医嘱；涉及漏服、补服或药物调整，请联系医生或药师确认。' });
  if ((tags.sleep || 0) >= 2) observations.push({ title: '睡眠节律值得连续观察', evidence: [`7 天内有 ${tags.sleep} 条睡眠线索`], limitations: '记录中的共现不能说明原因，也不构成诊断。', suggested_action: '连续 3 天记录上床、入睡和夜醒时间。' });
  if ((tags.emotion || 0) >= 2) observations.push({ title: '情绪线索有重复出现', evidence: [`7 天内有 ${tags.emotion} 条情绪相关线索`], limitations: '记录不足以判断触发原因。', suggested_action: '记录情绪前的活动切换与安抚是否有效。' });
  if (!observations.length) observations.push({ title: '还未形成稳定趋势', evidence: [`当前纳入 ${summary.event_count} 条事件`], limitations: '数据不足或事件分散，无法判断长期模式。', suggested_action: summary.care_scene === 'senior' ? '连续 3 天记录固定用药时段、食欲、活动和睡眠，便于比较变化。' : '连续 3 天记录同一类指标，便于比较变化。' });
  const comparable = (summary.data_quality?.direct_fact_count || 0) + (summary.data_quality?.plan_checked_count || 0);
  const factDays = summary.data_quality?.comparable_fact_days || 0;
  const confidence = comparable >= 5 && factDays >= 3 ? 'medium' : comparable >= 3 && factDays >= 2 ? 'early' : 'insufficient';
  return { status: urgent ? 'urgent' : 'observe', confidence, observations, follow_up_fields: ['occurred_at', 'category'], escalation: urgent ? '如正在出现快速加重或危及生命的症状，请立即联系当地急救或医疗服务。' : '如担心症状或日常功能明显受影响，请及时咨询专业人员。' };
}
function looksUnsafe(value) { return /确诊|诊断为|处方|剂量|毫克|停药|替代急救/.test(JSON.stringify(value)); }
function safeAnalysis(value, fallback) {
  if (!value || typeof value !== 'object' || looksUnsafe(value)) return fallback;
  const status = ['observe', 'review_soon', 'urgent'].includes(value.status) ? value.status : fallback.status;
  const confidence = ['insufficient', 'early', 'medium'].includes(value.confidence) ? value.confidence : fallback.confidence;
  const observations = Array.isArray(value.observations) ? value.observations.slice(0, 3).map(item => ({ title: text(item.title, 80), evidence: Array.isArray(item.evidence) ? item.evidence.map(part => text(part, 120)).filter(Boolean).slice(0, 3) : [], limitations: text(item.limitations, 160), suggested_action: text(item.suggested_action, 180) })).filter(item => item.title && item.suggested_action) : [];
  return { status, confidence, observations: observations.length ? observations : fallback.observations, follow_up_fields: Array.isArray(value.follow_up_fields) ? value.follow_up_fields.map(field => text(field, 40)).filter(Boolean).slice(0, 2) : fallback.follow_up_fields, escalation: text(value.escalation, 200) || fallback.escalation };
}
function foodIdeasFallback(input) {
  const ingredients = text(input.ingredients, 160).split(/[，,、；;\n]+/).map(item => text(item, 30)).filter(Boolean).slice(0, 7);
  const ingredientLine = ingredients.length ? ingredients : ['本次食材'];
  return {
    ideas: [{
      title: '食材组合小灵感',
      subtitle: '按家中惯用做法准备，再根据实际接受度调整。',
      ingredients: ingredientLine,
      steps: ['将食材分别清洗，并按家庭习惯处理。', '把主食、蛋白和蔬菜组合成一餐；需要时调整软硬和份量。', '用餐后按实际情况记录食欲和餐后情况。'],
      minutes: 20,
      tags: ['家常搭配', '需人工确认']
    }],
    preparation_note: '模型未返回可用的结构化食谱，已提供本地整理提示。',
    safety_note: '请自行核对过敏、年龄适配和咀嚼/吞咽限制；如涉及疾病相关饮食或喂养问题，请咨询医生或营养专业人员。'
  };
}
function foodIdeasUnsafe(value) {
  return /确诊|诊断为|处方|剂量|毫克|停药|补服|药物相互作用|降糖|减肥|治疗/.test(JSON.stringify(value));
}
function safeFoodIdeas(value, fallback) {
  if (!value || typeof value !== 'object' || foodIdeasUnsafe(value)) return fallback;
  const ideas = Array.isArray(value.ideas) ? value.ideas.slice(0, 2).map(item => {
    const minutes = Number(item.minutes);
    return {
      title: text(item.title, 60),
      subtitle: text(item.subtitle, 100),
      ingredients: Array.isArray(item.ingredients) ? item.ingredients.map(part => text(part, 40)).filter(Boolean).slice(0, 8) : [],
      steps: Array.isArray(item.steps) ? item.steps.map(part => text(part, 100)).filter(Boolean).slice(0, 4) : [],
      minutes: Number.isInteger(minutes) && minutes >= 5 && minutes <= 90 ? minutes : 20,
      tags: Array.isArray(item.tags) ? item.tags.map(tag => text(tag, 20)).filter(Boolean).slice(0, 3) : []
    };
  }).filter(item => item.title && item.steps.length >= 2) : [];
  if (!ideas.length) return fallback;
  return {
    ideas,
    preparation_note: text(value.preparation_note, 160) || fallback.preparation_note,
    safety_note: text(value.safety_note, 180) || fallback.safety_note
  };
}
function parseJsonFromModel(content) {
  const raw = String(content || '').trim().replace(/^```json\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(raw);
}
function normalizeBaseUrl(value) {
  const parsed = new URL(text(value, 220));
  if (parsed.protocol !== 'https:' && !(ALLOW_HTTP_LLM && parsed.protocol === 'http:')) throw new Error('模型地址必须使用 HTTPS。');
  return parsed.toString().replace(/\/$/, '');
}
function usageAllowed(userId) {
  const cutoff = now() - 60 * 60 * 1000;
  const count = db.prepare('SELECT COUNT(*) AS count FROM ai_usage WHERE user_id = ? AND created_at > ?').get(userId, cutoff).count;
  if (count >= AI_CALLS_PER_HOUR) return false;
  db.prepare('INSERT INTO ai_usage (id, user_id, created_at) VALUES (?, ?, ?)').run(id(), userId, now());
  return true;
}
async function callFoodIdeas(userId, profile, input) {
  const config = db.prepare('SELECT base_url, model, api_key_encrypted FROM llm_configs WHERE user_id = ?').get(userId);
  if (!config) throw Object.assign(new Error('请先在“设置”中配置你自己的模型 Key。'), { status: 409, code: 'LLM_NOT_CONFIGURED' });
  if (!usageAllowed(userId)) throw Object.assign(new Error(`已达到每小时 ${AI_CALLS_PER_HOUR} 次的 AI 调用上限。`), { status: 429, code: 'RATE_LIMITED' });
  const fallback = foodIdeasFallback(input);
  const system = '你是家庭家常食谱灵感助手。仅根据用户主动提交的本次食材和本餐偏好，返回严格 JSON。你的任务是给出最多 2 种家常搭配与简短做法，不是医疗营养建议。禁止诊断、治疗性饮食、疾病/体重/血糖管理、过敏识别、补充剂、药物或食物相互作用、用药或剂量建议、食品安全或健康效果保证；不要判断某个年龄一定适合。必须提醒用户自行核对过敏、年龄适配和咀嚼/吞咽限制。输出格式：{"ideas":[{"title":"","subtitle":"","ingredients":[""],"steps":[""],"minutes":20,"tags":[""]}],"preparation_note":"","safety_note":""}。每个做法最多 4 步，表达简洁。';
  const user = `本次主动提交的食材与偏好：${JSON.stringify({ care_scene: profile.scene, segment: profile.segment, ingredients: input.ingredients, meal_type: input.mealType, food_groups: input.groups, appetite: input.appetite, reaction: input.reaction })}\n请只按上述 JSON 格式给出家常食谱灵感。`;
  let response;
  try {
    response = await fetch(`${normalizeBaseUrl(config.base_url)}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${open(config.api_key_encrypted)}` }, body: JSON.stringify({ model: config.model, response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, temperature: 0.6, max_tokens: 1000, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }), signal: AbortSignal.timeout(30000) });
  } catch (error) { throw Object.assign(new Error('无法连接模型服务，请检查地址、网络和 API Key。'), { status: 502, code: 'LLM_CONNECT_FAILED' }); }
  if (!response.ok) {
    const providerText = await response.text();
    console.warn('Food idea request failed', response.status, providerText.slice(0, 200));
    throw Object.assign(new Error('模型服务拒绝了食谱请求。请检查模型名、API Key 和账号额度。'), { status: 502, code: 'LLM_REQUEST_FAILED' });
  }
  try {
    const payload = await response.json();
    return { ...safeFoodIdeas(parseJsonFromModel(payload?.choices?.[0]?.message?.content), fallback), source: 'byok_model', model: config.model };
  } catch { return { ...fallback, source: 'safe_fallback', model: null }; }
}
async function callModel(userId, summary, question = '', mode = 'report') {
  const config = db.prepare('SELECT base_url, model, api_key_encrypted FROM llm_configs WHERE user_id = ?').get(userId);
  if (!config) throw Object.assign(new Error('请先在“设置”中配置你自己的模型 Key。'), { status: 409, code: 'LLM_NOT_CONFIGURED' });
  if (!usageAllowed(userId)) throw Object.assign(new Error(`已达到每小时 ${AI_CALLS_PER_HOUR} 次的 AI 调用上限。`), { status: 429, code: 'RATE_LIMITED' });
  const fallback = fallbackAnalysis(summary);
  if (fallback.status === 'urgent') return { ...fallback, source: 'safety_rule' };
  const safetyMode = mode === 'safety_followup';
  const system = safetyMode
    ? '你是家庭照护记录整理助手。仅根据提供的去身份化事件摘要和非紧急问题，返回严格 JSON。你的作用是帮助用户在获得实时帮助后整理交接和后续留存事实。禁止诊断、分诊、急救步骤、药物/剂量建议、处方、替代紧急服务；相关性不能写成因果。若问题出现危险、快速加重、意识或呼吸异常、严重出血、疑似中毒或严重受伤，只能明确要求立即联系当地急救或医疗服务，不得给出远程处置步骤。信息不足必须说明不足。输出格式：{"status":"observe|review_soon|urgent","confidence":"insufficient|early|medium","observations":[{"title":"","evidence":[""],"limitations":"","suggested_action":""}],"follow_up_fields":[""],"escalation":""}。最多 3 条 observations。'
    : '你是家庭照护助手。仅根据提供的去身份化事件摘要，返回严格 JSON。数据仅来自家庭记录或既有计划核对；必须把数据不足、转述记录和缺少连续事实写入 limitations，不能将其表述为医学风险或诊断。禁止诊断、药物/剂量建议、处方、替代紧急服务；相关性不能写成因果。信息不足必须说明不足。输出格式：{"status":"observe|review_soon|urgent","confidence":"insufficient|early|medium","observations":[{"title":"","evidence":[""],"limitations":"","suggested_action":""}],"follow_up_fields":[""],"escalation":""}。最多 3 条 observations。';
  const user = question ? `事件摘要：${JSON.stringify(summary)}\n用户问题：${question}\n${safetyMode ? '仅整理非紧急情况下应留存和交接的事实；仍只返回指定 JSON。' : '请在同一安全边界内回答，仍只返回指定 JSON。'}` : `事件摘要：${JSON.stringify(summary)}\n请生成一份可解释的 7 天照护观察。`;
  let response;
  try {
    // Kimi K2.6 with thinking disabled accepts temperature 0.6. Keeping the
    // setting in this single request path makes report and safety-follow-up
    // calls behave consistently for the current BYOK setup.
    response = await fetch(`${normalizeBaseUrl(config.base_url)}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${open(config.api_key_encrypted)}` }, body: JSON.stringify({ model: config.model, response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, temperature: 0.6, max_tokens: 900, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }), signal: AbortSignal.timeout(30000) });
  } catch (error) { throw Object.assign(new Error('无法连接模型服务，请检查地址、网络和 API Key。'), { status: 502, code: 'LLM_CONNECT_FAILED' }); }
  if (!response.ok) {
    const providerText = await response.text();
    console.warn('LLM request failed', response.status, providerText.slice(0, 200));
    throw Object.assign(new Error('模型服务拒绝了请求。请检查模型名、API Key 和账号额度。'), { status: 502, code: 'LLM_REQUEST_FAILED' });
  }
  try {
    const payload = await response.json();
    const analysis = safeAnalysis(parseJsonFromModel(payload?.choices?.[0]?.message?.content), fallback);
    return { ...analysis, source: 'byok_model' };
  } catch { return { ...fallback, source: 'safe_fallback' }; }
}
function createReport(userId, recipientId, summary, analysis) {
  const createdAt = now();
  const config = publicLLMConfig(userId);
  const report = {
    id: id(),
    kind: 'weekly_report',
    createdAt,
    analysis,
    metadata: {
      source: analysis.source,
      model: analysis.source === 'byok_model' ? config.model : null,
      eventCount: summary.event_count,
      windowDays: summary.window_days,
      dataQuality: summary.data_quality || null,
      sentToModel: '仅类别、状态、时间段、记录依据与本地提取标签；不含原始备注或身份信息。'
    },
    feedback: null
  };
  db.prepare('INSERT INTO reports (id, user_id, recipient_id, kind, data_encrypted, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(report.id, userId, recipientId, report.kind, seal(report), createdAt);
  return report;
}
function latestReport(userId, recipientId) {
  if (!recipientId) return null;
  const row = db.prepare("SELECT data_encrypted FROM reports WHERE user_id = ? AND recipient_id = ? AND kind = 'weekly_report' ORDER BY created_at DESC LIMIT 1").get(userId, recipientId);
  if (!row) return null;
  const report = open(row.data_encrypted);
  return report?.analysis && report?.metadata ? report : null;
}
function updateReportFeedback(userId, recipientId, reportId, rating) {
  if (!['helpful', 'not_helpful'].includes(rating)) return null;
  const row = db.prepare("SELECT data_encrypted FROM reports WHERE id = ? AND user_id = ? AND recipient_id = ? AND kind = 'weekly_report'").get(reportId, userId, recipientId);
  if (!row) return false;
  const report = open(row.data_encrypted);
  if (!report?.analysis || !report?.metadata) return false;
  report.feedback = { rating, updatedAt: now() };
  db.prepare('UPDATE reports SET data_encrypted = ? WHERE id = ? AND user_id = ? AND recipient_id = ?').run(seal(report), reportId, userId, recipientId);
  return report;
}
function serveStatic(req, res) {
  const requestPath = new URL(req.url, 'http://localhost').pathname;
  const relative = requestPath === '/' ? 'index.html' : decodeURIComponent(requestPath).replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`) && target !== path.join(PUBLIC_DIR, 'index.html')) return fail(res, 403, 'FORBIDDEN', 'Forbidden.');
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return fail(res, 404, 'NOT_FOUND', 'Not found.');
  const type = target.endsWith('.html') ? 'text/html; charset=utf-8' : target.endsWith('.css') ? 'text/css; charset=utf-8' : target.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; base-uri 'self'; frame-ancestors 'none'" });
  fs.createReadStream(target).pipe(res);
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/auth/register') {
      const body = await readJson(req); const email = text(body.email, 120).toLowerCase(); const password = String(body.password || '');
      if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 12) return fail(res, 422, 'INVALID_ACCOUNT', '请输入有效邮箱，并使用至少 12 位密码。');
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return fail(res, 409, 'EMAIL_USED', '该邮箱已注册。');
      const record = await passwordRecord(password); const userId = id();
      db.prepare('INSERT INTO users (id, email, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, email, record.salt, record.hash, now());
      setSessionCookie(res, makeSession(userId)); audit(userId, 'account_registered'); return json(res, 201, { user: { id: userId, email } });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const body = await readJson(req); const email = text(body.email, 120).toLowerCase(); const password = String(body.password || ''); const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (!user || !(await passwordMatches(password, user.password_salt, user.password_hash))) return fail(res, 401, 'INVALID_LOGIN', '邮箱或密码不正确。');
      setSessionCookie(res, makeSession(user.id)); audit(user.id, 'login'); return json(res, 200, { user: { id: user.id, email: user.email } });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') { const user = currentUser(req); if (user) { const token = getCookie(req, 'sid'); db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token)); audit(user.id, 'logout'); } clearSessionCookie(res); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/api/me') { const user = currentUser(req); return json(res, 200, { user: user ? { id: user.id, email: user.email } : null }); }
    const user = requireUser(req, res); if (!user) return;
    if (req.method === 'GET' && url.pathname === '/api/recipients') return json(res, 200, { recipients: recipientsFor(user.id).map(recipient => ({ id: recipient.id, alias: recipient.alias, scene: recipient.scene, segment: recipient.segment, template: templateForProfile(recipient), updatedAt: recipient.updatedAt })) });
    if (req.method === 'POST' && url.pathname === '/api/recipients') { const profile = validProfile(await readJson(req)); if (!profile) return fail(res, 422, 'INVALID_PROFILE', '请填写照护别名、场景和有效年龄分层；不要填写姓名或联系方式。'); const recipient = { id: id(), ...profile, createdAt: now() }; db.prepare('INSERT INTO care_recipients (id, user_id, data_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(recipient.id, user.id, seal(profile), recipient.createdAt, now()); audit(user.id, 'recipient_created'); return json(res, 201, { recipient }); }
    const recipient = requestedRecipient(req, user.id);
    if (req.method === 'GET' && url.pathname === '/api/profile') return json(res, 200, { profile: recipient, recipientId: recipient?.id || null, sceneLocked: profileSceneLocked(user.id, recipient?.id) });
    if (req.method === 'PUT' && url.pathname === '/api/profile') { const profile = validProfile(await readJson(req)); const existing = recipient; if (!profile) return fail(res, 422, 'INVALID_PROFILE', '请填写照护别名、场景和有效年龄分层；不要填写姓名或联系方式。'); if (existing && (existing.scene !== profile.scene || templateForProfile(existing) !== profile.template) && profileSceneLocked(user.id, existing.id)) return fail(res, 409, 'SCENE_LOCKED', '这个照护对象已经有观察或记录。为避免不同年龄模板的数据混在一起，不能再修改场景或年龄分层；请新建照护对象。'); const recipientId = existing?.id || id(); if (existing) db.prepare('UPDATE care_recipients SET data_encrypted = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(seal(profile), now(), recipientId, user.id); else db.prepare('INSERT INTO care_recipients (id, user_id, data_encrypted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(recipientId, user.id, seal(profile), now(), now()); const saved = { id: recipientId, ...profile }; audit(user.id, existing ? 'recipient_updated' : 'recipient_created'); return json(res, 200, { profile: saved, recipient: saved, sceneLocked: false }); }
    if (req.method === 'GET' && url.pathname === '/api/events') return json(res, 200, { events: eventsFor(user.id, recipient?.id) });
    if (req.method === 'GET' && url.pathname === '/api/evidence/summary') return json(res, 200, { summary: evidenceSummaryFor(user.id, recipient?.id) });
    if (req.method === 'GET' && url.pathname === '/api/handoffs/latest') return json(res, 200, { handoff: latestHandoffFor(user.id, recipient?.id) });
    if (req.method === 'POST' && url.pathname === '/api/handoffs') {
      if (!recipient) return fail(res, 409, 'PROFILE_REQUIRED', '请先建立照护对象。');
      const body = await readJson(req); const handoff = createHandoff(user.id, recipient.id, text(body.receiverRole, 20));
      if (!handoff) return fail(res, 422, 'INVALID_HANDOFF', '请先保存至少一条近 24 小时的记录，并选择交接对象。');
      audit(user.id, 'care_handoff_confirmed'); return json(res, 201, { handoff, evidence: evidenceSummaryFor(user.id, recipient.id) });
    }
    if (req.method === 'POST' && url.pathname === '/api/events') { if (!recipient) return fail(res, 409, 'PROFILE_REQUIRED', '请先建立照护对象。'); const body = await readJson(req); const event = validEvent(body); if (!event) return fail(res, 422, 'INVALID_EVENT', '记录字段无效，或备注中包含联系方式/证件号。'); const saved = saveCareEvent(user.id, recipient.id, Number(body.occurredAt), event); const alerts = alertFromEvent(user.id, recipient.id, saved); audit(user.id, 'event_created'); return json(res, 201, { event: saved, alerts, alertSummary: alertSummaryFor(user.id, recipient.id) }); }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/events/')) { if (!recipient) return fail(res, 409, 'PROFILE_REQUIRED', '请先建立照护对象。'); const eventId = url.pathname.slice('/api/events/'.length); db.prepare('DELETE FROM care_events WHERE id = ? AND user_id = ? AND recipient_id = ?').run(eventId, user.id, recipient.id); audit(user.id, 'event_deleted'); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/api/alerts/summary') return json(res, 200, { summary: alertSummaryFor(user.id, recipient?.id) });
    if (req.method === 'GET' && url.pathname === '/api/food/summary') return json(res, 200, { summary: foodSummaryFor(user.id, recipient?.id) });
    if (req.method === 'POST' && url.pathname === '/api/food/logs') { if (!recipient) return fail(res, 409, 'PROFILE_REQUIRED', '请先建立照护对象。'); const body = await readJson(req); const event = validFoodLog(body); if (!event) return fail(res, 422, 'INVALID_FOOD_LOG', '请完成用餐类型、食物类别、食欲和反应；备注不要包含联系方式。'); const saved = saveCareEvent(user.id, recipient.id, Number(body.occurredAt), event); const alerts = alertFromEvent(user.id, recipient.id, saved); audit(user.id, 'food_log_created'); return json(res, 201, { event: saved, summary: foodSummaryFor(user.id, recipient.id), alerts, alertSummary: alertSummaryFor(user.id, recipient.id) }); }
    if (req.method === 'POST' && url.pathname === '/api/food/ideas') {
      if (!recipient) return fail(res, 409, 'PROFILE_REQUIRED', '请先建立照护对象。');
      const body = await readJson(req);
      const input = {
        ingredients: text(body.ingredients, 160),
        mealType: text(body.mealType, 12),
        groups: uniqueOptions(body.groups, FOOD_GROUPS, FOOD_GROUPS.length),
        appetite: text(body.appetite, 20),
        reaction: text(body.reaction, 20)
      };
      if (input.ingredients.length < 2 || hasDirectIdentifier(input.ingredients) || !MEAL_TYPES.includes(input.mealType) || !input.groups.length || !APPETITE_OPTIONS.includes(input.appetite) || !REACTION_OPTIONS.includes(input.reaction)) return fail(res, 422, 'INVALID_FOOD_IDEA_INPUT', '请填写今日食材，并完成本餐类型、食物类别、食欲和餐后情况；不要填写联系方式。');
      const ideas = await callFoodIdeas(user.id, recipient, input);
      audit(user.id, 'food_ideas_requested');
      return json(res, 200, { ideas });
    }
    if (req.method === 'GET' && url.pathname === '/api/medications/summary') return json(res, 200, { summary: medicationSummaryFor(user.id, recipient?.id) });
    if (req.method === 'POST' && url.pathname === '/api/medications/logs') { if (!recipient) return fail(res, 409, 'PROFILE_REQUIRED', '请先建立照护对象。'); const body = await readJson(req); const event = validMedicationLog(body); if (!event) return fail(res, 422, 'INVALID_MEDICATION_LOG', '请完成用药时段和状态；药品标记或备注不要包含联系方式。'); const saved = saveCareEvent(user.id, recipient.id, Number(body.occurredAt), event); const alerts = alertFromEvent(user.id, recipient.id, saved); audit(user.id, 'medication_log_created'); return json(res, 201, { event: saved, summary: medicationSummaryFor(user.id, recipient.id), alerts, alertSummary: alertSummaryFor(user.id, recipient.id) }); }
    if (req.method === 'GET' && url.pathname === '/api/safety/incidents') return json(res, 200, { incidents: safetyIncidentsFor(user.id, recipient?.id) });
    if (req.method === 'POST' && url.pathname === '/api/safety/incidents') { if (!recipient) return fail(res, 409, 'PROFILE_REQUIRED', '请先建立照护对象。'); const body = await readJson(req); const event = validSafetyIncident(body); if (!event) return fail(res, 422, 'INVALID_SAFETY_INCIDENT', '请完成情况与已采取的求助行动；备注不要包含联系方式。'); const saved = saveCareEvent(user.id, recipient.id, Number(body.occurredAt), event); const alerts = alertFromEvent(user.id, recipient.id, saved); audit(user.id, 'safety_incident_created'); return json(res, 201, { incident: { id: saved.id, occurredAt: saved.occurredAt, ...saved.details, note: saved.note }, alerts, alertSummary: alertSummaryFor(user.id, recipient.id) }); }
    if (req.method === 'GET' && url.pathname === '/api/screening/questions') return json(res, 200, screeningQuestionsFor(user.id, recipient?.id));
    if (req.method === 'GET' && url.pathname === '/api/screenings/latest') return json(res, 200, { result: latestScreening(user.id, recipient?.id) });
    if (req.method === 'GET' && url.pathname === '/api/screenings/history') return json(res, 200, { history: screeningHistory(user.id, recipient?.id).map(result => ({ id: result.id, completedAt: result.completedAt || result.createdAt, level: result.level, total: result.total, questionCount: result.questionCount || questionsForScene(result.scene || 'child', result.template).length, comparison: result.comparison || { available: false, changed: [] } })) });
    if (req.method === 'POST' && url.pathname === '/api/screenings') {
      if (!recipient) return fail(res, 409, 'PROFILE_REQUIRED', '请先建立照护对象。'); const body = await readJson(req); const answers = body.answers || {}; const session = screeningQuestionsFor(user.id, recipient.id);
      if (!session.questions.every(question => Number.isInteger(answers[question.id]) && answers[question.id] >= 0 && answers[question.id] <= 3)) return fail(res, 422, 'INVALID_SCREENING', '请完成这一轮全部家庭观察题目。');
      const result = createScreeningResult(answers, session.questions, session.comparisonAvailable ? latestScreening(user.id, recipient.id, session.template) : null, recipient); result.evidence = evidenceSummaryFor(user.id, recipient.id); const plan = newPlan(result);
      db.prepare('INSERT INTO screenings (id, user_id, recipient_id, result_encrypted, created_at) VALUES (?, ?, ?, ?, ?)').run(id(), user.id, recipient.id, seal(result), now());
      db.prepare('INSERT INTO recipient_care_plans (user_id, recipient_id, data_encrypted, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, recipient_id) DO UPDATE SET data_encrypted = excluded.data_encrypted, updated_at = excluded.updated_at').run(user.id, recipient.id, seal(plan), now());
      const alert = alertFromScreening(user.id, recipient.id, result);
      audit(user.id, 'screening_completed'); return json(res, 201, { result, plan, alert, alertSummary: alertSummaryFor(user.id, recipient.id) });
    }
    if (req.method === 'GET' && url.pathname === '/api/care-plan') return json(res, 200, { plan: planFor(user.id, recipient?.id) });
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/care-plan/tasks/')) { if (!recipient) return fail(res, 409, 'PROFILE_REQUIRED', '请先建立照护对象。'); const taskId = url.pathname.slice('/api/care-plan/tasks/'.length); const body = await readJson(req); const plan = updatePlanTask(user.id, recipient.id, taskId, body.completed); if (!plan) return fail(res, 404, 'PLAN_TASK_NOT_FOUND', '没有找到该计划任务。'); audit(user.id, 'care_plan_task_updated'); return json(res, 200, { plan }); }
    if (req.method === 'GET' && url.pathname === '/api/settings/llm') return json(res, 200, { config: publicLLMConfig(user.id) });
    if (req.method === 'PUT' && url.pathname === '/api/settings/llm') { const body = await readJson(req); let baseUrl; try { baseUrl = normalizeBaseUrl(body.baseUrl); } catch (error) { return fail(res, 422, 'INVALID_BASE_URL', error.message); } const model = text(body.model, 100); const apiKey = text(body.apiKey, 600); if (!model || apiKey.length < 8) return fail(res, 422, 'INVALID_LLM_CONFIG', '请输入模型名和有效 API Key。'); db.prepare('INSERT INTO llm_configs (user_id, base_url, model, api_key_encrypted, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET base_url = excluded.base_url, model = excluded.model, api_key_encrypted = excluded.api_key_encrypted, updated_at = excluded.updated_at').run(user.id, baseUrl, model, seal(apiKey), now()); audit(user.id, 'llm_config_updated'); return json(res, 200, { config: publicLLMConfig(user.id) }); }
    if (req.method === 'DELETE' && url.pathname === '/api/settings/llm') { db.prepare('DELETE FROM llm_configs WHERE user_id = ?').run(user.id); audit(user.id, 'llm_config_deleted'); return json(res, 200, { ok: true }); }
    if (req.method === 'GET' && url.pathname === '/api/reports/latest') return json(res, 200, { report: latestReport(user.id, recipient?.id) });
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/reports/') && url.pathname.endsWith('/feedback')) { if (!recipient) return fail(res, 409, 'PROFILE_REQUIRED', '请先建立照护对象。'); const reportId = url.pathname.slice('/api/reports/'.length, -'/feedback'.length); if (!/^[a-f0-9-]{36}$/i.test(reportId)) return fail(res, 404, 'REPORT_NOT_FOUND', '没有找到这份报告。'); const body = await readJson(req); const report = updateReportFeedback(user.id, recipient.id, reportId, body.rating); if (!report) return fail(res, 404, 'REPORT_NOT_FOUND', '没有找到这份可评价的报告。'); audit(user.id, `report_feedback_${report.feedback.rating}`); return json(res, 200, { report }); }
    if (req.method === 'POST' && url.pathname === '/api/ai/report') { const profile = recipient; if (!profile) return fail(res, 409, 'PROFILE_REQUIRED', '请先完成照护档案。'); const summary = aggregate(profile, eventsFor(user.id, recipient.id), latestScreening(user.id, recipient.id, templateForProfile(profile)), planFor(user.id, recipient.id)); const analysis = await callModel(user.id, summary); const report = createReport(user.id, recipient.id, summary, analysis); audit(user.id, 'ai_report_requested'); return json(res, 200, { analysis, report }); }
    if (req.method === 'POST' && url.pathname === '/api/ai/ask') { const profile = recipient; if (!profile) return fail(res, 409, 'PROFILE_REQUIRED', '请先完成照护档案。'); const body = await readJson(req); const question = text(body.question, 300); if (!question || hasDirectIdentifier(question)) return fail(res, 422, 'INVALID_QUESTION', '请输入问题，且不要包含电话、邮箱或证件号。'); const analysis = await callModel(user.id, aggregate(profile, eventsFor(user.id, recipient.id), latestScreening(user.id, recipient.id, templateForProfile(profile)), planFor(user.id, recipient.id)), question); audit(user.id, 'ai_question_requested'); return json(res, 200, { analysis }); }
    if (req.method === 'POST' && url.pathname === '/api/safety/ask') { const profile = recipient; if (!profile) return fail(res, 409, 'PROFILE_REQUIRED', '请先完成照护档案。'); const body = await readJson(req); const question = text(body.question, 300); if (!question || hasDirectIdentifier(question)) return fail(res, 422, 'INVALID_SAFETY_QUESTION', '请输入非紧急的留存问题，且不要包含电话、邮箱或证件号。'); const analysis = await callModel(user.id, aggregate(profile, eventsFor(user.id, recipient.id), latestScreening(user.id, recipient.id, templateForProfile(profile)), planFor(user.id, recipient.id)), question, 'safety_followup'); audit(user.id, 'safety_follow_up_requested'); return json(res, 200, { analysis }); }
    return fail(res, 404, 'NOT_FOUND', 'Not found.');
  } catch (error) {
    console.error(error);
    return fail(res, error.status || 500, error.code || 'INTERNAL_ERROR', error.message || '服务暂时不可用。');
  }
}
const server = http.createServer((req, res) => { if (req.url.startsWith('/api/') || req.url === '/health') handle(req, res); else serveStatic(req, res); });
if (require.main === module) server.listen(PORT, () => console.log(`Care Companion live server listening on http://127.0.0.1:${PORT}`));
module.exports = { server };
