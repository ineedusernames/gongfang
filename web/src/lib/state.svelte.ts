// 全局状态：连哪台电脑、钥匙、可选的模型、系统返回键。
const LS = 'gf.settings';
// 后端自己托管前端时，后端就是当前地址；开发服务器（vite，:5180）下默认连本机的后端
const DEV = typeof location !== 'undefined' && location.port === '5180';
const DEFAULT_BASE = DEV ? 'http://127.0.0.1:4800' : (typeof location !== 'undefined' ? location.origin : '');

export interface Settings { baseUrl: string; token: string }
export interface ModelOption { id: string; label: string }

function loadSettings(): Settings {
  try { return { baseUrl: DEFAULT_BASE, token: '', ...JSON.parse(localStorage.getItem(LS) || '{}') }; } catch { return { baseUrl: DEFAULT_BASE, token: '' }; }
}
export const settings = $state<Settings>(loadSettings());
export function saveSettings() {
  try { localStorage.setItem(LS, JSON.stringify({ baseUrl: settings.baseUrl, token: settings.token })); } catch { /* ignore */ }
}

/** 启动时打印的地址带着 ?token=：收下存好，再从地址栏里抹掉（别留在浏览历史和截图里） */
export function takeTokenFromUrl() {
  try {
    const u = new URL(location.href);
    const t = u.searchParams.get('token');
    if (!t) return;
    settings.token = t;
    if (!DEV) settings.baseUrl = location.origin;
    saveSettings();
    u.searchParams.delete('token');
    history.replaceState(history.state, '', u.pathname + (u.search || '') + u.hash);
  } catch { /* ignore */ }
}

export const app = $state({
  screen: 'boot' as 'boot' | 'setup' | 'main',
  online: null as boolean | null,
  models: [] as ModelOption[],
  problem: '',          // 后端找不到 claude 之类，显示在列表顶上
  error: '',            // 连接页上的错
});

/** 连一下：钥匙对不对、后端有哪些模型 */
export async function connect(): Promise<boolean> {
  try {
    const base = settings.baseUrl.trim().replace(/\/+$/, '');
    const res = await fetch(base + '/api/hello', { headers: { Authorization: 'Bearer ' + settings.token }, signal: AbortSignal.timeout(6000) });
    if (res.status === 401) { app.online = false; app.error = '钥匙不对'; return false; }
    if (!res.ok) { app.online = false; app.error = '连上了，但后端回了 ' + res.status; return false; }
    const h = await res.json() as { models?: ModelOption[]; problem?: string };
    app.models = h.models || [];
    app.problem = h.problem || '';
    app.online = true; app.error = '';
    return true;
  } catch {
    app.online = false; app.error = '连不上这个地址';
    return false;
  }
}

/** 系统返回键一层层往回收：抽屉 / 看大图 / 打开着的会话，各自登记 */
export const backHandlers: Array<() => boolean> = [];
if (typeof window !== 'undefined') window.addEventListener('popstate', () => {
  for (const h of backHandlers) if (h()) return;
});

/** effort = 想多深（claude --effort）。'' = 不指定，用 cc 自己的默认。haiku 没有这个设置 */
export const EFFORTS: Array<{ id: string; label: string; hint: string }> = [
  { id: '', label: '默认', hint: '不指定，用 cc 自己的默认' },
  { id: 'low', label: 'low', hint: '想得最少，回得最快' },
  { id: 'medium', label: 'medium', hint: '少想一点' },
  { id: 'high', label: 'high', hint: '想得比较深' },
  { id: 'xhigh', label: 'xhigh', hint: '更深，慢一些' },
  { id: 'max', label: 'max', hint: '想得最多，最慢、最费额度' },
];
export const effortLabel = (id: string) => id || 'effort';

/** 模型短名：claude-opus-4-6 → opus-4.6，claude-haiku-4-5-20251001 → haiku-4.5 */
export function modelShort(id?: string) {
  if (!id) return '';
  return id.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/^([a-z]+)-(\d+)-(\d+)$/, '$1-$2.$3');
}
