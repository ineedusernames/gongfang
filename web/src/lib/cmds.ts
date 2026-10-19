// 工坊输入框的斜杠命令：筛选、排序、常用内置命令的中文说明。清单本身从后端拿（/term/commands，cc 的 initialize 回包）。
import type { TermCmd } from './term';

// cc 自带的说明是英文；常用的几个写成人话。没写的照原文
const ZH: Record<string, string> = {
  compact: '压缩上下文：把前面的对话总结成摘要，腾出地方。后面可以写想怎么总结',
  context: '看上下文用了多少、都花在哪',
  usage: '看订阅额度用了多少、几点恢复',
  cost: '看订阅额度用了多少、几点恢复',
  model: '换模型，后面写名字：opus / sonnet / haiku / fable',
  effort: '换思考强度：low / medium / high / xhigh / max',
  fast: '快速模式开关（同一个模型，出字更快）',
  init: '给这个项目写一份 CLAUDE.md，以后开工先看它',
  'code-review': '审一遍这次的改动，找 bug',
  'security-review': '审一遍这次的改动有没有安全问题',
  simplify: '把改过的代码收拾得更简洁（不找 bug）',
  review: '审一遍这次的改动',
  goal: '定一个目标，一直干到达成为止',
  loop: '隔一段时间重复做一件事',
  schedule: '定时任务：到点让云端的 Claude 去做',
  rename: '给这个会话改个名字',
  color: '给这个会话换个颜色',
  config: '改设置，写成 键=值',
  mcp: '看接了哪些 MCP 服务',
  agents: '看有哪些子代理',
  doctor: '检查 Claude Code 装得对不对',
  'output-style': '换回答的风格',
  recap: '回顾一下这个会话做了什么',
  run: '把这个项目跑起来试一试',
  debug: '一起查一个 bug',
  verify: '验证刚做的改动真的能用',
  'update-config': '改 Claude Code 的设置文件（权限、钩子、环境变量）',
  'fewer-permission-prompts': '少弹几次"要不要允许"：把常用的只读命令加进白名单',
  'reload-skills': '重新读一遍 skill（刚装了新的）',
  'reload-plugins': '重新读一遍插件',
  insights: '看看最近怎么用 cc 的',
};
export const descOf = (c: TermCmd) => ZH[c.name] || c.desc;

/** 打字中的那个命令：框里从 / 开始、还没打空格。返回 / 后面打了的字（可以是空串），不是就 null */
export function cmdQuery(draft: string): string | null {
  const m = draft.match(/^\/([^\s/]*)$/);
  return m ? m[1] : null;
}

/** 发出去的一句是斜杠命令：拆成 名字 + 剩下的（给气泡上色用）。路径（/d/x）不算 */
export function splitCmd(text: string): { name: string; rest: string } | null {
  const m = text.match(/^\/([^\s/]+)(\s[\s\S]*)?$/);
  return m ? { name: m[1], rest: m[2] ?? '' } : null;
}

export interface CmdHit { c: TermCmd; at: number; len: number }   // at/len：名字里高亮的那一截（-1 = 名字没中，中的是说明）

/** 按打的字筛：名字开头 > 名字里有 > 别名 > 说明里有（两个字以上才搜说明）；同一档里最近用过的在前 */
export function filterCmds(list: TermCmd[], q: string, recent: string[]): CmdHit[] {
  const s = q.toLowerCase();
  const rec = (n: string) => { const i = recent.indexOf(n); return i < 0 ? 99 : i; };
  const out: Array<CmdHit & { rank: number; i: number }> = [];
  list.forEach((c, i) => {
    const n = c.name.toLowerCase();
    const at = n.indexOf(s);
    let rank = -1;
    if (at === 0) rank = 0;
    else if (at > 0) rank = n[at - 1] === '-' || n[at - 1] === ':' ? 1 : 2;   // 词头中的（sw-dialogue 里的 dia）比词中间中的靠前
    else if (c.aliases?.some(a => a.toLowerCase().includes(s))) rank = 3;
    else if (s.length >= 2 && descOf(c).toLowerCase().includes(s)) rank = 4;
    if (rank >= 0) out.push({ c, at: rank <= 2 ? at : -1, len: s.length, rank, i });
  });
  out.sort((a, b) => a.rank - b.rank || rec(a.c.name) - rec(b.c.name) || a.i - b.i);
  return out.slice(0, 40);
}
