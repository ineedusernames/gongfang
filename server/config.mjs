// 配置：项目根目录的 config.json（没有就照 config.example.json 生成一份）。路径一律正斜杠。
// token 留空时第一次启动自动生成一串、写回 config.json——工坊能让 cc 在这台电脑上改文件、跑命令，不许无钥匙裸奔。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { delimiter, dirname, isAbsolute, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = process.env.GONGFANG_CONFIG ? resolve(process.env.GONGFANG_CONFIG) : join(ROOT, 'config.json');

const DEFAULTS = {
  host: '0.0.0.0',
  port: 4800,
  token: '',
  claude: {
    exe: 'claude',
    thinking_display: 'summarized',
    models: [
      { id: 'opus', label: 'Opus' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'haiku', label: 'Haiku' },
    ],
  },
  hide: [],
  hide_temp: true,
  data_dir: './data',
  max_live: 4,
  idle_minutes: 20,
};

function load() {
  let raw = {};
  if (existsSync(FILE)) {
    try { raw = JSON.parse(readFileSync(FILE, 'utf8')); }
    catch (e) { console.error(`[config] ${FILE} 不是合法的 JSON：${e.message}`); process.exit(1); }
  }
  const cfg = { ...DEFAULTS, ...raw, claude: { ...DEFAULTS.claude, ...(raw.claude || {}) } };
  if (!cfg.token) {
    cfg.token = randomBytes(18).toString('base64url');
    raw.token = cfg.token;
    try {
      writeFileSync(FILE, JSON.stringify(existsSync(FILE) ? raw : { ...DEFAULTS, token: cfg.token }, null, 2) + '\n');
      console.log(`[config] 生成了钥匙，写进 ${FILE}`);
    } catch (e) { console.error(`[config] 写不了 ${FILE}：${e.message}（这次的钥匙只在内存里）`); }
  }
  return cfg;
}

export const CFG = load();
export const DATA_DIR = resolve(ROOT, CFG.data_dir);
mkdirSync(DATA_DIR, { recursive: true });
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** claude 可执行文件：写了绝对路径就用它；只写了名字就在 PATH 里找。
 *  Windows 上 spawn 不经过 shell，认不了 npm 装的 claude.cmd——这种情况直接说清楚，别等到发第一句才报"起不来" */
function findClaude(exe) {
  if (isAbsolute(exe)) return existsSync(exe) ? { path: exe } : { error: `找不到 ${exe}` };
  const exts = process.platform === 'win32' ? ['.exe', ''] : [''];
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  for (const d of dirs) for (const x of exts) { const p = join(d, exe + x); if (existsSync(p) && (x || process.platform !== 'win32')) return { path: p }; }
  if (process.platform === 'win32') for (const d of dirs) if (existsSync(join(d, exe + '.cmd'))) {
    // npm 装的：claude.cmd 只是转一手，真正的 exe 在包里
    const real = join(d, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(real)) return { path: real };
    return { error: `PATH 里只有 ${join(d, exe + '.cmd')}（npm 装的包装脚本），工坊起不了它。装原生版 Claude Code，或在 config.json 的 claude.exe 里写 claude.exe 的完整路径` };
  }
  return { error: `PATH 里找不到 ${exe}。装好 Claude Code，或在 config.json 的 claude.exe 里写完整路径` };
}
const found = findClaude(CFG.claude.exe);
export const CLAUDE_EXE = found.path || CFG.claude.exe;
export const CLAUDE_PROBLEM = found.error || '';
