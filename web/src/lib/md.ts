// Claude 回复里的 Markdown：加粗、斜体、列表、引用、代码、链接、换行。
// 标题不当标题渲染（手机屏上大标题太抢），一律降成加粗段落。输出过一遍 DOMPurify。
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    heading({ tokens }) { return `<p><strong>${this.parser.parseInline(tokens)}</strong></p>\n`; },
    html({ text }) { return DOMPurify.sanitize(text); },
  },
});

const ALLOWED = ['p', 'br', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre', 'a', 'hr'];

// 按原文缓存渲染结果：列表重绘时（落定、重新同步）不再把几百条消息全部重新解析
const cache = new Map<string, string>();
const CACHE_MAX = 600;

export function renderMd(src: string): string {
  if (!src) return '';
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const out = renderMdRaw(src);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(src, out);
  return out;
}

/** 流式中的文本每个字都在变，不进缓存 */
export function renderMdLive(src: string): string { return src ? renderMdRaw(src) : ''; }

/** 斜杠命令的输出（/context 是一张表）：多放行表格，别的和上面一样 */
const TABLE = ['table', 'thead', 'tbody', 'tr', 'th', 'td'];
export function renderOut(src: string): string {
  if (!src) return '';
  const key = '\u0000out:' + src;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const out = renderMdRaw(src, TABLE);
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
  cache.set(key, out);
  return out;
}

function renderMdRaw(src: string, extra: string[] = []): string {
  // 中文里 **加粗。**后面紧跟汉字 时，CommonMark 认为闭合符不合法，加粗会失效；先手动把成对的 ** 换成 strong
  const pre = src.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  const html = marked.parse(pre, { async: false }) as string;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS: extra.length ? [...ALLOWED, ...extra] : ALLOWED, ALLOWED_ATTR: ['href'], ADD_ATTR: ['target', 'rel'] })
    .replace(/<a /g, '<a target="_blank" rel="noopener" ');
}
