/**
 * Host half of the memory star map.
 *
 * Owns the durable memory store (a JSON file under the profile), the agent
 * tool that reads/writes it, the automatic capture of memorable user
 * messages, and the retrieval that is injected into the agent context.
 *
 * Every successful retrieval strengthens the memory (spacing effect), which
 * is what "recalling it makes it stronger" means here.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DAY = 86400000;
const UNTAGGED = '未分类';
const API_PATH = '/api/memory-starmap';

/* ------------------------------------------------------------------ *
 * Forgetting model — kept in lock-step with the Client module.
 * ------------------------------------------------------------------ */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function baseStability(importance) {
  return 4.5 * (0.55 + 0.22 * clamp(Number(importance) || 3, 1, 5));
}

function retention(node, at) {
  const s = Math.max(0.05, Number(node.stability) || baseStability(node.importance));
  const dt = Math.max(0, at - (Number(node.lastReview) || at));
  return Math.exp(-dt / (s * DAY));
}

function recallNode(node, at) {
  const importance = clamp(Number(node.importance) || 3, 1, 5);
  const growth = 1.55 + 0.12 * importance;
  return Object.assign({}, node, {
    lastReview: at,
    reviews: (Number(node.reviews) || 0) + 1,
    stability: clamp((Number(node.stability) || baseStability(importance)) * growth, 0.4, 5000),
  });
}

function uid() {
  return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function normalizeNode(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const node = {
    id: raw.id ? String(raw.id) : uid(),
    title: String(raw.title || '未命名的记忆').slice(0, 120),
    content: String(raw.content || ''),
    tags: Array.isArray(raw.tags) && raw.tags.length ? raw.tags.map(String).slice(0, 5) : [UNTAGGED],
    importance: clamp(Number(raw.importance) || 3, 1, 5),
    createdAt: Number(raw.createdAt) || Date.now(),
    lastReview: Number(raw.lastReview) || Number(raw.createdAt) || Date.now(),
    reviews: Math.max(0, Number(raw.reviews) || 0),
    stability: Number(raw.stability) || baseStability(Number(raw.importance) || 3),
  };
  if (typeof raw.x === 'number') node.x = raw.x;
  if (typeof raw.y === 'number') node.y = raw.y;
  if (typeof raw.z === 'number') node.z = raw.z;
  if (typeof raw.phase === 'number') node.phase = raw.phase;
  if (raw.source === 'auto') node.source = 'auto';
  return node;
}

/* ------------------------------------------------------------------ *
 * Theme vocabulary for automatic tagging.
 * ------------------------------------------------------------------ */
const TAG_WORDS = {
  家人: ['妈妈', '爸爸', '母亲', '父亲', '外婆', '外公', '奶奶', '爷爷', '家里', '家人', '弟弟', '妹妹', '哥哥', '姐姐', '儿子', '女儿'],
  朋友: ['朋友', '同学', '同事', '室友', '兄弟', '闺蜜', '哥们', '发小'],
  工作: ['工作', '上班', '加班', '项目', '公司', '老板', '面试', '辞职', '工资', '同事', '客户', '会议'],
  学习: ['学习', '考试', '学校', '大学', '专业', '作业', '论文', '毕业', '老师', '课程'],
  旅行: ['旅行', '旅游', '景点', '机票', '酒店', '海边', '爬山', '出发', '出差', '民宿'],
  城市: ['城市', '地铁', '租房', '搬家', '北京', '上海', '深圳', '广州', '杭州', '成都', '南京', '武汉'],
  音乐: ['歌', '音乐', '乐队', '专辑', '演唱会', '耳机', '吉他', '钢琴', '电台'],
  电影: ['电影', '剧', '导演', '演员', '影院', '纪录片'],
  游戏: ['游戏', '开黑', '服务器', '通关', '比赛', '队友'],
  美食: ['吃', '饭', '菜', '咖啡', '奶茶', '餐厅', '味道', '做饭', '火锅', '甜品'],
  夜晚: ['晚上', '夜里', '凌晨', '月亮', '星星', '深夜', '熬夜'],
  夏天: ['夏天', '暑假', '蝉', '空调', '西瓜'],
  冬天: ['冬天', '下雪', '雪', '冷', '暖气'],
  秋天: ['秋天', '落叶', '桂花'],
  春天: ['春天', '樱花', '花开'],
  童年: ['小时候', '童年', '小学', '幼儿园', '玩具'],
  成长: ['长大', '成长', '第一次', '学会', '终于', '后来'],
  日常: ['每天', '习惯', '总是', '一般', '经常', '周末'],
  情绪: ['开心', '难过', '焦虑', '害怕', '感动', '孤独', '委屈', '幸福', '生气'],
  健康: ['生病', '医院', '睡觉', '失眠', '跑步', '健身', '减肥', '体检'],
};

function pickTags(text) {
  const hits = [];
  for (const tag of Object.keys(TAG_WORDS)) {
    if (TAG_WORDS[tag].some((w) => text.includes(w))) hits.push(tag);
  }
  return hits.slice(0, 3);
}

/* ------------------------------------------------------------------ *
 * Text helpers
 * ------------------------------------------------------------------ */
function messageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content.trim();
  const blocks = Array.isArray(message.content) ? message.content : [];
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  const words = s.match(/[a-z0-9]{2,}/g) || [];
  for (const w of words) out.add(w);
  const segments = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of segments) {
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
    if (seg.length <= 4) out.add(seg);
  }
  return out;
}

function bigrams(text) {
  const s = String(text || '').replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

function titleSimilarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** Turn a raw chat message into a short, readable memory title. */
function cleanTitle(text) {
  let s = String(text || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/^(嗯+|哦+|对了|其实|话说|然后|就是|另外|还有|不过)[，,、\s]*/, '');
  const first = (s.split(/[。！？!?\n]/)[0] || s).trim();
  const cut = first.length > 22 ? first.slice(0, 22) : first;
  return cut || s.slice(0, 22);
}

function scoreMemory(node, queryTokens, rawQuery) {  let score = 0;
  const title = String(node.title || '').toLowerCase();
  const content = String(node.content || '').toLowerCase();
  for (const tag of node.tags || []) {
    if (tag !== UNTAGGED && rawQuery.includes(tag)) score += 3;
  }
  let hits = 0;
  for (const tok of queryTokens) {
    if (tok.length < 2) continue;
    if (title.includes(tok)) {
      score += 2;
      hits++;
    } else if (content.includes(tok)) {
      score += 1;
      hits++;
    }
  }
  return score + Math.min(hits, 3) * 0.4;
}

/* ------------------------------------------------------------------ *
 * Durable store
 * ------------------------------------------------------------------ */
function storePath() {
  // DSH_PROFILE_DIR is only exported to shell calls, so the Host falls back to
  // the shared DSH home; one star map for every profile of this user.
  const base = process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh');
  return path.join(base, 'memory-starmap', 'memories.json');
}

function createStore(file) {
  const state = {
    version: 0,
    settings: { autoCapture: true, autoRecall: true },
    nodes: [],
  };
  let writeTimer = null;
  let dirty = false;

  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.nodes)) {
      state.nodes = parsed.nodes.map(normalizeNode).filter(Boolean);
    }
    if (parsed && parsed.settings && typeof parsed.settings === 'object') {
      state.settings.autoCapture = parsed.settings.autoCapture !== false;
      state.settings.autoRecall = parsed.settings.autoRecall !== false;
    }
    state.version = Number(parsed.version) || 0;
  } catch (err) {
    // first run, unreadable file, or invalid JSON: start empty
  }

  function writeNow() {
    if (!dirty) return;
    dirty = false;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const payload = JSON.stringify({ version: state.version, settings: state.settings, nodes: state.nodes }, null, 2);
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      // keep the in-memory copy; retry on the next write
      dirty = true;
    }
  }

  function touch() {
    state.version += 1;
    dirty = true;
    if (writeTimer) return;
    writeTimer = setTimeout(() => {
      writeTimer = null;
      writeNow();
    }, 250);
    if (writeTimer.unref) writeTimer.unref();
  }

  function flush() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    writeNow();
  }

  const index = () => new Map(state.nodes.map((n) => [n.id, n]));

  return {
    snapshot() {
      return { version: state.version, settings: Object.assign({}, state.settings), nodes: state.nodes.map((n) => Object.assign({}, n)) };
    },
    settings() {
      return state.settings;
    },
    updateSettings(patch) {
      if (!patch || typeof patch !== 'object') return state.settings;
      if (typeof patch.autoCapture === 'boolean') state.settings.autoCapture = patch.autoCapture;
      if (typeof patch.autoRecall === 'boolean') state.settings.autoRecall = patch.autoRecall;
      touch();
      return Object.assign({}, state.settings);
    },
    get(id) {
      return index().get(id);
    },
    save(raw) {
      const node = normalizeNode(raw);
      if (!node) return null;
      const map = index();
      const existing = map.get(node.id);
      const merged = existing ? Object.assign({}, existing, node) : node;
      const at = state.nodes.findIndex((n) => n.id === node.id);
      if (at >= 0) state.nodes[at] = merged;
      else state.nodes.push(merged);
      touch();
      return merged;
    },
    saveMany(list) {
      if (!Array.isArray(list)) return 0;
      let count = 0;
      for (const raw of list) {
        const node = normalizeNode(raw);
        if (!node) continue;
        const at = state.nodes.findIndex((n) => n.id === node.id);
        if (at >= 0) state.nodes[at] = Object.assign({}, state.nodes[at], node);
        else state.nodes.push(node);
        count++;
      }
      if (count) touch();
      return count;
    },
    remove(id) {
      const before = state.nodes.length;
      state.nodes = state.nodes.filter((n) => n.id !== id);
      if (state.nodes.length !== before) touch();
      return state.nodes.length !== before;
    },
    clear() {
      state.nodes = [];
      touch();
    },
    import(list) {
      const nodes = (Array.isArray(list) ? list : []).map(normalizeNode).filter(Boolean);
      state.nodes = nodes;
      touch();
      return nodes.length;
    },
    create(fields) {
      const text = String((fields && fields.content) || '');
      const tags = fields && Array.isArray(fields.tags) && fields.tags.length ? fields.tags.slice(0, 5) : pickTags(text);
      const node = normalizeNode({
        id: fields && fields.id,
        title: fields && fields.title,
        content: text,
        tags: tags.length ? tags : [UNTAGGED],
        importance: fields && fields.importance,
        source: fields && fields.source,
      });
      state.nodes.push(node);
      touch();
      return node;
    },
    search(query, limit) {
      const raw = String(query || '').toLowerCase();
      if (!raw) return [];
      const qt = tokens(raw);
      const scored = [];
      for (const node of state.nodes) {
        const score = scoreMemory(node, qt, raw);
        if (score >= 2.5) scored.push({ node, score });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, Math.max(1, Number(limit) || 3)).map((s) => s.node);
    },
    reinforce(node, at) {
      const next = recallNode(node, at);
      const map = index();
      if (map.has(node.id)) this.save(next);
      return next;
    },
    reinforceMany(nodes, at) {
      const out = [];
      for (const node of nodes) out.push(this.reinforce(node, at));
      return out;
    },
    shouldCapture(text) {
      return shouldCapture(text);
    },
    findSimilar(title, content) {
      const body = String(content || '').slice(0, 40);
      return (
        state.nodes.find((n) => {
          if (body && n.content && n.content.slice(0, 40) === body) return true;
          return titleSimilarity(n.title, title) >= 0.55;
        }) || null
      );
    },
    capture(text) {
      const trimmed = String(text || '').trim();
      if (!trimmed) return null;
      const title = cleanTitle(trimmed);
      const content = trimmed.slice(0, 600);
      if (this.findSimilar(title, content)) return null;
      const importance = /永远|最重要|一辈子|第一次|再也不会|最难忘/.test(trimmed) ? 4 : 3;
      const tags = pickTags(trimmed);
      return this.create({ title, content, tags: tags.length ? tags : [UNTAGGED], importance, source: 'auto' });
    },
    flush,
  };
}

/** Heuristic gate: only messages that sound like durable personal facts. */
function shouldCapture(text) {
  const t = String(text || '').trim();
  if (t.length < 8 || t.length > 600) return false;
  if (t.startsWith('/') || t.startsWith('!')) return false;
  if (/^(帮我|请|麻烦|写|改|翻译|查|搜|找|解释|总结|生成|列出|给我|告诉我)/.test(t)) return false;
  if (/[?？]\s*$/.test(t)) return false;
  if (/^(什么|怎么|为什么|如何|哪里|谁|哪些|能不能|可不可以|是否)/.test(t)) return false;
  const explicit = /^(记住|记一下|帮我记住|别忘了|记下来)[：:,\s]/.test(t);
  const personal = /(我|俺)(的|家|们)?[^。！？\n]{0,40}(记得|第一次|小时候|以前|后来|那天|那年|最近|喜欢|讨厌|养了|养了只|住在|工作在|上学|认识|结婚|搬|去过|吃过|玩过|学会|开始|总是|每天|习惯|决定|答应|害怕|期待)/.test(t);
  const pastEvent = /(那天|那年|小时候|有一次|第一次|后来|直到|当时)/.test(t) && t.length >= 14;
  return explicit || personal || pastEvent;
}

/* ------------------------------------------------------------------ *
 * Plugin
 * ------------------------------------------------------------------ */
export const inject = ['tools', 'systemPrompt'];

export function apply(ctx) {
  const store = createStore(storePath());
  const recalled = new Map(); // sessionId -> { ids, at }
  const reinforced = new Map(); // `${sessionId}:${nodeId}` -> bucket
  const agentDisposers = new Map();

  ctx.effect(() => () => store.flush());

  function reinforceOnce(nodes, sessionId, at) {
    if (reinforced.size > 4000) reinforced.clear();
    const bucket = Math.floor(at / (5 * 60000));
    const fresh = [];
    for (const node of nodes) {
      const key = String(sessionId) + ':' + node.id;
      if (reinforced.get(key) === bucket) continue;
      reinforced.set(key, bucket);
      fresh.push(node);
    }
    if (fresh.length) store.reinforceMany(fresh, at);
    return fresh.length;
  }

  /** Subagents write their own prompts into their inbox; only a real user
   * conversation with a root agent should feed the shared star map. */
  function isRootAgent(agent) {
    try {
      const agents = ctx.get('agents');
      if (!agents || typeof agents.roots !== 'function') return true;
      return agents.roots().some((a) => String(a.id) === String(agent.id));
    } catch (err) {
      return true;
    }
  }

  function recallContextFor(sessionId) {
    const entry = recalled.get(String(sessionId));
    if (!entry || !entry.ids || !entry.ids.length) return '';
    const nodes = store.snapshot().nodes;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const picked = entry.ids.map((id) => byId.get(id)).filter(Boolean);
    if (!picked.length) return '';
    const now = Date.now();
    const lines = picked.map((node, i) => {
      const r = Math.round(retention(node, now) * 100);
      const body = String(node.content || '').replace(/\s+/g, ' ').slice(0, 90);
      return `${i + 1}. 「${node.title}」[${(node.tags || []).join('/')}] 清晰度 ${r}% — ${body}`;
    });
    return [
      '以下记忆来自用户的记忆星图，与当前话题相关；它们刚被回忆并因此得到强化。请自然地在回答中利用它们，不要逐条复述，也不要说“根据记忆库”。',
      ...lines,
    ].join('\n');
  }

  /* ---- automatic capture + recall on every user message ---- */
  ctx.on('agent/inbox/claimed', (payload) => {
    try {
      const agent = payload && payload.agent;
      if (!agent || !agent.id) return;
      if (!isRootAgent(agent)) return;
      const text = messageText(payload.message);
      if (!text) return;
      const sessionId = String(agent.id);

      if (store.settings().autoRecall) {
        const matches = store.search(text, 3);
        if (matches.length) {
          reinforceOnce(matches, sessionId, Date.now());
          recalled.set(sessionId, { ids: matches.map((n) => n.id), at: Date.now() });
        } else {
          recalled.delete(sessionId);
        }
      } else {
        recalled.delete(sessionId);
      }

      if (store.settings().autoCapture && store.shouldCapture(text)) {
        store.capture(text);
      }
    } catch (err) {
      // auto-memory must never break a turn
    }
  });

  /* ---- per-agent prompt context carrying the recalled memories ---- */
  function attachAgent(agent) {
    if (!agent || !agent.ctx) return;
    const key = String(agent.id);
    if (agentDisposers.has(key)) return;
    try {
      if (!agent.ctx.systemPrompt) return;
      const dispose = agent.ctx.systemPrompt.context({
        name: 'memory-starmap-recall',
        order: 60,
        text: () => {
          try {
            return isRootAgent(agent) ? recallContextFor(agent.id) : '';
          } catch (err) {
            return '';
          }
        },
      });
      agentDisposers.set(key, dispose);
    } catch (err) {
      // an agent without a prompt context simply gets no recall
    }
  }

  ctx.on('agent/created', (payload) => {
    try {
      attachAgent(payload && payload.agent);
    } catch (err) {}
  });

  // Cover agents that were already live when this plugin (re)loaded.
  try {
    const agentsService = ctx.get('agents');
    if (agentsService && typeof agentsService.list === 'function') {
      for (const live of agentsService.list()) attachAgent(live);
    }
  } catch (err) {}

  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload && payload.agent;
      if (!agent) return;
      const key = String(agent.id);
      const dispose = agentDisposers.get(key);
      if (dispose) {
        try {
          dispose();
        } catch (err) {}
        agentDisposers.delete(key);
      }
      recalled.delete(key);
    } catch (err) {}
  });

  ctx.effect(() => () => {
    for (const dispose of agentDisposers.values()) {
      try {
        dispose();
      } catch (err) {}
    }
    agentDisposers.clear();
    recalled.clear();
  });

  /* ---- guidance for the model ---- */
  ctx.systemPrompt.section({
    name: 'memory-starmap',
    order: 90,
    text: [
      '## 记忆星图',
      '你有一张长期记忆星图，工具名 memory_starmap。',
      '- 当用户分享值得长期记住的个人信息、偏好、重要经历、承诺或关系时，主动用 action=save 记下来：标题简短，内容保留关键细节，标签给 1-3 个主题词。',
      '- 当回答涉及用户的个人情况、偏好或过去经历时，先用 action=search 检索记忆；被检索到的记忆会自动强化。',
      '- 不要把一次性任务、临时路径、代码片段、凭据或用户的隐私数据写进记忆。',
      '- 记忆会随时间和回忆次数变化清晰度；如果用户提到某件事已经过去很久，优先检索并确认，而不是凭空断言。',
    ].join('\n'),
  });

  /* ---- the tool ---- */
  ctx.tools.register({
    name: 'memory_starmap',
    description:
      '读写用户的长期记忆星图。action=save 保存一段值得记住的事；search 按关键词检索相关记忆（检索会强化记忆）；list 列出最近记忆；recall 手动回忆并强化一条；forget 删除一条。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['save', 'search', 'list', 'recall', 'forget'] },
        title: { type: 'string', description: 'save 时的简短标题' },
        content: { type: 'string', description: 'save 时的内容细节' },
        tags: { type: 'array', items: { type: 'string' }, description: 'save 时的 1-3 个主题标签' },
        importance: { type: 'integer', minimum: 1, maximum: 5, description: '1-5，越重要淡忘越慢' },
        query: { type: 'string', description: 'search 的关键词或一句话' },
        id: { type: 'string', description: 'recall / forget 的目标记忆 id' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'search/list 的条数' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      render(_args, value) {
        return [{ type: 'text', text: String((value && value.text) || '') }];
      },
    },
    async execute(args) {
      const a = args || {};
      const now = Date.now();
      if (a.action === 'save') {
        if (!a.title && !a.content) return { text: '需要 title 或 content。' };
        const title = a.title || cleanTitle(a.content);
        const content = a.content || a.title || '';
        const similar = store.findSimilar(title, content);
        if (similar) {
          store.reinforce(similar, now);
          return { text: `星图里已有相近的记忆「${similar.title}」，已把它重新点亮。`, id: similar.id };
        }
        const node = store.create({
          title: title,
          content: content,
          tags: Array.isArray(a.tags) ? a.tags : [],
          importance: a.importance || 3,
        });
        return { text: `已记入星图：「${node.title}」（${node.tags.join('/') || UNTAGGED}）。`, id: node.id };
      }
      if (a.action === 'search') {
        const matches = store.search(a.query || '', a.limit || 3);
        if (!matches.length) return { text: '没有找到相关记忆。' };
        const sessionId = 'tool';
        reinforceOnce(matches, sessionId, now);
        const lines = matches.map((n, i) => {
          const r = Math.round(retention(n, now) * 100);
          return `${i + 1}. [${n.id}] 「${n.title}」[${(n.tags || []).join('/')}] 清晰度 ${r}% — ${String(n.content || '').slice(0, 120)}`;
        });
        return { text: '相关记忆（已强化）：\n' + lines.join('\n') };
      }
      if (a.action === 'list') {
        const nodes = store
          .snapshot()
          .nodes.slice()
          .sort((x, y) => (Number(y.lastReview) || 0) - (Number(x.lastReview) || 0))
          .slice(0, a.limit || 10);
        if (!nodes.length) return { text: '星图还是空的。' };
        return {
          text: nodes
            .map((n, i) => `${i + 1}. [${n.id}] 「${n.title}」[${(n.tags || []).join('/')}] 清晰度 ${Math.round(retention(n, now) * 100)}%`)
            .join('\n'),
        };
      }
      if (a.action === 'recall') {
        const node = a.id ? store.get(a.id) : null;
        if (!node) return { text: '没找到这条记忆。' };
        const next = store.reinforce(node, now);
        return {
          text: `「${next.title}」被重新点亮：清晰度回到 100%，稳定性从 ${Math.round(Number(node.stability))} 天提升到 ${Math.round(Number(next.stability))} 天。`,
        };
      }
      if (a.action === 'forget') {
        if (!a.id) return { text: '需要 id。' };
        const ok = store.remove(a.id);
        return { text: ok ? '这条记忆已经消散。' : '没找到这条记忆。' };
      }
      return { text: '未知 action。' };
    },
  });

  /* ---- HTTP bridge for the Web UI ---- */
  ctx.inject(['webServer'], (webCtx) => {
    let origin = '';
    try {
      origin = webCtx.webServer.getOrigin();
    } catch (err) {}

    function allowed(req) {
      const value = req.headers.origin;
      if (!value) return true; // same-origin GET and non-browser callers
      if (origin && value === origin) return true;
      return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(value);
    }

    function send(res, code, obj) {
      try {
        const body = JSON.stringify(obj);
        res.writeHead(code, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        });
        res.end(body);
      } catch (err) {
        try {
          res.destroy();
        } catch (e) {}
      }
    }

    function readBody(req) {
      return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];
        req.on('data', (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            reject(new Error('body too large'));
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve(text ? JSON.parse(text) : {});
          } catch (err) {
            reject(err);
          }
        });
        req.on('error', reject);
      });
    }

    webCtx.effect(() =>
      webCtx.webServer.register({
        kind: 'exact',
        path: API_PATH,
        async handler(req, res) {
          try {
            if (!allowed(req)) {
              send(res, 403, { ok: false, error: 'forbidden' });
              return;
            }
            if (req.method === 'GET') {
              const snapshot = store.snapshot();
              snapshot.ok = true;
              send(res, 200, snapshot);
              return;
            }
            if (req.method !== 'POST') {
              send(res, 405, { ok: false, error: 'method not allowed' });
              return;
            }
            const body = await readBody(req);
            const op = body && body.op;
            if (op === 'save' && body.node) store.save(body.node);
            else if (op === 'saveMany' && Array.isArray(body.nodes)) store.saveMany(body.nodes);
            else if (op === 'delete' && body.id) store.remove(String(body.id));
            else if (op === 'clear') store.clear();
            else if (op === 'import' && Array.isArray(body.nodes)) store.import(body.nodes);
            else if (op === 'recall' && body.id) {
              const node = store.get(String(body.id));
              if (node) store.reinforce(node, Date.now());
            } else if (op === 'settings') store.updateSettings(body.settings);
            else {
              send(res, 400, { ok: false, error: 'unknown op' });
              return;
            }
            const snapshot = store.snapshot();
            snapshot.ok = true;
            send(res, 200, snapshot);
          } catch (err) {
            send(res, 500, { ok: false, error: String((err && err.message) || err) });
          }
        },
      }),
    );
  });
}
