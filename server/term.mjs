/**
 * 工坊的后端：手机上看、接着用本机的 Claude Code 会话，像官方 Remote Control，但跑在自己电脑上。
 * 数据形状见 web/src/lib/term.ts（前端、假后端、这里三方共用），接口表也在那里。
 *
 * - 索引：扫 ~/.claude/projects/<目录>/<id>.jsonl（只要顶层，子文件夹是子代理日志），按 路径+mtime+大小 缓存到
 *   data/term-index.json；文件只会往后追加，变长了就只读新增的那截。
 * - 记录：jsonl → TermItem[]。工具结果按 tool_use_id 挂回工具；图写一份到 data/term-img/<sha1>.<ext>。
 * - 活会话：每个会话一个常驻的 `claude -p --input-format stream-json` 进程，一轮一行 user 消息；权限请求走
 *   stdio 的 control_request，由手机回。stream-json 归一成 item / patch / delta / session 事件，从 /term/events 推出去。
 *
 * 隐私（硬规矩）：config.hide 里的目录、和临时目录（hide_temp）里起头的会话哪里都不出现——列表、记录、
 * 新开会话的目录、图，目录名和 cwd 两道都查，内容一个字都不读。
 */
import { spawn } from 'child_process';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { CFG, CLAUDE_EXE, DATA_DIR, EFFORTS } from './config.mjs';

// ---- 路径、上限 ----
export const termOpts = {
  projects: join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects'),
  indexFile: join(DATA_DIR, 'term-index.json'),
  ownedFile: join(DATA_DIR, 'term-owned.json'),
  imgDir: join(DATA_DIR, 'term-img'),
  allow: [],   // 测试用：临时目录下放行的前缀（正斜杠）。config.hide 里的永远不放行
};
const CUT = 16000;            // 大字段截断
const TEXT_CAP = 64000;       // 你 / cc 说的话再长也就到这
const OUT_CAP = 12000;        // 斜杠命令的输出（/context 那张表）
const MAX_LIVE = Math.max(1, +CFG.max_live || 4);              // 同时挂着的进程
const IDLE_MS = Math.max(1, +CFG.idle_minutes || 20) * 60e3;   // 没事干多久就关
const PC_BUSY_MS = 2 * 60e3;  // 不是我们的进程、2 分钟内有人写 = 电脑上开着
const MAX_IMAGES = 4, MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// ---- 隐藏目录 / 临时目录 ----
const fwd = p => String(p || '').replace(/\\/g, '/');
const norm = p => fwd(p).replace(/\/+$/, '').toLowerCase();
const under = (p, root) => { const a = norm(p), b = norm(root); return !!b && (a === b || a.startsWith(b + '/')); };
const encodeCwd = p => String(p).replace(/[^a-zA-Z0-9]/g, '-');   // cc 自己的目录名规则
const trimSlash = p => fwd(p).replace(/[/]+$/, '');
const HIDE = (Array.isArray(CFG.hide) ? CFG.hide : []).map(trimSlash).filter(Boolean);
const HIDE_DIRS = HIDE.map(encodeCwd);
const TMP_ROOTS = CFG.hide_temp === false ? [] : [...new Set([tmpdir(), process.env.TEMP, process.env.TMP].filter(Boolean).map(fwd))];
const allowed = p => termOpts.allow.some(a => under(p, a));
const isPrivCwd = p => HIDE.some(h => under(p, h));
const isTmpCwd = p => !allowed(p) && TMP_ROOTS.some(t => under(p, t));
function dirHidden(name) {
  if (HIDE_DIRS.some(d => name === d || name.startsWith(d + '-'))) return true;
  if (termOpts.allow.some(a => name.startsWith(encodeCwd(a.replace(/\/+$/, ''))))) return false;
  return TMP_ROOTS.some(t => { const e = encodeCwd(t.replace(/\/+$/, '')); return name === e || name.startsWith(e + '-'); });
}
const project = cwd => fwd(cwd).replace(/\/+$/, '').split('/').pop() || cwd;

// ---- 小工具 ----
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const json = (res, data, status = 200) => { if (res.headersSent) return; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(data)); };
const readBody = req => new Promise(r => { const parts = []; req.on('data', c => parts.push(c)); req.on('end', () => r(Buffer.concat(parts).toString('utf8'))); });
const parseJson = async req => { try { const b = await readBody(req); return b ? JSON.parse(b) : {}; } catch { return {}; } };
const ts = s => { const n = Date.parse(s); return Number.isFinite(n) ? n : 0; };
const cap = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
function cutInput(v, d = 0) {
  if (typeof v === 'string') return cap(v, CUT);
  if (d > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(x => cutInput(x, d + 1));
  const o = {}; for (const k of Object.keys(v)) o[k] = cutInput(v[k], d + 1); return o;
}
// auto = cc 自己判断（分类器）：稳妥的直接做，有风险的才问
const fromCliMode = m => (m === 'default' || m === 'manual' ? 'manual' : m === 'acceptEdits' || m === 'plan' || m === 'auto' ? m : undefined);

/** 逐行读 jsonl（从字节 start 开始），返回最后一个完整行之后的字节位置。超大行（带图的工具结果）不反复拼接 */
async function eachLine(file, start, fn) {
  let parts = [], partsLen = 0, total = 0;
  const handle = buf => { const s = buf.toString('utf8'); if (!s.trim()) return; let j; try { j = JSON.parse(s); } catch { return; } fn(j); };
  for await (const chunk of createReadStream(file, { start, highWaterMark: 1 << 20 })) {
    let from = 0, i;
    while ((i = chunk.indexOf(10, from)) >= 0) {
      let b = chunk.subarray(from, i);
      if (parts.length) { parts.push(b); b = Buffer.concat(parts); parts = []; partsLen = 0; }
      handle(b);
      from = i + 1;
    }
    if (from < chunk.length) { parts.push(chunk.subarray(from)); partsLen += chunk.length - from; }
    total += chunk.length;
  }
  return { off: start + total - partsLen, tail: parts.length ? Buffer.concat(parts) : null };
}

// ============================================================
//  图：按内容哈希存一份，永久缓存
// ============================================================
const IMG_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
function sniff(buf) {
  if (buf[0] === 0xFF && buf[1] === 0xD8) return 'jpg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (buf.subarray(0, 3).toString('latin1') === 'GIF') return 'gif';
  return null;
}
function imgSize(buf, ext) {
  try {
    if (ext === 'png') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (ext === 'gif') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (ext === 'webp') {
      const k = buf.subarray(12, 16).toString('latin1');
      if (k === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (k === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3FFF, h: buf.readUInt16LE(28) & 0x3FFF };
      if (k === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3FFF) + 1, h: ((b >> 14) & 0x3FFF) + 1 }; }
    }
    if (ext === 'jpg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xFF) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return {};
}
const knownImg = new Set();
/** base64 → { src, w, h }（认不出是图就 null） */
function saveImg(b64, dims) {
  if (typeof b64 !== 'string' || !b64) return null;
  const buf = Buffer.from(b64, 'base64');
  const ext = sniff(buf); if (!ext) return null;
  const name = createHash('sha1').update(buf).digest('hex') + '.' + ext;
  if (!knownImg.has(name)) {
    if (!existsSync(termOpts.imgDir)) mkdirSync(termOpts.imgDir, { recursive: true });
    const f = join(termOpts.imgDir, name);
    if (!existsSync(f)) writeFileSync(f, buf);
    knownImg.add(name);
  }
  const { w, h } = dims?.w ? dims : imgSize(buf, ext);
  return { src: '/term/img/' + name, ...(w ? { w, h } : {}), ext, buf };
}
const imgOut = i => (i ? { src: i.src, ...(i.w ? { w: i.w, h: i.h } : {}) } : null);

// ============================================================
//  条目解析（索引和记录共用）
// ============================================================
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const CMD_TOOLS = new Set(['Bash', 'PowerShell']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const SKIP = { skip: true };
const tagText = (s, tag) => { const m = s.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)); return m ? m[1].trim() : ''; };

/** 不是你说的话的 user 文本（斜杠命令、命令输出、任务通知、中断……）→ note / SKIP；是你说的话 → null。
 *  斜杠命令本身 cmd = true（排成你说的一句话），命令的输出 out = true（排成一张输出卡片） */
function noteFor(text) {
  const s = text.trimStart();
  if (s.startsWith('[Request interrupted')) return { text: '已中断', tone: 'info' };
  if (!s.startsWith('<')) return null;
  if (s.startsWith('<command-name>') || s.startsWith('<command-message>')) {
    const name = tagText(s, 'command-name') || '/' + tagText(s, 'command-message');
    const args = tagText(s, 'command-args');
    return { text: (name + (args ? ' ' + args : '')).trim(), boundary: true, cmd: true };
  }
  if (s.startsWith('<local-command-stdout>') || s.startsWith('<local-command-stderr>')) {
    const err = s.startsWith('<local-command-stderr>');
    const out = tagText(s, err ? 'local-command-stderr' : 'local-command-stdout').replace(/\x1b\[[0-9;]*m/g, '').trim();
    return out ? { text: cap(out, OUT_CAP), out: true, ...(err ? { tone: 'err' } : {}) } : SKIP;
  }
  if (s.startsWith('<task-notification>')) {
    const st = tagText(s, 'status');
    return { id: 'task-' + tagText(s, 'task-id'), text: tagText(s, 'summary') || ('后台任务 ' + st), tone: st === 'failed' ? 'err' : 'info', boundary: true };
  }
  if (s.startsWith('<bash-input>')) return { text: '! ' + tagText(s, 'bash-input'), boundary: true };
  if (s.startsWith('<bash-stdout>') || s.startsWith('<bash-stderr>')) {
    const out = [tagText(s, 'bash-stdout'), tagText(s, 'bash-stderr')].filter(Boolean).join('\n');
    return out ? { text: cap(out, 4000) } : SKIP;
  }
  if (/^<(local-command-caveat|system-reminder|user-prompt-submit-hook)>/.test(s)) return SKIP;
  return null;
}

/** user 消息的内容 → 文字 + 图（图要不要落盘由 withImages 决定：索引不落） */
function userContent(c, withImages) {
  if (typeof c === 'string') return { text: c, images: [] };
  const texts = [], images = [];
  if (Array.isArray(c)) for (const b of c) {
    if (b?.type === 'text' && b.text) texts.push(b.text);
    else if (b?.type === 'image' && withImages && b.source?.type === 'base64') { const i = imgOut(saveImg(b.source.data)); if (i) images.push(i); }
  }
  return { text: texts.join('\n'), images };
}

function countPatch(p) { let a = 0, d = 0; for (const h of p || []) for (const l of h.lines || []) { if (l[0] === '+') a++; else if (l[0] === '-') d++; } return [a, d]; }
function createdLines(content) { const ls = String(content).split('\n'); if (ls.length && ls[ls.length - 1] === '') ls.pop(); return ls; }

/** structuredPatch 截一截：总行数、单行长度都有上限 */
function cutPatch(hunks) {
  let n = 0, cut = false;
  const out = [];
  for (const h of hunks) {
    if (n >= 3000) { cut = true; break; }
    const src = (h.lines || []).filter(l => l[0] !== '\\');   // "\ No newline at end of file" 不算一行
    const lines = src.slice(0, 3000 - n).map(l => (l.length > 2000 ? (cut = true, l.slice(0, 2000)) : l));
    if (lines.length < src.length) cut = true;
    n += lines.length;
    out.push({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines });
  }
  return { patch: out, cut };
}

/** 一个 tool_result 块（+ 条目上的 toolUseResult）→ { state, result } */
function toolResult(b, tur, denied) {
  const r = {};
  let text = '';
  const images = [];
  if (typeof b.content === 'string') text = b.content;
  else if (Array.isArray(b.content)) {
    const ts_ = [];
    for (const x of b.content) {
      if (x?.type === 'text' && x.text) ts_.push(x.text);
      else if (x?.type === 'image' && x.source?.type === 'base64') { const i = imgOut(saveImg(x.source.data)); if (i) images.push(i); }
      else if (x?.type === 'tool_reference' && x.tool_name) ts_.push(x.tool_name);
    }
    text = ts_.join('\n');
  }
  if (tur && typeof tur === 'object' && !Array.isArray(tur)) {
    if (tur.type === 'text' && tur.file) {   // Read：正文用原文（不带行号），行号从 file.start 起
      if (typeof tur.file.content === 'string') text = tur.file.content;
      r.file = { path: fwd(tur.file.filePath), start: tur.file.startLine || 1, lines: tur.file.numLines || 0, total: tur.file.totalLines || 0 };
    }
    if (tur.type === 'image' && tur.file?.dimensions && images.length === 1) {
      const d = tur.file.dimensions; images[0] = { ...images[0], w: d.displayWidth || d.originalWidth, h: d.displayHeight || d.originalHeight };
    }
    if (Array.isArray(tur.structuredPatch) && tur.structuredPatch.length) { const p = cutPatch(tur.structuredPatch); r.patch = p.patch; if (p.cut) r.cut = true; }
    if (tur.type === 'create') {
      r.created = true;
      if (!r.patch && typeof tur.content === 'string') {   // 新建的文件：整份当成 + 行
        const ls = createdLines(tur.content);
        const p = cutPatch([{ oldStart: 0, oldLines: 0, newStart: 1, newLines: ls.length, lines: ls.map(l => '+' + l) }]);
        r.patch = p.patch; if (p.cut) r.cut = true;
      }
    }
    if (tur.backgroundTaskId) r.bgId = String(tur.backgroundTaskId);
  }
  if (text) { if (text.length > CUT) { r.text = text.slice(0, CUT); r.cut = true; } else r.text = text; }
  if (images.length) r.images = images;
  if (b.is_error) r.err = true;
  if (tur === 'User rejected tool use') denied = true;
  return { state: denied ? 'denied' : b.is_error ? 'err' : 'ok', result: r };
}

// ============================================================
//  索引：一份会话一条 meta，data/term-index.json
// ============================================================
const IDX_V = 1;   // meta.root = 第一条消息的 uuid：分叉出来的会话和原会话一样，前端按它把一家子并成一张卡片
let IDX = null;            // { v, files: { [path]: { size, mtime, off, priv?, tmp?, m? } } }
let scanning = null, saveTimer = null;
function loadIdx() {
  if (IDX) return IDX;
  try {
    IDX = JSON.parse(readFileSync(termOpts.indexFile, 'utf8'));
    if (!IDX.files || IDX.v !== IDX_V) throw 0;
    // 隐藏名单可能改过：上次记成 priv 的不一定还藏，丢掉重读（反过来新藏的，visible() 里还会按 cwd 再拦一道）
    for (const [p, e] of Object.entries(IDX.files)) if (e.priv) delete IDX.files[p];
  }
  catch { IDX = { v: IDX_V, files: {} }; }
  return IDX;
}
function saveIdxSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { writeFileSync(termOpts.indexFile, JSON.stringify(IDX)); } catch (e) { console.error('[term] index save', e.message); } }, 1500);
  saveTimer.unref?.();
}
const newMeta = id => ({ id, root: '', cwd: '', n: 0, first: '', ai: '', custom: '', started: 0, updated: 0, model: '', mode: '', stats: { edits: 0, adds: 0, dels: 0, cmds: 0, reads: 0, turns: 0 }, costAdds: 0, costDels: 0 });

/** 把一条 jsonl 条目并进 meta。返回 'priv' / 'tmp' 表示这份会话不能出现 */
function metaEntry(m, j) {
  if (j.isSidechain) return;
  // 只看会话起头的目录：中途 cd 进隐藏目录不算（不然整份会话会莫名其妙消失）
  if (j.cwd && !m.cwd) {
    if (isPrivCwd(j.cwd)) return 'priv';
    m.cwd = fwd(j.cwd); if (isTmpCwd(m.cwd)) return 'tmp';
  }
  const t = ts(j.timestamp);
  if (t) { if (!m.started) m.started = t; if (t > m.updated) m.updated = t; }
  // --fork-session 分出来的文件把原会话的条目原样抄过去（uuid 不变），所以第一条消息的 uuid 就是"同一家"的记号
  if (!m.root && j.uuid && (j.type === 'user' || j.type === 'assistant')) m.root = j.uuid;
  switch (j.type) {
    case 'ai-title': if (j.aiTitle) m.ai = String(j.aiTitle); break;
    case 'custom-title': if (j.customTitle) m.custom = String(j.customTitle); break;
    case 'permission-mode': if (j.permissionMode) m.mode = j.permissionMode; break;
    case 'cost-state': m.costAdds = Math.max(m.costAdds, j.totalLinesAdded || 0); m.costDels = Math.max(m.costDels, j.totalLinesRemoved || 0); break;
    case 'assistant': {
      m.n++;
      const mm = j.message?.model; if (mm && mm !== '<synthetic>') m.model = mm;
      for (const b of j.message?.content || []) if (b?.type === 'tool_use') {
        if (EDIT_TOOLS.has(b.name)) m.stats.edits++; else if (CMD_TOOLS.has(b.name)) m.stats.cmds++; else if (READ_TOOLS.has(b.name)) m.stats.reads++;
      }
      break;
    }
    case 'attachment':
      if (j.attachment?.type === 'queued_command') { m.n++; m.stats.turns++; if (!m.first) m.first = firstOf(userContent(j.attachment.prompt).text); }
      break;
    case 'user': {
      m.n++;
      if (j.permissionMode) m.mode = j.permissionMode;
      const r = j.toolUseResult;
      if (r && typeof r === 'object') {
        if (Array.isArray(r.structuredPatch) && r.structuredPatch.length) { const [a, d] = countPatch(r.structuredPatch); m.stats.adds += a; m.stats.dels += d; }
        else if (r.type === 'create' && typeof r.content === 'string') m.stats.adds += createdLines(r.content).length;
      }
      if (j.isMeta || j.isCompactSummary || j.isVisibleInTranscriptOnly) break;
      const c = j.message?.content;
      if (Array.isArray(c) && c.some(b => b?.type === 'tool_result')) break;
      const { text } = userContent(c);
      if (!text.trim() || noteFor(text)) break;
      m.stats.turns++;
      if (!m.first) m.first = firstOf(text);
      break;
    }
  }
}
const firstOf = s => [...String(s).replace(/\s+/g, ' ').trim()].slice(0, 40).join('');

/** 读一份文件进索引（变长了只读新增的） */
async function indexFile(path, st) {
  const idx = loadIdx();
  let e = idx.files[path];
  if (e && e.size === st.size && e.mtime === st.mtimeMs) return false;
  if (e?.priv) { e.size = st.size; e.mtime = st.mtimeMs; return true; }  // 隐藏目录的会话：永远不读内容
  const id = path.replace(/\\/g, '/').split('/').pop().replace(/\.jsonl$/, '');
  let start = 0;
  if (e && !e.tmp && e.m && st.size >= e.off && st.mtimeMs >= e.mtime) start = e.off;
  else e = null;
  let verdict = null;
  const m = e ? structuredClone(e.m) : newMeta(id);   // 读一半出错不会把计数记两遍
  const { off } = await eachLine(path, start, j => { if (!verdict) verdict = metaEntry(m, j) || null; });
  idx.files[path] = verdict === 'priv' ? { size: st.size, mtime: st.mtimeMs, off, priv: true }
    : verdict === 'tmp' ? { size: st.size, mtime: st.mtimeMs, off, tmp: true }
    : { size: st.size, mtime: st.mtimeMs, off, m };
  return true;
}

/** 扫一遍所有会话（并发调用共用一次） */
function scan() {
  if (scanning) return scanning;
  scanning = (async () => {
    const idx = loadIdx();
    const seen = new Set();
    let changed = false;
    let dirs = [];
    try { dirs = readdirSync(termOpts.projects, { withFileTypes: true }).filter(d => d.isDirectory() && !dirHidden(d.name)); } catch {}
    for (const d of dirs) {
      const dp = join(termOpts.projects, d.name);
      let files = [];
      try { files = readdirSync(dp, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const p = join(dp, f.name);
        seen.add(p);
        try { if (await indexFile(p, statSync(p))) changed = true; } catch (e) { console.error('[term] index', e.message); }
      }
    }
    for (const p of Object.keys(idx.files)) if (!seen.has(p)) { delete idx.files[p]; changed = true; }
    if (changed) saveIdxSoon();
  })().finally(() => { scanning = null; });
  return scanning;
}
/** 只刷新一份（活会话每轮结束时） */
async function refreshOne(path) {
  if (!path || !existsSync(path)) return false;
  try { if (await indexFile(path, statSync(path))) { saveIdxSoon(); return true; } } catch {}
  return false;
}

/** 看得见的会话：[{ path, e }]（不含隐藏的、临时的、空的、没有 cwd 的） */
function visible() {
  const out = [];
  for (const [path, e] of Object.entries(loadIdx().files)) {
    if (e.priv || e.tmp || !e.m || !e.m.cwd || !e.m.n) continue;
    if (isPrivCwd(e.m.cwd) || isTmpCwd(e.m.cwd)) continue;
    out.push({ path, e });
  }
  return out;
}
function findVisible(id) { return visible().find(x => x.e.m.id === id) || null; }

// ============================================================
//  活会话：进程、事件
// ============================================================
const live = new Map();       // sid → L
const ownedAt = new Map();    // sid → 我们的进程最后一次退出的时间（别把自己刚写的当成"电脑上开着"）
// ownedAt 落一份到 data/term-owned.json：后端重启时挂着的进程跟着没了、onExit 来不及记，
// 不落盘的话重启后 2 分钟内在工坊里接着说，会被当成"电脑上开着"又分出一版。
// 文件里 'live' = 重启那一刻还挂着的，读回来按"刚退出"算
let ownedLoaded = false;
function loadOwned() {
  if (ownedLoaded) return;
  ownedLoaded = true;
  try {
    const o = JSON.parse(readFileSync(termOpts.ownedFile, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(o)) if (!ownedAt.has(k)) ownedAt.set(k, v === 'live' ? now : +v || 0);
  } catch { /* 没有就算了 */ }
}
function saveOwned() {
  const o = {};
  const now = Date.now();
  for (const [k, v] of ownedAt) if (now - v < 10 * 60e3) o[k] = v;   // 只留十分钟内的
  for (const k of live.keys()) o[k] = 'live';
  try { writeFileSync(termOpts.ownedFile, JSON.stringify(o)); } catch { /* 写不了不影响用 */ }
}
const clients = new Set();
let SEQ = 0;

function emit(ev) {
  ev.seq = ++SEQ;
  const s = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) if (!res.writableEnded) res.write(s);
}
function pcBusyOf(sid, e) {
  loadOwned();
  if (live.has(sid) || !e) return false;
  if (Date.now() - e.mtime >= PC_BUSY_MS) return false;
  const o = ownedAt.get(sid);
  return !(o && e.mtime <= o + 3000);
}
/** ghost = 刚退出的进程：文件还没落（刚开就挂了）时拿它补 cwd / 标题，好把 live=false 告诉前端 */
function sessionOut(sid, ghost) {
  const L = live.get(sid);
  const hit = findVisible(sid);
  const m = hit?.e.m;
  const src = L || ghost;
  if (!m && !src) return null;
  const cwd = m?.cwd || src.cwd;
  const s = {
    id: sid, cwd, project: project(cwd),
    title: m?.custom || m?.ai || m?.first || src?.title || project(cwd),
    started: m?.started || src?.started || 0,
    updated: Math.max(m?.updated || 0, src?.lastActive || 0),
    live: !!L, busy: !!L?.busy, waiting: !!L?.asks.size,
    stats: m ? { ...m.stats, ...(!m.stats.adds && !m.stats.dels ? { adds: m.costAdds, dels: m.costDels } : {}) } : { edits: 0, adds: 0, dels: 0, cmds: 0, reads: 0, turns: src?.turns || 0 },
  };
  if (!L && hit && pcBusyOf(sid, hit.e)) s.pcBusy = true;
  const root = m?.root || src?.root; if (root) s.root = root;
  const model = L?.model || m?.model || ghost?.model; if (model) s.model = model;
  const mode = L ? L.mode : fromCliMode(m?.mode) || ghost?.mode; if (mode) s.mode = mode;
  return s;
}
const emitSession = (sid, ghost) => { const session = sessionOut(sid, ghost); if (session) emit({ type: 'session', session }); };

function addItem(L, it) {
  if (L.byId.has(it.id)) return;
  L.byId.set(it.id, it); L.items.push(it);
  if (L.items.length > 1500) { const old = L.items.splice(0, 300); for (const o of old) L.byId.delete(o.id); }
  emit({ type: 'item', sid: L.sid, item: it });
}
function patchItem(L, id, patch) {
  const it = L.byId.get(id); if (!it) return;
  Object.assign(it, patch);
  emit({ type: 'patch', sid: L.sid, id, patch });
}
function write(L, obj) { try { L.proc.stdin.write(JSON.stringify(obj) + '\n'); } catch {} }
function ctl(L, request, ms = 8000) {
  const id = randomUUID();
  return new Promise(res => {
    const timer = setTimeout(() => { L.pending.delete(id); res(null); }, ms);
    L.pending.set(id, r => { clearTimeout(timer); res(r); });
    write(L, { type: 'control_request', request_id: id, request });
  });
}
// 整棵杀：cc 起的命令（dev server 之类）一起走。Windows 用 taskkill /T；别的系统起进程时 detached = 自成一个进程组，杀整组
const WIN = process.platform === 'win32';
function treeKill(pid) {
  if (!pid) return;
  if (WIN) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
  else { try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch {} } }
}

function startLive({ sid, cwd, model, effort, mode, resume, fork, file, parentFile, title, root }) {
  const alive = [...live.values()].filter(x => !x.closing);
  if (alive.length >= MAX_LIVE) {
    const idle = alive.filter(x => !x.busy && !x.asks.size).sort((a, b) => a.lastActive - b.lastActive)[0];
    if (!idle) throw Object.assign(new Error(`已经有 ${MAX_LIVE} 个会话在跑，先关掉一个`), { status: 429 });
    closeLive(idle);
  }
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-prompts', 'host', '--permission-prompt-tool', 'stdio',
    '--permission-mode', mode,
    '--thinking-display', CFG.claude?.thinking_display || 'summarized'];   // 不加的话 -p 里的思考是空壳
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (resume) { args.push('--resume', resume); if (fork) args.push('--fork-session', '--session-id', sid); }
  else args.push('--session-id', sid);
  const proc = spawn(CLAUDE_EXE, args, { cwd, env: { ...process.env }, windowsHide: true, detached: !WIN });
  const L = {
    sid, cwd: fwd(cwd), proc, title: title || '', root: root || '', started: Date.now(), lastActive: Date.now(),
    reqModel: model || '', reqEffort: effort || '', reqMode: mode, model: '', mode: fromCliMode(mode),
    busy: false, closing: false, interrupting: false, turns: 0,
    items: [], byId: new Map(), asks: new Map(), denied: new Set(), pending: new Map(), bg: new Set(),
    msgId: '', blockIdx: -1, ord: new Map(), turnAsst: '', file, parentFile, stderr: '', buf: '',
  };
  live.set(sid, L);
  saveOwned();
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', d => {
    L.buf += d;
    let i;
    while ((i = L.buf.indexOf('\n')) >= 0) {
      const line = L.buf.slice(0, i); L.buf = L.buf.slice(i + 1);
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      try { onLine(L, j); } catch (e) { console.error('[term] line', e); }
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', d => { L.stderr = (L.stderr + d).slice(-2000); });
  proc.stdin.on('error', () => {});
  proc.on('error', e => { L.stderr += '\n' + e.message; onExit(L, null); });
  proc.on('close', code => onExit(L, code));
  return L;
}

function onExit(L, code) {
  if (L.exited) return;
  L.exited = true;
  if (live.get(L.sid) === L) live.delete(L.sid);
  ownedAt.set(L.sid, Date.now());
  saveOwned();
  for (const [id] of L.asks) patchItem(L, id, { state: 'gone' });
  L.asks.clear();
  for (const it of L.items) if (it.k === 'tool' && it.state === 'run' && !it.result?.bgId) patchItem(L, it.id, { state: 'err' });
  for (const [, r] of L.pending) r(null);
  if (!L.closing) {
    const why = L.stderr.trim().split('\n').filter(Boolean).pop() || '';
    addItem(L, { k: 'note', id: 'exit-' + randomUUID(), t: Date.now(), tone: 'err', text: `cc 进程退出了（${code ?? '起不来'}）${why ? '：' + cap(why, 300) : ''}` });
  }
  L.busy = false;
  refreshOne(L.file || locate(L.sid, L.cwd)).finally(() => emitSession(L.sid, L));
}

function closeLive(L) {
  if (L.exited || L.closing) return;
  L.closing = true;
  if (L.busy) return treeKill(L.proc.pid);
  try { L.proc.stdin.end(); } catch {}
  setTimeout(() => { if (!L.exited) treeKill(L.proc.pid); }, 3000).unref?.();
}

// 没事干的进程 20 分钟后关掉（它起的后台命令还在跑就先不关，关了命令也跟着没了）
setInterval(() => {
  const now = Date.now();
  for (const L of live.values()) if (!L.busy && !L.asks.size && !L.bg.size && now - L.lastActive > IDLE_MS) closeLive(L);
}, 60e3).unref?.();

/** 会话文件在哪：索引里有就用；没有就按 cc 的目录名规则猜，猜不中挨个目录找 */
function locate(sid, cwd) {
  const hit = findVisible(sid); if (hit) return hit.path;
  if (cwd) { const p = join(termOpts.projects, encodeCwd(fwd(cwd).replace(/\/+$/, '')), sid + '.jsonl'); if (existsSync(p)) return p; }
  try {
    for (const d of readdirSync(termOpts.projects, { withFileTypes: true })) {
      if (!d.isDirectory() || dirHidden(d.name)) continue;
      const p = join(termOpts.projects, d.name, sid + '.jsonl'); if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

// ---- stdout 一行 → 事件 ----
function onLine(L, j) {
  const now = Date.now();
  switch (j.type) {
    case 'system': {
      if (j.subtype === 'init') {
        if (j.model) L.model = j.model;
        const md = fromCliMode(j.permissionMode); if (md) L.mode = md;
        // 要了自动、cc 却按每次问起的（haiku 这类模型用不了自动模式，cc 不报错、悄悄降级）：说一声
        if (L.reqMode === 'auto' && j.permissionMode !== 'auto' && !L.autoNoted) { L.autoNoted = true; addItem(L, { k: 'note', id: 'auto-' + now, t: now, text: '这个模型用不了自动模式，还是每次问你' }); }
        if (!L.busy) { L.busy = true; L.lastActive = now; emitSession(L.sid); }   // 后台任务做完它会自己开一轮
      } else if (j.subtype === 'compact_boundary') addItem(L, { k: 'note', id: j.uuid || randomUUID(), t: now, text: '上下文压缩了' });
      else if (j.subtype === 'task_started' && j.is_backgrounded) L.bg.add(j.task_id);
      else if (j.subtype === 'task_notification' && L.bg.delete(j.task_id)) {
        addItem(L, { k: 'note', id: 'task-' + j.task_id, t: now, text: j.summary || '后台任务 ' + (j.status || ''), tone: j.status === 'failed' ? 'err' : 'info' });
      }
      return;
    }
    case 'stream_event': {
      if (j.parent_tool_use_id) return;   // 子代理的流式不显示
      const ev = j.event || {};
      if (ev.type === 'message_start') { L.msgId = ev.message?.id || ''; L.blockIdx = -1; if (ev.message?.model) L.model = ev.message.model; }
      else if (ev.type === 'content_block_start') L.blockIdx = ev.index;
      else if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        const k = d.type === 'text_delta' ? 'text' : d.type === 'thinking_delta' ? 'think' : null;
        const s = k === 'text' ? d.text : d.thinking;
        if (!k || !s) return;
        const id = `${L.msgId}:${ev.index}`;
        const it = L.byId.get(id);
        if (!it) addItem(L, { k, id, t: now, text: s });
        else { it.text += s; emit({ type: 'delta', sid: L.sid, id, text: s }); }
      }
      return;
    }
    case 'assistant': {
      const m = j.message || {};
      const sub = !!j.parent_tool_use_id;
      const t = ts(j.timestamp) || now;
      if (!sub && !(L.cmdOut && m.model === '<synthetic>')) { L.turnAsst = j.uuid || L.turnAsst; if (m.model && m.model !== '<synthetic>') L.model = m.model; }
      const blocks = m.content || [];
      for (const b of blocks) {
        const n = L.ord.get(m.id) || 0; L.ord.set(m.id, n + 1);   // 没有流式信息时的块序号（和解析文件时一样，所有块都数）
        if (b?.type === 'tool_use') {
          if (!L.byId.has(b.id)) addItem(L, { k: 'tool', id: b.id, t, name: b.name, input: cutInput(b.input || {}), state: 'run', ...(sub ? { sub: true } : {}) });
          continue;
        }
        if (sub) continue;
        if (m.model === '<synthetic>' || j.isApiErrorMessage) {
          // 刚发了斜杠命令：这条 <synthetic> 是命令的输出（文件里记成 system local_command，同一个 uuid）
          if (b?.type === 'text' && b.text) addItem(L, L.cmdOut && !j.isApiErrorMessage ? { k: 'out', id: j.uuid || randomUUID(), t, text: cap(b.text.trim(), OUT_CAP) } : { k: 'note', id: j.uuid || randomUUID(), t, text: cap(b.text, 4000), tone: j.isApiErrorMessage ? 'err' : 'info' });
          continue;
        }
        if (b?.type !== 'text' && b?.type !== 'thinking') continue;
        const text = (b.type === 'text' ? b.text : b.thinking) || '';
        const idx = blocks.length === 1 && m.id === L.msgId && L.blockIdx >= 0 ? L.blockIdx : n;
        const id = `${m.id}:${idx}`;
        if (L.byId.has(id)) { if (text) patchItem(L, id, { text }); }   // 流式的对一下终稿（顺手修掉任何错位）
        else if (text) addItem(L, { k: b.type === 'text' ? 'text' : 'think', id, t, text });
      }
      L.lastActive = now;
      return;
    }
    case 'user': {
      if (j.isReplay || j.isSynthetic) return;
      const c = j.message?.content;
      if (Array.isArray(c) && c.some(b => b?.type === 'tool_result')) {
        for (const b of c) {
          if (b?.type !== 'tool_result' || !L.byId.has(b.tool_use_id)) continue;
          const { state, result } = toolResult(b, j.tool_use_result, L.denied.has(b.tool_use_id));
          patchItem(L, b.tool_use_id, { state, result });
        }
        L.lastActive = now;
        return;
      }
      if (j.parent_tool_use_id || j.isMeta) return;
      const n = noteFor(userContent(c).text);
      if (n && n !== SKIP) {
        const t = ts(j.timestamp) || now;
        if (n.cmd) { if (!L.byId.has(j.uuid)) addItem(L, { k: 'user', id: j.uuid || randomUUID(), t, text: n.text }); }   // 发的那句 sendUser 已经放上去了
        else addItem(L, { k: n.out ? 'out' : 'note', id: n.id || j.uuid || randomUUID(), t, text: n.text, ...(n.tone ? { tone: n.tone } : {}) });
      }
      return;
    }
    case 'control_request': {
      const q = j.request || {};
      if (q.subtype !== 'can_use_tool') {   // 不认识的请求：回个错，免得它干等
        write(L, { type: 'control_response', response: { subtype: 'error', request_id: j.request_id, error: 'unsupported: ' + q.subtype } });
        return;
      }
      // "这个会话里都允许"：只在本会话生效，别写进设置文件
      const sugg = (q.permission_suggestions || []).map(s => ({ ...s, destination: 'session' }));
      L.asks.set(j.request_id, { tool: q.tool_name, input: q.input || {}, sugg, toolUseId: q.tool_use_id });
      const it = { k: 'ask', id: j.request_id, t: now, tool: q.tool_name, input: cutInput(q.input || {}), state: 'wait' };
      if (q.description) it.desc = String(q.description);
      if (sugg.length) it.canAlways = true;
      if (q.tool_name === 'AskUserQuestion' && Array.isArray(q.input?.questions)) it.questions = q.input.questions;
      addItem(L, it);
      emitSession(L.sid);
      // 手机不在前台时弹个横幅（server.mjs 的 /events 转给壳的常驻服务）
      return;
    }
    case 'control_cancel_request': {
      if (L.asks.delete(j.request_id)) { patchItem(L, j.request_id, { state: 'gone' }); emitSession(L.sid); }
      return;
    }
    case 'control_response': {
      const r = j.response || {};
      const f = L.pending.get(r.request_id); if (f) { L.pending.delete(r.request_id); f(r); }
      return;
    }
    case 'result': {
      if (j.is_error && !(L.interrupting && j.subtype === 'error_during_execution')) {
        const msg = (typeof j.result === 'string' && j.result) || (Array.isArray(j.errors) && j.errors.filter(e => !String(e).startsWith('[ede_diagnostic]')).join('\n')) || j.subtype || '出错了';
        addItem(L, { k: 'note', id: 'err-' + (j.uuid || randomUUID()), t: now, tone: 'err', text: cap(String(msg), 2000) });
      }
      // 只跑了个本地命令（/usage 这种，模型没开口）：不记一轮结束，和文件里一样
      if (L.turnAsst || !L.cmdOut) addItem(L, { k: 'end', id: 'end-' + (L.turnAsst || j.uuid || randomUUID()), t: now, ...(j.duration_ms ? { ms: j.duration_ms } : {}), ...(L.model ? { model: L.model } : {}) });
      L.turnAsst = ''; L.interrupting = false; L.busy = false; L.cmdOut = false; L.lastActive = now;
      emitSession(L.sid);
      refreshOne(L.file || (L.file = locate(L.sid, L.cwd))).then(ch => { if (ch) emitSession(L.sid); });   // 统计、标题跟上
      return;
    }
    case 'rate_limit_event': {
      const info = j.rate_limit_info || {};
      if (info.status === 'rejected') addItem(L, { k: 'note', id: 'rl-' + (j.uuid || randomUUID()), t: now, tone: 'err', text: '额度用完了' + (info.resetsAt ? `，${new Date(info.resetsAt * 1000).toLocaleString('zh-CN', { hour12: false })} 恢复` : '') });
      return;
    }
  }
}

// ---- 发一句 ----
function saveSendImages(list) {
  const out = [];
  for (const it of (Array.isArray(list) ? list : []).slice(0, MAX_IMAGES)) {
    if (typeof it?.data !== 'string') continue;
    const data = it.data.replace(/^data:[^,]*,/, '');
    const img = saveImg(data);
    if (!img || img.buf.length > MAX_IMAGE_BYTES) continue;
    out.push({ ...imgOut(img), media_type: IMG_MIME[img.ext], data });
  }
  return out;
}
function sendUser(L, body) {
  const text = String(body.text || '');
  const imgs = saveSendImages(body.images);
  const content = imgs.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } }));
  if (text) content.push({ type: 'text', text });   // stream-json 里 text 块不能是空串
  if (!content.length) throw Object.assign(new Error('空消息'), { status: 400 });
  const uuid = randomUUID();   // 自带 uuid：cc 会原样记进 jsonl，快照和事件流的 id 就对得上
  write(L, { type: 'user', uuid, message: { role: 'user', content } });
  addItem(L, { k: 'user', id: uuid, t: Date.now(), text, ...(imgs.length ? { images: imgs.map(({ src, w, h }) => ({ src, ...(w ? { w, h } : {}) })) } : {}) });
  if (!L.title) L.title = firstOf(text) || '[图片]';
  if (/^\/[^\s/]+/.test(text.trim())) L.cmdOut = true;   // 斜杠命令：接下来的 <synthetic> 回复是它的输出
  L.turns++;
  L.busy = true; L.lastActive = Date.now();
  emitSession(L.sid);
}
/** 刚拉起来的进程第一句就发不出去（图全坏了之类）：别留个空转的进程 */
function firstSend(L, body) { try { sendUser(L, body); } catch (e) { L.closing = true; treeKill(L.proc.pid); throw e; } }
const effortOf = b => (EFFORTS.includes(b?.effort) ? b.effort : '');
const isEmpty = b => !String(b.text || '') && !(Array.isArray(b.images) && b.images.length);
/** 活着的进程换模型 / effort / 模式：只在这次选的和上次选的不一样时才发（"都允许"切到的模式不会被默认值冲掉） */
async function applyChoice(L, body) {
  if (typeof body.model === 'string' && body.model !== L.reqModel) {
    L.reqModel = body.model;
    await ctl(L, body.model ? { subtype: 'set_model', model: body.model } : { subtype: 'set_model' });
  }
  // effort 不用重启进程：apply_flag_settings（Remote Control 也是这么换的）。null = 回到默认（-p 实测 high）
  if ((body.effort === '' || EFFORTS.includes(body.effort)) && body.effort !== L.reqEffort) {
    L.reqEffort = body.effort;
    await ctl(L, { subtype: 'apply_flag_settings', settings: { effortLevel: body.effort || null } });
  }
  if (body.mode && body.mode !== L.reqMode && fromCliMode(body.mode)) {
    L.reqMode = body.mode;
    const r = await ctl(L, { subtype: 'set_permission_mode', mode: body.mode === 'manual' ? 'default' : body.mode });
    if (r?.subtype === 'success') L.mode = body.mode;
    else if (body.mode === 'auto') { const t = Date.now(); addItem(L, { k: 'note', id: 'auto-' + t, t, text: '这个模型用不了自动模式，还是每次问你' }); }
  }
}

// ============================================================
//  斜杠命令：输入框打 / 时的清单
// ============================================================
// 起一个不说话的 cc，只发一句 initialize 控制请求，回包里有这个目录能用的全部命令（内置 + skill + 插件，带说明）。
// 不走 API、不留会话文件，约 1 秒。按目录缓存 10 分钟（新装的 skill 最多晚 10 分钟出现）
const CMD_TTL = 10 * 60e3;
const HIDE_CMDS = new Set(['clear', 'heapdump', 'workflow-launch-exec']);   // clear 会换掉会话 id，工坊跟不上；另两个是内部用的
const cmdCache = new Map();   // norm(cwd) → { at, list?, p? }
// 说明末尾的来源 "(user)" "(claude.ai sync)"、插件 skill 开头的 "(screenwriting) " 去掉
const cleanDesc = s => String(s || '').replace(/\s*\([^()]*\)\s*$/, '').replace(/^\([\w.-]+\)\s*/, '').trim();
function probeCommands(cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE_EXE, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd, env: { ...process.env }, windowsHide: true, detached: !WIN });
    let buf = '', done = false;
    const finish = (err, list) => { if (done) return; done = true; clearTimeout(timer); treeKill(proc.pid); err ? reject(err) : resolve(list); };
    const timer = setTimeout(() => finish(new Error('cc 没回命令清单')), 20000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.type !== 'control_response' || j.response?.request_id !== 'cmds') continue;
        const list = (j.response.response?.commands || [])
          .filter(c => c?.name && !c.name.startsWith('__') && !HIDE_CMDS.has(c.name))
          .map(c => ({ name: String(c.name), desc: cleanDesc(c.description), ...(c.argumentHint ? { hint: String(c.argumentHint) } : {}), ...(c.builtin ? { builtin: true } : {}), ...(Array.isArray(c.aliases) && c.aliases.length ? { aliases: c.aliases.map(String) } : {}) }));
        finish(null, list);
      }
    });
    proc.stdin.on('error', () => {});
    proc.on('error', e => finish(e));
    proc.on('close', () => finish(new Error('cc 起不来')));
    proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'cmds', request: { subtype: 'initialize' } }) + '\n');
  });
}
async function commandsFor(cwd) {
  const k = norm(cwd);
  const c = cmdCache.get(k);
  if (c?.list && Date.now() - c.at < CMD_TTL) return c.list;
  if (c?.p) return c.p;
  const p = probeCommands(cwd)
    .then(list => { cmdCache.set(k, { at: Date.now(), list }); return list; })
    .catch(e => { if (c?.list) { cmdCache.set(k, c); return c.list; } cmdCache.delete(k); throw e; });   // 失败了有旧的就先用旧的
  cmdCache.set(k, { ...c, p });
  return p;
}

// ============================================================
//  记录：jsonl → TermItem[]
// ============================================================
const tcache = new Map();   // path → { size, mtime, items }（最近几份）
async function parseTranscript(path, { busy }) {
  const st = statSync(path);
  const key = `${st.size}:${st.mtimeMs}:${busy ? 1 : 0}`;
  const c = tcache.get(path);
  if (c?.key === key) return c.items.map(x => ({ ...x }));
  const items = [], pos = new Map(), tools = new Map(), ord = new Map();
  let lastAsst = '', lastAsstT = 0, lastModel = '', turnStart = 0, activity = false, bad = false, cwd0 = '';
  const push = it => { const k = pos.get(it.id); if (k !== undefined) items[k] = it; else { pos.set(it.id, items.length); items.push(it); } };
  // 一轮结束：-p 不写 turn_duration，所以在下一句话之前（和文件末尾）补一条；id 用这一轮最后一条 assistant 的 uuid，和活进程发的对得上
  const endTurn = ms => {
    if (activity && lastAsst) push({ k: 'end', id: 'end-' + lastAsst, t: lastAsstT, ...(ms || (turnStart && lastAsstT > turnStart) ? { ms: ms || lastAsstT - turnStart } : {}), ...(lastModel ? { model: lastModel } : {}) });
    activity = false;
  };
  const onEntry = j => {
    if (j.isSidechain) return;
    if (j.cwd && !cwd0) { cwd0 = j.cwd; if (isPrivCwd(j.cwd)) bad = true; }   // 同索引：只看起头的目录
    if (bad) return;
    const t = ts(j.timestamp) || lastAsstT;
    if (j.type === 'user') {
      if (j.isMeta || j.isCompactSummary || j.isVisibleInTranscriptOnly) return;
      const c = j.message?.content;
      if (Array.isArray(c) && c.some(b => b?.type === 'tool_result')) {
        for (const b of c) {
          if (b?.type !== 'tool_result') continue;
          const it = tools.get(b.tool_use_id); if (!it) continue;
          const { state, result } = toolResult(b, j.toolUseResult, !!j.toolDenialKind);
          it.state = state; it.result = result;
        }
        return;
      }
      const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n') : '';
      const n = noteFor(raw);
      if (n === SKIP) return;
      if (n) {
        if (n.boundary) { endTurn(); turnStart = t; }
        // 斜杠命令：id 就是发的时候带的 uuid（cc 原样记下），和活进程里那句对得上
        push(n.cmd ? { k: 'user', id: j.uuid, t, text: n.text } : { k: n.out ? 'out' : 'note', id: n.id || j.uuid, t, text: n.text, ...(n.tone ? { tone: n.tone } : {}) });
        return;
      }
      const { text, images } = userContent(c, true);
      if (!text.trim() && !images.length) return;
      endTurn(); turnStart = t;
      push({ k: 'user', id: j.uuid, t, text: cap(text, TEXT_CAP), ...(images.length ? { images } : {}) });
    } else if (j.type === 'attachment' && j.attachment?.type === 'queued_command') {
      // 忙的时候插的话：cc 塞进当前这一轮（不算新一轮）；source_uuid 是我们发的时候带的 uuid，和活进程的 id 对得上
      const { text, images } = userContent(j.attachment.prompt, true);
      if (text.trim() || images.length) push({ k: 'user', id: j.attachment.source_uuid || j.uuid, t, text: cap(text, TEXT_CAP), ...(images.length ? { images } : {}) });
    } else if (j.type === 'assistant') {
      const m = j.message || {};
      lastAsst = j.uuid; lastAsstT = t; activity = true;
      if (m.model && m.model !== '<synthetic>') lastModel = m.model;
      for (const b of m.content || []) {
        const n = ord.get(m.id) || 0; ord.set(m.id, n + 1);
        if (b?.type === 'tool_use') { const it = { k: 'tool', id: b.id, t, name: b.name, input: cutInput(b.input || {}), state: 'run' }; tools.set(b.id, it); push(it); continue; }
        if (m.model === '<synthetic>' || j.isApiErrorMessage) {
          if (b?.type === 'text' && b.text) push({ k: 'note', id: j.uuid, t, text: cap(b.text, 4000), tone: j.isApiErrorMessage ? 'err' : 'info' });
          continue;
        }
        const idx = Number.isInteger(j.apiBlockIndex) && (m.content || []).length === 1 ? j.apiBlockIndex : n;
        if (b?.type === 'text' && b.text) push({ k: 'text', id: `${m.id}:${idx}`, t, text: cap(b.text, TEXT_CAP) });
        else if (b?.type === 'thinking' && b.thinking) push({ k: 'think', id: `${m.id}:${idx}`, t, text: cap(b.thinking, TEXT_CAP) });
      }
    } else if (j.type === 'system') {
      if (j.subtype === 'compact_boundary') push({ k: 'note', id: j.uuid, t, text: '上下文压缩了' });
      else if (j.subtype === 'turn_duration') endTurn(j.durationMs);
      else if (j.subtype === 'local_command' && typeof j.content === 'string') {
        // 命令的输出：uuid 和活进程里那条 <synthetic> 回复一样
        const n = noteFor(j.content);
        if (n && n !== SKIP) push({ k: n.out ? 'out' : 'note', id: j.uuid, t, text: n.text, ...(n.tone ? { tone: n.tone } : {}) });
      }
    }
  };
  const { tail } = await eachLine(path, 0, onEntry);
  if (tail) { try { onEntry(JSON.parse(tail.toString('utf8'))); } catch {} }
  if (bad) throw Object.assign(new Error('not found'), { status: 404 });   // 从隐藏目录起头的：当它不存在
  if (!busy) endTurn();
  for (const it of tools.values()) if (it.state === 'run' && !busy) it.state = 'err';   // 没等到结果、也没在跑 = 被打断了
  tcache.set(path, { key, items });
  if (tcache.size > 3) tcache.delete(tcache.keys().next().value);
  return items.map(x => ({ ...x }));
}

/** 文件里的记录 + 活进程手里的（还没落盘的流式、ask、进程通知）。同 id 用活的；只有活的就插在它前一条后面 */
function mergeLive(items, L) {
  if (!L) return items;
  const pos = new Map(items.map((x, i) => [x.id, i]));
  const out = items.slice();
  const after = new Map();          // 文件里第 k 条 → 紧跟在它后面的、只有活进程有的
  let anchor = out.length - 1;      // 这个进程还没有任何东西落盘：接在最后
  for (const it of L.items) {
    const k = pos.get(it.id);
    if (k !== undefined) { out[k] = { ...it }; anchor = k; }
    else { if (!after.has(anchor)) after.set(anchor, []); after.get(anchor).push({ ...it }); }
  }
  if (!after.size) return out;
  const res = [...(after.get(-1) || [])];
  out.forEach((x, i) => { res.push(x); const a = after.get(i); if (a) res.push(...a); });
  return res;
}

// ============================================================
//  路由
// ============================================================
export async function handleTerm(req, res, url) {
  const path = url.pathname;
  const method = req.method;
  let m;
  try {
    if (method === 'GET' && path === '/term/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no', ...CORS });
      res.write(`: hi ${SEQ}\n\n`);
      clients.add(res);
      const ka = setInterval(() => { if (!res.writableEnded) res.write(': ka\n\n'); }, 25e3);
      req.on('close', () => { clients.delete(res); clearInterval(ka); });
      return;
    }
    if (method === 'GET' && (m = path.match(/^\/term\/img\/([a-f0-9]{40}\.(png|jpg|gif|webp))$/))) {
      const f = join(termOpts.imgDir, m[1]);
      if (!existsSync(f)) return json(res, { error: 'not found' }, 404);
      res.writeHead(200, { 'Content-Type': IMG_MIME[m[2]], 'Cache-Control': 'private, max-age=31536000, immutable', ...CORS });
      return createReadStream(f).pipe(res);
    }
    if (method === 'GET' && path === '/term/sessions') {
      await scan();
      const ids = new Set(visible().map(x => x.e.m.id));
      for (const sid of live.keys()) ids.add(sid);
      const sessions = [...ids].map(sessionOut).filter(Boolean).sort((a, b) => b.updated - a.updated);
      return json(res, { sessions });
    }
    if (method === 'GET' && path === '/term/dirs') {
      await scan();
      const by = new Map();
      for (const { e } of visible()) {
        const k = norm(e.m.cwd);
        const d = by.get(k) || { cwd: e.m.cwd, project: project(e.m.cwd), updated: 0, count: 0 };
        d.count++; if (e.m.updated > d.updated) d.updated = e.m.updated;
        by.set(k, d);
      }
      return json(res, { dirs: [...by.values()].sort((a, b) => b.updated - a.updated) });
    }
    if (method === 'GET' && path === '/term/commands') {
      const cwd = fwd(url.searchParams.get('cwd') || '').replace(/\/+$/, '');
      if (!/^([a-zA-Z]:)?\//.test(cwd)) return json(res, { error: 'cwd 要绝对路径' }, 400);
      if (isPrivCwd(cwd) || isTmpCwd(cwd)) return json(res, { error: '这个目录不能用' }, 403);
      try { if (!statSync(cwd).isDirectory()) throw 0; } catch { return json(res, { error: '目录不存在' }, 400); }
      try { return json(res, { commands: await commandsFor(cwd) }); }
      catch (e) { return json(res, { error: e.message || '拿不到命令清单' }, 502); }
    }
    if (method === 'POST' && path === '/term/sessions') {
      const body = await parseJson(req);
      const cwd = fwd(body.cwd || '').replace(/\/+$/, '');
      if (!/^([a-zA-Z]:)?\//.test(cwd)) return json(res, { error: 'cwd 要绝对路径' }, 400);
      if (isPrivCwd(cwd) || isTmpCwd(cwd)) return json(res, { error: '这个目录不能用' }, 403);
      try { if (!statSync(cwd).isDirectory()) throw 0; } catch { return json(res, { error: '目录不存在' }, 400); }
      if (isEmpty(body)) return json(res, { error: '空消息' }, 400);
      const sid = randomUUID();
      const mode = fromCliMode(body.mode) || 'manual';
      const L = startLive({ sid, cwd, model: body.model || '', effort: effortOf(body), mode, title: firstOf(body.text || '') });
      L.reqModel = typeof body.model === 'string' ? body.model : '';
      L.reqMode = mode;
      firstSend(L, body);
      return json(res, { id: sid });
    }
    if ((m = path.match(/^\/term\/sessions\/([0-9a-f-]{36})(?:\/(send|answer|interrupt|close))?$/))) {
      const sid = m[1], act = m[2];
      if (method === 'GET' && !act) {
        const L = live.get(sid);
        await scan();
        const hit = findVisible(sid);
        if (!hit && !L) return json(res, { error: 'not found' }, 404);
        const file = hit?.path || (L && (L.file = L.file || locate(sid, L.cwd)));
        const src = file && existsSync(file) ? file : L?.parentFile && existsSync(L.parentFile) ? L.parentFile : null;   // 刚分出来、自己的文件还没写：先用原会话的
        const fileItems = src ? await parseTranscript(src, { busy: !!L?.busy || (!L && pcBusyOf(sid, hit?.e)) }) : [];
        const all = mergeLive(fileItems, live.get(sid));
        const seq = SEQ;   // 和 mergeLive 同一拍：这之前的事件都已经在快照里
        const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '300', 10) || 300));
        const bq = parseInt(url.searchParams.get('before') || '', 10);
        const end = Number.isFinite(bq) ? Math.min(Math.max(0, bq), all.length) : all.length;
        const start = Math.max(0, end - limit);
        return json(res, { session: sessionOut(sid), items: all.slice(start, end), before: start > 0 ? start : null, seq });
      }
      if (method !== 'POST') return json(res, { error: 'not found' }, 404);
      const body = await parseJson(req);
      let L = live.get(sid);
      if (act === 'send') {
        if (L) { await applyChoice(L, body); sendUser(L, body); return json(res, { ok: true }); }
        await scan();
        if ((L = live.get(sid))) { await applyChoice(L, body); sendUser(L, body); return json(res, { ok: true }); }   // 等扫描的工夫别人已经拉起来了
        const hit = findVisible(sid);
        if (!hit) return json(res, { error: 'not found' }, 404);
        if (isEmpty(body)) return json(res, { error: '空消息' }, 400);
        const fork = pcBusyOf(sid, hit.e);   // 电脑上正开着：分一条新的出来，别两边写同一个文件
        const target = fork ? randomUUID() : sid;
        const mode = fromCliMode(body.mode) || fromCliMode(hit.e.m.mode) || 'manual';
        L = startLive({ sid: target, cwd: hit.e.m.cwd, model: body.model || '', effort: effortOf(body), mode, resume: sid, fork, file: fork ? null : hit.path, parentFile: fork ? hit.path : null, title: hit.e.m.custom || hit.e.m.ai || hit.e.m.first, root: hit.e.m.root });
        L.reqModel = typeof body.model === 'string' ? body.model : '';
        L.reqMode = mode;
        firstSend(L, body);
        // 分出来的：这句后面留一行说明（只在这次进程里有，文件里没有；mergeLive 把它挂在这句后面）
        if (fork) addItem(L, { k: 'note', id: 'fork-' + target, t: Date.now(), text: '电脑上正开着那一条，从这句起分了一版出来' });
        return json(res, fork ? { ok: true, id: target } : { ok: true });
      }
      if (!L) return json(res, { ok: false, error: '没在跑' }, act === 'answer' ? 409 : 200);
      if (act === 'answer') {
        const a = L.asks.get(body.req);
        if (!a) return json(res, { ok: false, error: '这个请求已经不在了' }, 409);
        L.asks.delete(body.req);
        let response;
        if (body.behavior === 'allow') {
          const answers = body.answers && typeof body.answers === 'object' ? body.answers : null;
          response = { behavior: 'allow', updatedInput: answers ? { ...a.input, answers } : a.input };
          if (a.tool === 'ExitPlanMode') L.mode = 'manual';   // 方案批了，cc 回到每次问（这一轮里就生效，不等下一轮的 init）
          if (body.always && a.sugg.length) {
            response.updatedPermissions = a.sugg;
            const sm = a.sugg.find(s => s.type === 'setMode'); if (sm && fromCliMode(sm.mode)) L.mode = fromCliMode(sm.mode);
          }
        } else {
          response = { behavior: 'deny', message: String(body.message || '').trim() || "The user doesn't want to proceed with this tool use. STOP what you are doing and wait for the user to tell you how to proceed." };
          if (a.toolUseId) L.denied.add(a.toolUseId);
        }
        write(L, { type: 'control_response', response: { subtype: 'success', request_id: body.req, response } });
        patchItem(L, body.req, { state: body.behavior === 'allow' ? 'allow' : 'deny', ...(body.answers ? { answers: body.answers } : {}) });
        L.lastActive = Date.now();
        emitSession(sid);
        return json(res, { ok: true });
      }
      if (act === 'interrupt') {
        if (!L.busy) return json(res, { ok: true });
        L.interrupting = true;
        const r = await ctl(L, { subtype: 'interrupt' }, 6000);
        if (!r) { L.closing = true; treeKill(L.proc.pid); }   // 不理人就整棵杀掉，下次 --resume 接着
        return json(res, { ok: true });
      }
      if (act === 'close') { closeLive(L); return json(res, { ok: true }); }
    }
    return json(res, { error: 'not found' }, 404);
  } catch (e) {
    if (e.status) return json(res, { error: e.message }, e.status);
    throw e;
  }
}
