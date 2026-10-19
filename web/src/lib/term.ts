// 工坊的数据形状：后端 server/term.mjs、假后端 tools/mock-server.mjs、前端三方共用这一份。
// 改字段先改这里。所有时间都是毫秒时间戳。
//
// 接口（都要钥匙：Authorization: Bearer <token>，或 ?token=）：
//   GET  /term/sessions                      → { sessions: TermSession[] }        本机 cc 会话，新的在前（不含隐藏目录、临时目录的）
//   GET  /term/sessions/:id?before=&limit=   → TermTranscript                      一个会话的记录（默认最后 300 条，before = 往前翻的游标）
//   POST /term/sessions                      body TermSend & { cwd }  → { id }     新开一个会话并发第一句
//   POST /term/sessions/:id/send             body TermSend            → { ok }     接着说（没在跑就 --resume 拉起来）
//   POST /term/sessions/:id/answer           body TermAnswer          → { ok }     回权限请求 / 选项
//   POST /term/sessions/:id/interrupt        → { ok }                              停下这一轮
//   POST /term/sessions/:id/close            → { ok }                              关掉后台进程（记录留着）
//   GET  /term/dirs                          → { dirs: TermDir[] }                 新开会话可选的目录
//   GET  /term/commands?cwd=                 → { commands: TermCmd[] }             这个目录能用的斜杠命令（输入框打 / 时的清单）
//   GET  /term/img/<sha1>.<ext>              图片（工具读到的图、你发的图），永久缓存
//   GET  /term/events?token=                 SSE，事件见 TermEvent

export type TermMode = 'manual' | 'auto' | 'acceptEdits' | 'plan';

export interface TermStats {
  edits: number;   // 改 / 新建文件的次数（Edit、Write、MultiEdit、NotebookEdit）
  adds: number;    // 加了多少行
  dels: number;    // 删了多少行
  cmds: number;    // 跑了多少条命令（Bash、PowerShell）
  reads: number;   // 读 / 搜了多少次（Read、Grep、Glob）
  turns: number;   // 你说了几句
}

export interface TermSession {
  id: string;
  cwd: string;          // 正斜杠
  project: string;      // cwd 的最后一段，给人看的
  title: string;        // 最后一条 ai-title；没有就取你第一句的前 40 个字
  started: number;
  updated: number;
  live: boolean;        // 后端有进程挂着它
  busy: boolean;        // 正在跑一轮
  waiting: boolean;     // 有权限请求 / 选项等你回
  pcBusy?: boolean;     // 不是我们起的进程、但最近 2 分钟有人在写（电脑上开着）：接着说会分出一条新会话
  model?: string;       // 最近一次实际用的模型
  mode?: TermMode;
  stats: TermStats;
  root?: string;        // 第一条消息的 uuid：分叉出来的会话和原会话一样。列表按它并成一张卡片，会话页里 ‹ 1/2 › 切
}

export interface TermImg { src: string; w?: number; h?: number }

/** structuredPatch 的一段：lines 每行首字符 ' ' / '+' / '-' */
export interface TermHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

export interface TermToolResult {
  text?: string;          // 输出正文，超过 16k 字截断（cut = true）
  cut?: boolean;
  err?: boolean;
  images?: TermImg[];     // Read 一张图、截图之类
  patch?: TermHunk[];     // Edit / Write / MultiEdit 的改动（带行号）
  created?: boolean;      // Write 新建的文件
  file?: { path: string; start: number; lines: number; total: number };  // Read 读的是哪几行
  bgId?: string;          // 后台跑起来的命令 id
}

export type TermItem =
  | { k: 'user'; id: string; t: number; text: string; images?: TermImg[] }
  | { k: 'text'; id: string; t: number; text: string }                     // Claude 说的话，markdown
  | { k: 'think'; id: string; t: number; text: string }                    // 思考摘要（空的不发）
  | {
      k: 'tool'; id: string; t: number;                                    // id = tool_use_id
      name: string;                                                        // Edit / Write / Read / PowerShell / Bash / Grep / Glob / WebFetch / WebSearch / Task / TodoWrite / mcp__x__y …
      input: Record<string, unknown>;                                      // 原样（大字段截到 16k）
      state: 'run' | 'ok' | 'err' | 'denied';
      result?: TermToolResult;
      sub?: boolean;                                                       // 子代理里的调用（parent_tool_use_id 非空），前端并进它的 Task
    }
  | {
      k: 'ask'; id: string; t: number;                                     // id = control_request 的 request_id
      tool: string; input: Record<string, unknown>;
      desc?: string;                                                       // cc 给的一句话说明
      canAlways?: boolean;                                                 // 有 permission_suggestions，可以"这个会话里都允许"
      questions?: TermQuestion[];                                          // AskUserQuestion 的选项题
      state: 'wait' | 'allow' | 'deny' | 'gone';                           // gone = 进程没了 / 这轮被停了
      answers?: Record<string, string>;                                    // 选了什么（给回显用）
    }
  | { k: 'note'; id: string; t: number; text: string; tone?: 'info' | 'err' }   // 压缩、中断、出错、后台任务通知
  | { k: 'out'; id: string; t: number; text: string; tone?: 'err' }             // 斜杠命令的输出（/context 那张表、/usage 的额度），markdown。命令本身是一条 user
  | { k: 'end'; id: string; t: number; ms?: number; model?: string };           // 一轮结束

export interface TermQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string; preview?: string }[];   // preview：选中时下面摊开的样稿（等宽排的草图、代码）
}

/** 斜杠命令（cc 的 initialize 回包，后端去掉了内部用的和 /clear） */
export interface TermCmd {
  name: string;          // 不带 /；插件的是 "screenwriting:sw-dialogue"
  desc: string;
  hint?: string;         // 参数提示，比如 "<model>"
  builtin?: boolean;     // cc 自带的（含自带的 skill）；没有 = 你装的 skill / 插件
  aliases?: string[];
}

export interface TermTranscript {
  session: TermSession;
  items: TermItem[];
  before: number | null;  // 还有更早的就给游标，没有 null
  seq: number;            // 这份快照对应的事件序号；SSE 里 seq <= 它的事件丢掉
}

export interface TermSend {
  text: string;
  images?: { media_type: string; data: string }[];   // base64，最多 4 张
  model?: string;                                    // '' = cc 自己的默认
  effort?: string;                                   // '' = 不指定（-p 是 high）；low/medium/high/xhigh/max
  mode?: TermMode;
}

export interface TermAnswer {
  req: string;                                       // ask 的 id
  behavior: 'allow' | 'deny';
  always?: boolean;                                  // 这个会话里同类都允许（用 permission_suggestions）
  message?: string;                                  // 拒绝时带一句话给 Claude
  answers?: Record<string, string>;                  // AskUserQuestion：question → 选中的 label（多选用 ", " 连）
}

export interface TermDir { cwd: string; project: string; updated: number; count: number }

/** /term/events 的每条 data（event 名 = type） */
export type TermEvent =
  | { type: 'session'; seq: number; session: TermSession }                      // 列表里这一条变了（新建、live/busy/waiting、标题）
  | { type: 'item'; seq: number; sid: string; item: TermItem }                  // 追加一条
  | { type: 'patch'; seq: number; sid: string; id: string; patch: Partial<TermItem> }  // 改一条（工具结果到了、ask 回了）
  | { type: 'delta'; seq: number; sid: string; id: string; text: string };      // 往 text / think 里追加字（流式）
