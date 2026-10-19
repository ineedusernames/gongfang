// 代码块：顶上一条（语言名 · 复制 · 展开），超过 5 行先只露 5 行，点展开原地铺开。
// md.ts 只吐 <pre data-lang><code>，这里用一个 action 挂在列表外层，看见新的 <pre> 就给它加上顶栏——
// 不往 Markdown 的 HTML 里塞按钮和 SVG（那样 DOMPurify 要放行一堆标签和属性）。
// 顶栏塞在 <pre> 里面、不挪 <pre> 本身：{@html} 记着自己插进去的头尾节点，挪走了它下次更新就删不干净。
// 横向滚动、折叠都在 <code> 上（顶栏不跟着横滑）。流式输出时 {@html} 每个字都重画，顶栏也跟着重加，开销很小。
import { copyText } from './copy';
import { haptic } from './haptic';

const FOLD_LINES = 5;
const svg = (body: string) => `<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
const IC_COPY = svg('<rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 5V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H5"/>');
const IC_DONE = svg('<path d="M4.5 10.5l3.5 3.5 7.5-8"/>');
const IC_OPEN = svg('<path d="M11.5 3.5h5v5M8.5 16.5h-5v-5M16.5 3.5l-5 5M3.5 16.5l5-5"/>');
const IC_CLOSE = svg('<path d="M12 3.5v4.5h4.5M8 16.5V12H3.5M12 8l4.5-4.5M8 12l-4.5 4.5"/>');

function enhance(pre: HTMLPreElement) {
  const code = pre.querySelector(':scope > code');
  if (!code) { pre.dataset.cb = '0'; return; }
  pre.dataset.cb = '1';
  pre.classList.add('cb');
  code.classList.add('cb-c');
  const lines = (code.textContent ?? '').replace(/\n$/, '').split('\n').length;
  const head = document.createElement('div');
  head.className = 'cb-head';
  head.contentEditable = 'false';
  const lang = document.createElement('span');
  lang.className = 'cb-lang';
  lang.textContent = pre.dataset.lang || 'code';
  head.append(lang);
  const btn = (cls: string, label: string, icon: string) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = cls; b.setAttribute('aria-label', label); b.innerHTML = icon;
    head.append(b);
  };
  btn('cb-copy', '复制', IC_COPY);
  if (lines > FOLD_LINES) { btn('cb-more', '展开', IC_OPEN); pre.classList.add('folded'); }
  pre.prepend(head);
}

function enhanceAll(root: HTMLElement) {
  for (const pre of root.querySelectorAll<HTMLPreElement>('pre:not([data-cb])')) enhance(pre);
}

async function onClick(e: MouseEvent) {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('.cb-copy, .cb-more');
  if (!b) return;
  const pre = b.closest<HTMLElement>('pre.cb');
  const code = pre?.querySelector<HTMLElement>(':scope > code');
  if (!pre || !code) return;
  e.stopPropagation();
  if (b.classList.contains('cb-copy')) {
    if (!await copyText(code.textContent ?? '')) return;
    haptic('select');
    b.innerHTML = IC_DONE;
    clearTimeout(Number(b.dataset.t));
    b.dataset.t = String(window.setTimeout(() => { b.innerHTML = IC_COPY; }, 1200));
    return;
  }
  // 展开 / 收起：max-height 从眼前的高度过渡到目标高度，动完放开（之后内容再变也不被卡住）
  haptic('tick');
  const opening = pre.classList.contains('folded');
  const from = code.getBoundingClientRect().height;
  pre.classList.toggle('folded', !opening);
  const to = opening ? code.scrollHeight : code.getBoundingClientRect().height;
  code.style.maxHeight = from + 'px';
  void code.offsetHeight;
  code.style.transition = 'max-height .28s cubic-bezier(0.22, 1, 0.36, 1)';
  code.style.maxHeight = to + 'px';
  let t = 0;
  const done = () => { clearTimeout(t); code.style.transition = ''; code.style.maxHeight = ''; code.removeEventListener('transitionend', done); };
  code.addEventListener('transitionend', done);
  t = window.setTimeout(done, 400);
  b.innerHTML = opening ? IC_CLOSE : IC_OPEN;
  b.setAttribute('aria-label', opening ? '收起' : '展开');
}

/** use:codeBlocks —— 挂在装 Markdown 的外层容器上 */
export function codeBlocks(node: HTMLElement) {
  enhanceAll(node);
  const mo = new MutationObserver(() => enhanceAll(node));
  mo.observe(node, { childList: true, subtree: true });
  node.addEventListener('click', onClick);
  return { destroy() { mo.disconnect(); node.removeEventListener('click', onClick); } };
}
