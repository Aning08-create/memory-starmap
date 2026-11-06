window.__ModuleLoader__.load({
  id: '@local/memory-starmap',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useMemo, useCallback } = React;

    /* ------------------------------------------------------------------ *
     * Constants
     * ------------------------------------------------------------------ */
    const DAY = 86400000;
    const TAU = Math.PI * 2;
    const STORAGE_KEY = 'dsh.memory-starmap.v1';
    const NS = 'memory-starmap';
    const PANEL_ID = 'memory-starmap';
    const UNTAGGED = '未分类';

    /* Gradient palette taken from the reference footage: aurora green, amber,
     * electric blue, violet, rose, cyan. Cluster colours are assigned by tag. */
    const PALETTE = ['#5fe3a6', '#f5c25c', '#7fa2ff', '#b98cff', '#ff7fa8', '#63d9f5', '#9ee36b'];

    /* ------------------------------------------------------------------ *
     * Small utilities
     * ------------------------------------------------------------------ */
    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

    function roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    function hash(str) {
      let x = 2166136261;
      const s = String(str);
      for (let i = 0; i < s.length; i++) {
        x ^= s.charCodeAt(i);
        x = Math.imul(x, 16777619);
      }
      return x >>> 0;
    }

    function mulberry32(seed) {
      let a = seed >>> 0;
      return function () {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    function uid() {
      return 'm-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    function hexToRgb(hex) {
      let v = String(hex).replace('#', '');
      if (v.length === 3) v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
      const n = parseInt(v, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function mixHex(a, b, t) {
      const A = hexToRgb(a);
      const B = hexToRgb(b);
      const c = A.map((v, i) => Math.round(v + (B[i] - v) * t));
      return '#' + ((1 << 24) + (c[0] << 16) + (c[1] << 8) + c[2]).toString(16).slice(1);
    }

    function rgba(hex, alpha) {
      const c = hexToRgb(hex);
      return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + alpha + ')';
    }

    function colorForTag(tag) {
      if (!tag || tag === UNTAGGED) return '#a9b8d6';
      return PALETTE[hash(tag) % PALETTE.length];
    }

    /** Give every cluster on the current map its own colour, keeping the
     * hash preference when it is free so tags stay stable between visits. */
    function buildColorMap(nodes) {
      const tags = Array.from(new Set((nodes || []).map(primaryTag))).sort();
      const used = new Set();
      const map = new Map();
      for (const tag of tags) {
        if (tag === UNTAGGED) {
          map.set(tag, '#a9b8d6');
          continue;
        }
        let idx = hash(tag) % PALETTE.length;
        let guard = 0;
        while (used.has(idx) && guard < PALETTE.length) {
          idx = (idx + 1) % PALETTE.length;
          guard++;
        }
        used.add(idx);
        map.set(tag, PALETTE[idx]);
      }
      return map;
    }

    function truncate(str, n) {
      const s = String(str || '');
      if (s.length <= n) return s;
      return s.slice(0, n - 1) + '…';
    }

    function parseTags(input) {
      return String(input || '')
        .split(/[,，、;；\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 5);
    }

    function primaryTag(node) {
      return (node.tags && node.tags[0]) || UNTAGGED;
    }

    /* ------------------------------------------------------------------ *
     * Forgetting model — Ebbinghaus retention over a stability term that
     * grows on every recall (spacing effect), exactly the "use it or lose it"
     * behaviour of a synapse.
     * ------------------------------------------------------------------ */
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

    function consolidateNode(node, at) {
      // A "night's sleep": a small replay bonus for anything recently touched,
      // a gentler one for memories that are almost gone.
      const r = retention(node, at);
      const factor = r > 0.3 ? 1.14 : r > 0.05 ? 1.08 : 1.04;
      return Object.assign({}, node, {
        stability: clamp((Number(node.stability) || baseStability(node.importance)) * factor, 0.4, 5000),
      });
    }

    function daysUntilFade(node, at) {
      const s = Math.max(0.05, Number(node.stability) || baseStability(node.importance));
      const elapsed = Math.max(0, at - (Number(node.lastReview) || at)) / DAY;
      return Math.max(0, -s * Math.log(0.08) - elapsed);
    }

    function statusOf(r) {
      if (r >= 0.6) return 'bright';
      if (r >= 0.3) return 'dim';
      if (r >= 0.08) return 'fading';
      return 'dormant';
    }

    /* ------------------------------------------------------------------ *
     * Layout & synapses
     * ------------------------------------------------------------------ */
    function ensureLayout(nodes) {
      const tags = Array.from(new Set(nodes.map(primaryTag))).sort();
      const n = Math.max(tags.length, 1);
      const centers = new Map();
      tags.forEach((tag, i) => {
        const y = n === 1 ? 0 : 1 - ((i + 0.5) / n) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = i * 2.399963229728653;
        const R = 205;
        centers.set(tag, {
          x: Math.cos(theta) * r * R,
          y: y * R * 0.82,
          z: Math.sin(theta) * r * R,
        });
      });
      for (const node of nodes) {
        if (typeof node.x === 'number' && typeof node.y === 'number' && typeof node.z === 'number') {
          if (!node.phase) node.phase = (hash(node.id) % 1000) / 1000 * TAU;
          continue;
        }
        const c = centers.get(primaryTag(node)) || { x: 0, y: 0, z: 0 };
        const rnd = mulberry32(hash(node.id));
        const rad = 14 + rnd() * 70;
        const a = rnd() * TAU;
        const el = (rnd() - 0.5) * 1.3;
        node.x = c.x + Math.cos(a) * Math.cos(el) * rad;
        node.y = c.y + Math.sin(el) * rad * 0.85;
        node.z = c.z + Math.sin(a) * Math.cos(el) * rad;
        node.phase = rnd() * TAU;
      }
      return nodes;
    }

    function buildEdges(nodes, colorOf) {
      const colorFor = typeof colorOf === 'function' ? colorOf : colorForTag;
      const list = [];
      const seen = new Set();
      const byTag = new Map();
      for (const node of nodes) {
        const tag = primaryTag(node);
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(node);
      }
      const add = (a, b, weight) => {
        if (!a || !b || a.id === b.id) return;
        const key = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id;
        if (seen.has(key)) return;
        seen.add(key);
        list.push({
          a: a.id,
          b: b.id,
          weight: clamp(weight, 0.08, 1),
          color: mixHex(colorFor(primaryTag(a)), colorFor(primaryTag(b)), 0.5),
        });
      };
      // Each cluster is a small neural assembly: a hub wired to its stars.
      for (const arr of byTag.values()) {
        if (arr.length < 2) continue;
        const hub = arr[0];
        for (let i = 1; i < arr.length; i++) add(hub, arr[i], 0.3);
        for (let i = 0; i < arr.length; i++) {
          for (let j = i + 1; j < arr.length; j++) {
            if ((i * 7 + j * 13 + arr.length) % 4 === 0) add(arr[i], arr[j], 0.5);
          }
        }
      }
      // Shared tags form long associative fibres between clusters.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          if (primaryTag(a) === primaryTag(b)) continue;
          const setA = new Set(a.tags || []);
          let shared = 0;
          for (const t of b.tags || []) if (setA.has(t)) shared++;
          if (shared > 0) add(a, b, 0.36 + 0.2 * Math.min(shared, 3));
        }
      }
      // A few faint hub bridges keep the whole map one constellation.
      const hubs = Array.from(byTag.values()).map((arr) => arr[0]).filter(Boolean);
      for (let i = 0; i < hubs.length; i++) {
        for (let j = i + 1; j < hubs.length; j++) {
          if ((i * 11 + j * 7) % 3 === 0) add(hubs[i], hubs[j], 0.12);
        }
      }
      return list;
    }

    /* ------------------------------------------------------------------ *
     * Seed memories — fail in the direction of "some stars already dim".
     * ------------------------------------------------------------------ */
    function seedMemories(now) {
      const defs = [
        { title: '外婆的桂花糕', content: '蒸笼掀开的一瞬间，整条巷子都是甜的。外婆总把最完整的那块留给我。', tags: ['家人', '味道', '秋天'], imp: 4, age: 12, rev: 2 },
        { title: '夏夜捉萤火虫', content: '玻璃瓶里明明灭灭，像把一小段银河揣进了口袋。', tags: ['童年', '夏天', '夜晚'], imp: 2, age: 100, rev: 0 },
        { title: '第一次独自旅行', content: '在陌生的站台看错了班次，却因此遇见了整片山谷的晚霞。', tags: ['旅行', '勇敢', '秋天'], imp: 3, age: 25, rev: 2 },
        { title: '高考前夜的月光', content: '复习到凌晨，抬头看见窗外的月亮特别亮，忽然就不慌了。', tags: ['成长', '夜晚', '夏天'], imp: 4, age: 120, rev: 0 },
        { title: '通宵打完的那局游戏', content: '五个人在语音里喊到嗓子哑，赢下最后一把时天已经亮了。', tags: ['朋友', '夜晚', '青春'], imp: 4, age: 3, rev: 3 },
        { title: '海边看日落', content: '浪一层层退下去，太阳把整片海烧成橘色，谁都没有说话。', tags: ['旅行', '夏天', '浪漫'], imp: 3, age: 20, rev: 2 },
        { title: '妈妈的一句唠叨', content: '“外套穿上。”那天很冷，我至今还记得她站在门口的样子。', tags: ['家人', '声音', '冬天'], imp: 3, age: 6, rev: 2 },
        { title: '学会骑车的那天', content: '爸爸松手的瞬间我还在往前冲，回头才发现他早就站在原地笑了。', tags: ['成长', '童年', '夏天'], imp: 3, age: 8, rev: 0 },
        { title: '楼下咖啡店的雨声', content: '雨点敲在遮雨棚上，我改完了那份一直拖着的稿子。', tags: ['日常', '声音', '冬天'], imp: 3, age: 1, rev: 1 },
        { title: '毕业照上的笑脸', content: '快门按下时有人在后面比了个鬼脸，于是所有人都笑得不像样。', tags: ['朋友', '青春', '成长'], imp: 4, age: 25, rev: 2 },
        { title: '深夜电台里的那首歌', content: '主播念了一段听众来信，前奏一响，整间屋子忽然安静下来。', tags: ['音乐', '夜晚', '青春'], imp: 3, age: 5, rev: 1 },
        { title: '第一次拿到工资', content: '给爸妈各买了一件外套，剩下的钱请自己吃了一顿很贵的面。', tags: ['成长', '城市', '秋天'], imp: 4, age: 45, rev: 1 },
        { title: '楼下那只来蹭饭的猫', content: '它现在每天傍晚准时蹲在门口，像一份毛茸茸的日程表。', tags: ['日常', '温柔', '冬天'], imp: 4, age: 2, rev: 2 },
        { title: '暴雨里跑回家的晚上', content: '两个人淋成落汤鸡，却一路笑到楼下，谁也没提打车。', tags: ['朋友', '城市', '夏天'], imp: 2, age: 70, rev: 0 },
      ];
      return defs.map((d, i) => {
        const importance = d.imp;
        const stability = baseStability(importance) * Math.pow(1.55 + 0.12 * importance, d.rev);
        return {
          id: 'seed-' + i,
          title: d.title,
          content: d.content,
          tags: d.tags,
          importance,
          createdAt: now - (d.age + 30 + i * 7) * DAY,
          lastReview: now - d.age * DAY,
          reviews: d.rev,
          stability,
          phase: (hash('seed-' + i) % 1000) / 1000 * TAU,
        };
      });
    }

    /* ------------------------------------------------------------------ *
     * Persistence (browser-local; export/import covers other profiles)
     * ------------------------------------------------------------------ */
    function normalizeNode(raw) {
      const node = {
        id: raw && raw.id ? String(raw.id) : uid(),
        title: String((raw && raw.title) || '未命名的记忆'),
        content: String((raw && raw.content) || ''),
        tags: Array.isArray(raw && raw.tags) && raw.tags.length ? raw.tags.map(String).slice(0, 5) : [UNTAGGED],
        importance: clamp(Number(raw && raw.importance) || 3, 1, 5),
        createdAt: Number(raw && raw.createdAt) || Date.now(),
        lastReview: Number(raw && raw.lastReview) || Number(raw && raw.createdAt) || Date.now(),
        reviews: Math.max(0, Number(raw && raw.reviews) || 0),
        stability: Number(raw && raw.stability) || baseStability(Number(raw && raw.importance) || 3),
      };
      if (raw && typeof raw.x === 'number') node.x = raw.x;
      if (raw && typeof raw.y === 'number') node.y = raw.y;
      if (raw && typeof raw.z === 'number') node.z = raw.z;
      if (raw && typeof raw.phase === 'number') node.phase = raw.phase;
      if (raw && raw.source === 'auto') node.source = 'auto';
      return node;
    }

    function loadStore() {
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) {
          const nodes = seedMemories(Date.now());
          ensureLayout(nodes);
          return { nodes };
        }
        const parsed = JSON.parse(raw);
        const nodes = Array.isArray(parsed && parsed.nodes) ? parsed.nodes.map(normalizeNode) : [];
        ensureLayout(nodes);
        return { nodes };
      } catch (err) {
        return { nodes: [] };
      }
    }

    /* ------------------------------------------------------------------ *
     * Locale dictionaries
     * ------------------------------------------------------------------ */
    const DICT = {
      zh: {
        'nav.label': '记忆星图',
        'title': '记忆星图',
        'subtitle': '像神经元一样：被想起的会亮起来，被冷落的会慢慢暗下去。',
        'action.add': '记录记忆',
        'action.recall': '回忆一下',
        'action.edit': '编辑',
        'action.delete': '删除',
        'action.export': '导出',
        'action.import': '导入',
        'action.clear': '清空',
        'action.close': '关闭',
        'action.consolidate': '睡眠整理',
        'metric.memories': '记忆',
        'metric.bright': '清晰',
        'metric.fading': '将忘',
        'metric.dormant': '沉眠',
        'metric.toggleHint': '显示或隐藏几乎沉眠的记忆',
        'auto.label': '自动记忆',
        'auto.on': '开',
        'auto.off': '关',
        'auto.hint': '对话里值得记住的内容会自动进入星图，每次被提起又会变清晰一点',
        'warp.label': '推演',
        'warp.now': '此刻',
        'warp.day': '{n} 天',
        'hint': '拖动旋转 · 滚轮缩放 · 点击星点查看',
        'legend.title': '星团',
        'legend.other': '其他',
        'detail.retention': '清晰度',
        'detail.created': '记录于',
        'detail.lastRecall': '上次回忆',
        'detail.reviews': '回忆次数',
        'detail.importance': '重要度',
        'detail.links': '联结',
        'detail.source': '来源',
        'detail.auto': '对话自动记录',
        'detail.eta': '约 {n} 天后淡出视野',
        'detail.etaNow': '已濒临淡出',
        'detail.never': '从未回忆',
        'detail.future': '未来 90 天',
        'detail.fadeLine': '虚线 = 8% 淡出线',
        'detail.hint': '点击星图里的一颗星，查看它的故事。',
        'status.bright': '清晰',
        'status.dim': '微光',
        'status.fading': '将要淡忘',
        'status.dormant': '几乎沉眠',
        'empty.title': '星图还是一片虚空',
        'empty.body': '写下一段想记住的事，它会成为星图上的一颗星。被回忆的星会变亮、突触会变粗，长久不理会的会像闲置的神经元一样慢慢暗淡。',
        'empty.first': '记录第一段记忆',
        'empty.sample': '载入示例星群',
        'allDormant.title': '这个时刻，星星都沉眠了',
        'allDormant.body': '所有记忆都淡出了视野，但它们仍在星图深处等着被重新想起。',
        'allDormant.back': '回到此刻',
        'dialog.addTitle': '记下一段记忆',
        'dialog.editTitle': '编辑这段记忆',
        'dialog.title': '标题',
        'dialog.titlePh': '例如：外婆的桂花糕',
        'dialog.content': '细节',
        'dialog.contentPh': '写下让你想留住它的画面、声音或味道……',
        'dialog.tags': '星团标签',
        'dialog.tagsHint': '用逗号分隔；第一个标签决定它落在哪个星团',
        'dialog.importance': '重要度',
        'dialog.importanceHint': '越重要，淡忘得越慢',
        'dialog.cancel': '取消',
        'dialog.save': '记录',
        'dialog.update': '保存',
        'toast.added': '一颗新的星点亮了',
        'toast.recalled': '记忆被重新点亮，突触更牢固了',
        'toast.updated': '记忆已更新',
        'toast.deleted': '这段记忆消散了',
        'toast.consolidated': '巩固完成：加固 {n} 段记忆，剪除 {m} 条微弱联结',
        'toast.imported': '已导入 {n} 段记忆',
        'toast.importFailed': '导入失败，请检查文件格式',
        'toast.exported': '星图已导出',
        'toast.cleared': '星图已清空',
        'toast.saveFailed': '浏览器存储不可用，本次改动可能不会被保留',
        'toast.autoCaptured': '自动记下了「{title}」',
        'toast.newStar': '星图里多了一颗星「{title}」',
        'toast.autoRecalled': '想起了「{title}」，它又清晰了一点',
        'confirm.deleteTitle': '让这段记忆消散？',
        'confirm.deleteBody': '它会从星图上消失，且无法恢复。',
        'confirm.clearTitle': '清空整片星图？',
        'confirm.clearBody': '所有记忆都会被删除，且无法恢复。',
        'confirm.delete': '删除',
        'confirm.clear': '清空',
        'confirm.cancel': '取消',
        'confirm.consolidate': '整理',
        'consolidate.title': '像睡觉一样整理一次记忆？',
        'consolidate.body': '近期被回忆过的记忆会得到一点加固，几乎消失的记忆也会被轻轻托起；已经很微弱的联结会被剪除。不会删除任何记忆。',
      },
      en: {
        'nav.label': 'Memory Star Map',
        'title': 'Memory Star Map',
        'subtitle': 'Like neurons: what you recall lights up, what you neglect slowly goes dark.',
        'action.add': 'New memory',
        'action.recall': 'Recall',
        'action.edit': 'Edit',
        'action.delete': 'Delete',
        'action.export': 'Export',
        'action.import': 'Import',
        'action.clear': 'Clear',
        'action.close': 'Close',
        'action.consolidate': 'Consolidate',
        'metric.memories': 'memories',
        'metric.bright': 'vivid',
        'metric.fading': 'fading',
        'metric.dormant': 'dormant',
        'metric.toggleHint': 'Show or hide nearly forgotten memories',
        'auto.label': 'Auto memory',
        'auto.on': 'on',
        'auto.off': 'off',
        'auto.hint': 'Worthwhile things from chats enter the map automatically and sharpen each time they are recalled',
        'warp.label': 'Preview',
        'warp.now': 'now',
        'warp.day': '+{n}d',
        'hint': 'Drag to rotate · scroll to zoom · click a star',
        'legend.title': 'Clusters',
        'legend.other': 'Other',
        'detail.retention': 'Vividness',
        'detail.created': 'Created',
        'detail.lastRecall': 'Last recalled',
        'detail.reviews': 'Recalls',
        'detail.importance': 'Importance',
        'detail.links': 'links',
        'detail.source': 'Source',
        'detail.auto': 'captured from chat',
        'detail.eta': 'fades in about {n} days',
        'detail.etaNow': 'nearly gone',
        'detail.never': 'never',
        'detail.future': 'next 90 days',
        'detail.fadeLine': 'dashed = 8% fade line',
        'detail.hint': 'Click a star in the map to read its story.',
        'status.bright': 'vivid',
        'status.dim': 'glowing',
        'status.fading': 'fading',
        'status.dormant': 'dormant',
        'empty.title': 'The sky is still empty',
        'empty.body': 'Write down something you want to keep, and it becomes a star. Recalled stars brighten and their synapses thicken; neglected ones dim like unused neurons.',
        'empty.first': 'Record the first memory',
        'empty.sample': 'Load a sample constellation',
        'allDormant.title': 'At this moment every star is dormant',
        'allDormant.body': 'Every memory has faded from view, yet all still wait in the depths of the map.',
        'allDormant.back': 'Back to now',
        'dialog.addTitle': 'Record a memory',
        'dialog.editTitle': 'Edit this memory',
        'dialog.title': 'Title',
        'dialog.titlePh': 'e.g. Grandma’s osmanthus cake',
        'dialog.content': 'Details',
        'dialog.contentPh': 'The image, sound, or taste you want to keep…',
        'dialog.tags': 'Cluster tags',
        'dialog.tagsHint': 'Comma separated; the first tag decides its cluster',
        'dialog.importance': 'Importance',
        'dialog.importanceHint': 'More important memories fade more slowly',
        'dialog.cancel': 'Cancel',
        'dialog.save': 'Record',
        'dialog.update': 'Save',
        'toast.added': 'A new star just lit up',
        'toast.recalled': 'Rekindled — the synapse grew stronger',
        'toast.updated': 'Memory updated',
        'toast.deleted': 'The memory dissolved',
        'toast.consolidated': 'Consolidated: {n} memories reinforced, {m} faint links pruned',
        'toast.imported': 'Imported {n} memories',
        'toast.importFailed': 'Import failed — check the file format',
        'toast.exported': 'Star map exported',
        'toast.cleared': 'Star map cleared',
        'toast.saveFailed': 'Browser storage unavailable; changes may not persist',
        'toast.autoCaptured': 'Automatically remembered “{title}”',
        'toast.newStar': 'A new star joined the map: “{title}”',
        'toast.autoRecalled': 'Recalled “{title}” — it grew a little clearer',
        'confirm.deleteTitle': 'Let this memory dissolve?',
        'confirm.deleteBody': 'It disappears from the map and cannot be restored.',
        'confirm.clearTitle': 'Clear the whole sky?',
        'confirm.clearBody': 'Every memory will be deleted. This cannot be undone.',
        'confirm.delete': 'Delete',
        'confirm.clear': 'Clear',
        'confirm.cancel': 'Cancel',
        'confirm.consolidate': 'Consolidate',
        'consolidate.title': 'Consolidate memories like a night of sleep?',
        'consolidate.body': 'Recently recalled memories get a small reinforcement and nearly forgotten ones are lifted a little; very faint links are pruned. No memory is deleted.',
      },
    };

    /* ------------------------------------------------------------------ *
     * Styles (rendered as a component-local <style>, removed on unmount)
     * ------------------------------------------------------------------ */
    const CSS = `
.ms-page{position:relative;height:100%;min-height:0;display:flex;flex-direction:column;gap:14px;padding:calc(18px + var(--dsh-frame-top-clearance,0px)) 22px 20px;box-sizing:border-box;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;overflow:hidden}
.ms-head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;flex:none}
.ms-brand{display:flex;align-items:center;gap:12px;min-width:0}
.ms-mark{width:36px;height:36px;flex:none;border-radius:11px;display:grid;place-items:center;color:#cfe0ff;background:linear-gradient(150deg,#18213a,#070a14);border:1px solid var(--dsw-alias-border-l1);box-shadow:inset 0 0 16px rgba(100,140,255,.22),0 4px 16px -8px rgba(0,0,0,.6)}
.ms-title{margin:0;font-size:17px;font-weight:600;line-height:1.2;letter-spacing:.2px}
.ms-sub{margin:4px 0 0;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-secondary);max-width:520px}
.ms-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.ms-metrics{display:flex;align-items:center;gap:15px;margin-right:2px}
.ms-metric{display:flex;flex-direction:column;align-items:flex-start;gap:3px;padding:0;border:0;background:none;color:inherit;font:inherit;line-height:1}
.ms-metric b{font-size:15px;font-weight:600;font-variant-numeric:tabular-nums}
.ms-metric span{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
button.ms-metric{cursor:pointer;border-radius:6px;padding:2px 4px;margin:-2px -4px;transition:background .15s}
button.ms-metric:hover{background:var(--dsw-alias-bg-layer-2)}
.ms-auto{display:inline-flex;align-items:center;gap:6px;height:31px;padding:0 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;cursor:pointer;transition:border-color .15s,background .15s,color .15s;white-space:nowrap}
.ms-auto:hover{background:var(--dsw-alias-bg-layer-2)}
.ms-auto i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.ms-auto.on{color:var(--dsw-alias-label-primary);border-color:rgba(47,169,113,.45)}
.ms-auto.on i{background:#2fa971;box-shadow:0 0 7px #2fa971}
.ms-auto em{font-style:normal;font-size:10.5px;opacity:.65}
@media (max-width:760px){.ms-auto span{display:none}}
.ms-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:31px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12.5px;font-weight:500;font-family:inherit;cursor:pointer;transition:background .15s,border-color .15s,opacity .15s;white-space:nowrap}
.ms-btn:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}
.ms-btn:disabled{opacity:.5;cursor:default}
.ms-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.ms-btn-primary:hover{background:var(--dsw-alias-brand-primary);filter:brightness(1.08);border-color:transparent}
.ms-btn-ghost{background:transparent;border-color:transparent;color:var(--dsw-alias-label-secondary);padding:0 8px}
.ms-btn-ghost:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-color:transparent}
.ms-btn-danger{color:var(--dsw-alias-state-error-primary)}
.ms-icon{width:31px;padding:0}
.ms-stage{position:relative;flex:1;min-height:340px;border-radius:16px;overflow:hidden;background:radial-gradient(120% 95% at 30% 6%,#111c36 0%,#080d1a 46%,#04050b 100%),radial-gradient(58% 52% at 76% 88%,rgba(82,112,196,.16),rgba(4,5,11,0) 72%);border:1px solid rgba(126,156,226,.16);box-shadow:0 24px 64px -30px rgba(0,0,0,.85),inset 0 1px 0 rgba(170,200,255,.09),inset 0 0 110px rgba(0,0,0,.6)}
.ms-canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:grab;animation:ms-canvas-in 1.2s ease-out}
@keyframes ms-canvas-in{from{opacity:0}to{opacity:1}}
.ms-canvas:active{cursor:grabbing}
.ms-hud{position:absolute;z-index:3;display:flex;gap:8px;align-items:flex-start;pointer-events:none}
.ms-hud>*{pointer-events:auto}
.ms-hud-tl{left:14px;top:14px;bottom:58px;max-width:calc(100% - 28px)}
.ms-hud-tr{right:14px;top:14px}
.ms-clusters{width:206px;max-height:100%;display:flex;flex-direction:column;border-radius:12px;border:1px solid rgba(150,175,235,.16);background:rgba(8,12,24,.55);backdrop-filter:blur(14px);overflow:hidden;box-shadow:0 18px 44px -26px rgba(0,0,0,.9);animation:ms-rise .35s ease-out}
.ms-clusters-head{display:flex;align-items:center;justify-content:space-between;padding:9px 11px 7px;font-size:10px;letter-spacing:1.8px;color:rgba(160,180,212,.8);text-transform:uppercase}
.ms-clusters-head em{font-style:normal;font-size:10px;letter-spacing:0;color:rgba(160,180,212,.5)}
.ms-clusters-body{min-height:0;overflow:auto;padding:0 6px 6px;display:flex;flex-direction:column;gap:1px;scrollbar-width:thin}
.ms-cluster{display:grid;grid-template-columns:8px 1fr auto 40px;align-items:center;gap:7px;height:28px;padding:0 6px;border:0;border-radius:7px;background:transparent;font:inherit;font-size:11.5px;color:#c6d6f2;cursor:pointer;text-align:left;transition:background .15s}
.ms-cluster:hover{background:rgba(120,150,220,.1)}
.ms-cluster.on{background:rgba(120,160,255,.17)}
.ms-cluster .dot{width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 7px currentColor}
.ms-cluster .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c9d8f4}
.ms-cluster .num{font-size:10px;color:rgba(160,180,212,.75);font-variant-numeric:tabular-nums}
.ms-cluster .meter{display:block;height:3px;border-radius:2px;background:rgba(120,140,180,.22);overflow:hidden}
.ms-cluster .meter b{display:block;height:100%;border-radius:2px;background:currentColor;opacity:.85}
.ms-warp{display:flex;align-items:center;gap:1px;padding:3px;border-radius:999px;background:rgba(9,13,26,.6);border:1px solid rgba(150,175,235,.18);backdrop-filter:blur(10px)}
.ms-warp>span{padding:0 7px 0 8px;font-size:10.5px;color:#8ea3c6;white-space:nowrap}
.ms-warp button{height:22px;padding:0 9px;border-radius:999px;border:0;background:transparent;color:#a8bcda;font-size:11px;font-family:inherit;cursor:pointer;white-space:nowrap}
.ms-warp button:hover{color:#e2ecff}
.ms-warp button.on{background:rgba(122,162,255,.24);color:#eaf2ff}
.ms-hint{position:absolute;left:50%;bottom:13px;transform:translateX(-50%);z-index:2;font-size:11px;color:rgba(186,204,238,.48);letter-spacing:.3px;white-space:nowrap;pointer-events:none}
.ms-detail{position:absolute;right:13px;top:54px;bottom:13px;width:302px;z-index:5;display:flex;flex-direction:column;gap:13px;padding:16px;box-sizing:border-box;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 26px 60px -32px rgba(0,0,0,.9);overflow:auto;animation:ms-rise .2s ease-out}
@keyframes ms-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.ms-detail-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.ms-detail-tag{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:999px;font-size:10.5px;border:1px solid currentColor;opacity:.9}
.ms-detail-tag i{width:5px;height:5px;border-radius:50%;background:currentColor;box-shadow:0 0 6px currentColor}
.ms-detail-title{margin:0;font-size:16.5px;font-weight:600;line-height:1.4;letter-spacing:.2px;word-break:break-word}
.ms-detail-body{margin:0;font-size:12.5px;line-height:1.75;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word}
.ms-meter-head{display:flex;align-items:baseline;justify-content:space-between;font-size:11px;color:var(--dsw-alias-label-secondary)}
.ms-meter-head b{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.ms-meter{height:6px;border-radius:999px;background:rgba(120,140,180,.22);overflow:hidden}
.ms-meter i{display:block;height:100%;border-radius:999px;transition:width .35s ease}
.ms-eta{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:-4px}
.ms-spark{margin-top:-2px}
.ms-spark-foot{display:flex;justify-content:space-between;gap:8px;font-size:9.5px;color:var(--dsw-alias-label-secondary);opacity:.72;margin-top:2px}
.ms-tags{display:flex;flex-wrap:wrap;gap:5px}
.ms-tags span{display:inline-flex;align-items:center;height:19px;padding:0 7px;border-radius:999px;border:1px solid currentColor;font-size:10px;opacity:.82}
.ms-rows{display:flex;flex-direction:column;gap:7px;padding-top:2px;border-top:1px solid var(--dsw-alias-border-l1)}
.ms-row{display:flex;align-items:center;justify-content:space-between;gap:10px;font-size:11.5px}
.ms-row span{color:var(--dsw-alias-label-secondary)}
.ms-row b{font-weight:500;font-variant-numeric:tabular-nums}
.ms-dots{display:flex;gap:4px}.ms-dots i{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-border-l2)}
.ms-dots i.on{background:var(--dsw-alias-brand-primary)}
.ms-detail-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:auto;padding-top:4px}
.ms-empty{position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:11px;padding:28px;text-align:center;background:radial-gradient(62% 62% at 50% 42%,rgba(22,34,66,.55),rgba(4,5,11,.88))}
.ms-empty h2{margin:0;font-size:18px;font-weight:600;color:#eaf2ff}
.ms-empty p{margin:0;max-width:430px;font-size:12.5px;line-height:1.75;color:#9fb1d0}
.ms-empty-orb{width:72px;height:72px;border-radius:50%;background:radial-gradient(circle at 40% 35%,#8fb4ff 0%,#3d63c8 26%,rgba(30,44,90,.5) 52%,transparent 70%);filter:blur(.4px);box-shadow:0 0 70px rgba(90,130,255,.35);animation:ms-float 7s ease-in-out infinite}
@keyframes ms-float{0%,100%{transform:translateY(0);opacity:.85}50%{transform:translateY(-7px);opacity:1}}
.ms-empty.ms-soft{background:radial-gradient(58% 58% at 50% 46%,rgba(16,24,48,.66),rgba(4,5,11,.5))}
.ms-empty.ms-soft h2{font-size:15px}
.ms-empty.ms-soft p{font-size:12px;max-width:360px}
.ms-empty-actions{display:flex;gap:8px;margin-top:6px;flex-wrap:wrap;justify-content:center}
.ms-backdrop{position:absolute;inset:0;z-index:20;display:grid;place-items:center;padding:20px;background:rgba(3,6,14,.58);backdrop-filter:blur(7px);animation:ms-fade .16s ease-out}
@keyframes ms-fade{from{opacity:0}to{opacity:1}}
.ms-dialog{width:min(452px,100%);max-height:100%;overflow:auto;box-sizing:border-box;border-radius:16px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay);box-shadow:0 30px 80px -30px rgba(0,0,0,.9);padding:20px;display:flex;flex-direction:column;gap:14px;animation:ms-pop .18s ease-out}
@keyframes ms-pop{from{opacity:0;transform:translateY(8px) scale(.99)}to{opacity:1;transform:none}}
.ms-dialog h3{margin:0;font-size:15.5px;font-weight:600}
.ms-field{display:flex;flex-direction:column;gap:6px}
.ms-field label{font-size:11.5px;color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:space-between;gap:8px}
.ms-field input,.ms-field textarea{box-sizing:border-box;width:100%;border-radius:9px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;padding:9px 10px;outline:none;transition:border-color .15s,box-shadow .15s}
.ms-field input:focus,.ms-field textarea:focus{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px rgba(90,130,255,.14)}
.ms-field textarea{min-height:84px;resize:vertical;line-height:1.65}
.ms-hintline{font-size:10.5px;color:var(--dsw-alias-label-secondary);opacity:.85}
.ms-tagpreview{display:flex;flex-wrap:wrap;gap:5px;min-height:18px}
.ms-tagpreview span{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:999px;font-size:10.5px;border:1px solid currentColor}
.ms-tagpreview i{width:5px;height:5px;border-radius:50%;background:currentColor}
.ms-importance{display:flex;gap:6px}
.ms-importance button{width:26px;height:26px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:11px;font-family:inherit;cursor:pointer}
.ms-importance button.on{background:var(--dsw-alias-brand-primary);border-color:transparent;color:#fff}
.ms-dialog-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}
.ms-toast{position:absolute;left:50%;bottom:42px;transform:translateX(-50%);z-index:30;padding:8px 15px;border-radius:999px;background:rgba(11,17,32,.88);border:1px solid rgba(140,170,255,.24);color:#dce8ff;font-size:12px;line-height:1.4;backdrop-filter:blur(10px);box-shadow:0 14px 34px -18px rgba(0,0,0,.9);animation:ms-toast-in .22s ease-out;max-width:88%;text-align:center}
@keyframes ms-toast-in{from{opacity:0;transform:translate(-50%,8px)}to{opacity:1;transform:translate(-50%,0)}}
.ms-narrow .ms-hud-tl{max-width:calc(100% - 28px)}
.ms-narrow .ms-clusters{width:172px}
.ms-narrow .ms-hud-tr{top:auto;bottom:12px;right:12px}
.ms-narrow .ms-hint{display:none}
.ms-narrow .ms-detail{left:13px;right:13px;top:auto;bottom:13px;width:auto;max-height:58%}
@media (max-width:640px){.ms-sub{display:none}.ms-metrics{gap:10px}}
`;

    /* ------------------------------------------------------------------ *
     * Canvas star field
     * ------------------------------------------------------------------ */
    function makeSprite(color, faded) {
      const size = 64;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext('2d');
      const rgb = hexToRgb(faded ? mixHex(color, '#94a7c6', 0.58) : color);
      const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(0.1, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.92)');
      grad.addColorStop(0.26, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.36)');
      grad.addColorStop(0.55, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0.08)');
      grad.addColorStop(1, 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',0)');
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
      return canvas;
    }

    /** An organic nebula puff: many overlapping soft blobs instead of one
     * perfect radial gradient, so every cluster has its own texture. */
    function makeNebulaCloud(color) {
      const size = 288;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext('2d');
      const rnd = mulberry32(hash(color) ^ 0x9e3779b9);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 32; i++) {
        const a = rnd() * TAU;
        const d = Math.pow(rnd(), 0.62) * size * 0.3;
        const x = size / 2 + Math.cos(a) * d;
        const y = size / 2 + Math.sin(a) * d * 0.78;
        const r = size * (0.06 + rnd() * 0.17);
        const alpha = 0.03 + rnd() * 0.055;
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, rgba(color, alpha));
        grad.addColorStop(0.55, rgba(color, alpha * 0.42));
        grad.addColorStop(1, rgba(color, 0));
        g.fillStyle = grad;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      }
      return canvas;
    }

    /** Soft four-point diffraction star for bright memories. */
    function makeSpike(color) {
      const size = 128;
      const half = size / 2;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext('2d');
      g.translate(half, half);
      const horizontal = g.createLinearGradient(-half, 0, half, 0);
      horizontal.addColorStop(0, rgba(color, 0));
      horizontal.addColorStop(0.5, rgba(color, 0.6));
      horizontal.addColorStop(1, rgba(color, 0));
      g.fillStyle = horizontal;
      g.fillRect(-half, -0.8, size, 1.6);
      const vertical = g.createLinearGradient(0, -half, 0, half);
      vertical.addColorStop(0, rgba(color, 0));
      vertical.addColorStop(0.5, rgba(color, 0.6));
      vertical.addColorStop(1, rgba(color, 0));
      g.fillStyle = vertical;
      g.fillRect(-0.8, -half, 1.6, size);
      g.rotate(Math.PI / 4);
      g.globalAlpha = 0.38;
      g.fillStyle = horizontal;
      g.fillRect(-half * 0.55, -0.6, size * 0.55, 1.2);
      g.fillStyle = vertical;
      g.fillRect(-0.6, -half * 0.55, 1.2, size * 0.55);
      return canvas;
    }

    /** Deterministic cloud of companion motes orbiting one memory. */
    function makeSwarm(node) {
      const rnd = mulberry32(hash(node.id + ':swarm'));
      const count = 9 + Math.round((Number(node.importance) || 3) * 2.6);
      const out = [];
      for (let i = 0; i < count; i++) {
        out.push({
          rad: 4 + rnd() * 13,
          tilt: rnd() * TAU,
          speed: (0.1 + rnd() * 0.26) * (rnd() < 0.5 ? -1 : 1),
          size: 0.45 + rnd() * 1.05,
          alpha: 0.22 + rnd() * 0.55,
          phase: rnd() * TAU,
        });
      }
      return out;
    }

    const DUST = (() => {
      const out = [];
      const rnd = mulberry32(7331);
      for (let i = 0; i < 520; i++) {
        const theta = rnd() * TAU;
        const phi = Math.acos(2 * rnd() - 1);
        const radius = 420 + rnd() * 420;
        const tone = rnd();
        out.push({
          x: Math.sin(phi) * Math.cos(theta) * radius,
          y: Math.cos(phi) * radius,
          z: Math.sin(phi) * Math.sin(theta) * radius,
          size: 0.35 + rnd() * 1.15,
          tone: tone < 0.68 ? '#cfe0ff' : tone < 0.86 ? '#ffe2b8' : '#a9c6ff',
          big: rnd() < 0.05,
          phase: rnd() * TAU,
          speed: 0.35 + rnd() * 1.3,
        });
      }
      return out;
    })();

    function StarField(props) {
      const canvasRef = useRef(null);
      const propsRef = useRef(props);
      propsRef.current = props;
      const camRef = useRef({ yaw: 0.55, pitch: -0.1, zoom: 1, zoomTarget: 1, idleUntil: 0, focus: null, shift: 0, fit: 0.8 });
      const hitsRef = useRef([]);
      const hoverRef = useRef(null);
      const burstRef = useRef([]);
      const dragRef = useRef(null);
      const swarmRef = useRef(new Map());

      useEffect(() => {
        const map = new Map();
        for (const node of props.nodes || []) map.set(node.id, makeSwarm(node));
        swarmRef.current = map;
      }, [props.nodes]);

      useEffect(() => {
        if (!props.pulse) return;
        const node = (props.nodes || []).find((n) => n.id === props.pulse.id);
        if (node) burstRef.current.push({ node, t0: performance.now() });
      }, [props.pulse]);

      useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const cam = camRef.current;
        const size = { w: 0, h: 0, dpr: 1 };
        const sprites = new Map();
        const nebulae = new Map();
        let raf = 0;
        let last = performance.now();
        let disposed = false;

        function spriteFor(color, faded) {
          const key = color + (faded ? ':faded' : '');
          let s = sprites.get(key);
          if (!s) {
            s = makeSprite(color, faded);
            sprites.set(key, s);
          }
          return s;
        }

        function nebulaFor(color) {
          let s = nebulae.get(color);
          if (!s) {
            s = makeNebulaCloud(color);
            nebulae.set(color, s);
          }
          return s;
        }

        function spikeFor(color) {
          let s = sprites.get(color + ':spike');
          if (!s) {
            s = makeSpike(color);
            sprites.set(color + ':spike', s);
          }
          return s;
        }

        function resize() {
          const rect = canvas.getBoundingClientRect();
          const w = Math.max(1, rect.width);
          const hh = Math.max(1, rect.height);
          const dpr = Math.min(2, window.devicePixelRatio || 1);
          size.w = w;
          size.h = hh;
          size.dpr = dpr;
          canvas.width = Math.round(w * dpr);
          canvas.height = Math.round(hh * dpr);
        }

        function project(x, y, z, c) {
          const cyaw = Math.cos(c.yaw);
          const syaw = Math.sin(c.yaw);
          const cpit = Math.cos(c.pitch);
          const spit = Math.sin(c.pitch);
          const x1 = x * cyaw - z * syaw;
          const z1 = x * syaw + z * cyaw;
          const y1 = y * cpit - z1 * spit;
          const z2 = y * spit + z1 * cpit;
          const persp = 1300 / (1300 + z2);
          const s = c.scale * persp;
          return {
            x: c.cx + x1 * s,
            y: c.cy + y1 * s,
            z: z2,
            s: s,
            persp: persp,
            sx: x1,
            sy: y1,
          };
        }

        function pick(px, py) {
          const hits = hitsRef.current;
          for (let i = 0; i < hits.length; i++) {
            const hit = hits[i];
            const dx = px - hit.x;
            const dy = py - hit.y;
            const r = Math.max(15, hit.r + 8);
            if (dx * dx + dy * dy <= r * r) return hit;
          }
          return null;
        }

        function frame(now) {
          if (disposed) return;
          const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
          last = now;
          const p = propsRef.current;
          const w = size.w;
          const hh = size.h;
          if (w < 2 || hh < 2) {
            raf = requestAnimationFrame(frame);
            return;
          }

          // camera ------------------------------------------------------
          if (cam.focus) {
            const k = clamp((now - cam.focus.t0) / cam.focus.dur, 0, 1);
            const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
            cam.yaw = cam.focus.fromYaw + cam.focus.dYaw * e;
            cam.pitch = cam.focus.fromPitch + cam.focus.dPitch * e;
            if (k >= 1) {
              cam.focus = null;
              cam.idleUntil = now + 4200;
            }
          } else if (now > cam.idleUntil) {
            cam.yaw += dt * 0.055;
          }
          cam.pitch = clamp(cam.pitch, -1.15, 1.15);
          cam.zoom += (cam.zoomTarget - cam.zoom) * Math.min(1, dt * 9);

          const at = Date.now() + (p.warpDays || 0) * DAY;
          const nodes = p.nodes || [];
          const selectedId = p.selectedId;
          const filterTag = p.filterTag;
          const showFading = p.showFading;
          const colorOf = typeof p.colorOf === 'function' ? p.colorOf : colorForTag;
          // Fit the camera automatically so a single cluster fills the frame
          // and a large constellation still reads as one shape.
          let extent = 0;
          for (let i = 0; i < nodes.length; i++) {
            const n = nodes[i];
            const d = Math.sqrt((n.x || 0) * (n.x || 0) + (n.y || 0) * (n.y || 0) + (n.z || 0) * (n.z || 0));
            if (d > extent) extent = d;
          }
          const targetFit = clamp((Math.min(w, hh) * 0.62) / Math.max(80, extent), 0.7, 3);
          cam.fit += (targetFit - cam.fit) * Math.min(1, dt * 3.2);
          const targetShift = selectedId && w >= 660 ? -50 : 0;
          cam.shift += (targetShift - cam.shift) * Math.min(1, dt * 6);
          const c = {
            yaw: cam.yaw,
            pitch: cam.pitch,
            cx: w / 2 + cam.shift,
            cy: hh / 2 + 6,
            scale: cam.fit * cam.zoom * (1 + Math.sin((now / 1000) * 0.08) * 0.015),
          };

          ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
          ctx.clearRect(0, 0, w, hh);

          const t = now / 1000;

          // project every visible star ---------------------------------
          const views = [];
          const clusters = new Map();
          for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];
            const r = retention(node, at);
            const dormant = r < 0.08;
            if (dormant && !showFading && node.id !== selectedId) continue;
            const dim = filterTag && !(node.tags || []).includes(filterTag);
            const tag = primaryTag(node);
            const bob = Math.sin(t * 0.55 + (node.phase || 0)) * 2.1;
            const pr = project(node.x || 0, (node.y || 0) + bob, node.z || 0, c);
            const color = colorOf(tag);
            const sizePx = r < 0.08 ? 1.1 : (1.9 + 3.9 * Math.pow(r, 0.52)) * (0.86 + 0.06 * (node.importance || 3));
            const op = r < 0.08 ? 0.28 : clamp(0.12 + 0.88 * Math.pow(r, 0.62), 0, 1);
            views.push({
              node: node,
              r: r,
              tag: tag,
              color: color,
              faded: r < 0.32,
              x: pr.x,
              y: pr.y,
              z: pr.z,
              s: pr.s,
              size: sizePx * pr.s,
              op: op * (dim ? 0.14 : 1),
              dim: !!dim,
              dormant: dormant,
            });
            if (!dim && !dormant) {
              let cl = clusters.get(tag);
              if (!cl) {
                cl = { x: 0, y: 0, z: 0, n: 0, r: 0, color: color };
                clusters.set(tag, cl);
              }
              cl.x += node.x || 0;
              cl.y += (node.y || 0) + bob;
              cl.z += node.z || 0;
              cl.n += 1;
              cl.r += r;
            }
          }

          // nebula wash ------------------------------------------------
          ctx.globalCompositeOperation = 'lighter';
          for (const cl of clusters.values()) {
            const pr = project(cl.x / cl.n, cl.y / cl.n, cl.z / cl.n, c);
            const avg = cl.r / cl.n;
            const rad = 160 * pr.s * (0.8 + 0.34 * avg);
            if (rad < 10) continue;
            ctx.globalAlpha = (0.38 + 0.3 * avg) * (0.62 + 0.38 * pr.persp);
            const spin = t * 0.016 + ((hash(cl.color) % 100) / 100) * TAU;
            ctx.save();
            ctx.translate(pr.x, pr.y);
            ctx.rotate(spin);
            ctx.drawImage(nebulaFor(cl.color), -rad, -rad, rad * 2, rad * 2);
            ctx.restore();
          }

          // dust — orthographic, so the far sky drifts instead of rushing past
          ctx.globalAlpha = 1;
          const cyaw = Math.cos(c.yaw);
          const syaw = Math.sin(c.yaw);
          const cpit = Math.cos(c.pitch);
          const spit = Math.sin(c.pitch);
          for (let i = 0; i < DUST.length; i++) {
            const d = DUST[i];
            const x1 = d.x * cyaw - d.z * syaw;
            const z1 = d.x * syaw + d.z * cyaw;
            const y1 = d.y * cpit - z1 * spit;
            const sx = c.cx + x1 * c.scale * 0.92;
            const sy = c.cy + y1 * c.scale * 0.92;
            if (sx < -20 || sx > w + 20 || sy < -20 || sy > hh + 20) continue;
            const tw = 0.5 + 0.5 * Math.sin(t * d.speed + d.phase);
            if (d.big) {
              ctx.globalAlpha = 0.22 + 0.4 * tw;
              ctx.fillStyle = d.tone;
              ctx.beginPath();
              ctx.arc(sx, sy, 1.15, 0, TAU);
              ctx.fill();
              ctx.globalAlpha = 0.06 + 0.1 * tw;
              ctx.beginPath();
              ctx.arc(sx, sy, 3.4, 0, TAU);
              ctx.fill();
            } else {
              ctx.globalAlpha = 0.08 + 0.3 * tw;
              ctx.fillStyle = d.tone;
              ctx.fillRect(sx, sy, d.size, d.size);
            }
          }

          // synapses ---------------------------------------------------
          const byId = new Map();
          for (const v of views) byId.set(v.node.id, v);
          const edges = p.edges || [];
          ctx.lineCap = 'round';
          for (let i = 0; i < edges.length; i++) {
            const edge = edges[i];
            const A = byId.get(edge.a);
            const B = byId.get(edge.b);
            if (!A || !B) continue;
            if (A.dim && B.dim) continue;
            const strength = Math.pow(Math.min(A.r, B.r), 0.7);
            let alpha = 0.42 * edge.weight * strength;
            if (alpha < 0.014) continue;
            if (A.dim || B.dim) alpha *= 0.2;
            const depth = clamp((A.s + B.s) / (2 * c.scale), 0.7, 1.35);
            ctx.globalAlpha = clamp(alpha * depth, 0, 0.5);
            const bend = (((hash(edge.a + edge.b) % 200) / 200) - 0.5) * 0.16;
            const nx = -(B.y - A.y);
            const ny = B.x - A.x;
            const mx = (A.x + B.x) / 2 + nx * bend;
            const my = (A.y + B.y) / 2 + ny * bend;
            ctx.strokeStyle = edge.color;
            // soft halo under a fine core reads as a glowing filament
            ctx.globalAlpha = clamp(alpha * depth * 0.28, 0, 0.22);
            ctx.lineWidth = 3.4 + 2.4 * edge.weight;
            ctx.beginPath();
            ctx.moveTo(A.x, A.y);
            ctx.quadraticCurveTo(mx, my, B.x, B.y);
            ctx.stroke();
            ctx.globalAlpha = clamp(alpha * depth, 0, 0.5);
            ctx.lineWidth = 0.6 + 0.9 * edge.weight;
            ctx.beginPath();
            ctx.moveTo(A.x, A.y);
            ctx.quadraticCurveTo(mx, my, B.x, B.y);
            ctx.stroke();
            // a slow pulse travelling the fibre: co-activation in motion
            if (strength > 0.42 && edge.weight >= 0.25) {
              const phase = (t * 0.16 + (hash(edge.a) % 100) / 100) % 1;
              const q = 1 - phase;
              const px = q * q * A.x + 2 * q * phase * mx + phase * phase * B.x;
              const py = q * q * A.y + 2 * q * phase * my + phase * phase * B.y;
              ctx.globalAlpha = clamp(alpha * 1.9 * Math.sin(Math.PI * phase), 0, 0.75);
              ctx.fillStyle = mixHex(edge.color, '#ffffff', 0.55);
              ctx.beginPath();
              ctx.arc(px, py, 1.05 + edge.weight * 0.9, 0, TAU);
              ctx.fill();
            }
          }

          // stars (far to near) ---------------------------------------
          views.sort((a, b) => b.z - a.z);
          const hoveredId = hoverRef.current;
          const hovered = hoveredId ? views.find((v) => v.node.id === hoveredId) : null;
          const swarm = swarmRef.current;
          for (let i = 0; i < views.length; i++) {
            const v = views[i];
            if (v.dormant) {
              const tw = 0.55 + 0.45 * Math.sin(t * 1.4 + (v.node.phase || 0));
              ctx.globalAlpha = clamp(v.op * tw * (hoveredId === v.node.id ? 2.2 : 1), 0, 1);
              ctx.fillStyle = '#9db0cf';
              ctx.fillRect(v.x, v.y, 1.4, 1.4);
              continue;
            }
            // companion motes: the memory reads as a small neural assembly
            const parts = swarm.get(v.node.id);
            if (parts && v.r > 0.1) {
              const bob = Math.sin(t * 0.55 + (v.node.phase || 0)) * 3;
              for (let k = 0; k < parts.length; k++) {
                const part = parts[k];
                const a = part.phase + t * part.speed;
                const px = (v.node.x || 0) + Math.cos(a) * part.rad;
                const py = (v.node.y || 0) + Math.sin(a * 1.3 + part.tilt) * part.rad * 0.42 + bob;
                const pz = (v.node.z || 0) + Math.sin(a) * part.rad;
                const pr = project(px, py, pz, c);
                ctx.globalAlpha = clamp(part.alpha * v.op * (v.dim ? 0.08 : 0.46), 0, 1);
                ctx.fillStyle = v.color;
                ctx.beginPath();
                ctx.arc(pr.x, pr.y, Math.max(0.55, part.size * 0.62 * pr.persp), 0, TAU);
                ctx.fill();
              }
            }
            const twinkle = 0.92 + 0.08 * Math.sin(t * 1.9 + (v.node.phase || 0));
            const sprite = spriteFor(v.color, v.faded);
            if (v.r > 0.5 && !v.dim) {
              const bloom = Math.max(10, v.size * 16);
              ctx.globalAlpha = clamp(v.op * 0.12 * v.r, 0, 0.16);
              ctx.drawImage(sprite, v.x - bloom / 2, v.y - bloom / 2, bloom, bloom);
            }
            const drawSize = Math.max(6, v.size * 8);
            ctx.globalAlpha = clamp(v.op * 0.95 * twinkle, 0, 1);
            ctx.drawImage(sprite, v.x - drawSize / 2, v.y - drawSize / 2, drawSize, drawSize);
            if (v.r > 0.45 && !v.dim) {
              const spike = spikeFor(v.color);
              const ss = Math.max(12, v.size * 8);
              ctx.save();
              ctx.translate(v.x, v.y);
              ctx.rotate(t * 0.05 + (v.node.phase || 0));
              ctx.globalAlpha = clamp(0.06 + 0.2 * v.r, 0, 0.28);
              ctx.drawImage(spike, -ss / 2, -ss / 2, ss, ss);
              ctx.restore();
            }
            ctx.globalAlpha = clamp(0.35 + 0.65 * v.r, 0, 1) * (v.dim ? 0.2 : 1);
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(v.x, v.y, Math.max(0.7, v.size * 0.34), 0, TAU);
            ctx.fill();
          }

          // labels ------------------------------------------------------
          ctx.globalCompositeOperation = 'source-over';
          const labels = [];
          for (const v of views) {
            if (v.dormant || v.dim) continue;
            if (v.r < 0.3) continue;
            labels.push(v);
          }
          labels.sort((a, b) => b.r - a.r);
          const maxLabels = w < 560 ? 10 : 26;
          const UI_FONT = '"Segoe UI","PingFang SC","Microsoft YaHei",ui-sans-serif,system-ui,sans-serif';
          ctx.font = '500 11px ' + UI_FONT;
          ctx.textBaseline = 'middle';
          ctx.shadowColor = 'rgba(2,4,10,0.9)';
          ctx.shadowBlur = 5;
          for (let i = 0; i < Math.min(labels.length, maxLabels); i++) {
            const v = labels[i];
            const a = 0.32 + 0.55 * v.r;
            ctx.fillStyle = 'rgba(228,238,255,' + a.toFixed(3) + ')';
            ctx.fillText(truncate(v.node.title, 13), v.x + 10, v.y + 1);
          }
          ctx.shadowBlur = 0;
          ctx.shadowColor = 'transparent';

          // hover card -------------------------------------------------
          if (hovered && hovered.node.id !== selectedId && !hovered.dim) {
            const titleText = truncate(hovered.node.title, 18);
            const subText =
              Math.round(hovered.r * 100) + '%  ·  ' + (typeof p.t === 'function' ? p.t('status.' + statusOf(hovered.r)) : '');
            ctx.font = '600 11.5px ' + UI_FONT;
            const titleW = ctx.measureText(titleText).width;
            ctx.font = '400 10px ' + UI_FONT;
            const subW = ctx.measureText(subText).width;
            const cardW = Math.max(titleW, subW) + 28;
            const cardH = 40;
            let bx = hovered.x + 16;
            let by = hovered.y - cardH - 12;
            if (bx + cardW > w - 10) bx = hovered.x - cardW - 16;
            if (bx < 8) bx = 8;
            if (by < 8) by = hovered.y + 16;
            ctx.globalAlpha = 1;
            roundRect(ctx, bx, by, cardW, cardH, 9);
            ctx.fillStyle = 'rgba(8,12,24,0.9)';
            ctx.fill();
            ctx.strokeStyle = rgba(hovered.color, 0.42);
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = hovered.color;
            ctx.fillRect(bx + 9, by + 9, 2, cardH - 18);
            ctx.textBaseline = 'middle';
            ctx.font = '600 11.5px ' + UI_FONT;
            ctx.fillStyle = 'rgba(236,243,255,0.96)';
            ctx.fillText(titleText, bx + 17, by + 14);
            ctx.font = '400 10px ' + UI_FONT;
            ctx.fillStyle = 'rgba(158,178,210,0.96)';
            ctx.fillText(subText, bx + 17, by + 28);
          }

          // selection / hover rings -----------------------------------
          ctx.globalCompositeOperation = 'source-over';
          const selected = views.find((v) => v.node.id === selectedId);
          if (selected) {
            ctx.globalAlpha = 0.9;
            ctx.strokeStyle = selected.color;
            ctx.lineWidth = 1.2;
            ctx.beginPath();
            ctx.arc(selected.x, selected.y, Math.max(9, selected.size + 6), 0, TAU);
            ctx.stroke();
            ctx.globalAlpha = 0.16;
            ctx.beginPath();
            ctx.arc(selected.x, selected.y, Math.max(14, selected.size + 14), 0, TAU);
            ctx.stroke();
            ctx.globalAlpha = 0.5;
            ctx.setLineDash([2.5, 5.5]);
            ctx.lineDashOffset = -t * 14;
            ctx.beginPath();
            ctx.arc(selected.x, selected.y, Math.max(15, selected.size + 13), 0, TAU);
            ctx.stroke();
            ctx.setLineDash([]);
          }
          if (hovered && hovered !== selected) {
            ctx.globalAlpha = 0.6;
            ctx.strokeStyle = 'rgba(230,240,255,.85)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(hovered.x, hovered.y, Math.max(8, hovered.size + 5), 0, TAU);
            ctx.stroke();
          }

          // recall bursts ---------------------------------------------
          ctx.globalCompositeOperation = 'lighter';
          for (let i = burstRef.current.length - 1; i >= 0; i--) {
            const b = burstRef.current[i];
            const age = (now - b.t0) / 950;
            if (age >= 1) {
              burstRef.current.splice(i, 1);
              continue;
            }
            const node = b.node;
            const bob = Math.sin(t * 0.55 + (node.phase || 0)) * 2.1;
            const pr = project(node.x || 0, (node.y || 0) + bob, node.z || 0, c);
            const rad = (6 + age * 58) * pr.s;
            ctx.globalAlpha = Math.pow(1 - age, 2) * 0.85;
            ctx.strokeStyle = colorOf(primaryTag(node));
            ctx.lineWidth = 1.6;
            ctx.beginPath();
            ctx.arc(pr.x, pr.y, rad, 0, TAU);
            ctx.stroke();
            ctx.globalAlpha = Math.pow(1 - age, 3) * 0.45;
            ctx.beginPath();
            ctx.arc(pr.x, pr.y, rad * 1.75, 0, TAU);
            ctx.stroke();
            ctx.globalAlpha = Math.pow(1 - age, 3) * 0.9;
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(pr.x, pr.y, Math.max(1, 3 * pr.s * (1 - age)), 0, TAU);
            ctx.fill();
          }
          ctx.globalAlpha = 1;

          // hit map (front-most first)
          const hits = hitsRef.current;
          hits.length = 0;
          for (let i = views.length - 1; i >= 0; i--) {
            const v = views[i];
            hits.push({ id: v.node.id, x: v.x, y: v.y, r: Math.max(v.size, 2) });
          }

          raf = requestAnimationFrame(frame);
        }

        // ---- pointer interaction
        function localPoint(e) {
          const rect = canvas.getBoundingClientRect();
          return { x: e.clientX - rect.left, y: e.clientY - rect.top };
        }

        function onDown(e) {
          if (e.button !== undefined && e.button > 0) return;
          canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
          const pt = localPoint(e);
          dragRef.current = { x: pt.x, y: pt.y, moved: 0, startX: pt.x, startY: pt.y };
          cam.idleUntil = performance.now() + 4500;
        }

        function onMove(e) {
          const drag = dragRef.current;
          const pt = localPoint(e);
          if (drag) {
            const dx = pt.x - drag.x;
            const dy = pt.y - drag.y;
            drag.moved += Math.abs(dx) + Math.abs(dy);
            drag.x = pt.x;
            drag.y = pt.y;
            cam.yaw += dx * 0.0062;
            cam.pitch = clamp(cam.pitch + dy * 0.0052, -1.15, 1.15);
            if (cam.focus) cam.focus = null;
            cam.idleUntil = performance.now() + 4500;
            return;
          }
          const hit = pick(pt.x, pt.y);
          hoverRef.current = hit ? hit.id : null;
          canvas.style.cursor = hit ? 'pointer' : 'grab';
        }

        function onUp(e) {
          const drag = dragRef.current;
          dragRef.current = null;
          if (!drag) return;
          if (drag.moved < 7) {
            const pt = localPoint(e);
            const hit = pick(pt.x, pt.y);
            const live = propsRef.current;
            if (live.onSelect) live.onSelect(hit ? hit.id : null);
          }
          cam.idleUntil = performance.now() + 3500;
        }

        function onLeave() {
          hoverRef.current = null;
          dragRef.current = null;
        }

        function onWheel(e) {
          e.preventDefault();
          const factor = Math.exp(-e.deltaY * 0.0011);
          cam.zoomTarget = clamp(cam.zoomTarget * factor, 0.5, 2.6);
          cam.idleUntil = performance.now() + 3500;
        }

        function onDouble(e) {
          cam.zoomTarget = 1;
          cam.focus = {
            t0: performance.now(),
            dur: 650,
            fromYaw: cam.yaw,
            fromPitch: cam.pitch,
            dYaw: 0.55 - cam.yaw,
            dPitch: -0.1 - cam.pitch,
          };
        }

        canvas.addEventListener('pointerdown', onDown);
        canvas.addEventListener('pointermove', onMove);
        canvas.addEventListener('pointerup', onUp);
        canvas.addEventListener('pointercancel', onUp);
        canvas.addEventListener('pointerleave', onLeave);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('dblclick', onDouble);

        const ro = new ResizeObserver(resize);
        ro.observe(canvas);
        resize();

        // expose camera helpers to the page (cluster focus / reset)
        if (props.apiRef) {
          props.apiRef.current = {
            focusCluster(tag) {
              const live = propsRef.current;
              const members = (live.nodes || []).filter((n) => (n.tags || []).includes(tag));
              if (!members.length) return;
              let x = 0;
              let y = 0;
              let z = 0;
              for (const m of members) {
                x += m.x || 0;
                y += m.y || 0;
                z += m.z || 0;
              }
              x /= members.length;
              y /= members.length;
              z /= members.length;
              const targetYaw = Math.atan2(x, z);
              const len = Math.sqrt(x * x + y * y + z * z) || 1;
              const targetPitch = -Math.asin(clamp(y / len, -1, 1)) * 0.85;
              let dYaw = targetYaw - cam.yaw;
              while (dYaw > Math.PI) dYaw -= TAU;
              while (dYaw < -Math.PI) dYaw += TAU;
              cam.focus = {
                t0: performance.now(),
                dur: 900,
                fromYaw: cam.yaw,
                fromPitch: cam.pitch,
                dYaw: dYaw,
                dPitch: targetPitch - cam.pitch,
              };
            },
            reset() {
              cam.zoomTarget = 1;
              cam.focus = {
                t0: performance.now(),
                dur: 700,
                fromYaw: cam.yaw,
                fromPitch: cam.pitch,
                dYaw: 0.55 - cam.yaw,
                dPitch: -0.1 - cam.pitch,
              };
            },
          };
        }

        raf = requestAnimationFrame(frame);

        return () => {
          disposed = true;
          cancelAnimationFrame(raf);
          ro.disconnect();
          canvas.removeEventListener('pointerdown', onDown);
          canvas.removeEventListener('pointermove', onMove);
          canvas.removeEventListener('pointerup', onUp);
          canvas.removeEventListener('pointercancel', onUp);
          canvas.removeEventListener('pointerleave', onLeave);
          canvas.removeEventListener('wheel', onWheel);
          canvas.removeEventListener('dblclick', onDouble);
        };
      }, []);

      return h('canvas', { ref: canvasRef, className: 'ms-canvas', 'aria-label': props.ariaLabel || 'Memory star map' });
    }

    /* ------------------------------------------------------------------ *
     * Icons
     * ------------------------------------------------------------------ */
    function Svg(props) {
      return h(
        'svg',
        Object.assign(
          { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
          props,
        ),
        props.children,
      );
    }

    const IconPlus = () =>
      h(Svg, { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' },
        h('path', { d: 'M12 5v14M5 12h14' }));

    const IconSpark = () =>
      h(Svg, { stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z' }),
        h('path', { d: 'M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z' }));

    const IconClose = () =>
      h(Svg, { stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' },
        h('path', { d: 'M6 6l12 12M18 6L6 18' }));

    const IconPencil = () =>
      h(Svg, { stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M15.5 4.5l4 4L8 20H4v-4z' }));

    const IconDownload = () =>
      h(Svg, { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M12 3v12M7.5 10.5L12 15l4.5-4.5' }),
        h('path', { d: 'M4.5 19.5h15' }));

    const IconUpload = () =>
      h(Svg, { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M12 15V3M7.5 7.5L12 3l4.5 4.5' }),
        h('path', { d: 'M4.5 19.5h15' }));

    const IconTrash = () =>
      h(Svg, { stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13' }));

    const IconRecall = () =>
      h(Svg, { stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: 'M20 12a8 8 0 1 1-2.6-5.9' }),
        h('path', { d: 'M20 4v5h-5' }));

    function SidebarIcon(props) {
      const size = Math.max(14, Math.min(28, Number(props.size) || 20));
      const active = !!props.active;
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M4.6 16.8 L9 8.2 L14 13.2 L19.4 6.2',
          stroke: 'currentColor',
          strokeWidth: 1.25,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          opacity: active ? 0.85 : 0.55,
        }),
        h('circle', { cx: 4.6, cy: 16.8, r: 1.5, fill: 'currentColor', opacity: active ? 1 : 0.8 }),
        h('circle', { cx: 9, cy: 8.2, r: 2, fill: 'currentColor' }),
        h('circle', { cx: 14, cy: 13.2, r: 1.25, fill: 'currentColor', opacity: active ? 0.95 : 0.7 }),
        h('circle', { cx: 19.4, cy: 6.2, r: 2.2, fill: 'currentColor' }),
      );
    }

    /* ------------------------------------------------------------------ *
     * Page
     * ------------------------------------------------------------------ */
    function Btn(props) {
      const variant = props.variant ? ' ms-btn-' + props.variant : '';
      const cls = 'ms-btn' + variant + (props.iconOnly ? ' ms-icon' : '') + (props.className ? ' ' + props.className : '');
      const rest = Object.assign({}, props);
      delete rest.variant;
      delete rest.iconOnly;
      delete rest.className;
      delete rest.children;
      return h('button', Object.assign({ type: 'button', className: cls }, rest), props.children);
    }

    function MemoryPage(props) {
      const ctx = props.ctx;
      const t = props.t;
      const [store, setStore] = useState(() => loadStore());
      const [selectedId, setSelectedId] = useState(() => (props.initialSelectedId ? props.initialSelectedId : null));
      const [showFading, setShowFading] = useState(false);
      const [warpDays, setWarpDays] = useState(0);
      const [filterTag, setFilterTag] = useState(null);
      const [dialog, setDialog] = useState(null);
      const [pulse, setPulse] = useState(null);
      const [toast, setToast] = useState(null);
      const [confirm, setConfirm] = useState(null);
      const [nowTick, setNowTick] = useState(() => Date.now());
      const [locRev, setLocRev] = useState(0);
      const [narrow, setNarrow] = useState(false);
      const stageRef = useRef(null);
      const apiRef = useRef(null);
      const fileRef = useRef(null);
      const saveTimer = useRef(0);
      const toastTimer = useRef(0);
      const [storeReady, setStoreReady] = useState(false);
      const [sync, setSync] = useState({ mode: 'local', rev: -1, autoCapture: true, autoRecall: true });
      const syncRef = useRef(sync);
      syncRef.current = sync;
      const storeRef = useRef(store);
      storeRef.current = store;

      // Talk to the Host memory store that the agent writes to as well.
      const hostPost = useCallback(async (op, payload) => {
        try {
          const res = await fetch('/api/memory-starmap', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.assign({ op: op }, payload || {})),
          });
          if (!res.ok) return null;
          const data = await res.json();
          if (data && typeof data.version === 'number') {
            setSync((s) =>
              s.mode === 'host'
                ? Object.assign({}, s, {
                    rev: data.version,
                    autoCapture: !(data.settings && data.settings.autoCapture === false),
                    autoRecall: !(data.settings && data.settings.autoRecall === false),
                  })
                : s,
            );
          }
          return data;
        } catch (err) {
          return null;
        }
      }, []);

      const showToast = useCallback((msg) => {
        setToast(msg);
        try {
          window.clearTimeout(toastTimer.current);
        } catch (e) {}
        toastTimer.current = window.setTimeout(() => setToast(null), 3600);
      }, []);

      useEffect(() => () => {
        try {
          window.clearTimeout(toastTimer.current);
        } catch (e) {}
      }, []);

      const nodes = store.nodes;
      const at = nowTick + warpDays * DAY;

      // locale subscription so labels follow the active language
      useEffect(() => {
        if (!ctx || !ctx.locale || !ctx.locale.subscribe) return;
        return ctx.locale.subscribe(() => setLocRev((x) => x + 1));
      }, [ctx]);

      // a slow tick keeps the forgetting curve moving while the panel is open
      useEffect(() => {
        const id = window.setInterval(() => setNowTick(Date.now()), 30000);
        return () => window.clearInterval(id);
      }, []);

      // persist
      useEffect(() => {
        if (!storeReady) return;
        try {
          window.clearTimeout(saveTimer.current);
        } catch (e) {}
        saveTimer.current = window.setTimeout(() => {
          try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, nodes: store.nodes }));
          } catch (err) {
            showToast(t('toast.saveFailed'));
          }
        }, 220);
        return () => window.clearTimeout(saveTimer.current);
      }, [store, storeReady]);

      useEffect(() => {
        setStoreReady(true);
      }, []);

      // Flush the pending debounce when the panel unmounts (switching pages),
      // so a memory recalled right before leaving is never lost.
      const latestNodes = useRef(nodes);
      latestNodes.current = nodes;
      useEffect(() => () => {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, nodes: latestNodes.current }));
        } catch (err) {}
      }, []);

      // Connect to the Host store once: adopt its memories, and migrate the
      // browser-local map into it the first time (the agent shares this file).
      useEffect(() => {
        let alive = true;
        (async () => {
          try {
            const res = await fetch('/api/memory-starmap', { headers: { accept: 'application/json' } });
            if (!res.ok) return;
            let data = await res.json();
            if (!alive || !data || !Array.isArray(data.nodes)) return;
            const local = storeRef.current.nodes || [];
            const hostIds = new Set(data.nodes.map((n) => n.id));
            const missing = local.filter((n) => !hostIds.has(n.id));
            if (!data.nodes.length && local.length) {
              await fetch('/api/memory-starmap', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ op: 'import', nodes: local }),
              });
              const again = await fetch('/api/memory-starmap');
              if (again.ok) data = await again.json();
            } else if (missing.length) {
              await fetch('/api/memory-starmap', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ op: 'saveMany', nodes: missing }),
              });
              const again = await fetch('/api/memory-starmap');
              if (again.ok) data = await again.json();
            }
            if (!alive || !data || !Array.isArray(data.nodes)) return;
            setStore({ nodes: ensureLayout(data.nodes.map(normalizeNode)) });
            setSync({
              mode: 'host',
              rev: Number(data.version) || 0,
              autoCapture: !(data.settings && data.settings.autoCapture === false),
              autoRecall: !(data.settings && data.settings.autoRecall === false),
            });
          } catch (err) {
            // keep working from the browser-local map
          }
        })();
        return () => {
          alive = false;
        };
      }, []);

      // Pick up memories the agent captured or reinforced while we are open.
      useEffect(() => {
        if (sync.mode !== 'host') return;
        const id = window.setInterval(async () => {
          try {
            const res = await fetch('/api/memory-starmap', { headers: { accept: 'application/json' } });
            if (!res.ok) return;
            const data = await res.json();
            if (!data || !Array.isArray(data.nodes)) return;
            if (Number(data.version) === syncRef.current.rev) return;
            const incoming = ensureLayout(data.nodes.map(normalizeNode));
            const known = new Map(storeRef.current.nodes.map((n) => [n.id, n]));
            const fresh = incoming.filter((n) => !known.has(n.id));
            const recalledNow = incoming.filter((n) => {
              const before = known.get(n.id);
              return before && Number(n.reviews || 0) > Number(before.reviews || 0);
            });
            setStore({ nodes: incoming });
            if (fresh.length) {
              const first = fresh[0];
              showToast(
                first.source === 'auto'
                  ? t('toast.autoCaptured', { title: first.title })
                  : t('toast.newStar', { title: first.title }),
              );
            } else if (recalledNow.length) {
              const hit = recalledNow[0];
              showToast(t('toast.autoRecalled', { title: hit.title }));
              setPulse({ id: hit.id, at: Date.now() });
            }
            setSync((s) =>
              Object.assign({}, s, {
                rev: Number(data.version) || 0,
                autoCapture: !(data.settings && data.settings.autoCapture === false),
                autoRecall: !(data.settings && data.settings.autoRecall === false),
              }),
            );
          } catch (err) {}
        }, 4000);
        return () => window.clearInterval(id);
      }, [sync.mode, showToast, t]);

      // responsive drawer
      useEffect(() => {
        const el = stageRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver((entries) => {
          const w = entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0;
          setNarrow(w < 660);
        });
        ro.observe(el);
        return () => ro.disconnect();
      }, []);

      const colors = useMemo(() => buildColorMap(nodes), [nodes]);
      const colorOf = useCallback((tag) => colors.get(tag) || colorForTag(tag), [colors]);

      const edges = useMemo(() => buildEdges(nodes, colorOf), [nodes, colorOf]);

      const metrics = useMemo(() => {
        let bright = 0;
        let fading = 0;
        let dormant = 0;
        for (const node of nodes) {
          const r = retention(node, at);
          if (r >= 0.6) bright++;
          else if (r >= 0.08) fading++;
          else dormant++;
        }
        return { total: nodes.length, bright: bright, fading: fading, dormant: dormant };
      }, [nodes, at]);

      const clusters = useMemo(() => {
        const map = new Map();
        for (const node of nodes) {
          const tag = primaryTag(node);
          if (!map.has(tag)) map.set(tag, { tag: tag, count: 0, color: colorOf(tag), rSum: 0 });
          const cl = map.get(tag);
          cl.count++;
          cl.rSum += retention(node, at);
        }
        return Array.from(map.values())
          .map((cl) => ({ tag: cl.tag, count: cl.count, color: cl.color, avg: cl.rSum / cl.count }))
          .sort((a, b) => b.count - a.count || (a.tag < b.tag ? -1 : 1));
      }, [nodes, colorOf, at]);

      const selected = selectedId ? nodes.find((n) => n.id === selectedId) || null : null;

      const saveNodes = useCallback((next) => {
        setStore({ nodes: next });
      }, []);

      const addMemory = useCallback(
        (draft) => {
          const node = normalizeNode({
            id: uid(),
            title: draft.title,
            content: draft.content,
            tags: draft.tags,
            importance: draft.importance,
            createdAt: Date.now(),
            lastReview: Date.now(),
            reviews: 0,
            stability: baseStability(draft.importance),
          });
          const next = ensureLayout(nodes.concat([node]));
          saveNodes(next);
          hostPost('save', { node: node });
          setDialog(null);
          setSelectedId(node.id);
          setFilterTag(null);
          showToast(t('toast.added'));
        },
        [nodes, saveNodes, hostPost, showToast, t],
      );

      const updateMemory = useCallback(
        (id, draft) => {
          const next = nodes.map((n) => {
            if (n.id !== id) return n;
            const merged = Object.assign({}, n, {
              title: draft.title,
              content: draft.content,
              tags: draft.tags,
              importance: draft.importance,
            });
            // A different first tag means a different cluster: let layout re-seat it.
            if (primaryTag(n) !== primaryTag(merged)) {
              delete merged.x;
              delete merged.y;
              delete merged.z;
            }
            return merged;
          });
          saveNodes(ensureLayout(next));
          const updated = next.find((n) => n.id === id);
          if (updated) hostPost('save', { node: updated });
          setDialog(null);
          showToast(t('toast.updated'));
        },
        [nodes, saveNodes, hostPost, showToast, t],
      );

      const deleteMemory = useCallback(
        (id) => {
          saveNodes(nodes.filter((n) => n.id !== id));
          hostPost('delete', { id: id });
          setSelectedId(null);
          setConfirm(null);
          showToast(t('toast.deleted'));
        },
        [nodes, saveNodes, hostPost, showToast, t],
      );

      const recall = useCallback(
        (id) => {
          const now = Date.now();
          const next = nodes.map((n) => (n.id === id ? recallNode(n, now) : n));
          saveNodes(next);
          const after = next.find((n) => n.id === id);
          if (after) hostPost('save', { node: after });
          setNowTick(now);
          setPulse({ id: id, at: now });
          showToast(t('toast.recalled'));
        },
        [nodes, saveNodes, hostPost, showToast, t],
      );

      const consolidate = useCallback(() => {
        const now = Date.now();
        const before = at;
        let pruned = 0;
        for (const edge of edges) {
          const a = nodes.find((n) => n.id === edge.a);
          const b = nodes.find((n) => n.id === edge.b);
          if (!a || !b) continue;
          if (Math.min(retention(a, before), retention(b, before)) < 0.05) pruned++;
        }
        const next = nodes.map((n) => consolidateNode(n, now));
        saveNodes(next);
        hostPost('saveMany', { nodes: next });
        setNowTick(now);
        setConfirm(null);
        showToast(t('toast.consolidated', { n: nodes.length, m: pruned }));
      }, [nodes, edges, saveNodes, hostPost, showToast, t, at]);

      const clearAll = useCallback(() => {
        saveNodes([]);
        hostPost('clear');
        setSelectedId(null);
        setConfirm(null);
        setFilterTag(null);
        showToast(t('toast.cleared'));
      }, [saveNodes, hostPost, showToast, t]);

      const loadSample = useCallback(() => {
        const next = seedMemories(Date.now());
        ensureLayout(next);
        saveNodes(next);
        hostPost('import', { nodes: next });
        showToast(t('toast.added'));
      }, [saveNodes, hostPost, showToast, t]);

      const exportJson = useCallback(() => {
        try {
          const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), nodes: nodes }, null, 2)], {
            type: 'application/json',
          });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'memory-starmap-' + new Date().toISOString().slice(0, 10) + '.json';
          document.body.appendChild(a);
          a.click();
          a.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 4000);
          showToast(t('toast.exported'));
        } catch (err) {
          showToast(t('toast.saveFailed'));
        }
      }, [nodes, showToast, t]);

      const importJson = useCallback(
        (file) => {
          if (!file) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const parsed = JSON.parse(String(reader.result || '{}'));
              const list = Array.isArray(parsed) ? parsed : parsed && parsed.nodes;
              if (!Array.isArray(list)) throw new Error('bad file');
              const next = ensureLayout(list.map(normalizeNode));
              saveNodes(next);
              hostPost('import', { nodes: next });
              setSelectedId(null);
              setFilterTag(null);
              showToast(t('toast.imported', { n: next.length }));
            } catch (err) {
              showToast(t('toast.importFailed'));
            }
          };
          reader.onerror = () => showToast(t('toast.importFailed'));
          reader.readAsText(file);
        },
        [saveNodes, hostPost, showToast, t],
      );

      const toggleAuto = useCallback(() => {
        const next = !syncRef.current.autoCapture;
        setSync((s) => Object.assign({}, s, { autoCapture: next, autoRecall: next }));
        hostPost('settings', { settings: { autoCapture: next, autoRecall: next } });
      }, [hostPost]);

      const onLegend = useCallback(
        (tag) => {
          const next = filterTag === tag ? null : tag;
          setFilterTag(next);
          if (next && apiRef.current) apiRef.current.focusCluster(next);
        },
        [filterTag],
      );

      // keyboard: escape closes the topmost surface
      useEffect(() => {
        function onKey(e) {
          if (e.key !== 'Escape') return;
          if (dialog) setDialog(null);
          else if (confirm) setConfirm(null);
          else if (selectedId) setSelectedId(null);
          else if (filterTag) setFilterTag(null);
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      }, [dialog, confirm, selectedId, filterTag]);

      void locRev;

      const selectedR = selected ? retention(selected, at) : 0;
      const visibleCount = metrics.bright + metrics.fading;
      const linkCount = selected ? edges.filter((e) => e.a === selected.id || e.b === selected.id).length : 0;
      const selectedStatus = statusOf(selectedR);
      const selectedColor = selected ? colorOf(primaryTag(selected)) : '#7fa2ff';

      return h(
        'div',
        { className: 'ms-page' + (narrow ? ' ms-narrow' : '') },
        h('style', null, CSS),
        h(
          'header',
          { className: 'ms-head' },
          h(
            'div',
            { className: 'ms-brand' },
            h(
              'div',
              { className: 'ms-mark', 'aria-hidden': true },
              h(SidebarIcon, { size: 22, active: true }),
            ),
            h(
              'div',
              { style: { minWidth: 0 } },
              h('h1', { className: 'ms-title' }, t('title')),
              h('p', { className: 'ms-sub' }, t('subtitle')),
            ),
          ),
          h(
            'div',
            { className: 'ms-tools' },
            h(
              'div',
              { className: 'ms-metrics', role: 'group', 'aria-label': t('metric.memories') },
              h('div', { className: 'ms-metric' }, h('b', null, String(metrics.total)), h('span', null, t('metric.memories'))),
              h(
                'div',
                { className: 'ms-metric' },
                h('b', { style: { color: '#2fa971' } }, String(metrics.bright)),
                h('span', null, t('metric.bright')),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ms-metric',
                  title: t('metric.toggleHint'),
                  'aria-pressed': showFading,
                  onClick: () => setShowFading((v) => !v),
                },
                h('b', { style: { color: showFading ? '#6b7f9e' : '#c98a1e' } }, String(showFading ? metrics.dormant : metrics.fading)),
                h('span', null, showFading ? t('metric.dormant') : t('metric.fading')),
              ),
            ),
            sync.mode === 'host'
              ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'ms-auto' + (sync.autoCapture ? ' on' : ''),
                    title: t('auto.hint'),
                    'aria-pressed': sync.autoCapture,
                    onClick: toggleAuto,
                  },
                  h('i', null),
                  h('span', null, t('auto.label')),
                  h('em', null, sync.autoCapture ? t('auto.on') : t('auto.off')),
                )
              : null,
            h(
              Btn,
              { variant: 'ghost', iconOnly: true, title: t('action.import'), 'aria-label': t('action.import'), onClick: () => fileRef.current && fileRef.current.click() },
              h(IconUpload),
            ),
            h(
              Btn,
              { variant: 'ghost', iconOnly: true, title: t('action.export'), 'aria-label': t('action.export'), onClick: exportJson },
              h(IconDownload),
            ),
            h(
              Btn,
              {
                variant: 'ghost',
                iconOnly: true,
                title: t('action.clear'),
                'aria-label': t('action.clear'),
                disabled: nodes.length === 0,
                onClick: () => setConfirm('clear'),
              },
              h(IconTrash),
            ),
            h(
              Btn,
              { variant: 'ghost', iconOnly: true, title: t('action.consolidate'), 'aria-label': t('action.consolidate'), onClick: () => setConfirm('consolidate') },
              h(IconSpark),
            ),
            h(
              Btn,
              { variant: 'primary', onClick: () => setDialog({ mode: 'add', node: null }) },
              h(IconPlus),
              h('span', null, t('action.add')),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ms-stage', ref: stageRef },
          h(StarField, {
            nodes: nodes,
            edges: edges,
            selectedId: selectedId,
            showFading: showFading,
            warpDays: warpDays,
            filterTag: filterTag,
            colorOf: colorOf,
            pulse: pulse,
            apiRef: apiRef,
            onSelect: (id) => setSelectedId(id),
            t: t,
            ariaLabel: t('title'),
          }),
          h(
            'div',
            { className: 'ms-hud ms-hud-tl' },
            h(
              'div',
              { className: 'ms-clusters', role: 'group', 'aria-label': t('legend.title') },
              h(
                'div',
                { className: 'ms-clusters-head' },
                h('span', null, t('legend.title')),
                h('em', null, String(clusters.length)),
              ),
              h(
                'div',
                { className: 'ms-clusters-body' },
                clusters.map((cl) =>
                  h(
                    'button',
                    {
                      key: cl.tag,
                      type: 'button',
                      className: 'ms-cluster' + (filterTag === cl.tag ? ' on' : ''),
                      style: { color: cl.color },
                      title: cl.tag + ' · ' + Math.round(cl.avg * 100) + '%',
                      onClick: () => onLegend(cl.tag),
                    },
                    h('i', { className: 'dot' }),
                    h('span', { className: 'name' }, cl.tag),
                    h('span', { className: 'num' }, String(cl.count)),
                    h('span', { className: 'meter' }, h('b', { style: { width: Math.max(5, Math.round(cl.avg * 100)) + '%' } })),
                  ),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'ms-hud ms-hud-tr' },
            h(
              'div',
              { className: 'ms-warp', role: 'group', 'aria-label': t('warp.label') },
              h('span', null, t('warp.label')),
              [0, 7, 30, 90, 365].map((d) =>
                h(
                  'button',
                  {
                    key: d,
                    type: 'button',
                    className: warpDays === d ? 'on' : '',
                    onClick: () => setWarpDays(d),
                    title: d === 0 ? t('warp.now') : t('warp.day', { n: d }),
                  },
                  d === 0 ? t('warp.now') : t('warp.day', { n: d }),
                ),
              ),
            ),
          ),
          nodes.length > 0 && !selected
            ? h('div', { className: 'ms-hint' }, t('hint'))
            : null,
          selected
            ? h(
                'aside',
                { className: 'ms-detail', role: 'dialog', 'aria-label': selected.title },
                h(
                  'div',
                  { className: 'ms-detail-head' },
                  h(
                    'span',
                    { className: 'ms-detail-tag', style: { color: selectedColor } },
                    h('i', null),
                    primaryTag(selected),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ms-btn ms-btn-ghost ms-icon',
                      'aria-label': t('action.close'),
                      onClick: () => setSelectedId(null),
                    },
                    h(IconClose),
                  ),
                ),
                h('h2', { className: 'ms-detail-title' }, selected.title),
                selected.tags && selected.tags.length > 1
                  ? h(
                      'div',
                      { className: 'ms-tags' },
                      selected.tags.slice(1).map((tag) => h('span', { key: tag, style: { color: colorOf(tag) } }, tag)),
                    )
                  : null,
                selected.content ? h('p', { className: 'ms-detail-body' }, selected.content) : null,
                h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'ms-meter-head' },
                    h('span', null, t('detail.retention')),
                    h('b', null, Math.round(selectedR * 100) + '%'),
                  ),
                  h(
                    'div',
                    { className: 'ms-meter', role: 'img', 'aria-label': t('status.' + selectedStatus) + ' ' + Math.round(selectedR * 100) + '%' },
                    h('i', {
                      style: {
                        width: Math.max(3, Math.round(selectedR * 100)) + '%',
                        background:
                          'linear-gradient(90deg,' + selectedColor + ',' + mixHex(selectedColor, '#ffffff', 0.45) + ')',
                      },
                    }),
                  ),
                  h('div', { style: { marginTop: 6, fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('status.' + selectedStatus)),
                ),
                h(
                  'div',
                  { className: 'ms-eta' },
                  selectedR > 0.08
                    ? t('detail.eta', { n: Math.max(1, Math.round(daysUntilFade(selected, at))) })
                    : t('detail.etaNow'),
                ),
                h(RetentionCurve, { node: selected, at: at, color: selectedColor, t: t }),
                h(
                  'div',
                  { className: 'ms-rows' },
                  h('div', { className: 'ms-row' }, h('span', null, t('detail.created')), h('b', null, formatDate(selected.createdAt))),
                  h(
                    'div',
                    { className: 'ms-row' },
                    h('span', null, t('detail.lastRecall')),
                    h('b', null, selected.reviews > 0 ? formatDate(selected.lastReview) : t('detail.never')),
                  ),
                  h('div', { className: 'ms-row' }, h('span', null, t('detail.reviews')), h('b', null, String(selected.reviews))),
                  h('div', { className: 'ms-row' }, h('span', null, t('detail.links')), h('b', null, String(linkCount))),
                  selected.source === 'auto'
                    ? h(
                        'div',
                        { className: 'ms-row' },
                        h('span', null, t('detail.source')),
                        h('b', null, t('detail.auto')),
                      )
                    : null,
                  h(
                    'div',
                    { className: 'ms-row' },
                    h('span', null, t('detail.importance')),
                    h(
                      'span',
                      { className: 'ms-dots', 'aria-label': t('detail.importance') + ' ' + selected.importance },
                      [1, 2, 3, 4, 5].map((n) => h('i', { key: n, className: n <= selected.importance ? 'on' : '' })),
                    ),
                  ),
                ),
                h(
                  'div',
                  { className: 'ms-detail-actions' },
                  h(
                    Btn,
                    { variant: 'primary', onClick: () => recall(selected.id) },
                    h(IconRecall),
                    h('span', null, t('action.recall')),
                  ),
                  h(
                    Btn,
                    { onClick: () => setDialog({ mode: 'edit', node: selected }) },
                    h(IconPencil),
                    h('span', null, t('action.edit')),
                  ),
                  h(
                    Btn,
                    { variant: 'ghost', className: 'ms-btn-danger', onClick: () => setConfirm('delete') },
                    h(IconTrash),
                    h('span', null, t('action.delete')),
                  ),
                ),
              )
            : null,
          nodes.length === 0
            ? h(
                'div',
                { className: 'ms-empty' },
                h('div', { className: 'ms-empty-orb' }),
                h('h2', null, t('empty.title')),
                h('p', null, t('empty.body')),
                h(
                  'div',
                  { className: 'ms-empty-actions' },
                  h(Btn, { variant: 'primary', onClick: () => setDialog({ mode: 'add', node: null }) }, h(IconPlus), h('span', null, t('empty.first'))),
                  h(Btn, { onClick: loadSample }, h(IconSpark), h('span', null, t('empty.sample'))),
                ),
              )
            : null,
          nodes.length > 0 && visibleCount === 0 && !showFading && !selected
            ? h(
                'div',
                { className: 'ms-empty ms-soft' },
                h('h2', null, t('allDormant.title')),
                h('p', null, t('allDormant.body')),
                h(
                  'div',
                  { className: 'ms-empty-actions' },
                  h(Btn, { variant: 'primary', onClick: () => setWarpDays(0) }, t('allDormant.back')),
                ),
              )
            : null,
          dialog
            ? h(MemoryDialog, {
                mode: dialog.mode,
                node: dialog.node,
                t: t,
                colorOf: colorOf,
                onCancel: () => setDialog(null),
                onSave: (draft) => (dialog.mode === 'edit' ? updateMemory(dialog.node.id, draft) : addMemory(draft)),
              })
            : null,
          confirm
            ? h(ConfirmDialog, {
                kind: confirm,
                t: t,
                onCancel: () => setConfirm(null),
                onConfirm: () => (confirm === 'delete' ? deleteMemory(selectedId) : confirm === 'clear' ? clearAll() : consolidate()),
              })
            : null,
          toast ? h('div', { className: 'ms-toast', role: 'status' }, toast) : null,
          h('input', {
            ref: fileRef,
            type: 'file',
            accept: 'application/json,.json',
            style: { display: 'none' },
            onChange: (e) => {
              const f = e.target.files && e.target.files[0];
              importJson(f);
              e.target.value = '';
            },
          }),
        ),
      );
    }

    function formatDate(ts) {
      try {
        return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
      } catch (e) {
        return new Date(ts).toLocaleDateString();
      }
    }

    /** Projected clarity for the next 90 days, with the fade threshold. */
    function RetentionCurve(props) {
      const node = props.node;
      const at = props.at;
      const color = props.color;
      const t = props.t;
      const W = 268;
      const H = 46;
      const pad = 3;
      const s = Math.max(0.05, Number(node.stability) || baseStability(node.importance));
      const elapsed = Math.max(0, at - (Number(node.lastReview) || at)) / DAY;
      const horizon = 90;
      const pts = [];
      for (let d = 0; d <= horizon; d += 3) {
        const r = Math.exp(-(elapsed + d) / s);
        pts.push([(d / horizon) * W, H - pad - r * (H - pad * 2)]);
      }
      let line = '';
      for (let i = 0; i < pts.length; i++) line += (i ? ' L' : 'M') + pts[i][0].toFixed(1) + ',' + pts[i][1].toFixed(1);
      const area = line + ' L' + W + ',' + H + ' L0,' + H + ' Z';
      const thresholdY = H - pad - 0.08 * (H - pad * 2);
      return h(
        'div',
        { className: 'ms-spark' },
        h(
          'svg',
          { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, preserveAspectRatio: 'none', 'aria-hidden': true },
          h('path', { d: area, fill: color, opacity: 0.1 }),
          h('line', {
            x1: 0,
            y1: thresholdY,
            x2: W,
            y2: thresholdY,
            stroke: 'rgba(255,255,255,0.16)',
            strokeDasharray: '2 4',
            strokeWidth: 1,
          }),
          h('path', { d: line, fill: 'none', stroke: color, strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          h('circle', { cx: 1.6, cy: pts[0][1], r: 2.2, fill: color }),
        ),
        h('div', { className: 'ms-spark-foot' }, h('span', null, t('detail.future')), h('span', null, t('detail.fadeLine'))),
      );
    }

    /* ------------------------------------------------------------------ *
     * Dialogs
     * ------------------------------------------------------------------ */
    function MemoryDialog(props) {
      const t = props.t;
      const editing = props.mode === 'edit' && props.node;
      const [title, setTitle] = useState(editing ? props.node.title : '');
      const [content, setContent] = useState(editing ? props.node.content : '');
      const [tags, setTags] = useState(editing ? (props.node.tags || []).join('，') : '');
      const [importance, setImportance] = useState(editing ? props.node.importance : 3);
      const titleRef = useRef(null);

      useEffect(() => {
        const el = titleRef.current;
        if (el) {
          el.focus();
          try {
            el.setSelectionRange(el.value.length, el.value.length);
          } catch (e) {}
        }
      }, []);

      const parsed = parseTags(tags);
      const canSave = title.trim().length > 0;

      function submit() {
        if (!canSave) return;
        props.onSave({
          title: title.trim(),
          content: content.trim(),
          tags: parsed.length ? parsed : [UNTAGGED],
          importance: importance,
        });
      }

      return h(
        'div',
        { className: 'ms-backdrop', onMouseDown: (e) => e.target === e.currentTarget && props.onCancel() },
        h(
          'div',
          { className: 'ms-dialog', role: 'dialog', 'aria-modal': true, 'aria-label': editing ? t('dialog.editTitle') : t('dialog.addTitle') },
          h('h3', null, editing ? t('dialog.editTitle') : t('dialog.addTitle')),
          h(
            'div',
            { className: 'ms-field' },
            h('label', { htmlFor: 'ms-title' }, t('dialog.title')),
            h('input', {
              id: 'ms-title',
              ref: titleRef,
              value: title,
              maxLength: 60,
              placeholder: t('dialog.titlePh'),
              onChange: (e) => setTitle(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              },
            }),
          ),
          h(
            'div',
            { className: 'ms-field' },
            h('label', { htmlFor: 'ms-content' }, t('dialog.content')),
            h('textarea', {
              id: 'ms-content',
              value: content,
              placeholder: t('dialog.contentPh'),
              onChange: (e) => setContent(e.target.value),
            }),
          ),
          h(
            'div',
            { className: 'ms-field' },
            h('label', { htmlFor: 'ms-tags' }, t('dialog.tags'), h('span', { className: 'ms-hintline' }, t('dialog.tagsHint'))),
            h('input', {
              id: 'ms-tags',
              value: tags,
              placeholder: '家人，秋天',
              onChange: (e) => setTags(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit();
              },
            }),
            h(
              'div',
              { className: 'ms-tagpreview' },
              parsed.map((tag) =>
                h('span', { key: tag, style: { color: (props.colorOf || colorForTag)(tag) } }, h('i', null), tag),
              ),
            ),
          ),
          h(
            'div',
            { className: 'ms-field' },
            h('label', null, t('dialog.importance'), h('span', { className: 'ms-hintline' }, t('dialog.importanceHint'))),
            h(
              'div',
              { className: 'ms-importance', role: 'radiogroup', 'aria-label': t('dialog.importance') },
              [1, 2, 3, 4, 5].map((n) =>
                h(
                  'button',
                  {
                    key: n,
                    type: 'button',
                    role: 'radio',
                    'aria-checked': importance === n,
                    className: importance === n ? 'on' : '',
                    onClick: () => setImportance(n),
                  },
                  String(n),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'ms-dialog-actions' },
            h('button', { type: 'button', className: 'ms-btn', onClick: props.onCancel }, t('dialog.cancel')),
            h(
              'button',
              { type: 'button', className: 'ms-btn ms-btn-primary', disabled: !canSave, onClick: submit },
              editing ? t('dialog.update') : t('dialog.save'),
            ),
          ),
        ),
      );
    }

    function ConfirmDialog(props) {
      const t = props.t;
      const kind = props.kind;
      const risky = kind === 'delete' || kind === 'clear';
      const title =
        kind === 'delete' ? t('confirm.deleteTitle') : kind === 'clear' ? t('confirm.clearTitle') : t('consolidate.title');
      const body =
        kind === 'delete' ? t('confirm.deleteBody') : kind === 'clear' ? t('confirm.clearBody') : t('consolidate.body');
      const action =
        kind === 'delete' ? t('confirm.delete') : kind === 'clear' ? t('confirm.clear') : t('confirm.consolidate');

      return h(
        'div',
        { className: 'ms-backdrop', onMouseDown: (e) => e.target === e.currentTarget && props.onCancel() },
        h(
          'div',
          { className: 'ms-dialog', role: 'alertdialog', 'aria-modal': true, 'aria-label': title },
          h('h3', null, title),
          body ? h('p', { style: { margin: 0, fontSize: 12.5, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)' } }, body) : null,
          h(
            'div',
            { className: 'ms-dialog-actions' },
            h('button', { type: 'button', className: 'ms-btn', onClick: props.onCancel }, t('confirm.cancel')),
            h(
              'button',
              {
                type: 'button',
                className: 'ms-btn ' + (risky ? 'ms-btn-danger' : 'ms-btn-primary'),
                onClick: props.onConfirm,
              },
              action,
            ),
          ),
        ),
      );
    }

    /* ------------------------------------------------------------------ *
     * Plugin entry
     * ------------------------------------------------------------------ */
    function apply(ctx) {
      let t = (key) => key;

      function activeLang() {
        try {
          const snap = ctx.locale.getLocale();
          const id = String((snap && (snap.active || snap.id)) || 'en').toLowerCase();
          return id.indexOf('zh') === 0 ? 'zh' : 'en';
        } catch (e) {
          return 'en';
        }
      }

      t = function (key, params) {
        const lang = activeLang();
        const dict = DICT[lang] || DICT.en;
        let s = dict[key] != null ? dict[key] : DICT.en[key] != null ? DICT.en[key] : key;
        if (params) {
          s = s.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
        }
        return s;
      };

      ctx.effect(() => {
        const disposers = [];
        try {
          disposers.push(ctx.locale.register(NS, 'zh-CN', DICT.zh));
        } catch (e) {}
        try {
          disposers.push(ctx.locale.register(NS, 'en-US', DICT.en));
        } catch (e) {}
        return () => {
          for (const d of disposers) {
            try {
              d();
            } catch (e) {}
          }
        };
      });

      const Icon = (props) => h(SidebarIcon, props);
      const Page = (props) => h(MemoryPage, Object.assign({}, props, { ctx: ctx, t: t }));

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 30,
            label: () => t('nav.label'),
          },
          Icon,
        ),
      );

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            order: 30,
          },
          Page,
        ),
      );
    }

    const api = { inject: ['slots', 'locale'], apply: apply };
    if (typeof globalThis !== 'undefined' && globalThis.__MEMORY_STARMAP_TEST__) {
      api.__internals = {
        retention,
        recallNode,
        consolidateNode,
        buildEdges,
        buildColorMap,
        ensureLayout,
        seedMemories,
        normalizeNode,
        baseStability,
        daysUntilFade,
        parseTags,
        colorForTag,
        MemoryPage,
        MemoryDialog,
        ConfirmDialog,
        SidebarIcon,
        DICT,
        CSS,
      };
    }
    return api;
  },
});
