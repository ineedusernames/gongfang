// 假后端：不碰 claude、不读你的会话，全是编的。看界面、改样式、截图用。
//   pnpm mock            → http://127.0.0.1:4800/?token=demo （先 pnpm build；钥匙随便填什么都行）
//   pnpm mock + pnpm dev → 前端热更新，开 http://localhost:5180 ，钥匙填 demo
// 发一句话会模拟一轮：想 → 读 → 改 → 编译 → 等你点头 → 收尾。话里带"选项"出选择题，带"方案"出方案。斜杠命令有几条假输出。
import { createServer } from 'http';
import { createReadStream, existsSync, statSync } from 'fs';
import { extname, join, normalize, sep, dirname } from 'path';
import { fileURLToPath } from 'url';

const PORT = +(process.env.PORT || 4800);
const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'dist');
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const json = (res, obj, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(obj)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const body = async req => { const parts = []; for await (const c of req) parts.push(c); try { return JSON.parse(Buffer.concat(parts).toString('utf8') || '{}'); } catch { return {}; } };

const M = 60e3, H = 60 * M, D = 24 * H;
const now0 = Date.now();
let seq = 1000, nid = 0;
const id = (p = 'i') => `${p}${++nid}`;
const MODEL = 'claude-opus-5-5';

// ---- 假截图（SVG） ----
function shotSvg(kind) {
  if (kind === 'dark') return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280"><rect width="720" height="1280" fill="#101114"/><rect x="48" y="120" width="624" height="300" rx="36" fill="#1b1d23"/><circle cx="150" cy="230" r="54" fill="#f2c94c"/><rect x="240" y="196" width="260" height="34" rx="17" fill="#2a2d35"/><rect x="240" y="250" width="180" height="22" rx="11" fill="#2a2d35"/><rect x="48" y="460" width="624" height="120" rx="28" fill="#1b1d23"/><rect x="48" y="610" width="624" height="120" rx="28" fill="#1b1d23"/></svg>`;
  if (kind === 'fixed') return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280"><rect width="720" height="1280" fill="#101114"/><rect x="48" y="120" width="624" height="300" rx="36" fill="#1b1d23"/><circle cx="150" cy="230" r="54" fill="#f2c94c"/><rect x="240" y="196" width="260" height="34" rx="17" fill="#e9e7e1"/><rect x="240" y="250" width="180" height="22" rx="11" fill="#9a9890"/><rect x="48" y="460" width="624" height="120" rx="28" fill="#1b1d23"/><rect x="88" y="500" width="300" height="22" rx="11" fill="#e9e7e1"/><rect x="48" y="610" width="624" height="120" rx="28" fill="#1b1d23"/><rect x="88" y="650" width="240" height="22" rx="11" fill="#e9e7e1"/></svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200"><defs><linearGradient id="p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5d6470"/><stop offset="1" stop-color="#2a2d33"/></linearGradient></defs><rect width="900" height="1200" fill="url(#p)"/><rect x="160" y="140" width="580" height="920" rx="60" fill="#101114" transform="rotate(-3 450 600)"/><rect x="200" y="240" width="500" height="240" rx="30" fill="#1b1d23" transform="rotate(-3 450 600)"/><circle cx="290" cy="330" r="44" fill="#f2c94c" transform="rotate(-3 450 600)"/></svg>`;
}
const IMG = {
  photo: { src: '/term/img/photo.svg', w: 900, h: 1200 },
  dark: { src: '/term/img/dark.svg', w: 720, h: 1280 },
  fixed: { src: '/term/img/fixed.svg', w: 720, h: 1280 },
};

// ---- 会话 ----
const HOME = '/home/demo/code';
const S = o => ({ live: false, busy: false, waiting: false, mode: 'manual', model: MODEL, stats: { edits: 0, adds: 0, dels: 0, cmds: 0, reads: 0, turns: 0 }, ...o, project: o.cwd.split('/').pop() });
const sessions = [
  S({ id: '11111111-1111-4111-8111-111111111111', root: 'r-weather', cwd: `${HOME}/weather-app`, title: '天气卡片深色模式下看不清', started: now0 - 5 * H, updated: now0 - 4 * M, live: true, stats: { edits: 6, adds: 84, dels: 21, cmds: 5, reads: 9, turns: 4 } }),
  S({ id: '11111111-1111-4111-8111-111111111112', root: 'r-weather', cwd: `${HOME}/weather-app`, title: '天气卡片深色模式下看不清', started: now0 - 6 * H, updated: now0 - 50 * M, stats: { edits: 5, adds: 70, dels: 18, cmds: 4, reads: 8, turns: 3 } }),
  S({ id: '22222222-2222-4222-8222-222222222222', cwd: `${HOME}/notes-site`, title: '笔记站点打包报错', started: now0 - 9 * H, updated: now0 - 40 * M, live: true, waiting: true, stats: { edits: 3, adds: 22, dels: 9, cmds: 6, reads: 12, turns: 3 } }),
  S({ id: '33333333-3333-4333-8333-333333333333', cwd: `${HOME}/blog`, title: '博客加一个 RSS', started: now0 - 26 * H, updated: now0 - 22 * H, live: true, waiting: true, stats: { edits: 1, adds: 12, dels: 0, cmds: 2, reads: 6, turns: 2 } }),
  S({ id: '44444444-4444-4444-8444-444444444444', cwd: `${HOME}/dotfiles`, title: '整理一下 shell 的别名', started: now0 - 3 * H, updated: now0 - 70 * M, pcBusy: true, stats: { edits: 2, adds: 14, dels: 3, cmds: 6, reads: 4, turns: 3 } }),
  S({ id: '55555555-5555-4555-8555-555555555555', cwd: `${HOME}/budget-sheet`, title: '月度账单的分类规则', started: now0 - 3 * D, updated: now0 - 3 * D + 2 * H, stats: { edits: 11, adds: 230, dels: 180, cmds: 2, reads: 40, turns: 6 } }),
  S({ id: '66666666-6666-4666-8666-666666666666', cwd: `${HOME}/weather-app`, title: '加一个逐小时的降水图', started: now0 - 4 * D, updated: now0 - 4 * D + 5 * H, stats: { edits: 21, adds: 540, dels: 210, cmds: 30, reads: 66, turns: 12 } }),
];

// ---- 记录 ----
let tt = now0 - 5 * H;
const at = (m = 1) => (tt += m * M);
const U = (text, images) => ({ k: 'user', id: id('u'), t: at(3), text, ...(images ? { images } : {}) });
const X = text => ({ k: 'text', id: id('x'), t: at(0.2), text });
const K = text => ({ k: 'think', id: id('k'), t: at(0.1), text });
const E = ms => ({ k: 'end', id: id('e'), t: at(0.1), ms, model: MODEL });
const tool = (name, input, result, state = 'ok') => ({ k: 'tool', id: id('toolu_'), t: at(0.2), name, input, state, ...(result ? { result } : {}) });
const hunk = (oldStart, newStart, lines) => ({ oldStart, newStart, oldLines: lines.filter(l => l[0] !== '+').length, newLines: lines.filter(l => l[0] !== '-').length, lines });
const W = `${HOME}/weather-app`;

const weather = [
  U('深色模式下天气卡片上的字几乎看不见，你看这张，手机拍的', [IMG.photo]),
  K('照片里卡片是深灰底，标题和温度也是深灰，对比度不够。先看卡片的样式是怎么取颜色的。'),
  X('看到了：卡片底色跟着深色模式变了，但上面的字还是写死的深灰。我先看一下样式。'),
  tool('Read', { file_path: `${W}/src/components/WeatherCard.svelte` }, { text: '<div class="card">\n  <h2>{city}</h2>\n  <p class="temp">{temp}°</p>\n</div>\n\n<style>\n  .card { background: var(--surface); }\n  h2, .temp { color: #333; }\n</style>', file: { path: `${W}/src/components/WeatherCard.svelte`, start: 1, lines: 9, total: 9 } }),
  tool('Grep', { pattern: '#333', path: `${W}/src` }, { text: 'src/components/WeatherCard.svelte:8\nsrc/components/HourlyRow.svelte:14' }),
  tool('Edit', { file_path: `${W}/src/components/WeatherCard.svelte`, old_string: '…', new_string: '…' }, { patch: [hunk(6, 6, ['   .card { background: var(--surface); }', '-  h2, .temp { color: #333; }', '+  h2, .temp { color: var(--text); }', '+  .temp { font-variant-numeric: tabular-nums; }'])] }),
  tool('Edit', { file_path: `${W}/src/components/HourlyRow.svelte`, old_string: '…', new_string: '…' }, { patch: [hunk(14, 14, ['-  .hour { color: #333; }', '+  .hour { color: var(--text-2); }'])] }),
  tool('Bash', { command: 'npm run build && npm run shot -- --dark', description: '打包并截一张深色模式的图' }, { text: '✓ built in 1.84s\nsaved shots/dark.png' }),
  tool('Read', { file_path: `${W}/shots/dark.png` }, { images: [IMG.fixed], file: { path: `${W}/shots/dark.png`, start: 1, lines: 1, total: 1 } }),
  X('改好了，截图在上面。\n\n**原因**：卡片底色用的是变量 `--surface`，会跟着深色模式变；但标题和温度写死成了 `#333`，深色底上就成了深灰配深灰。\n\n改了两个文件：\n- `WeatherCard.svelte`：字色换成 `var(--text)`\n- `HourlyRow.svelte`：逐小时那一行同样的问题，换成 `var(--text-2)`\n\n顺手给温度加了等宽数字，数字变化时不会左右跳。'),
  E(48000),
  U('好多了。逐小时那一行再淡一点？'),
  tool('Edit', { file_path: `${W}/src/app.css`, old_string: '…', new_string: '…' }, { patch: [hunk(31, 31, ['-  --text-2: #b8b6ae;', '+  --text-2: #8f8d86;'])] }),
  X('调淡了一档（`--text-2` 从 `#b8b6ae` 到 `#8f8d86`），浅色模式不受影响。'),
  E(12000),
  U('深色模式的那几个颜色变量贴给我看看？'),
  X('在 `src/app.css` 里，深色模式那一段：\n\n```css\n@media (prefers-color-scheme: dark) {\n  :root {\n    --surface: #1b1d23;\n    --text: #e9e7e1;\n    --text-2: #8f8d86;\n    --accent: #3a6cff;\n    --rule: rgba(233, 231, 225, 0.10);\n  }\n}\n```\n\n要在别的组件里用，直接写：\n\n```css\ncolor: var(--text-2);\n```'),
  E(9000),
];

const notes = [
  U('笔记站点 npm run build 报错，帮我看看'),
  tool('Bash', { command: 'npm run build 2>&1 | tail -8', description: '先跑一遍看报错' }, { text: 'error: Cannot find module \'./plugins/toc\'\n    at src/build.js:12:18', err: true }, 'err'),
  tool('Glob', { pattern: 'src/plugins/*' }, { text: 'src/plugins/footnote.js\nsrc/plugins/TOC.js' }),
  X('找到了：文件叫 `TOC.js`（大写），代码里引用的是 `./plugins/toc`。Windows 不分大小写所以本地没事，Linux 上的构建机就找不到了。我把文件名改成小写，再跑一遍。'),
  { k: 'ask', id: 'req-notes', t: now0 - 40 * M, tool: 'Bash', input: { command: 'git mv src/plugins/TOC.js src/plugins/toc.js && npm run build', description: '把文件名改成小写并重新打包' }, desc: '把文件名改成小写并重新打包', canAlways: true, state: 'wait' },
];

const blog = [
  U('博客想加一个 RSS'),
  tool('Read', { file_path: `${HOME}/blog/package.json` }, { text: '{\n  "name": "blog",\n  "scripts": { "build": "node build.js" }\n}', file: { path: `${HOME}/blog/package.json`, start: 1, lines: 4, total: 4 } }),
  X('可以，生成一个 `feed.xml` 就行。动手之前想先问几件事：'),
  { k: 'ask', id: 'req-blog', t: now0 - 22 * H, tool: 'AskUserQuestion', input: {}, state: 'wait', questions: [
    { question: 'RSS 里放全文还是摘要？', header: '内容', options: [{ label: '全文', description: '订阅的人在阅读器里就能看完' }, { label: '摘要', description: '只放前两段，点进来看全文' }] },
    { question: '要哪些格式？', header: '格式', multiSelect: true, options: [{ label: 'RSS 2.0', description: '最通用' }, { label: 'Atom', description: '更规范一点' }, { label: 'JSON Feed', description: '新一些的阅读器支持' }] },
    { question: '页面上订阅入口放哪？', header: '入口', options: [
      { label: '页脚', description: '不打扰，一行小字', preview: '┌──────────────────────┐\n│ …文章…               │\n│                      │\n│ ── RSS · GitHub ──   │\n└──────────────────────┘' },
      { label: '标题旁边', description: '一个小图标', preview: '┌──────────────────────┐\n│ 我的博客   ◎         │\n│ …文章…               │\n└──────────────────────┘' },
      { label: '不放', description: '只在 <head> 里声明，阅读器能自动找到' },
    ] },
  ] },
];

const small = title => [U(title), X('好，我看一下。'), tool('Read', { file_path: `${HOME}/README.md` }, { text: '…', file: { path: `${HOME}/README.md`, start: 1, lines: 40, total: 40 } }), tool('Edit', { file_path: `${HOME}/config.json`, old_string: '…', new_string: '…' }, { patch: [hunk(8, 8, ['   "theme": {', '-    "accent": "blue",', '+    "accent": "ink",', '   }'])] }), X('改好了。'), E(21000)];
const transcripts = { [sessions[0].id]: weather, [sessions[2].id]: notes, [sessions[3].id]: blog };
function itemsOf(sid) {
  if (!transcripts[sid]) { const s = sessions.find(x => x.id === sid); transcripts[sid] = small(s?.title || '看看'); }
  return transcripts[sid];
}

// ---- 事件流 ----
const clients = new Set();
function emit(ev) {
  ev.seq = ++seq;
  const line = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
}
const touch = (s, p) => { Object.assign(s, p, { updated: Date.now() }); emit({ type: 'session', session: s }); };
const push = (sid, item) => { itemsOf(sid).push(item); emit({ type: 'item', sid, item }); };
const patch = (sid, iid, p) => { const it = itemsOf(sid).find(x => x.id === iid); if (it) Object.assign(it, p); emit({ type: 'patch', sid, id: iid, patch: p }); };
const delta = (sid, iid, text) => { const it = itemsOf(sid).find(x => x.id === iid); if (it) it.text += text; emit({ type: 'delta', sid, id: iid, text }); };

// ---- 斜杠命令（形状和真后端 /term/commands 一样：你装的 skill 在前，cc 自带的 builtin） ----
const CMDS = [
  { name: 'handoff', desc: 'Compact the current conversation into a handoff document for another agent to pick up.', hint: 'What will the next session be used for?' },
  { name: 'grill-me', desc: 'A relentless interview to sharpen a plan or design.' },
  { name: 'compact', desc: 'Free up context by summarizing the conversation so far', hint: '<optional custom summarization instructions>', builtin: true },
  { name: 'context', desc: 'Show current context usage', builtin: true },
  { name: 'usage', desc: 'Show plan usage limits', builtin: true },
  { name: 'model', desc: 'Set the AI model for Claude Code', hint: '<model>', builtin: true },
  { name: 'effort', desc: 'Set effort level', hint: '<level>', builtin: true },
  { name: 'init', desc: 'Initialize a new CLAUDE.md file with codebase documentation', builtin: true },
  { name: 'code-review', desc: 'Review the current diff for correctness bugs', builtin: true },
  { name: 'simplify', desc: 'Review the changed code for reuse, simplification, efficiency', builtin: true },
  { name: 'rename', desc: 'Rename the current conversation', hint: '<name>', builtin: true },
  { name: 'doctor', desc: 'Diagnose and verify your Claude Code installation', builtin: true },
];
const CMD_OUT = {
  context: '## Context Usage\n\n**Model:** claude-opus-5-5  \n**Tokens:** 41.2k / 1m (4%)\n\n| Category | Tokens | Percentage |\n|---|---|---|\n| System prompt | 6.1k | 0.6% |\n| System tools | 14.8k | 1.5% |\n| Memory files | 9.4k | 0.9% |\n| Messages | 8.7k | 0.9% |\n| Free space | 958.8k | 95.9% |',
  usage: 'Current session: 12% used · resets 7:39pm\n\nCurrent week (all models): 38% used · resets Oct 9',
};

// ---- 模拟一轮 ----
const runs = new Map();   // sid → { stop, resolve? }
async function stream(sid, iid, text, run) {
  for (let i = 0; i < text.length;) {
    if (run.stop) return false;
    const n = 2 + Math.floor(Math.random() * 5);
    delta(sid, iid, text.slice(i, i + n)); i += n;
    await sleep(40 + Math.random() * 30);
  }
  return true;
}
async function simulateCmd(sid, msg) {
  const s = sessions.find(x => x.id === sid);
  const name = msg.trim().slice(1).split(/\s/)[0];
  touch(s, { live: true, busy: true });
  try {
    await sleep(600);
    if (CMD_OUT[name]) return push(sid, { k: 'out', id: id('o'), t: Date.now(), text: CMD_OUT[name] });
    const c = CMDS.find(x => x.name === name);
    if (!c || c.builtin) return push(sid, { k: 'out', id: id('o'), t: Date.now(), text: c ? `/${name} done.` : `Unknown command: /${name}`, ...(c ? {} : { tone: 'err' }) });
    const x = { k: 'text', id: id('x'), t: Date.now(), text: '' };
    push(sid, x);
    await stream(sid, x.id, `好，照 /${name} 来。先说说你想做什么？`, { stop: false });
    push(sid, { k: 'end', id: id('e'), t: Date.now(), ms: 2400, model: MODEL });
  } finally { touch(s, { busy: false }); }
}
async function simulate(sid, msg) {
  const s = sessions.find(x => x.id === sid);
  const cwd = s.cwd;
  const run = { stop: false };
  runs.set(sid, run);
  touch(s, { live: true, busy: true });
  const t0 = Date.now();
  const wantsQ = msg.includes('选项'), wantsPlan = msg.includes('方案');
  try {
    await sleep(500);
    const k = { k: 'think', id: id('k'), t: Date.now(), text: '' };
    push(sid, k);
    if (!await stream(sid, k.id, '要改的是：' + msg.slice(0, 20) + '。先看一眼相关的代码，再动手。', run)) return;
    const x = { k: 'text', id: id('x'), t: Date.now(), text: '' };
    push(sid, x);
    if (!await stream(sid, x.id, '好，我先看一下现在是怎么写的，改完打包一遍、截图给你。', run)) return;
    const r = tool('Read', { file_path: `${cwd}/src/app.css` }, null, 'run'); r.t = Date.now();
    push(sid, r); await sleep(500); if (run.stop) return;
    patch(sid, r.id, { state: 'ok', result: { text: '…', file: { path: `${cwd}/src/app.css`, start: 1, lines: 60, total: 212 } } });
    const ed = tool('Edit', { file_path: `${cwd}/src/app.css`, old_string: '…', new_string: '…' }, null, 'run'); ed.t = Date.now();
    push(sid, ed); await sleep(700); if (run.stop) return;
    patch(sid, ed.id, { state: 'ok', result: { patch: [hunk(40, 40, ['   .card {', '-    border-radius: 12px;', '+    border-radius: 18px;   /* 和输入框一样圆 */', '   }'])] } });
    const b = tool('Bash', { command: 'npm run build', description: '重新打包' }, null, 'run'); b.t = Date.now();
    push(sid, b); await sleep(1400); if (run.stop) return;
    patch(sid, b.id, { state: 'ok', result: { text: '✓ built in 1.9s' } });
    const ask = wantsPlan
      ? { k: 'ask', id: id('req-'), t: Date.now(), tool: 'ExitPlanMode', input: { plan: '## 卡片圆角统一\n\n1. `app.css` 里卡片圆角从 12 改到 18\n2. 列表项跟着改\n3. 打包、截图给你看\n\n**不动**：颜色、间距。' }, state: 'wait' }
      : wantsQ
      ? { k: 'ask', id: id('req-'), t: Date.now(), tool: 'AskUserQuestion', input: {}, state: 'wait', questions: [{ question: '圆角要多大？', header: '圆角', options: [{ label: '18', description: '和输入框一样' }, { label: '12', description: '保持原样' }, { label: '24', description: '更圆一点' }] }] }
      : { k: 'ask', id: id('req-'), t: Date.now(), tool: 'Bash', input: { command: 'npm run shot -- --dark', description: '截一张深色模式的图' }, desc: '截一张深色模式的图', canAlways: true, state: 'wait' };
    push(sid, ask);
    touch(s, { waiting: true });
    const ans = await new Promise(resolve => { run.resolve = resolve; });
    touch(s, { waiting: false });
    if (run.stop || !ans) return;
    patch(sid, ask.id, { state: ans.behavior, ...(ans.answers ? { answers: ans.answers } : {}) });
    if (ans.behavior === 'allow' && !wantsQ && !wantsPlan) {
      const sh = tool('Bash', ask.input, null, 'run'); sh.t = Date.now();
      push(sid, sh); await sleep(900); if (run.stop) return;
      patch(sid, sh.id, { state: 'ok', result: { text: 'saved shots/dark.png' } });
      const rd = tool('Read', { file_path: `${cwd}/shots/dark.png` }, null, 'run'); rd.t = Date.now();
      push(sid, rd); await sleep(500);
      patch(sid, rd.id, { state: 'ok', result: { images: [IMG.fixed], file: { path: `${cwd}/shots/dark.png`, start: 1, lines: 1, total: 1 } } });
    }
    const x2 = { k: 'text', id: id('x'), t: Date.now(), text: '' };
    push(sid, x2);
    const end = ans.behavior === 'deny' ? '好，那张先不截。改动已经打包好了，你打开看看？' : wantsQ ? `按你选的「${Object.values(ans.answers || {})[0] || ''}」来，已经改好了。` : '卡片圆角改成 18 了，截图在上面。';
    if (!await stream(sid, x2.id, end, run)) return;
    push(sid, { k: 'end', id: id('e'), t: Date.now(), ms: Date.now() - t0, model: MODEL });
  } finally {
    if (runs.get(sid) === run) runs.delete(sid);
    touch(s, { busy: false, waiting: false });
  }
}

// ---- 路由 ----
async function handleTerm(req, res, url) {
  const p = url.pathname;
  if (p === '/term/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...CORS });
    res.write(`: hi ${seq}\n\n`);
    clients.add(res);
    const ka = setInterval(() => res.write(': ka\n\n'), 25e3);
    req.on('close', () => { clients.delete(res); clearInterval(ka); });
    return;
  }
  let m;
  if ((m = p.match(/^\/term\/img\/(\w+)\.svg$/))) { res.writeHead(200, { 'Content-Type': 'image/svg+xml', ...CORS }); return res.end(shotSvg(m[1])); }
  if (p === '/term/sessions' && req.method === 'GET') return json(res, { sessions: [...sessions].sort((a, b) => b.updated - a.updated) });
  if (p === '/term/dirs') {
    const by = new Map();
    for (const s of sessions) { const d = by.get(s.cwd) || { cwd: s.cwd, project: s.project, updated: 0, count: 0 }; d.count++; d.updated = Math.max(d.updated, s.updated); by.set(s.cwd, d); }
    return json(res, { dirs: [...by.values()].sort((a, b) => b.updated - a.updated) });
  }
  if (p === '/term/commands') { await sleep(300); return json(res, { commands: CMDS }); }
  if (p === '/term/sessions' && req.method === 'POST') {
    const b = await body(req);
    const sid = crypto.randomUUID();
    const s = S({ id: sid, cwd: b.cwd || `${HOME}/new-project`, title: (b.text || '').slice(0, 40), started: Date.now(), updated: Date.now() });
    sessions.push(s); transcripts[sid] = [];
    json(res, { id: sid });
    emit({ type: 'session', session: s });
    setTimeout(() => { push(sid, { k: 'user', id: id('u'), t: Date.now(), text: b.text || '' }); void simulate(sid, b.text || ''); }, 150);
    return;
  }
  if ((m = p.match(/^\/term\/sessions\/([\w-]+)(\/\w+)?$/))) {
    const sid = m[1], act = m[2];
    const s = sessions.find(x => x.id === sid);
    if (!s) return json(res, { error: 'not found' }, 404);
    if (!act && req.method === 'GET') {
      const all = itemsOf(sid);
      const limit = +(url.searchParams.get('limit') || 300);
      const before = url.searchParams.has('before') ? +url.searchParams.get('before') : all.length;
      const from = Math.max(0, before - limit);
      return json(res, { session: s, items: all.slice(from, before), before: from > 0 ? from : null, seq });
    }
    const b = await body(req);
    if (act === '/send') {
      json(res, { ok: true });
      setTimeout(() => {
        push(sid, { k: 'user', id: id('u'), t: Date.now(), text: b.text || '', ...(b.images?.length ? { images: [IMG.photo] } : {}) });
        if (!runs.has(sid)) void ((b.text || '').trim().startsWith('/') ? simulateCmd : simulate)(sid, b.text || '');
      }, 150);
      return;
    }
    if (act === '/answer') {
      const r = runs.get(sid);
      if (r?.resolve) { r.resolve(b); r.resolve = undefined; }
      else {   // 列表里本来就在等的那几个（不是模拟出来的）：直接改状态
        const it = itemsOf(sid).find(x => x.id === b.req);
        if (it) { patch(sid, it.id, { state: b.behavior, ...(b.answers ? { answers: b.answers } : {}) }); touch(s, { waiting: false }); }
      }
      return json(res, { ok: true });
    }
    if (act === '/interrupt') {
      const r = runs.get(sid);
      if (r) { r.stop = true; r.resolve?.(null); }
      for (const it of itemsOf(sid)) if (it.k === 'ask' && it.state === 'wait') patch(sid, it.id, { state: 'gone' });
      for (const it of itemsOf(sid)) if (it.k === 'tool' && it.state === 'run') patch(sid, it.id, { state: 'err', result: { err: true, text: '被停下了' } });
      push(sid, { k: 'note', id: id('n'), t: Date.now(), text: '已中断' });
      touch(s, { busy: false, waiting: false });
      return json(res, { ok: true });
    }
    if (act === '/close') { touch(s, { live: false, busy: false, waiting: false }); return json(res, { ok: true }); }
  }
  json(res, { error: 'not found' }, 404);
}

function serveStatic(res, pathname) {
  if (!existsSync(join(DIST, 'index.html'))) { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('先 pnpm build'); }
  let rel; try { rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, ''); } catch { rel = ''; }
  let file = join(DIST, rel);
  if (!file.startsWith(DIST + sep) || !existsSync(file) || !statSync(file).isFile()) file = join(DIST, 'index.html');
  const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }[extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (url.pathname === '/health') return json(res, { ok: true, app: 'gongfang-mock' });
  if (url.pathname === '/api/hello') return json(res, { ok: true, version: 'mock', models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }] });
  if (url.pathname.startsWith('/term/')) return handleTerm(req, res, url);
  serveStatic(res, url.pathname);
}).listen(PORT, () => console.log(`假后端：http://127.0.0.1:${PORT}/?token=demo`));
