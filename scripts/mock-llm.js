/* Local OpenAI-compatible provider for end-to-end verification only. Never deploy it publicly. */
const http = require('node:http');
const port = Number(process.env.MOCK_LLM_PORT || 4010);
const response = { status: 'observe', confidence: 'early', observations: [{ title: '睡眠节律值得连续观察', evidence: ['7 天内出现多条睡眠相关记录'], limitations: '模拟模型仅验证接口，不代表任何真实判断。', suggested_action: '连续 3 天记录上床与入睡时间。' }], follow_up_fields: ['occurred_at', 'sleep_onset_time'], escalation: '如出现紧急或快速加重症状，请立即联系当地急救或医疗服务。' };
const recipeResponse = { ideas: [{ title: '鸡蛋青菜拌饭', subtitle: '把本次食材组合成一碗家常午餐。', ingredients: ['米饭', '鸡蛋', '青菜'], steps: ['按家中习惯处理食材。', '将鸡蛋和青菜分别做熟，再与米饭搭配。', '根据实际接受度调整软硬和份量。'], minutes: 20, tags: ['家常搭配', '需确认'] }, { title: '青菜蛋花小汤配主食', subtitle: '适合作为清淡的一餐组合。', ingredients: ['鸡蛋', '青菜', '米饭'], steps: ['将食材清洗并按习惯处理。', '煮一份青菜蛋花汤，同时准备主食。', '按实际需要调整食材形态。'], minutes: 15, tags: ['简单做法', '需确认'] }], preparation_note: '这是对本次主动输入的家常搭配整理，不会保存为饮食记录。', safety_note: '请自行核对过敏、年龄适配和咀嚼/吞咽限制。' };
http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const payload = JSON.parse(raw || '{}');
  const system = String(payload.messages?.[0]?.content || '');
  const result = system.includes('家常食谱灵感助手') ? recipeResponse : response;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
}).listen(port, () => console.log(`Mock LLM on http://127.0.0.1:${port}/v1`));
