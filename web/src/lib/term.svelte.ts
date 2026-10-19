// 工坊的状态：会话列表、打开着的那个会话、事件流。形状见 term.ts。
// 真相在电脑上（cc 自己的会话记录 + 后端挂着的进程），这里只是镜像：打开会话拿一份快照，之后按事件流一条条补。
import { backHandlers, settings } from './state.svelte';
import type { Picked } from './image';
import type { TermCmd, TermDir, TermEvent, TermItem, TermMode, TermSession, TermTranscript } from './term';

function base() { return settings.baseUrl.trim().replace(/\/+$/, ''); }
function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (settings.token) h.Authorization = 'Bearer ' + settings.token;
  return h;
}
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(base() + path, { ...init, headers: headers() });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const b = await res.json(); msg = b?.error?.message || b?.error || msg; } catch { /* ignore */ }
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return res.json() as Promise<T>;
}
/** 图（工具读到的、你发的）：<img> 带不了请求头，钥匙走查询参数；本地预览（blob:）原样 */
export function termImg(src: string) {
  if (!src || src.startsWith('blob:') || src.startsWith('data:') || /^https?:/.test(src)) return src;
  return base() + src + (settings.token ? (src.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(settings.token) : '');
}

function load(k: string, d: string) { try { return localStorage.getItem(k) ?? d; } catch { return d; } }
function save(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

export interface TermView {
  sid: string | null;          // null = 新开、还没发第一句
  cwd: string;
  session: TermSession | null;
  items: TermItem[];
  before: number | null;
  seq: number;
  loading: boolean;
  more: boolean;               // 正在往前翻
  failed: string;
}

export const term = $state({
  sessions: [] as TermSession[],
  loaded: false,
  failed: false,
  view: null as TermView | null,
  dirs: [] as TermDir[],
  mode: load('gf.mode', 'manual') as TermMode,
  model: load('gf.model', ''),
  effort: load('gf.effort', ''),
  sheet: null as null | 'new' | 'mode' | 'model' | 'effort' | 'more',
});
export function setTermMode(m: TermMode) { term.mode = m; save('gf.mode', m); }
export function setTermModel(m: string) { term.model = m; save('gf.model', m); }
export function setTermEffort(e: string) { term.effort = e; save('gf.effort', e); }

export const MODES: Array<{ id: TermMode; label: string; hint: string }> = [
  { id: 'manual', label: '每次问', hint: '改文件、跑命令之前都先问你' },
  { id: 'auto', label: '自动', hint: 'cc 自己判断：稳妥的直接做，有风险的才问你' },
  { id: 'acceptEdits', label: '改文件不问', hint: '改文件直接改，跑命令还是先问' },
  { id: 'plan', label: '只出方案', hint: '先看、先想，不动手' },
];
export const modeLabel = (m: TermMode) => MODES.find(x => x.id === m)?.label ?? m;

const sortSessions = () => { term.sessions.sort((a, b) => b.updated - a.updated); };

export async function loadSessions() {
  try {
    const r = await call<{ sessions: TermSession[] }>('/term/sessions');
    term.sessions = r.sessions;
    sortSessions();
    term.failed = false;
  } catch { term.failed = true; }
  finally { term.loaded = true; }
}
export async function loadDirs() {
  try { term.dirs = (await call<{ dirs: TermDir[] }>('/term/dirs')).dirs; } catch { /* 列表里没有就只能手填 */ }
}

// ---- 斜杠命令：按目录一份（不同项目的 skill 不一样），打开会话时先拿着，打 / 时就不用等 ----
export const cmds = $state({
  by: {} as Record<string, { list: TermCmd[]; at: number }>,
  loading: '' as string,     // 正在拿哪个目录的
  failed: '' as string,      // 哪个目录拿失败了
  recent: JSON.parse(load('gf.cmdRecent', '[]')) as string[],
});
export async function loadCommands(cwd: string, force = false) {
  if (!cwd) return;
  const hit = cmds.by[cwd];
  if (!force && hit && Date.now() - hit.at < 10 * 60e3) return;
  if (cmds.loading === cwd) return;
  cmds.loading = cwd;
  try {
    const r = await call<{ commands: TermCmd[] }>('/term/commands?cwd=' + encodeURIComponent(cwd));
    cmds.by[cwd] = { list: r.commands, at: Date.now() };
    if (cmds.failed === cwd) cmds.failed = '';
  } catch { if (!hit) cmds.failed = cwd; }
  finally { if (cmds.loading === cwd) cmds.loading = ''; }
}
/** 发出去的是斜杠命令：记进"最近用过"（最多 6 个，新的在前） */
export function noteCommandUsed(text: string) {
  const m = text.trim().match(/^\/([^\s/]+)/);
  if (!m) return;
  cmds.recent = [m[1], ...cmds.recent.filter(x => x !== m[1])].slice(0, 6);
  save('gf.cmdRecent', JSON.stringify(cmds.recent));
}

// ---- 打开 / 关上一个会话（从右边推进来的页面，系统返回键关掉） ----
function pushLayer() { try { history.pushState({ layer: 'term' }, ''); } catch { /* ignore */ } }

export async function openSession(id: string) {
  const s = term.sessions.find(x => x.id === id) ?? null;
  if (!term.view) pushLayer();
  term.view = { sid: id, cwd: s?.cwd ?? '', session: s, items: [], before: null, seq: 0, loading: true, more: false, failed: '' };
  await fetchTranscript(id);
}
export function startNew(cwd: string) {
  if (!term.view) pushLayer();
  term.view = { sid: null, cwd, session: null, items: [], before: null, seq: 0, loading: false, more: false, failed: '' };
}
export function closeSession() {
  if (!term.view) return;
  if (history.state?.layer === 'term') history.back(); else term.view = null;
}
backHandlers.push(() => { if (!term.view) return false; term.view = null; return true; });

async function fetchTranscript(id: string) {
  const v = term.view;
  if (!v || v.sid !== id) return;
  try {
    const t = await call<TermTranscript>('/term/sessions/' + encodeURIComponent(id));
    if (term.view?.sid !== id) return;
    // 快照只有最后 300 条。手上已有的按位置并：比快照更早的（往前翻出来的）留在前面，
    // 快照之后才来的（事件流比快照先到）接在后面。以前是"快照里没有的一律接在最后"，
    // 回到前台补一次快照时，往前翻出来的那截旧记录就被挂到了最底下
    const snap = t.items;
    const cur = term.view.items;
    const known = new Set(snap.map(x => x.id));
    const first = snap.length ? cur.findIndex(x => x.id === snap[0].id) : -1;
    const last = snap.length ? cur.findIndex(x => x.id === snap[snap.length - 1].id) : -1;
    const older = first > 0 ? cur.slice(0, first).filter(x => !known.has(x.id)) : [];
    const newer = (snap.length ? (last >= 0 ? cur.slice(last + 1) : []) : cur).filter(x => !known.has(x.id) && !x.id.startsWith('local-'));
    term.view.items = [...older, ...snap, ...newer];
    term.view.session = t.session;
    term.view.cwd = t.session.cwd;
    if (!older.length) term.view.before = t.before;   // 往前翻过的就留着原来的游标（接着往更早翻）
    term.view.seq = t.seq;
    term.view.failed = '';
  } catch (e) {
    if (term.view?.sid === id) term.view.failed = e instanceof Error ? e.message : '读不到';
  } finally {
    if (term.view?.sid === id) term.view.loading = false;
  }
}
export async function loadEarlier() {
  const v = term.view;
  if (!v || !v.sid || v.before === null || v.more) return;
  v.more = true;
  try {
    const t = await call<TermTranscript>(`/term/sessions/${encodeURIComponent(v.sid)}?before=${v.before}`);
    if (term.view !== v) return;
    const known = new Set(v.items.map(x => x.id));
    v.items = [...t.items.filter(x => !known.has(x.id)), ...v.items];
    v.before = t.before;
  } catch { /* 下次再翻 */ }
  finally { v.more = false; }
}

// ---- 说话 / 回答 / 停 ----
let localN = 0;
export async function sendTerm(text: string, pics: Picked[]) {
  const v = term.view;
  if (!v || (!text.trim() && !pics.length)) return;
  noteCommandUsed(text);
  // 先把你的话放上去（事件流回来同一句时替换掉），不等电脑
  v.items.push({ k: 'user', id: 'local-' + ++localN, t: Date.now(), text, images: pics.map(p => ({ src: p.url, w: p.w, h: p.h })) });
  const body = { text, images: pics.map(p => ({ media_type: p.media_type, data: p.data })), model: term.model, effort: term.effort, mode: term.mode };
  try {
    if (!v.sid) {
      const r = await call<{ id: string }>('/term/sessions', { method: 'POST', body: JSON.stringify({ ...body, cwd: v.cwd }) });
      if (term.view === v) { v.sid = r.id; void loadSessions(); }
    } else {
      const r = await call<{ ok: boolean; id?: string }>(`/term/sessions/${encodeURIComponent(v.sid)}/send`, { method: 'POST', body: JSON.stringify(body) });
      // 电脑上开着这个会话时后端会分出一条新的：跟过去
      if (r.id && r.id !== v.sid && term.view === v) { v.sid = r.id; v.loading = true; await fetchTranscript(r.id); }
    }
  } catch (e) {
    if (term.view === v) v.items.push({ k: 'note', id: 'local-' + ++localN, t: Date.now(), tone: 'err', text: '没发出去：' + (e instanceof Error ? e.message : '连不上电脑') });
  }
}
export async function answerAsk(req: string, behavior: 'allow' | 'deny', extra: { always?: boolean; message?: string; answers?: Record<string, string> } = {}) {
  const v = term.view;
  if (!v?.sid) return;
  const it = v.items.find(x => x.id === req);
  const prev = it && it.k === 'ask' ? it.state : null;
  if (it && it.k === 'ask') { it.state = behavior; if (extra.answers) it.answers = extra.answers; }   // 先变，失败再退回
  try {
    await call(`/term/sessions/${encodeURIComponent(v.sid)}/answer`, { method: 'POST', body: JSON.stringify({ req, behavior, ...extra }) });
  } catch (e) {
    // 409 = 这个请求已经不在了（这轮被停了 / 进程没了）；别的错误（断网）退回去让你再点
    if (it && it.k === 'ask') it.state = (e as { status?: number }).status === 409 ? 'gone' : prev ?? 'wait';
  }
}
export async function interruptTerm() {
  const v = term.view;
  if (v?.sid) { try { await call(`/term/sessions/${encodeURIComponent(v.sid)}/interrupt`, { method: 'POST' }); } catch { /* ignore */ } }
}
export async function closeProcess() {
  const v = term.view;
  if (v?.sid) { try { await call(`/term/sessions/${encodeURIComponent(v.sid)}/close`, { method: 'POST' }); } catch { /* ignore */ } }
}

// ---- 事件流 ----
let es: EventSource | null = null;
let esUrl = '';
let lostOnce = false;
export function startTermEvents() {
  const url = base() + '/term/events' + (settings.token ? '?token=' + encodeURIComponent(settings.token) : '');
  if (es && esUrl === url && es.readyState !== EventSource.CLOSED) return;
  es?.close();
  esUrl = url;
  try { es = new EventSource(url); } catch { es = null; return; }
  const on = (e: MessageEvent) => { try { apply(JSON.parse(e.data) as TermEvent); } catch { /* 半截的不管 */ } };
  for (const t of ['session', 'item', 'patch', 'delta']) es.addEventListener(t, on as EventListener);
  es.onmessage = on;
  // 断过再连上：中间漏掉的事件拿快照补
  es.onerror = () => { lostOnce = true; };
  es.onopen = () => {
    if (!lostOnce) return;
    lostOnce = false;
    void loadSessions();
    if (term.view?.sid) void fetchTranscript(term.view.sid);
  };
}
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !term.loaded) return;
  startTermEvents();
  void loadSessions();
  if (term.view?.sid) void fetchTranscript(term.view.sid);
});

function apply(e: TermEvent) {
  if (e.type === 'session') {
    const i = term.sessions.findIndex(s => s.id === e.session.id);
    if (i >= 0) term.sessions[i] = e.session; else term.sessions.push(e.session);
    sortSessions();
    if (term.view?.sid === e.session.id) term.view.session = e.session;
    return;
  }
  const v = term.view;
  if (!v || v.sid !== e.sid || e.seq <= v.seq) return;
  if (e.type === 'item') {
    const it = e.item;
    if (v.items.some(x => x.id === it.id)) return;
    if (it.k === 'user') {
      // 替掉先放上去的那句（图留着本地预览，不闪）
      const j = v.items.findIndex(x => x.k === 'user' && x.id.startsWith('local-') && x.text === it.text);
      if (j >= 0) {
        const local = v.items[j] as Extract<TermItem, { k: 'user' }>;
        v.items[j] = { ...it, images: local.images?.length ? local.images : it.images };
        return;
      }
    }
    v.items.push(it);
  } else if (e.type === 'patch') {
    const it = v.items.find(x => x.id === e.id);
    if (it) Object.assign(it, e.patch);
  } else if (e.type === 'delta') {
    const it = v.items.find(x => x.id === e.id);
    if (it && (it.k === 'text' || it.k === 'think')) it.text += e.text;
  }
}

/** 同一家的会话（分叉出来的和原来那条，root 一样），按开始时间排：第 1 版是最早那条 */
export function familyOf(s: TermSession | null | undefined): TermSession[] {
  if (!s) return [];
  if (!s.root) return [s];
  const fam = term.sessions.filter(x => x.root === s.root);
  if (!fam.some(x => x.id === s.id)) fam.push(s);
  return fam.sort((a, b) => a.started - b.started);
}
/** 列表上一家并成一张卡片：点开哪一条——有在等你的先开它，其次在干活的，否则最近动过的 */
export function familyPick(fam: TermSession[]): TermSession {
  return fam.find(x => x.waiting) ?? fam.find(x => x.busy) ?? [...fam].sort((a, b) => b.updated - a.updated)[0];
}

/** 页面标题前的小记号：有会话在等你回（权限、选项）/ 有会话在干活 */
export function termBadge(): 'wait' | 'busy' | '' {
  if (term.sessions.some(s => s.waiting)) return 'wait';
  if (term.sessions.some(s => s.busy)) return 'busy';
  return '';
}
