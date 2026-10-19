// 终端里一次工具调用怎么说成人话：动词 + 对象 + 图标 + 加减行数。一串调用合成一行摘要。
// Remote Control 那里写 "Used PowerShell command,description,timeout"（把参数名列出来），这里换成它实际在干嘛。
import type { TermItem, TermHunk } from './term';

export type ToolItem = Extract<TermItem, { k: 'tool' }>;
export type Icon = 'edit' | 'new' | 'read' | 'run' | 'search' | 'web' | 'task' | 'todo' | 'tool' | 'think';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
export function basename(p: string) { return p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p; }
const firstLine = (s: string) => s.split('\n').find(l => l.trim())?.trim() ?? '';
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function countPatch(p?: TermHunk[]) {
  let adds = 0, dels = 0;
  for (const h of p || []) for (const l of h.lines) { if (l[0] === '+') adds++; else if (l[0] === '-') dels++; }
  return { adds, dels };
}

/** 没有 structuredPatch（老记录）时从 Edit 的输入估：旧的全删、新的全加 */
function fallbackCount(t: ToolItem) {
  const i = t.input;
  if (t.name === 'Write') return { adds: str(i.content).split('\n').length, dels: 0 };
  if (t.name === 'Edit') return { adds: str(i.new_string).split('\n').length, dels: str(i.old_string).split('\n').length };
  if (t.name === 'MultiEdit' && Array.isArray(i.edits)) {
    let a = 0, d = 0;
    for (const e of i.edits as Array<Record<string, unknown>>) { a += str(e.new_string).split('\n').length; d += str(e.old_string).split('\n').length; }
    return { adds: a, dels: d };
  }
  return { adds: 0, dels: 0 };
}

export interface ToolInfo {
  icon: Icon;
  verb: string;       // 改 / 新建 / 读 / 跑 / 搜 …
  target: string;     // 文件名、命令说明、搜什么
  mono: boolean;      // target 用等宽（文件名、代码）
  detail: string;     // 第二行（命令本身、路径）
  adds: number;
  dels: number;
  kind: 'edit' | 'new' | 'read' | 'search' | 'run' | 'web' | 'task' | 'todo' | 'tool';
  path: string;       // 改的 / 读的文件完整路径（统计"几个文件"用）
}

export function toolInfo(t: ToolItem): ToolInfo {
  const i = t.input || {};
  const n = t.name;
  const path = str(i.file_path) || str(i.notebook_path) || str(i.path);
  const pc = t.result?.patch?.length ? countPatch(t.result.patch) : fallbackCount(t);
  const base = { adds: 0, dels: 0, detail: '', mono: true, path: '' };
  if (n === 'Edit' || n === 'MultiEdit' || n === 'NotebookEdit') return { ...base, icon: 'edit', kind: 'edit', verb: '改', target: basename(path), detail: path, path, ...pc };
  if (n === 'Write') {
    const created = t.result?.created ?? !t.result?.patch?.length;
    return { ...base, icon: created ? 'new' : 'edit', kind: created ? 'new' : 'edit', verb: created ? '新建' : '重写', target: basename(path), detail: path, path, ...pc };
  }
  if (n === 'Read') {
    const f = t.result?.file;
    const range = f && f.total > f.lines ? ` ${f.start}–${f.start + f.lines - 1}` : '';
    return { ...base, icon: 'read', kind: 'read', verb: '读', target: basename(path) + range, detail: path, path };
  }
  if (n === 'PowerShell' || n === 'Bash' || n === 'BashOutput' || n === 'KillShell' || n === 'KillBash') {
    const cmd = str(i.command);
    const desc = str(i.description);
    if (n === 'BashOutput') return { ...base, icon: 'run', kind: 'run', verb: '看后台', target: str(i.bash_id) || '输出', detail: '' };
    if (n === 'KillShell' || n === 'KillBash') return { ...base, icon: 'run', kind: 'run', verb: '停掉后台', target: str(i.shell_id) || str(i.bash_id), detail: '' };
    return { ...base, icon: 'run', kind: 'run', verb: i.run_in_background ? '后台跑' : '跑', target: desc || clip(firstLine(cmd), 60), mono: !desc, detail: cmd };
  }
  if (n === 'Grep') return { ...base, icon: 'search', kind: 'search', verb: '搜', target: str(i.pattern), detail: str(i.path) || str(i.glob) };
  if (n === 'Glob') return { ...base, icon: 'search', kind: 'search', verb: '找文件', target: str(i.pattern), detail: str(i.path) };
  if (n === 'WebSearch') return { ...base, icon: 'web', kind: 'web', verb: '搜网页', target: str(i.query), mono: false, detail: '' };
  if (n === 'WebFetch') {
    let host = str(i.url);
    try { host = new URL(host).hostname; } catch { /* 原样 */ }
    return { ...base, icon: 'web', kind: 'web', verb: '看网页', target: host, detail: str(i.url) };
  }
  if (n === 'Task' || n === 'Agent') return { ...base, icon: 'task', kind: 'task', verb: '派子代理', target: str(i.description) || str(i.subagent_type), mono: false, detail: str(i.subagent_type) };
  if (n === 'TodoWrite' || n === 'TaskCreate' || n === 'TaskUpdate' || n === 'TaskList' || n === 'TaskGet') {
    const todos = Array.isArray(i.todos) ? (i.todos as Array<{ status?: string }>) : [];
    const done = todos.filter(x => x.status === 'completed').length;
    return { ...base, icon: 'todo', kind: 'todo', verb: '待办', target: todos.length ? `${done}/${todos.length}` : str(i.subject) || str(i.title) || '更新', mono: !!todos.length, detail: '' };
  }
  if (n === 'ExitPlanMode') return { ...base, icon: 'todo', kind: 'tool', verb: '出方案', target: clip(firstLine(str(i.plan)).replace(/^[#\s*-]+/, ''), 40), mono: false, detail: '' };
  if (n === 'AskUserQuestion') {
    const q = Array.isArray(i.questions) ? (i.questions as Array<{ question?: string }>)[0]?.question ?? '' : '';
    return { ...base, icon: 'tool', kind: 'tool', verb: '问你', target: clip(q, 40), mono: false, detail: '' };
  }
  if (n === 'Skill') return { ...base, icon: 'tool', kind: 'tool', verb: '用技能', target: str(i.skill) || str(i.command), detail: '' };
  if (n === 'ToolSearch') return { ...base, icon: 'search', kind: 'tool', verb: '找工具', target: clip(str(i.query), 40), detail: '' };
  const m = /^mcp__(.+?)__(.+)$/.exec(n);
  if (m) return { ...base, icon: 'tool', kind: 'tool', verb: m[2].replace(/_/g, ' '), target: m[1].replace(/_/g, ' '), mono: false, detail: '' };
  return { ...base, icon: 'tool', kind: 'tool', verb: '用', target: n, detail: '' };
}

/** 一串工具调用 → "改了 3 个文件，跑了 2 条命令" + 总的加减行数 */
export function summarize(tools: ToolItem[]) {
  const edit = new Set<string>(), made = new Set<string>(), read = new Set<string>();
  let run = 0, search = 0, web = 0, task = 0, todo = 0, other = 0, adds = 0, dels = 0;
  for (const t of tools) {
    if (t.sub) continue;
    const f = toolInfo(t);
    adds += f.adds; dels += f.dels;
    if (f.kind === 'edit') edit.add(f.path || t.id);
    else if (f.kind === 'new') made.add(f.path || t.id);
    else if (f.kind === 'read') read.add(f.path || t.id);
    else if (f.kind === 'run') run++;
    else if (f.kind === 'search') search++;
    else if (f.kind === 'web') web++;
    else if (f.kind === 'task') task++;
    else if (f.kind === 'todo') todo++;
    else other++;
  }
  const parts: string[] = [];
  if (edit.size) parts.push(`改了 ${edit.size} 个文件`);
  if (made.size) parts.push(`新建 ${made.size} 个`);
  if (run) parts.push(`跑了 ${run} 条命令`);
  if (read.size) parts.push(`读了 ${read.size} 个`);
  if (search) parts.push(`搜了 ${search} 次`);
  if (web) parts.push(`查了 ${web} 次网页`);
  if (task) parts.push(`派了 ${task} 个子代理`);
  if (todo) parts.push('更新了待办');
  if (other) parts.push(`用了 ${other} 个工具`);
  return { text: parts.join('，') || '用了工具', adds, dels };
}

export function stateLabel(t: ToolItem) {
  return t.state === 'run' ? '跑着' : t.state === 'err' ? '出错' : t.state === 'denied' ? '没让' : '完成';
}
