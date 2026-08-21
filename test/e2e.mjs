import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const port = 4311;
const mockPort = 4312;
const tempDir = await mkdtemp(path.join(tmpdir(), 'care-companion-e2e-'));
const encryptionKey = crypto.randomBytes(32).toString('base64');
const children = [];
function start(command, args, env) {
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe' });
  children.push(child);
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  return child;
}
async function waitFor(url) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
async function request(route, { method = 'GET', body, cookie, recipientId } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(recipientId ? { 'X-Care-Recipient-Id': recipientId } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json();
  return { response, payload, cookie: response.headers.get('set-cookie')?.split(';')[0] || cookie };
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode) return;
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

try {
  start('node', ['scripts/mock-llm.js'], { MOCK_LLM_PORT: String(mockPort) });
  start('node', ['server.js'], { PORT: String(port), DATABASE_PATH: path.join(tempDir, 'pilot.sqlite'), APP_ENCRYPTION_KEY: encryptionKey, ALLOW_HTTP_LLM: 'true', AI_CALLS_PER_HOUR: '20' });
  await waitFor(`http://127.0.0.1:${port}/health`);

  let result = await request('/api/auth/register', { method: 'POST', body: { email: 'pilot-a@example.com', password: 'correct-horse-battery' } });
  assert.equal(result.response.status, 201); const userACookie = result.cookie;
  result = await request('/api/profile', { method: 'PUT', cookie: userACookie, body: { alias: '小树', scene: 'child', segment: '3-6 岁 · 情绪社交期' } });
  assert.equal(result.response.status, 200);
  const childRecipientId = result.payload.profile.id;
  result = await request('/api/screening/questions', { cookie: userACookie });
  assert.equal(result.response.status, 200); assert.equal(result.payload.questions.length, 8);
  const answers = Object.fromEntries(result.payload.questions.map((question, index) => [question.id, index < 3 ? 2 : 1]));
  result = await request('/api/screenings', { method: 'POST', cookie: userACookie, body: { answers } });
  assert.equal(result.response.status, 201); assert.ok(result.payload.plan.tasks.length >= 2);
  result = await request('/api/screening/questions', { cookie: userACookie });
  assert.equal(result.response.status, 200); assert.equal(result.payload.mode, 'follow_up'); assert.equal(result.payload.questions.length, 7);
  assert.equal(result.payload.questions.filter(question => question.type === 'core').length, 4);
  assert.equal(result.payload.questions.filter(question => question.type === 'adaptive').length, 3);
  const followUpAnswers = Object.fromEntries(result.payload.questions.map(question => [question.id, question.id === 'sleep' ? 1 : 2]));
  result = await request('/api/screenings', { method: 'POST', cookie: userACookie, body: { answers: followUpAnswers } });
  assert.equal(result.response.status, 201); assert.equal(result.payload.result.comparison.available, true); assert.ok(result.payload.result.comparison.changed.length >= 1); assert.equal(result.payload.result.comparison.items.length, 7); assert.ok(result.payload.result.comparison.items.some(item => item.direction === 'same'));
  const followUpPlanTaskId = result.payload.plan.tasks[0].id;
  result = await request('/api/screenings/history', { cookie: userACookie });
  assert.equal(result.response.status, 200); assert.equal(result.payload.history.length, 2); assert.equal(result.payload.history[0].comparison.available, true);
  result = await request(`/api/care-plan/tasks/${followUpPlanTaskId}`, { method: 'PATCH', cookie: userACookie, body: { completed: true } });
  assert.equal(result.response.status, 200); assert.equal(result.payload.plan.tasks[0].completed, true);
  for (const [category, mood, note, occurredAt] of [['睡眠', '烦躁', '昨晚晚睡，入睡需要安抚。', Date.now() - 25 * 60 * 60 * 1000], ['情绪行为', '烦躁', '晚餐前发脾气。', Date.now()], ['睡眠', '平稳', '午睡后精神不错。', Date.now()]]) {
    result = await request('/api/events', { method: 'POST', cookie: userACookie, body: { category, mood, note, occurredAt, reporter: 'primary_caregiver', basis: 'direct_observation' } });
    assert.equal(result.response.status, 201);
  }
  result = await request('/api/evidence/summary', { cookie: userACookie });
  assert.equal(result.response.status, 200); assert.equal(result.payload.summary.comparableFactCount, 3); assert.equal(result.payload.summary.factDayCount, 2); assert.equal(result.payload.summary.level, 'comparison_ready');
  result = await request('/api/food/logs', { method: 'POST', cookie: userACookie, body: { occurredAt: Date.now(), mealType: '午餐', groups: ['主食', '优质蛋白', '蔬菜水果'], colors: ['红橙', '绿色'], appetite: '吃得不错', reaction: '吞咽或咀嚼不便', note: '愿意尝试新的蔬菜。' } });
  assert.equal(result.response.status, 201); assert.equal(result.payload.summary.mealCount, 1); assert.equal(result.payload.summary.colorCount, 2); assert.equal(result.payload.alerts.length, 1); assert.equal(result.payload.alerts[0].source, 'food');
  result = await request('/api/food/summary', { cookie: userACookie });
  assert.equal(result.response.status, 200); assert.equal(result.payload.summary.records[0].mealType, '午餐');
  result = await request('/api/alerts/summary', { cookie: userACookie });
  assert.equal(result.response.status, 200); assert.ok(result.payload.summary.attentionCount >= 1); assert.ok(result.payload.summary.total >= 2);
  result = await request('/api/safety/incidents', { method: 'POST', cookie: userACookie, body: { occurredAt: Date.now(), incidentType: '其他需要立即求助的情况', action: '已向专业人员求助', note: '事后留存事实。' } });
  assert.equal(result.response.status, 201); assert.equal(result.payload.alerts[0].level, 'urgent');
  result = await request('/api/safety/incidents', { cookie: userACookie });
  assert.equal(result.response.status, 200); assert.equal(result.payload.incidents.length, 1);
  result = await request('/api/handoffs', { method: 'POST', cookie: userACookie, body: { receiverRole: '共同照护者' } });
  assert.equal(result.response.status, 201); assert.equal(result.payload.handoff.receiverRole, '共同照护者'); assert.equal(result.payload.evidence.level, 'handoff_ready'); assert.equal(JSON.stringify(result.payload.handoff).includes('事后留存事实。'), false, 'handoff must not include raw safety note');
  result = await request('/api/handoffs/latest', { cookie: userACookie });
  assert.equal(result.response.status, 200); assert.equal(result.payload.handoff.receiverRole, '共同照护者');
  result = await request('/api/alerts/summary', { cookie: userACookie });
  assert.equal(result.response.status, 200); assert.ok(result.payload.summary.urgentCount >= 1); assert.ok(result.payload.summary.dailyAdvice.length >= 1);
  result = await request('/api/settings/llm', { method: 'PUT', cookie: userACookie, body: { baseUrl: `http://127.0.0.1:${mockPort}/v1`, model: 'test-model', apiKey: 'local-test-key' } });
  assert.equal(result.response.status, 200); assert.equal(result.payload.config.configured, true);
  result = await request('/api/food/ideas', { method: 'POST', cookie: userACookie, recipientId: childRecipientId, body: { ingredients: '米饭、鸡蛋、青菜', mealType: '午餐', groups: ['主食', '优质蛋白', '蔬菜水果'], appetite: '吃得不错', reaction: '无不适' } });
  assert.equal(result.response.status, 200); assert.equal(result.payload.ideas.source, 'byok_model'); assert.equal(result.payload.ideas.ideas.length, 2); assert.equal(result.payload.ideas.ideas[0].steps.length, 3);
  result = await request('/api/safety/ask', { method: 'POST', cookie: userACookie, recipientId: childRecipientId, body: { question: '事后还应补记哪些事实，方便照护者交接？' } });
  assert.equal(result.response.status, 200); assert.equal(result.payload.analysis.source, 'byok_model'); assert.equal(result.payload.analysis.observations.length, 1);
  result = await request('/api/ai/report', { method: 'POST', cookie: userACookie, body: {} });
  assert.equal(result.response.status, 200); assert.equal(result.payload.analysis.source, 'byok_model'); assert.equal(result.payload.analysis.observations.length, 1);
  assert.ok(result.payload.report?.id); assert.equal(result.payload.report.metadata.eventCount, 4); assert.equal(result.payload.report.metadata.model, 'test-model');
  const reportId = result.payload.report.id;
  result = await request(`/api/reports/${reportId}/feedback`, { method: 'PATCH', cookie: userACookie, body: { rating: 'helpful' } });
  assert.equal(result.response.status, 200); assert.equal(result.payload.report.feedback.rating, 'helpful');
  result = await request('/api/reports/latest', { cookie: userACookie });
  assert.equal(result.response.status, 200); assert.equal(result.payload.report.id, reportId); assert.equal(result.payload.report.feedback.rating, 'helpful');
  result = await request('/api/events', { cookie: userACookie }); assert.equal(result.payload.events.length, 5);
  result = await request('/api/profile', { cookie: userACookie }); assert.equal(result.payload.sceneLocked, true);
  result = await request('/api/profile', { method: 'PUT', cookie: userACookie, body: { alias: '小树', scene: 'senior', segment: '60 岁以上 · 日常用药与生活支持' } });
  assert.equal(result.response.status, 409);
  result = await request('/api/recipients', { method: 'POST', cookie: userACookie, body: { alias: '奶奶', scene: 'senior', segment: '75–84 岁 · 日常协助支持' } });
  assert.equal(result.response.status, 201); const seniorRecipientId = result.payload.recipient.id;
  result = await request('/api/recipients', { cookie: userACookie }); assert.equal(result.response.status, 200); assert.equal(result.payload.recipients.length, 2);
  result = await request('/api/events', { cookie: userACookie, recipientId: seniorRecipientId }); assert.equal(result.payload.events.length, 0);
  result = await request('/api/screening/questions', { cookie: userACookie, recipientId: seniorRecipientId }); assert.equal(result.payload.scene, 'senior'); assert.equal(result.payload.template, 'senior_assisted'); assert.ok(result.payload.questions.some(question => question.id === 'memory'));
  const assistedAnswers = Object.fromEntries(result.payload.questions.map((question, index) => [question.id, index < 4 ? 2 : 1]));
  result = await request('/api/screenings', { method: 'POST', cookie: userACookie, recipientId: seniorRecipientId, body: { answers: assistedAnswers } }); assert.equal(result.response.status, 201); assert.equal(result.payload.result.template, 'senior_assisted');
  result = await request('/api/screening/questions', { cookie: userACookie, recipientId: seniorRecipientId }); assert.equal(result.payload.mode, 'follow_up'); assert.deepEqual(result.payload.questions.slice(0, 4).map(question => question.id), ['medication', 'memory', 'mobility', 'daily']);
  result = await request('/api/medications/logs', { method: 'POST', cookie: userACookie, recipientId: seniorRecipientId, body: { occurredAt: Date.now(), period: '早晨药盒', status: '已按计划服用', label: '家庭药盒', note: '已确认。' } }); assert.equal(result.response.status, 201);
  result = await request('/api/events', { cookie: userACookie, recipientId: childRecipientId }); assert.equal(result.payload.events.length, 5, 'a child record must not include the senior medication log');
  result = await request('/api/recipients', { method: 'POST', cookie: userACookie, body: { alias: '太奶奶', scene: 'senior', segment: '85 岁以上 · 高支持照护' } }); assert.equal(result.response.status, 201); const highSupportRecipientId = result.payload.recipient.id;
  result = await request('/api/screening/questions', { cookie: userACookie, recipientId: highSupportRecipientId }); assert.equal(result.payload.template, 'senior_high_support'); assert.ok(result.payload.questions.some(question => question.id === 'feeding')); assert.ok(result.payload.questions.some(question => question.id === 'transfer'));
  const highSupportAnswers = Object.fromEntries(result.payload.questions.map((question, index) => [question.id, index < 4 ? 2 : 1]));
  result = await request('/api/screenings', { method: 'POST', cookie: userACookie, recipientId: highSupportRecipientId, body: { answers: highSupportAnswers } }); assert.equal(result.response.status, 201); assert.equal(result.payload.result.template, 'senior_high_support');
  result = await request('/api/screening/questions', { cookie: userACookie, recipientId: highSupportRecipientId }); assert.equal(result.payload.mode, 'follow_up'); assert.deepEqual(result.payload.questions.slice(0, 4).map(question => question.id), ['medication', 'feeding', 'transfer', 'alertness']);
  result = await request('/api/recipients', { method: 'POST', cookie: userACookie, body: { alias: '小芽', scene: 'child', segment: '0–2 岁 · 婴幼儿生活节律' } }); assert.equal(result.response.status, 201); const infantRecipientId = result.payload.recipient.id;
  result = await request('/api/screening/questions', { cookie: userACookie, recipientId: infantRecipientId }); assert.equal(result.payload.template, 'child_infant'); assert.ok(result.payload.questions.some(question => question.id === 'feeding'));
  result = await request('/api/recipients', { method: 'POST', cookie: userACookie, body: { alias: '小峰', scene: 'child', segment: '7–12 岁 · 学龄适应期' } }); assert.equal(result.response.status, 201); const schoolRecipientId = result.payload.recipient.id;
  result = await request('/api/screening/questions', { cookie: userACookie, recipientId: schoolRecipientId }); assert.equal(result.payload.template, 'child_school'); assert.ok(result.payload.questions.some(question => question.id === 'school'));
  const databaseBytes = Buffer.concat(await Promise.all((await readdir(tempDir)).map(name => readFile(path.join(tempDir, name)))));
  assert.equal(databaseBytes.includes(Buffer.from('晚睡，入睡需要安抚')), false, 'raw note must not be written in plaintext');
  assert.equal(databaseBytes.includes(Buffer.from('愿意尝试新的蔬菜')), false, 'food note must not be written in plaintext');
  assert.equal(databaseBytes.includes(Buffer.from('米饭、鸡蛋、青菜')), false, 'one-time food idea input must not be persisted');

  result = await request('/api/auth/register', { method: 'POST', body: { email: 'pilot-b@example.com', password: 'correct-horse-battery' } });
  assert.equal(result.response.status, 201);
  const userBCookie = result.cookie;
  result = await request('/api/events', { cookie: userBCookie }); assert.equal(result.payload.events.length, 0);
  result = await request('/api/food/summary', { cookie: userBCookie }); assert.equal(result.payload.summary.mealCount, 0);
  result = await request('/api/alerts/summary', { cookie: userBCookie }); assert.equal(result.payload.summary.total, 0);
  result = await request('/api/safety/incidents', { cookie: userBCookie }); assert.equal(result.payload.incidents.length, 0);
  result = await request('/api/profile', { method: 'PUT', cookie: userBCookie, body: { alias: '外婆', scene: 'senior', segment: '60–74 岁 · 自主生活支持' } });
  assert.equal(result.response.status, 200); assert.equal(result.payload.profile.scene, 'senior'); assert.equal(result.payload.sceneLocked, false);
  result = await request('/api/profile', { method: 'PUT', cookie: userBCookie, body: { alias: '外婆', scene: 'child', segment: '3–6 岁 · 情绪社交期' } });
  assert.equal(result.response.status, 200); assert.equal(result.payload.profile.scene, 'child');
  result = await request('/api/profile', { method: 'PUT', cookie: userBCookie, body: { alias: '外婆', scene: 'senior', segment: '60–74 岁 · 自主生活支持' } });
  assert.equal(result.response.status, 200); assert.equal(result.payload.profile.scene, 'senior');
  result = await request('/api/screening/questions', { cookie: userBCookie }); assert.equal(result.payload.mode, 'baseline'); assert.equal(result.payload.scene, 'senior'); assert.equal(result.payload.questions.length, 8); assert.equal(result.payload.questions[0].id, 'medication'); assert.equal(result.payload.questions[0].title, '用药遗漏或不确定');
  const seniorAnswers = Object.fromEntries(result.payload.questions.map((question, index) => [question.id, index === 0 ? 2 : 1]));
  result = await request('/api/screenings', { method: 'POST', cookie: userBCookie, body: { answers: seniorAnswers } });
  assert.equal(result.response.status, 201); assert.equal(result.payload.result.scene, 'senior'); assert.ok(result.payload.plan.tasks.some(task => task.title.includes('是否按计划用药')));
  result = await request('/api/screening/questions', { cookie: userBCookie }); assert.equal(result.payload.mode, 'follow_up'); assert.equal(result.payload.questions.length, 7); assert.deepEqual(result.payload.questions.slice(0, 4).map(question => question.id), ['medication', 'sleep', 'appetite', 'mobility']);
  result = await request('/api/medications/logs', { method: 'POST', cookie: userBCookie, body: { occurredAt: Date.now(), period: '早晨药盒', status: '已按计划服用', label: '一号药盒', note: '家属已确认。' } });
  assert.equal(result.response.status, 201); assert.equal(result.payload.summary.total, 1); assert.equal(result.payload.summary.onPlan, 1);
  result = await request('/api/medications/logs', { method: 'POST', cookie: userBCookie, body: { occurredAt: Date.now(), period: '晚间药盒', status: '未按计划服用', label: '二号药盒', note: '仅留存事实。' } });
  assert.equal(result.response.status, 201); assert.equal(result.payload.summary.missed, 1); assert.equal(result.payload.alerts[0].source, 'medication');
  result = await request('/api/medications/summary', { cookie: userBCookie }); assert.equal(result.payload.summary.records.length, 2); assert.deepEqual(new Set(result.payload.summary.records.map(record => record.label)), new Set(['一号药盒', '二号药盒']));
  result = await request('/api/screenings/history', { cookie: userBCookie }); assert.equal(result.payload.history.length, 1); assert.equal(result.payload.history[0].questionCount, 8);
  result = await request(`/api/reports/${reportId}/feedback`, { method: 'PATCH', cookie: userBCookie, body: { rating: 'not_helpful' } });
  assert.equal(result.response.status, 404);
  const seniorDatabaseBytes = Buffer.concat(await Promise.all((await readdir(tempDir)).map(name => readFile(path.join(tempDir, name)))));
  assert.equal(seniorDatabaseBytes.includes(Buffer.from('一号药盒')), false, 'medication label must not be written in plaintext');
  console.log('E2E passed: continuous screening, encrypted record persistence, BYOK call, report feedback, and tenant isolation.');
} finally {
  await Promise.all(children.map(stop));
  // Windows can retain a SQLite WAL file briefly after the child process exits.
  await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
