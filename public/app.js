'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
let authMode = 'login';
let state = emptyState();

const SCENES = {
  child: {
    name: '儿童照护',
    segments: ['0–2 岁 · 婴幼儿生活节律', '3–6 岁 · 情绪社交期', '7–12 岁 · 学龄适应期'],
    intro: '这不是诊断，也不会给孩子贴标签。首次完成 8 题建立基线；之后会保留固定对比题，并围绕上次重点继续追问。',
    screeningTitle: '先找到值得连续记录的场景',
    recordTitle: '留下可比较的事实',
    categories: ['情绪行为', '睡眠', '进食', '同伴互动', '入园适应', '身体不适'],
    moods: ['平稳', '开心', '烦躁', '疲惫', '不舒服'],
    eventHint: '记录发生时间、前一项活动、持续多久及安抚后是否缓解。',
    foodTitle: '把一餐拆成可比较的事实',
    appetites: ['吃得不错', '一般', '不愿尝试'],
    reactions: ['无不适', '待观察'],
    foodHint: '例如：西兰花、鸡蛋、米饭；不要写姓名或联系方式。',
    askHint: '例如：接下来三天我先记录什么？'
  },
  senior: {
    name: '老年人照护',
    segments: ['60–74 岁 · 自主生活支持', '75–84 岁 · 日常协助支持', '85 岁以上 · 高支持照护'],
    intro: '这不是诊断，也不会代替医生或药师判断。题目会随年龄支持层级切换：自主生活、日常协助与高支持照护分别建立自己的连续基线。',
    screeningTitle: '先建立日常状态与用药记录基线',
    recordTitle: '留下与平时相比的变化',
    categories: ['睡眠', '进食饮水', '活动与行走', '日常自理', '情绪沟通', '身体不适'],
    moods: ['与平时相近', '精神不错', '疲惫', '需要更多协助', '不舒服'],
    eventHint: '记录什么时候、与平时相比有什么不同、持续多久，以及是否已寻求帮助。',
    foodTitle: '记录食欲与餐后情况的变化',
    appetites: ['吃得不错', '一般', '吃得较少', '无法判断'],
    reactions: ['无不适', '待观察', '吞咽或咀嚼不便'],
    foodHint: '例如：软米饭、鸡蛋羹、青菜；不要写姓名或联系方式。',
    askHint: '例如：接下来三天先记录哪些日常变化？'
  }
};

const SAFETY_ACTIONS = {
  child_infant: {
    label: '0–2 岁 · 婴幼儿生活节律',
    title: '先确保安全，再把观察到的事实交给专业人员',
    actions: [
      ['先判断是否要立即求助', '如出现意识反应异常、呼吸明显困难、严重出血、疑似误食/误服，或正在快速加重，请立即联系当地急救或医疗服务。'],
      ['保持陪伴与环境安全', '让孩子留在安全位置并陪在身边；不要把食物、饮水或药物塞入口中。'],
      ['避免可能造成二次伤害', '怀疑严重受伤、头颈背受伤或明显疼痛时，不要强行移动；疑似误服/中毒时不要催吐，保留相关物品或包装信息。']
    ],
    handoff: ['何时发现或发生', '当时看到的意识、呼吸、出血或行为变化', '可能接触的物品/食物及包装信息', '已联系谁、何时联系']
  },
  child_preschool: {
    label: '3–6 岁 · 情绪社交期',
    title: '先停止危险活动，陪伴并获得实时帮助',
    actions: [
      ['先判断是否要立即求助', '如出现意识反应异常、呼吸明显困难、严重出血、疑似误食/误服，或正在快速加重，请立即联系当地急救或医疗服务。'],
      ['停止危险活动并陪伴', '让孩子离开危险环境并留在身边；不要要求孩子独自处理或继续活动。'],
      ['避免可能造成二次伤害', '严重受伤、头颈背疼痛或明显无法活动时，不要强行移动；疑似误服/中毒时不要催吐，保留相关物品或包装信息。']
    ],
    handoff: ['发生时间与地点', '发生前在做什么', '当时观察到的意识、呼吸、出血或疼痛线索', '已采取的求助行动']
  },
  child_school: {
    label: '7–12 岁 · 学龄适应期',
    title: '先确保不再暴露于危险，再完成交接',
    actions: [
      ['先判断是否要立即求助', '如出现意识反应异常、呼吸明显困难、严重出血、疑似误食/误服，或正在快速加重，请立即联系当地急救或医疗服务。'],
      ['停止活动并保持陪伴', '离开危险环境，陪在孩子身边；不要让孩子独自离开、独自返校或继续运动。'],
      ['避免可能造成二次伤害', '严重受伤、头颈背疼痛或明显无法活动时，不要强行移动；疑似误服/中毒时不要催吐，保留相关物品或包装信息。']
    ],
    handoff: ['发生时间与地点', '前一项活动和当时发生的事实', '当时观察到的意识、呼吸、出血或疼痛线索', '已联系的家人或专业人员']
  },
  senior_independent: {
    label: '60–74 岁 · 自主生活支持',
    title: '先联系帮助，避免强行扶起或自行调整用药',
    actions: [
      ['先判断是否要立即求助', '如出现意识反应异常、呼吸明显困难、严重出血、突发明显变化、跌倒后无法起身或疑似严重受伤，请立即联系当地急救或医疗服务。'],
      ['跌倒或疑似严重受伤时', '怀疑头、颈、背、髋部受伤，或无法起身时，不要强行扶起或搬动，等待专业指导。'],
      ['用药不确定时', '不要自行加服、补服、停服或调整剂量；按既有医嘱或联系医生、药师确认。']
    ],
    handoff: ['何时发生或发现', '与平时相比的具体变化', '是否跌倒、是否能起身、是否有意识/呼吸/出血问题', '本次常用用药时段的状态和已联系的人员']
  },
  senior_assisted: {
    label: '75–84 岁 · 日常协助支持',
    title: '先呼叫在场照护者或实时医疗帮助，再完成交接',
    actions: [
      ['先判断是否要立即求助', '如出现意识反应异常、呼吸明显困难、严重出血、突发明显变化、跌倒后无法起身或疑似严重受伤，请立即联系当地急救或医疗服务。'],
      ['跌倒或疑似严重受伤时', '呼叫在场照护者协助；怀疑头、颈、背、髋部受伤，或无法起身时，不要强行搀扶、扶起或搬动。'],
      ['用药不确定时', '不要自行加服、补服、停服或调整剂量；按既有医嘱或联系医生、药师确认。']
    ],
    handoff: ['何时发生或发现', '与平时相比的具体变化和需要的协助', '是否跌倒、是否能起身、是否有意识/呼吸/出血问题', '本次常用用药时段的状态和已联系的人员']
  },
  senior_high_support: {
    label: '85 岁以上 · 高支持照护',
    title: '先确保在场照护与实时求助，再完成四项交接',
    actions: [
      ['先判断是否要立即求助', '如出现意识反应异常、呼吸明显困难、严重出血、突发明显变化、跌倒后无法起身或疑似严重受伤，请立即联系当地急救或医疗服务。'],
      ['转移、跌倒或疑似严重受伤时', '先呼叫在场照护者；怀疑头、颈、背、髋部受伤，或无法起身时，不要强行搀扶、扶起或搬动。'],
      ['进食或用药不确定时', '不要强行喂食、饮水或自行加服、补服、停服、调整剂量；按既有医嘱或联系医生、药师确认。']
    ],
    handoff: ['何时发生或发现', '意识、呼吸、进食饮水、转移时与平时相比的变化', '是否跌倒、是否能起身、是否有出血或快速加重', '用药状态、已联系人员与下一位照护者需留意的事项']
  }
};

function emptyState() {
  return { user: null, recipients: [], activeRecipientId: null, creatingRecipient: false, profile: null, profileSceneLocked: false, events: [], config: { configured: false }, questions: [], scale: [], screening: null, screeningMeta: { mode: 'baseline', scene: 'child' }, screeningHistory: [], plan: null, foodSummary: null, foodIdeas: null, medicationSummary: null, safetyIncidents: [], alertSummary: null, evidenceSummary: null, latestHandoff: null, safetyAnswer: null, currentReport: null, answers: {}, screeningIndex: 0 };
}
function esc(value) {
  return String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}
function sceneKey() { return state.profile && state.profile.scene === 'senior' ? 'senior' : 'child'; }
function currentScene() { return SCENES[sceneKey()]; }
function icon(name, className = '') {
  return '<svg class="ui-icon ' + esc(className) + '" aria-hidden="true"><use href="#icon-' + esc(name) + '"></use></svg>';
}
function safetyTemplate() {
  if (sceneKey() === 'senior') {
    if (state.profile?.segment?.startsWith('60–74')) return 'senior_independent';
    if (state.profile?.segment?.startsWith('75–84')) return 'senior_assisted';
    return 'senior_high_support';
  }
  if (state.profile?.segment?.startsWith('0–2')) return 'child_infant';
  if (state.profile?.segment?.startsWith('7–12')) return 'child_school';
  return 'child_preschool';
}
function optionList(values, selected) {
  return values.map(value => '<option value="' + esc(value) + '"' + (value === selected ? ' selected' : '') + '>' + esc(value) + '</option>').join('');
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(state.activeRecipientId ? { 'X-Care-Recipient-Id': state.activeRecipientId } : {}), ...(options.headers || {}) }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body && body.error && body.error.message ? body.error.message : '请求失败，请稍后重试。');
  return body;
}
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove('show'), 2600);
}
function datetimeValue(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + 'T' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}
function formatTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date) : '上一轮';
}
function formatToday() {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date());
}
function showView(name) {
  $$('.view').forEach(view => view.classList.toggle('active', view.dataset.view === name));
  $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.go === name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function renderSceneForms() {
  const current = currentScene();
  $('#eventCategory').innerHTML = optionList(current.categories, $('#eventCategory').value || current.categories[0]);
  $('#eventMood').innerHTML = optionList(current.moods, $('#eventMood').value || current.moods[0]);
  $('#eventNote').placeholder = current.eventHint;
  $('#recordTitle').textContent = current.recordTitle;
  $('#foodTitle').textContent = current.foodTitle;
  $('#foodAppetite').innerHTML = optionList(current.appetites, $('#foodAppetite').value || current.appetites[0]);
  $('#foodReaction').innerHTML = optionList(current.reactions, $('#foodReaction').value || current.reactions[0]);
  $('#foodNote').placeholder = current.foodHint;
  $('#askQuestion').placeholder = current.askHint;
  const incidentTypes = sceneKey() === 'senior'
    ? ['跌倒或疑似骨折', '意识反应异常', '呼吸明显困难', '严重外伤或出血', '其他需要立即求助的情况']
    : ['意识反应异常', '呼吸明显困难', '严重外伤或出血', '其他需要立即求助的情况'];
  $('#safetyIncidentType').innerHTML = optionList(incidentTypes, $('#safetyIncidentType').value || incidentTypes[0]);
  $('#profileScene').value = sceneKey();
  $('#profileScene').disabled = Boolean(state.profile && state.profileSceneLocked);
  $('#profileSegment').innerHTML = optionList(current.segments, state.profile ? state.profile.segment : current.segments[0]);
  $('#homeSceneLabel').textContent = state.profile ? current.name + ' · 仪表盘分析' : '仪表盘分析 · 连续照护记录';
  $('#screeningEyebrow').textContent = state.profile ? current.name + ' · 连续观察' : '连续观察';
  $('#screeningTitle').textContent = current.screeningTitle;
}
function renderStatus() {
  const ready = Boolean(state.profile && state.screening && state.config.configured);
  let next = '先添加一位照护对象';
  if (state.profile && !state.screening) next = '完成首次观察，建立基线';
  if (state.profile && state.screening && !state.config.configured) next = '配置个人模型，即可使用 AI';
  if (ready) next = '照护记录与 AI 分析已就绪';
  $('#statusCard').innerHTML = '<span class="status-orb ' + (ready ? 'ready' : '') + '" aria-hidden="true">' + (ready ? '✓' : '•') + '</span><div><strong>' + (ready ? '已准备好' : '下一步') + '</strong><p>' + esc(next) + '</p></div>';
}
function renderPlan() {
  const senior = sceneKey() === 'senior';
  if (!state.plan) {
    const title = senior ? '先做一次日常状态与用药观察' : '先做一次家庭行为观察';
    $('#planCard').innerHTML = '<div class="plan-top"><div><p class="eyebrow">本周照护计划</p><h3>' + title + '</h3><p>8 个简短问题，帮你决定接下来该记录什么。</p></div><span class="plan-week-chip">7 天</span></div><button class="secondary plan-start" data-go="screening" type="button">开始建立基线</button>';
    return;
  }
  const total = state.plan.tasks.length;
  const completed = state.plan.tasks.filter(task => task.completed).length;
  const progress = Math.max(0, Math.min(8, Math.round((completed / Math.max(1, total)) * 8)));
  const tasks = state.plan.tasks.map(task => '<label class="plan-task ' + (task.completed ? 'done' : '') + '"><input type="checkbox" data-plan-task="' + esc(task.id) + '"' + (task.completed ? ' checked' : '') + ' /><span class="plan-day">' + esc(task.day) + '</span><span><b>' + esc(task.focus) + '</b><small>' + esc(task.title) + '</small></span></label>').join('');
  $('#planCard').innerHTML = '<div class="plan-top"><div><p class="eyebrow">本周照护计划</p><h3>' + (senior ? '把关键事实留存下来' : '围绕本轮重点持续观察') + '</h3></div><span class="plan-week-chip">' + completed + ' / ' + total + '</span></div><div class="plan-progress" aria-label="已完成 ' + completed + ' 项，共 ' + total + ' 项"><i class="progress-' + progress + '"></i></div><p class="plan-status">' + (completed === total ? '本轮计划已完成，可以开始下一轮观察。' : '每天完成一件小事，就能形成连续变化。') + '</p><div class="plan-list">' + tasks + '</div>';
}
function renderHome() {
  const current = currentScene();
  $('#todayStamp').textContent = formatToday();
  $('#homeTitle').textContent = state.profile ? state.profile.alias + ' · ' + current.name : '添加一位照护对象';
  const recent = state.events.filter(event => event.occurredAt > Date.now() - 7 * 86400000 && !['safety_incident', 'food_log', 'medication_log'].includes(event.details && event.details.kind));
  const categories = new Set(recent.map(event => event.category));
  let focus = { label: '从这里开始', title: '建立第一位照护对象', copy: '选择儿童或老年人场景后，页面会自动切换对应工具。', action: '建立档案', go: 'settings', count: '01' };
  if (state.profile && !state.screening) focus = { label: '第一步', title: sceneKey() === 'senior' ? '完成 8 题日常状态观察' : '完成 8 题家庭行为观察', copy: '先有基线，后面的变化才有参照。', action: '开始观察', go: 'screening', count: '08' };
  if (state.profile && state.screening && recent.length < 3) focus = { label: '今日焦点', title: sceneKey() === 'senior' ? '补一条生活状态或用药记录' : '补一条今天的真实记录', copy: '再记录 ' + Math.max(0, 3 - recent.length) + ' 条相近事实，就能形成更有用的周回顾。', action: '现在记录', go: 'record', count: String(recent.length).padStart(2, '0') };
  if (state.profile && state.screening && recent.length >= 3) focus = { label: '本周已就绪', title: '生成本周照护回顾', copy: '模型只接收去身份化的摘要，不查看原始备注。', action: '查看 AI 报告', go: 'ai', count: 'AI' };
  $('#focusCard').innerHTML = '<span class="focus-number" aria-hidden="true">' + esc(focus.count) + '</span><div class="focus-copy"><p class="eyebrow"><i></i>' + esc(focus.label) + '</p><h3>' + esc(focus.title) + '</h3><p>' + esc(focus.copy) + '</p></div><button class="focus-action" data-go="' + esc(focus.go) + '" type="button">' + esc(focus.action) + icon('arrow', 'action-arrow') + '</button>';
  const food = state.foodSummary || { mealCount: 0, colorCount: 0 };
  const medication = state.medicationSummary || { total: 0, onPlan: 0, missed: 0, uncertain: 0 };
  const metricData = sceneKey() === 'senior'
    ? [[medication.total, '今日用药', 'pill', 'violet'], [food.mealCount, '今日餐次', 'food', 'orange'], [recent.length, '7 天记录', 'note', 'green']]
    : [[recent.length, '7 天记录', 'note', 'green'], [categories.size, '涉及场景', 'eye', 'blue'], [food.mealCount, '今日餐次', 'food', 'orange']];
  $('#metricGrid').innerHTML = metricData.map(item => '<article class="metric metric-' + item[3] + '"><span class="metric-icon">' + icon(item[2]) + '</span><strong>' + item[0] + '</strong><span>' + item[1] + '</span></article>').join('');
  const actions = [
    ['record', 'note', '记录今天', '留下一条日常事实', 'primary'],
    ['screening', 'eye', state.screening ? '继续观察' : '建立基线', state.screening ? '与上一次比较变化' : '完成 8 个简短问题', 'mint'],
    ['ai', 'spark', '查看分析', state.config.configured ? '汇总本周变化' : '配置模型后可用', 'lavender']
  ];
  $('#quickActions').innerHTML = '<div class="section-label"><p class="eyebrow">快捷操作</p><span>从一件小事开始</span></div><div class="quick-action-grid">' + actions.map(action => '<button class="quick-action action-' + action[4] + '" data-go="' + action[0] + '" type="button"><span class="quick-icon">' + icon(action[1]) + '</span><span><strong>' + action[2] + '</strong><small>' + action[3] + '</small></span>' + icon('arrow', 'quick-arrow') + '</button>').join('') + '</div>';
  const timeline = state.events.slice(0, 4).map(event => {
    const kind = event.details?.kind;
    const details = kind === 'food_log' ? ['饮食', event.details.mealType + ' · ' + event.details.appetite, 'food', 'food']
      : kind === 'medication_log' ? ['用药确认', event.details.period + ' · ' + event.details.status, 'pill', 'medication']
      : kind === 'safety_incident' ? ['紧急留存', event.details.incidentType, 'safety', 'safety']
      : [event.category || '日常记录', event.mood || '已记录', 'note', 'daily'];
    return '<article class="timeline-item timeline-' + details[3] + '"><span class="timeline-icon">' + icon(details[2]) + '</span><div><strong>' + esc(details[0]) + '</strong><small>' + esc(details[1]) + '</small></div><time>' + esc(formatTime(event.occurredAt)) + '</time></article>';
  }).join('');
  $('#recentTimeline').innerHTML = '<div class="section-label"><p class="eyebrow">最近动态</p><span>' + (timeline ? '只展示类型与状态' : '记录会显示在这里') + '</span></div><div class="timeline-list">' + (timeline || '<div class="timeline-empty"><span>' + icon('clock') + '</span><p>今天还没有记录<br/><small>从“记录今天”开始就好</small></p></div>') + '</div>';
  const foodCard = '<article class="health-card food-tool"><span class="tool-icon">' + icon('food') + '</span><div><p class="eyebrow">饮食健康</p><h3>' + (food.mealCount ? '今天已记录 ' + food.mealCount + ' 餐' : '记录今天的第一餐') + '</h3><p>' + (food.colorCount ? food.colorCount + ' 种颜色已出现' : '食材、食欲与餐后情况') + '</p><button class="tool-link" data-go="food" type="button">添加饮食 ' + icon('arrow', 'tool-arrow') + '</button></div></article>';
  const medicationCard = '<article class="health-card medication-tool"><span class="tool-icon">' + icon('pill') + '</span><div><p class="eyebrow">用药确认</p><h3>' + (medication.total ? '今天已记录 ' + medication.total + ' 次' : '记录第一次用药状态') + '</h3><p>' + (medication.uncertain ? medication.uncertain + ' 次待确认' : '只记录时段与状态') + '</p><button class="tool-link" data-go="medication" type="button">记录用药 ' + icon('arrow', 'tool-arrow') + '</button></div></article>';
  const safetyCard = '<article class="health-card safety-tool"><span class="tool-icon">' + icon('safety') + '</span><div><p class="eyebrow">紧急支持</p><h3>先求助，再留存</h3><p>' + (state.safetyIncidents.length ? '已留存 ' + state.safetyIncidents.length + ' 条事件' : '分层行动卡随对象变化') + '</p><button class="tool-link" data-go="safety" type="button">查看行动卡 ' + icon('arrow', 'tool-arrow') + '</button></div></article>';
  $('#supportCards').classList.toggle('two-tools', sceneKey() !== 'senior');
  $('#supportCards').innerHTML = (sceneKey() === 'senior' ? medicationCard : '') + foodCard + safetyCard;
  renderPlan();
}
function provenanceChip(provenance) {
  const data = provenance || {};
  const basis = data.basisLabel || '依据未补充';
  const reporter = data.reporterLabel || '';
  return '<span class="provenance-chip" title="' + esc(reporter ? reporter + ' · ' + basis : basis) + '">' + esc(basis) + '</span>';
}
function renderContinuity() {
  const container = $('#continuityCard');
  if (!container) return;
  if (!state.profile) {
    container.className = 'continuity-card is-empty';
    container.innerHTML = '<span class="continuity-icon">' + icon('lock') + '</span><div><p class="eyebrow">可信照护闭环</p><h3>先建立对象，再让记录可以被比较和交接</h3><p>每条记录会标明来自现场观察、计划核对或事后转述；不把问卷分数当成医学结论。</p></div><button class="secondary" type="button" data-go="settings">建立对象</button>';
    return;
  }
  const data = state.evidenceSummary || { level: 'collecting', label: '还在收集事实', comparableFactCount: 0, factDayCount: 0, directObservationCount: 0, planCheckedCount: 0, relayedCount: 0, detail: '先完成几条有记录依据的日常事实。', latestHandoff: null };
  const handoff = state.latestHandoff || data.latestHandoff;
  const badges = [
    ['现场观察', data.directObservationCount || 0],
    ['计划核对', data.planCheckedCount || 0],
    ['覆盖天数', data.factDayCount || 0]
  ].map(item => '<span><b>' + esc(item[1]) + '</b>' + esc(item[0]) + '</span>').join('');
  const handoffCopy = handoff
    ? '<div class="handoff-state complete"><strong>已完成交接</strong><p>' + esc(formatTime(handoff.createdAt)) + ' · 已向' + esc(handoff.receiverRole) + '留存最近事实摘要。</p></div>'
    : '<div class="handoff-state"><strong>尚未确认交接</strong><p>完成记录后，可向下一位照护者确认已交接；不填写姓名，也不发送原始备注。</p></div>';
  const disabled = (state.events || []).length ? '' : ' disabled';
  container.className = 'continuity-card level-' + esc(data.level || 'collecting');
  container.innerHTML = '<div class="continuity-main"><span class="continuity-icon">' + icon('lock') + '</span><div><p class="eyebrow">可信照护闭环</p><h3>' + esc(data.label || '还在收集事实') + '</h3><p>' + esc(data.detail || '记录会区分现场观察、计划核对与事后转述。') + '</p></div></div><div class="evidence-badges">' + badges + '</div>' + handoffCopy + '<div class="handoff-action"><label>下一位接手者<select id="handoffReceiverRole"><option value="共同照护者">共同照护者</option><option value="家庭成员">家庭成员</option><option value="护理人员">护理人员</option><option value="暂不需要交接">暂不需要交接</option></select></label><button class="secondary" type="button" data-confirm-handoff' + disabled + '>确认已交接</button></div><p class="continuity-footnote">趋势仅基于家庭记录或对既有计划的核对，不代表临床测量、诊断或医学风险评分。</p>';
}
function renderEvents() {
  const visible = state.events.filter(event => !['safety_incident', 'food_log', 'medication_log'].includes(event.details && event.details.kind));
  $('#eventList').innerHTML = visible.length ? visible.map(event => '<article class="event"><div class="event-head"><strong>' + esc(event.category) + ' · ' + esc(event.mood) + '</strong><button type="button" data-delete-event="' + esc(event.id) + '">删除</button></div><p>' + esc(event.note || '无备注') + '</p><small>' + formatTime(event.occurredAt) + (event.keywords && event.keywords.length ? ' · 标签：' + event.keywords.join('、') : '') + ' · ' + provenanceChip(event.provenance) + '</small></article>').join('') : '<section class="panel"><p>暂无记录。第一条建议写清“什么时候、发生什么、持续多久、之后如何”。</p></section>';
}
function renderFoodSummary() {
  const summary = state.foodSummary || { mealCount: 0, colorCount: 0, records: [] };
  const records = summary.records.map(record => esc(record.mealType) + '：' + esc(record.groups.join('、')) + (record.colors.length ? ' · ' + esc(record.colors.join('、')) : '') + ' · ' + esc(record.appetite) + ' · ' + provenanceChip(record.provenance)).join('<br/>');
  $('#foodTodayList').innerHTML = summary.records.length ? '<article><strong>今天已记录 ' + summary.mealCount + ' 餐 · ' + summary.colorCount + ' 种颜色</strong><br/>' + records + '</article>' : '<article>今天还没有饮食记录。先从一餐开始，不需要拍照或填写具体菜名。</article>';
}
function renderFoodIdeas(ideas) {
  const button = $('#generateMealIdeas');
  const configured = Boolean(state.config && state.config.configured);
  button.disabled = !configured;
  button.textContent = configured ? '生成食谱灵感' : '先配置个人模型';
  if (!ideas) {
    $('#foodAIOutput').innerHTML = configured
      ? '<p>填写“今日食材”后，主动生成两种家常食谱灵感；本次生成内容不会自动保存为饮食记录。</p>'
      : '<p>配置个人模型后，可根据本次输入的食材和用餐偏好生成家常做法。</p>';
    return;
  }
  const source = ideas.source === 'byok_model' ? '你的模型已生成' + (ideas.model ? ' · ' + esc(ideas.model) : '') : '本地整理提示';
  const cards = (ideas.ideas || []).map((idea, index) => {
    const ingredientChips = (idea.ingredients || []).map(item => '<span>' + esc(item) + '</span>').join('');
    const steps = (idea.steps || []).map((step, stepIndex) => '<li><b>' + (stepIndex + 1) + '</b><span>' + esc(step) + '</span></li>').join('');
    const tags = (idea.tags || []).map(tag => '<em>' + esc(tag) + '</em>').join('');
    return '<article class="food-idea-card"><div class="food-idea-top"><span class="idea-number">' + (index + 1) + '</span><div><h3>' + esc(idea.title) + '</h3><p>' + esc(idea.subtitle) + '</p></div><strong>' + esc(idea.minutes) + ' 分钟</strong></div><div class="ingredient-chips">' + ingredientChips + '</div><ol class="idea-steps">' + steps + '</ol><div class="idea-tags">' + tags + '</div></article>';
  }).join('');
  $('#foodAIOutput').innerHTML = '<div class="report-top food-idea-heading"><div><p class="eyebrow">' + source + '</p><h3>本次食材 · 家常做法</h3></div><span class="pill">不自动保存</span></div><p class="food-idea-note">' + esc(ideas.preparation_note) + '</p><div class="food-idea-grid">' + cards + '</div><p class="food-idea-safety">' + esc(ideas.safety_note) + '</p>';
}
function renderAlertOverview(summary) {
  const data = summary || { total: 0, urgentCount: 0, attentionCount: 0, observeCount: 0, sources: [], alerts: [], dailyAdvice: [] };
  const alertButton = $('.nav-item[data-go="alerts"]');
  alertButton.dataset.alertCount = data.total ? String(Math.min(99, data.total)) : '';
  alertButton.classList.toggle('has-alert', Boolean(data.total));
  if (!data.total) {
    $('#alertOverview').className = 'alert-overview empty';
    $('#alertOverview').innerHTML = '<span class="alert-orb">' + icon('bell') + '</span><div><p class="eyebrow">照护关注提醒 · 近 7 天</p><h3>暂无需要处理的关注提醒</h3><p>当日常记录、连续观察、饮食或用药出现可关注的事实时，会在这里留下可回看的提醒。</p></div><button class="secondary" data-go="alerts" type="button">查看规则</button>';
    return;
  }
  const primary = data.urgentCount ? 'urgent' : data.attentionCount ? 'attention' : 'observe';
  const copy = data.urgentCount ? '有需要优先处理的信号，请先获得实时帮助。' : data.attentionCount ? '有需要尽快核对或持续留意的照护事实。' : '有重复出现的照护事实，建议按计划继续记录。';
  const sourceChips = (data.sources || []).map(item => '<span>' + esc(item.label) + ' ' + esc(item.count) + '</span>').join('');
  $('#alertOverview').className = 'alert-overview ' + primary;
  $('#alertOverview').innerHTML = '<span class="alert-orb">' + icon('bell') + '</span><div class="alert-overview-copy"><p class="eyebrow">照护关注提醒 · 近 7 天</p><h3>' + esc(data.total) + ' 次关注提醒</h3><p>' + esc(copy) + '</p><div class="alert-source-chips">' + sourceChips + '</div></div><div class="alert-counts"><span><b>' + esc(data.urgentCount) + '</b>优先处理</span><span><b>' + esc(data.attentionCount) + '</b>需要关注</span><span><b>' + esc(data.observeCount) + '</b>连续观察</span></div><button class="secondary" data-go="alerts" type="button">查看提醒</button>';
}
function renderAlertCenter(summary) {
  const data = summary || { total: 0, urgentCount: 0, attentionCount: 0, observeCount: 0, sources: [], alerts: [], dailyAdvice: [] };
  if (!data.total) {
    $('#alertCenter').innerHTML = '<div class="alert-center-empty"><span>' + icon('bell') + '</span><div><h3>当前没有关注提醒</h3><p>完成日常记录、连续观察、饮食或用药留存后，系统会按明确规则识别重复或需要优先核实的事实。它不是诊断工具。</p></div></div><p class="local-only">若正在出现危险、快速加重、意识或呼吸异常、严重出血等情况，请立即联系当地急救或医疗服务，不要等待本页出现提醒。</p>';
    return;
  }
  const sourceChips = (data.sources || []).map(item => '<span>' + esc(item.label) + ' · ' + esc(item.count) + '</span>').join('');
  const advice = (data.dailyAdvice || []).map(item => '<li>' + esc(item) + '</li>').join('');
  const alerts = (data.alerts || []).map(alert => '<article class="alert-record ' + esc(alert.level) + '"><div class="alert-record-top"><span class="alert-level">' + esc(alert.levelLabel) + '</span><small>' + esc(alert.sourceLabel) + ' · ' + esc(formatTime(alert.createdAt)) + '</small></div><h3>' + esc(alert.title) + '</h3><p>' + esc(alert.evidence) + '</p></article>').join('');
  $('#alertCenter').innerHTML = '<section class="alert-center-summary"><div><p class="eyebrow">阶段性汇总 · 近 ' + esc(data.windowDays || 7) + ' 天</p><h3>' + esc(data.total) + ' 次照护关注提醒</h3><p>这些记录只反映已输入的事实和固定规则触发，不构成诊断或风险评分。</p></div><div class="alert-counts"><span><b>' + esc(data.urgentCount) + '</b>优先处理</span><span><b>' + esc(data.attentionCount) + '</b>需要关注</span><span><b>' + esc(data.observeCount) + '</b>连续观察</span></div><div class="alert-source-chips">' + sourceChips + '</div></section><section class="alert-advice"><p class="eyebrow">综合日常建议</p><h3>先把记录变成可交接的事实</h3><ul>' + advice + '</ul></section><section class="alert-record-list"><div class="alert-list-heading"><p class="eyebrow">关注提醒记录</p><span>按优先级和时间排序</span></div>' + alerts + '</section><p class="local-only">优先处理提示不替代实时急救或医疗服务；涉及用药、喂养、吞咽或持续影响日常的情况，请按既有医嘱或咨询相应专业人士。</p>';
}
function renderMedicationSummary() {
  const summary = state.medicationSummary || { total: 0, onPlan: 0, missed: 0, uncertain: 0, records: [] };
  const records = summary.records.map(record => esc(record.period) + '：' + esc(record.status) + (record.label ? ' · ' + esc(record.label) : '') + ' · ' + provenanceChip(record.provenance)).join('<br/>');
  $('#medicationTodayList').innerHTML = summary.records.length ? '<article><strong>今日 ' + summary.total + ' 次记录 · 已按计划 ' + summary.onPlan + ' · 未按计划 ' + summary.missed + ' · 不确定 ' + summary.uncertain + '</strong><br/>' + records + '</article>' : '<article>今天还没有用药记录。可从“早晨药盒”开始，先选择状态再保存。</article>';
}
function renderSafety() {
  $('#safetyIncidentList').innerHTML = state.safetyIncidents.length ? state.safetyIncidents.map(incident => '<article><strong>' + esc(incident.incidentType) + '</strong><br/>' + esc(incident.action) + ' · ' + formatTime(incident.occurredAt) + ' · ' + provenanceChip(incident.provenance) + (incident.note ? '<br/>本地备注：' + esc(incident.note) : '') + '<br/><button class="link-button danger" type="button" data-delete-safety="' + esc(incident.id) + '">删除留存</button></article>').join('') : '<article>暂无留存事件。这里仅用于事后记录，不替代获得实时帮助。</article>';
}
function renderSafetyActionCard() {
  const action = SAFETY_ACTIONS[safetyTemplate()] || SAFETY_ACTIONS.child_preschool;
  const recipientLabel = state.profile?.segment || action.label;
  const steps = action.actions.map((item, index) => '<article class="safety-step"><span>' + (index + 1) + '</span><div><strong>' + esc(item[0]) + '</strong><p>' + esc(item[1]) + '</p></div></article>').join('');
  const handoff = action.handoff.map(item => '<li>' + esc(item) + '</li>').join('');
  $('#safetyActionContent').innerHTML = '<p class="safety-segment">当前对象：' + esc(recipientLabel) + '</p><h3>' + esc(action.title) + '</h3><div class="safety-steps">' + steps + '</div><div class="safety-handoff"><strong>向家人或专业人员交接时，优先留存：</strong><ul>' + handoff + '</ul></div>';
  $('#safetyAskQuestion').placeholder = sceneKey() === 'senior'
    ? '例如：事后我还应补记哪些事实，方便与家人交接？'
    : '例如：事后我还应补记哪些事实，方便与照护者交接？';
}
function renderSafetyAnswer(analysis) {
  if (!analysis) {
    $('#safetyAIOutput').innerHTML = '<p>配置模型后，可在非紧急情况下，让它提示后续应记录哪些事实；遇到危险时先联系当地急救或医疗服务。</p>';
    return;
  }
  const source = analysis.source === 'byok_model' ? '你的模型已生成' : analysis.source === 'safety_rule' ? '安全规则优先提示' : '安全规则兜底结果';
  const observations = (analysis.observations || []).map(item => '<article class="observation"><strong>' + esc(item.title) + '</strong><p><b>建议留存：</b>' + esc(item.suggested_action) + '</p><p class="limit">局限：' + esc(item.limitations) + '</p></article>').join('');
  $('#safetyAIOutput').innerHTML = '<div class="report-top"><div><p class="eyebrow">' + source + '</p><h3>非紧急留存整理</h3></div><span class="pill">置信度：' + esc(analysis.confidence) + '</span></div><p class="local-only">这份内容仅帮助整理记录与交接重点；若情况危险或快速加重，请立即联系当地急救或医疗服务。</p>' + observations + '<p class="escalation">' + esc(analysis.escalation) + '</p>';
}
function renderProfile() {
  const current = currentScene();
  const form = $('#profileForm');
  if (!state.profile) {
    form.reset();
    $('#profileScene').disabled = false;
    $('#profileScene').value = 'child';
    $('#profileSegment').innerHTML = optionList(SCENES.child.segments, SCENES.child.segments[0]);
    return;
  }
  form.alias.value = state.profile.alias;
  $('#profileScene').value = sceneKey();
  $('#profileScene').disabled = Boolean(state.profile && state.profileSceneLocked);
  $('#profileSegment').innerHTML = optionList(current.segments, state.profile ? state.profile.segment : current.segments[0]);
}
function renderConfig() {
  const form = $('#llmForm');
  if (!state.config.configured) {
    form.reset();
    $('#removeLLMButton').textContent = '删除我的模型配置';
    return;
  }
  form.baseUrl.value = state.config.baseUrl;
  form.model.value = state.config.model;
  $('#removeLLMButton').textContent = '删除已启用的 ' + state.config.model + ' 配置';
}
function renderRecipientSwitcher() {
  const container = $('#recipientSwitcher');
  if (!state.recipients.length) {
    container.innerHTML = '<div><strong>还没有照护对象</strong><span>先建立一位儿童或老年人档案。</span></div><button class="secondary" type="button" data-new-recipient>添加照护对象</button>';
    return;
  }
  const options = state.recipients.map(recipient => '<option value="' + esc(recipient.id) + '"' + (recipient.id === state.activeRecipientId ? ' selected' : '') + '>' + esc(recipient.alias) + ' · ' + esc(recipient.segment.split(' · ')[0]) + '</option>').join('');
  container.innerHTML = '<label>当前照护对象<select id="recipientSelect">' + options + '</select></label><button class="secondary" type="button" data-new-recipient>＋ 添加对象</button>';
}
function prepareNewRecipient() {
  state.creatingRecipient = true;
  state.activeRecipientId = null;
  state.profile = null;
  state.profileSceneLocked = false;
  state.events = [];
  state.questions = [];
  state.scale = [];
  state.screening = null;
  state.screeningHistory = [];
  state.plan = null;
  state.foodSummary = null;
  state.foodIdeas = null;
  state.medicationSummary = null;
  state.safetyIncidents = [];
  state.alertSummary = null;
  state.evidenceSummary = null;
  state.latestHandoff = null;
  state.safetyAnswer = null;
  state.currentReport = null;
  renderAll();
  showView('settings');
}
function renderComparisonChart(items, allComparable) {
  if (!items.length) return '';
  const maxScore = Math.max(1, Array.isArray(state.scale) ? state.scale.length : 4);
  const score = value => Math.max(1, Math.min(maxScore, Number(value) + 1));
  const trendCopy = item => item.direction === 'less_often' ? '较少出现' : item.direction === 'more_often' ? '更多出现' : '保持相近';
  const scale = Array.from({ length: maxScore }, (_, index) => '<span>' + (index + 1) + '</span>').join('');
  const rows = items.map(item => {
    const before = score(item.before); const after = score(item.after);
    const trend = item.direction === 'same' ? 'same' : item.direction === 'less_often' ? 'less' : 'more';
    const title = item.id === 'medication' ? '用药遗漏或不确定' : item.title;
    return '<article class="dumbbell-row"><strong class="dumbbell-label">' + esc(title) + '</strong><div class="dumbbell-track" aria-label="上轮 ' + before + '，本轮 ' + after + '"><i class="dumbbell-link link-' + before + '-' + after + '"></i><i class="dumbbell-dot previous score-' + before + '"></i><i class="dumbbell-dot current score-' + after + '"></i></div><span class="dumbbell-change ' + trend + '"><b>' + before + ' → ' + after + '</b><em>' + trendCopy(item) + '</em></span></article>';
  }).join('');
  const scope = allComparable ? '展示全部 ' + items.length + ' 个可比较指标。' : '展示发生变化的指标；其余指标保持相近。';
  return '<section class="comparison-card comparison-chart"><div class="comparison-chart-head"><strong>上轮与本轮对比</strong><span class="comparison-legend"><i class="previous"></i>上轮 <i class="current"></i>本轮</span></div><p>' + scope + '横轴是问卷中“出现频率”的等级：1 低，' + maxScore + ' 高；并非医学风险分数。</p><div class="dumbbell-axis"><span>指标</span><div class="dumbbell-scale">' + scale + '</div><span>前→后</span></div><div class="dumbbell-list">' + rows + '</div></section>';
}
function renderScreeningResult() {
  const result = state.screening;
  const templateInfo = state.screeningMeta.templateMeta || {};
  const coreLabels = templateInfo.coreLabels || [];
  const fixedCopy = coreLabels.length ? '4 个固定问题比较' + coreLabels.join('、') + '的变化，另外 3 个问题会根据上一轮重点调整。' : '4 个固定问题用来比较变化，另外 3 个问题会根据上一次的重点场景调整。';
  const introCopy = state.screeningMeta.mode === 'follow_up'
    ? '这是一轮连续复盘：' + fixedCopy
    : (templateInfo.description || currentScene().intro);
  $('#screeningIntroCopy').textContent = introCopy + (state.screeningMeta.baselineNotice ? ' ' + state.screeningMeta.baselineNotice : '');
  $('#startScreeningButton').textContent = state.screeningMeta.mode === 'follow_up' ? '开始本轮连续观察（7 题）' : '开始首次 8 题观察';
  if (!result) { $('#screeningResult').hidden = true; return; }
  const changed = result.comparison && result.comparison.changed ? result.comparison.changed : [];
  let comparison = '';
  if (result.comparison && result.comparison.available) {
    const hasAllComparable = Array.isArray(result.comparison.items) && result.comparison.items.length > 0;
    const items = hasAllComparable ? result.comparison.items : changed;
    const summary = changed.length ? '有 ' + changed.length + ' 个可比较指标出现变化，' + result.comparison.stable + ' 个指标保持相近。' : '本轮可比较指标均与上次相近，共 ' + result.comparison.stable + ' 个。';
    comparison = '<section class="comparison-card comparison-summary"><strong>和上一次相比</strong><p>' + summary + '</p></section>' + renderComparisonChart(items, hasAllComparable);
  }
  const focuses = (result.focus || []).map(item => '<article class="focus-tag"><strong>' + esc(item.title) + '</strong>' + esc(item.task) + '</article>').join('');
  const history = state.screeningHistory.length > 1 ? '<p class="comparison-hint">已累计 ' + state.screeningHistory.length + ' 轮加密观察。每轮只与同一年龄支持层级的上一轮比较。</p>' : '';
  const evidence = result.evidence || state.evidenceSummary;
  const evidenceNote = evidence ? '<section class="trust-note"><strong>' + esc(evidence.label || '记录依据待补充') + '</strong><p>当前有 ' + esc(evidence.comparableFactCount || 0) + ' 条可比较事实，覆盖 ' + esc(evidence.factDayCount || 0) + ' 天。问卷图表只显示自评变化；日常趋势还需要现场观察或计划核对来验证。</p></section>' : '';
  $('#screeningResult').hidden = false;
  $('#screeningResult').innerHTML = '<span class="result-level">' + esc(result.title) + '</span><h3>' + esc(result.summary) + '</h3><p>' + esc(result.professional) + '</p>' + evidenceNote + comparison + '<div class="focus-tags">' + focuses + '</div>' + history + '<button class="primary" id="startNextScreening" type="button">开始下一轮连续观察</button>';
  $('#startNextScreening').addEventListener('click', startScreening);
}
function renderScreeningFlow() {
  const question = state.questions[state.screeningIndex];
  if (!question) return;
  const choices = state.scale.map((label, score) => '<button class="scale-button ' + (state.answers[question.id] === score ? 'selected' : '') + '" type="button" data-score="' + score + '">' + (score + 1) + '. ' + esc(label) + '</button>').join('');
  $('#screeningFlow').hidden = false;
  const questionType = question.type === 'adaptive' ? '上轮重点' : question.type === 'core' ? '固定对比' : '建立基线';
  $('#screeningFlow').innerHTML = '<div class="screening-progress"><span>第 ' + (state.screeningIndex + 1) + ' / ' + state.questions.length + ' 题</span><span>' + (state.screeningMeta.mode === 'follow_up' ? '连续观察复盘' : '首次基线') + '</span></div><p class="eyebrow">' + esc(question.title) + ' · ' + questionType + '</p><h3>' + esc(question.prompt) + '</h3>' + (question.reason ? '<p class="comparison-hint">' + esc(question.reason) + '</p>' : '') + '<div class="scale-list">' + choices + '</div><div class="screening-actions"><button class="secondary" id="previousQuestion" type="button"' + (state.screeningIndex === 0 ? ' disabled' : '') + '>上一题</button><button class="primary" id="nextQuestion" type="button">' + (state.screeningIndex === state.questions.length - 1 ? '生成 7 天计划' : '下一题') + '</button></div>';
  $$('.scale-button').forEach(button => button.addEventListener('click', () => { state.answers[question.id] = Number(button.dataset.score); renderScreeningFlow(); }));
  $('#previousQuestion').addEventListener('click', () => { state.screeningIndex -= 1; renderScreeningFlow(); });
  $('#nextQuestion').addEventListener('click', submitOrNextScreening);
}
function startScreening() {
  if (!state.profile) { toast('请先添加照护对象。'); showView('settings'); return; }
  if (!state.questions.length) { toast('观察题目还在加载，请稍后再试。'); return; }
  state.answers = {};
  state.screeningIndex = 0;
  $('#screeningIntro').hidden = true;
  $('#screeningResult').hidden = true;
  renderScreeningFlow();
}
async function submitOrNextScreening() {
  const question = state.questions[state.screeningIndex];
  if (!Number.isInteger(state.answers[question.id])) { toast('请选择最接近日常情况的一项。'); return; }
  if (state.screeningIndex < state.questions.length - 1) { state.screeningIndex += 1; renderScreeningFlow(); return; }
  try {
    const result = await api('/api/screenings', { method: 'POST', body: JSON.stringify({ answers: state.answers }) });
    const next = await api('/api/screening/questions');
    const history = await api('/api/screenings/history');
    state.screening = result.result;
    state.plan = result.plan;
    state.questions = next.questions;
    state.scale = next.scale;
    state.screeningMeta = { mode: next.mode, scene: next.scene, template: next.template, templateMeta: next.templateMeta, baselineNotice: next.baselineNotice || '' };
    state.screeningHistory = history.history;
    state.alertSummary = result.alertSummary || state.alertSummary;
    state.evidenceSummary = result.evidence || state.evidenceSummary;
    $('#screeningFlow').hidden = true;
    $('#screeningIntro').hidden = false;
    renderAll();
    toast(result.alert ? '本轮观察已生成 7 天计划，并写入一条照护关注提醒' : '已生成 7 天计划；下一轮会延续本轮观察重点');
  } catch (error) { toast(error.message); }
}
function renderAnalysis(analysis, report) {
  if (report) state.currentReport = report;
  const status = analysis.status === 'urgent' ? '需要优先核实' : analysis.status === 'review_soon' ? '建议近期关注' : '日常观察';
  const source = analysis.source === 'byok_model' ? '你的模型已生成' : analysis.source === 'safety_rule' ? '安全规则优先提示' : '安全规则兜底结果';
  const meta = report && report.metadata;
  const quality = meta && meta.dataQuality;
  const qualityLine = quality ? '<p class="report-quality">事实基础：现场观察 ' + esc(quality.direct_fact_count || 0) + ' 条 · 计划核对 ' + esc(quality.plan_checked_count || 0) + ' 条 · 覆盖 ' + esc(quality.comparable_fact_days || 0) + ' 天。' + esc(quality.limitation || '') + '</p>' : '';
  const provenance = meta ? '<section class="report-provenance"><div><strong>' + (meta.model ? '模型：' + esc(meta.model) : '本地安全规则') + '</strong><span>纳入 ' + meta.eventCount + ' 条记录 · ' + meta.windowDays + ' 天窗口 · ' + formatTime(report.createdAt) + '</span></div><p>' + esc(meta.sentToModel) + '</p>' + qualityLine + '</section>' : '';
  const observations = analysis.observations.map(item => '<article class="observation"><strong>' + esc(item.title) + '</strong><p><b>证据：</b>' + item.evidence.map(esc).join('；') + '</p><p class="limit">局限：' + esc(item.limitations) + '</p><p class="action"><b>接下来做：</b>' + esc(item.suggested_action) + '</p></article>').join('');
  let feedback = '';
  if (report && report.feedback) feedback = '<section class="report-feedback done">已记录反馈：' + (report.feedback.rating === 'helpful' ? '有帮助' : '暂时没帮助') + ' · 谢谢，这会帮助我们改进试用版。</section>';
  if (report && !report.feedback) feedback = '<section class="report-feedback"><strong>这份报告对你有帮助吗？</strong><div><button class="secondary feedback-button" type="button" data-report-id="' + esc(report.id) + '" data-report-feedback="helpful">有帮助</button><button class="secondary feedback-button" type="button" data-report-id="' + esc(report.id) + '" data-report-feedback="not_helpful">暂时没帮助</button></div></section>';
  $('#analysisOutput').innerHTML = '<div class="report-top"><div><p class="eyebrow">' + source + '</p><h3>' + status + '</h3></div><span class="pill ' + (analysis.status === 'urgent' ? 'urgent' : '') + '">置信度：' + esc(analysis.confidence) + '</span></div>' + provenance + observations + '<p class="escalation">' + esc(analysis.escalation) + '</p>' + feedback;
}
function renderAll() {
  renderRecipientSwitcher();
  renderSceneForms();
  renderStatus();
  renderHome();
  renderContinuity();
  renderEvents();
  renderFoodSummary();
  renderFoodIdeas(state.foodIdeas);
  renderAlertOverview(state.alertSummary);
  renderAlertCenter(state.alertSummary);
  renderMedicationSummary();
  renderSafety();
  renderSafetyActionCard();
  renderSafetyAnswer(state.safetyAnswer);
  renderProfile();
  renderConfig();
  renderScreeningResult();
  $('#reportCopy').textContent = sceneKey() === 'senior' ? '只发送类别、状态、时间段、记录依据、本地提取标签和去身份化的用药状态汇总；不发送原始备注、药品标记或身份信息。' : '只发送类别、状态、时间段、记录依据与本地提取标签；不发送原始备注或身份信息。';
  if (state.currentReport) renderAnalysis(state.currentReport.analysis, state.currentReport);
  else $('#analysisOutput').innerHTML = '<p>配置模型并添加至少 3 条记录后，即可生成第一份报告。</p>';
}
async function loadApp() {
  state.safetyAnswer = null;
  state.foodIdeas = null;
  const recipientResult = await api('/api/recipients');
  state.recipients = recipientResult.recipients || [];
  const storedRecipientId = sessionStorage.getItem('care-companion-active-recipient');
  const available = state.recipients.some(recipient => recipient.id === state.activeRecipientId);
  const storedAvailable = state.recipients.some(recipient => recipient.id === storedRecipientId);
  state.activeRecipientId = available ? state.activeRecipientId : storedAvailable ? storedRecipientId : state.recipients[0]?.id || null;
  state.creatingRecipient = false;
  if (state.activeRecipientId) sessionStorage.setItem('care-companion-active-recipient', state.activeRecipientId);
  else sessionStorage.removeItem('care-companion-active-recipient');
  const results = await Promise.all([
    api('/api/profile'), api('/api/events'), api('/api/settings/llm'), api('/api/screening/questions'), api('/api/screenings/latest'), api('/api/care-plan'), api('/api/reports/latest'), api('/api/food/summary'), api('/api/medications/summary'), api('/api/safety/incidents'), api('/api/screenings/history'), api('/api/alerts/summary'), api('/api/evidence/summary'), api('/api/handoffs/latest')
  ]);
  state.profile = results[0].profile;
  state.profileSceneLocked = Boolean(results[0].sceneLocked);
  state.events = results[1].events;
  state.config = results[2].config;
  state.questions = results[3].questions;
  state.scale = results[3].scale;
  state.screeningMeta = { mode: results[3].mode, scene: results[3].scene, template: results[3].template, templateMeta: results[3].templateMeta, baselineNotice: results[3].baselineNotice || '' };
  state.screening = results[4].result;
  state.plan = results[5].plan;
  state.currentReport = results[6].report;
  state.foodSummary = results[7].summary;
  state.medicationSummary = results[8].summary;
  state.safetyIncidents = results[9].incidents;
  state.screeningHistory = results[10].history;
  state.alertSummary = results[11].summary;
  state.evidenceSummary = results[12].summary;
  state.latestHandoff = results[13].handoff;
  renderAll();
}

$('#authModeButton').addEventListener('click', () => {
  authMode = authMode === 'login' ? 'register' : 'login';
  $('#authSubmit').textContent = authMode === 'login' ? '登录' : '创建账号';
  $('#authModeButton').textContent = authMode === 'login' ? '没有账号？创建试用账号' : '已有账号？返回登录';
});
$('#authForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  try {
    const result = await api('/api/auth/' + (authMode === 'login' ? 'login' : 'register'), { method: 'POST', body: JSON.stringify({ email: form.get('email'), password: form.get('password') }) });
    state = emptyState();
    renderAll();
    showView('home');
    state.user = result.user;
    $('#authView').hidden = true;
    $('#appView').hidden = false;
    await loadApp();
    toast(authMode === 'login' ? '登录成功' : '账号已创建');
  } catch (error) { toast(error.message); }
});
$('#logoutButton').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' });
  state = emptyState();
  renderAll();
  showView('home');
  $('#appView').hidden = true;
  $('#authView').hidden = false;
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-go]');
  if (button) showView(button.dataset.go);
});
$('#startScreeningButton').addEventListener('click', startScreening);
$('#profileScene').addEventListener('change', () => {
  if (state.profile && state.profileSceneLocked) return;
  const selected = $('#profileScene').value === 'senior' ? 'senior' : 'child';
  $('#profileSegment').innerHTML = optionList(SCENES[selected].segments, SCENES[selected].segments[0]);
});
$('#profileForm').addEventListener('submit', async event => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget));
  payload.scene = state.profile && state.profileSceneLocked ? state.profile.scene : $('#profileScene').value;
  try {
    const creating = state.creatingRecipient || !state.activeRecipientId;
    const result = await api(creating ? '/api/recipients' : '/api/profile', { method: creating ? 'POST' : 'PUT', body: JSON.stringify(payload) });
    if (result.recipient && result.recipient.id) {
      state.activeRecipientId = result.recipient.id;
      sessionStorage.setItem('care-companion-active-recipient', state.activeRecipientId);
    }
    state.creatingRecipient = false;
    state.profile = result.profile;
    state.profileSceneLocked = Boolean(result.sceneLocked);
    await loadApp();
    showView('home');
    toast(creating ? '新的照护对象档案已加密创建' : '照护对象档案已加密保存');
  } catch (error) { toast(error.message); }
});
$('#recipientSwitcher').addEventListener('change', async event => {
  if (event.target.id !== 'recipientSelect') return;
  state.activeRecipientId = event.target.value;
  state.creatingRecipient = false;
  sessionStorage.setItem('care-companion-active-recipient', state.activeRecipientId);
  try { await loadApp(); showView('home'); toast('已切换照护对象'); } catch (error) { toast(error.message); }
});
$('#recipientSwitcher').addEventListener('click', event => {
  if (event.target.closest('[data-new-recipient]')) prepareNewRecipient();
});
$('#llmForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try {
    const result = await api('/api/settings/llm', { method: 'PUT', body: JSON.stringify(Object.fromEntries(new FormData(formElement))) });
    state.config = result.config;
    formElement.elements.apiKey.value = '';
    renderAll();
    toast('个人模型已启用');
  } catch (error) { toast(error.message); }
});
$('#removeLLMButton').addEventListener('click', async () => {
  if (!state.config.configured || !confirm('确定删除自己的模型 Key 配置吗？')) return;
  try {
    await api('/api/settings/llm', { method: 'DELETE' });
    state.config = { configured: false };
    $('#llmForm').reset();
    renderAll();
    toast('模型配置已删除');
  } catch (error) { toast(error.message); }
});
$('#eventForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const result = await api('/api/events', { method: 'POST', body: JSON.stringify({ category: form.get('category'), mood: form.get('mood'), note: form.get('note'), reporter: form.get('reporter'), basis: form.get('basis'), occurredAt: new Date(form.get('occurredAt')).getTime() }) });
    formElement.reset();
    formElement.elements.occurredAt.value = datetimeValue();
    await loadApp();
    toast(result.alerts?.length ? '记录已保存，并已写入照护关注提醒' : '记录已加密保存');
  } catch (error) { toast(error.message); }
});
$('#foodForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const result = await api('/api/food/logs', { method: 'POST', body: JSON.stringify({ occurredAt: new Date(form.get('occurredAt')).getTime(), mealType: form.get('mealType'), groups: form.getAll('groups'), colors: form.getAll('colors'), appetite: form.get('appetite'), reaction: form.get('reaction'), reporter: form.get('reporter'), basis: form.get('basis'), note: form.get('note') }) });
    formElement.reset();
    formElement.elements.occurredAt.value = datetimeValue();
    await loadApp();
    toast(result.alerts?.length ? '这一餐已保存，并已写入饮食关注提醒' : '这一餐已加密保存');
  } catch (error) { toast(error.message); }
});
$('#generateMealIdeas').addEventListener('click', async event => {
  const formElement = $('#foodForm');
  const form = new FormData(formElement);
  const ingredients = String(form.get('note') || '').trim();
  if (ingredients.length < 2) {
    toast('先写下至少一种今日食材，再生成食谱灵感');
    $('#foodNote').focus();
    return;
  }
  const button = event.currentTarget;
  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = '正在生成…';
  try {
    const result = await api('/api/food/ideas', { method: 'POST', body: JSON.stringify({ ingredients, mealType: form.get('mealType'), groups: form.getAll('groups'), appetite: form.get('appetite'), reaction: form.get('reaction') }) });
    state.foodIdeas = result.ideas;
    renderFoodIdeas(state.foodIdeas);
    $('#foodAIOutput').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast(result.ideas.source === 'byok_model' ? '已生成本次家常食谱灵感' : '模型格式异常，已显示本地整理提示');
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = originalLabel;
  }
});
$('#medicationForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const result = await api('/api/medications/logs', { method: 'POST', body: JSON.stringify({ occurredAt: new Date(form.get('occurredAt')).getTime(), period: form.get('period'), status: form.get('status'), label: form.get('label'), reporter: form.get('reporter'), basis: form.get('basis'), note: form.get('note') }) });
    formElement.reset();
    formElement.elements.occurredAt.value = datetimeValue();
    await loadApp();
    toast(result.alerts?.length ? '用药状态已保存，并已写入照护关注提醒' : '用药状态已加密保存；药品标记和备注不会发送给 AI');
  } catch (error) { toast(error.message); }
});
$('#safetyForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    const result = await api('/api/safety/incidents', { method: 'POST', body: JSON.stringify({ occurredAt: new Date(form.get('occurredAt')).getTime(), incidentType: form.get('incidentType'), action: form.get('action'), reporter: form.get('reporter'), basis: form.get('basis'), note: form.get('note') }) });
    formElement.reset();
    formElement.elements.occurredAt.value = datetimeValue();
    await loadApp();
    toast(result.alerts?.length ? '紧急事件已加密留存，并已生成优先处理提醒' : '紧急事件已加密留存，不会发送给 AI');
  } catch (error) { toast(error.message); }
});
$('#refreshEvents').addEventListener('click', loadApp);
$('#continuityCard').addEventListener('click', async event => {
  const button = event.target.closest('[data-confirm-handoff]');
  if (!button) return;
  const receiverRole = $('#handoffReceiverRole')?.value || '共同照护者';
  try {
    button.disabled = true;
    button.textContent = '正在确认…';
    const result = await api('/api/handoffs', { method: 'POST', body: JSON.stringify({ receiverRole }) });
    state.latestHandoff = result.handoff;
    state.evidenceSummary = result.evidence;
    renderContinuity();
    toast('已加密留存交接确认；原始备注没有放入交接摘要');
  } catch (error) {
    button.disabled = false;
    button.textContent = '确认已交接';
    toast(error.message);
  }
});
$('#eventList').addEventListener('click', async event => {
  const button = event.target.closest('[data-delete-event]');
  if (!button || !confirm('删除这条记录？')) return;
  try { await api('/api/events/' + button.dataset.deleteEvent, { method: 'DELETE' }); await loadApp(); toast('记录已删除'); } catch (error) { toast(error.message); }
});
$('#safetyIncidentList').addEventListener('click', async event => {
  const button = event.target.closest('[data-delete-safety]');
  if (!button || !confirm('删除这条紧急事件留存？')) return;
  try { await api('/api/events/' + button.dataset.deleteSafety, { method: 'DELETE' }); await loadApp(); toast('紧急事件留存已删除'); } catch (error) { toast(error.message); }
});
$('#planCard').addEventListener('change', async event => {
  const input = event.target.closest('[data-plan-task]');
  if (!input) return;
  try {
    const result = await api('/api/care-plan/tasks/' + input.dataset.planTask, { method: 'PATCH', body: JSON.stringify({ completed: input.checked }) });
    state.plan = result.plan;
    renderAll();
  } catch (error) { toast(error.message); }
});
$('#reportButton').addEventListener('click', async () => {
  try {
    $('#reportButton').disabled = true;
    $('#reportButton').textContent = '正在使用你的模型…';
    const result = await api('/api/ai/report', { method: 'POST', body: '{}' });
    renderAnalysis(result.analysis, result.report);
  } catch (error) { toast(error.message); }
  finally {
    $('#reportButton').disabled = false;
    $('#reportButton').textContent = '使用我的模型生成报告';
  }
});
$('#askForm').addEventListener('submit', async event => {
  event.preventDefault();
  const question = new FormData(event.currentTarget).get('question');
  try { const result = await api('/api/ai/ask', { method: 'POST', body: JSON.stringify({ question }) }); renderAnalysis(result.analysis); } catch (error) { toast(error.message); }
});
$('#safetyAskForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#safetyAskButton');
  const question = new FormData(event.currentTarget).get('question');
  try {
    button.disabled = true;
    button.textContent = '正在整理留存重点…';
    const result = await api('/api/safety/ask', { method: 'POST', body: JSON.stringify({ question }) });
    state.safetyAnswer = result.analysis;
    renderSafetyAnswer(state.safetyAnswer);
  } catch (error) { toast(error.message); }
  finally {
    button.disabled = false;
    button.textContent = '使用我的模型梳理留存重点';
  }
});
$('#analysisOutput').addEventListener('click', async event => {
  const button = event.target.closest('[data-report-feedback]');
  if (!button) return;
  try {
    button.disabled = true;
    const result = await api('/api/reports/' + button.dataset.reportId + '/feedback', { method: 'PATCH', body: JSON.stringify({ rating: button.dataset.reportFeedback }) });
    renderAnalysis(result.report.analysis, result.report);
    toast('反馈已加密记录，感谢你的试用意见');
  } catch (error) { button.disabled = false; toast(error.message); }
});

(async () => {
  ['#eventForm', '#foodForm', '#medicationForm', '#safetyForm'].forEach(selector => { $(selector).elements.occurredAt.value = datetimeValue(); });
  renderAll();
  try {
    const result = await api('/api/me');
    if (!result.user) return;
    state.user = result.user;
    $('#authView').hidden = true;
    $('#appView').hidden = false;
    await loadApp();
  } catch { toast('无法连接服务端'); }
})();
