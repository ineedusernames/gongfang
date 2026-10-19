<script lang="ts">
  // 底部抽屉：整个应用唯一的一种弹层。
  // 开和关都是 JS 弹簧（可打断）：开到一半用手抓住，就从当前位置接管，不跳。
  // 跟手：往下拖 1:1；往上拖有橡皮筋阻力。松手先看速度方向：往上甩就回弹，往下甩或过 30% 就关。
  // 内容换页由父级用 {#key} 做，面板本身不重开。
  // 注意：Svelte 5 默认把 touch 事件挂成 passive，preventDefault 不生效，所以这里手动挂非被动监听。
  import type { Snippet } from 'svelte';
  import { spring, reducedMotion, type SpringHandle } from '../lib/spring';

  // height：固定高度（工具抽屉里面换页，面板不能跟着内容一会儿高一会儿矮）
  let { title = '', onclose, children, height = '' }: { title?: string; onclose: () => void; children?: Snippet; height?: string } = $props();
  let closing = $state(false);
  let sheetEl: HTMLElement | undefined = $state();
  let dimEl: HTMLElement | undefined = $state();
  let dragging = $state(false);

  let y = 0, startY = 0, startX = 0, lastY = 0, lastT = 0, vel = 0, intent = false, active = false;
  let touchTarget: EventTarget | null = null;
  let anim: SpringHandle | null = null;
  const H = () => sheetEl?.offsetHeight || 400;

  function setY(v: number) {
    y = v;
    if (sheetEl) sheetEl.style.transform = `translateY(${v}px)`;
    if (dimEl) dimEl.style.opacity = String(Math.min(1, Math.max(0, 1 - v / H())));
  }
  // 橡皮筋：越过边界越不跟手（Apple 的公式）
  function rubber(over: number, dim: number, c = 0.55) { return (over * dim * c) / (dim + c * Math.abs(over)); }

  // 开：从屏幕底下弹上来。damping≈1（不回弹），response≈0.3
  $effect(() => {
    if (!sheetEl) return;
    const h = H();
    setY(h);
    sheetEl.style.willChange = 'transform';
    if (reducedMotion()) { setY(0); sheetEl.style.willChange = ''; return; }
    anim = spring({ from: h, to: 0, stiffness: 340, damping: 34, onFrame: setY, onDone: () => { if (sheetEl) sheetEl.style.willChange = ''; } });
    return () => anim?.stop();
  });

  /** 面板自己就是滚动容器：里面换页时要回到顶 / 回到原来的位置 */
  export function scroller() { return sheetEl; }

  export function close() {
    if (closing) return;
    closing = true;
    anim?.stop();
    if (reducedMotion()) { onclose(); return; }
    const h = H();
    if (sheetEl) sheetEl.style.willChange = 'transform';
    // 退场比进场快，带上手指速度
    anim = spring({ from: y, to: h + 20, velocity: Math.max(vel, 1.2), stiffness: 300, damping: 30,
      onFrame: (v) => { if (sheetEl) sheetEl.style.transform = `translateY(${v}px)`; if (dimEl) dimEl.style.opacity = String(Math.max(0, 1 - v / h)); },
      onDone: onclose });
    setTimeout(onclose, 320); // 兜底
  }

  /** 从手指按住的地方一路往上到面板本身，有没有哪一层还能往 down（true = 往下翻）那边滚 */
  function canScroll(from: EventTarget | null, down: boolean) {
    for (let el = from instanceof Element ? from as HTMLElement : null; el; el = el.parentElement) {
      const oy = el === sheetEl ? 'auto' : getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
        if (down ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0) return true;
      }
      if (el === sheetEl) break;
    }
    return false;
  }

  function onStart(e: TouchEvent) {
    if (closing || e.touches.length !== 1) return;
    const t = e.touches[0];
    startY = lastY = t.clientY; startX = t.clientX; lastT = e.timeStamp; vel = 0; intent = false; active = true;
    touchTarget = e.target;
    // 抓住正在动的面板：停掉弹簧，从当前位置接管
    if (anim) { anim.stop(); anim = null; startY -= y; }
  }
  function onMove(e: TouchEvent) {
    if (!active || closing) return;
    const t = e.touches[0];
    const dy = t.clientY - startY;
    if (!intent) {
      const dx = t.clientX - startX;
      if (Math.abs(dy) < 8 && Math.abs(dx) < 8) return;
      // 横着滑（代码框、图片条）：不管
      if (Math.abs(dx) > Math.abs(dy)) { active = false; return; }
      // 手指往上 = 内容往下翻，手指往下 = 内容往上翻：手指底下哪一层还能往那边滚就让给滚动，都到头了才拖面板
      if (canScroll(touchTarget, dy < 0)) { active = false; return; }
      intent = true; dragging = true;
      if (sheetEl) sheetEl.style.willChange = 'transform';
    }
    if (!e.cancelable) { active = false; dragging = false; return; }
    e.preventDefault();
    const now = e.timeStamp;
    if (now > lastT) vel = (t.clientY - lastY) / (now - lastT);
    lastY = t.clientY; lastT = now;
    setY(dy >= 0 ? dy : rubber(dy, H()));
  }
  function onEnd() {
    if (!active) return;
    active = false; dragging = false;
    if (!intent) return;
    const h = H();
    // 先看速度方向，再看位置
    if (vel < -0.3) { anim = spring({ from: y, to: 0, velocity: vel, stiffness: 340, damping: 34, onFrame: setY }); return; }
    if (y > h * 0.3 || vel > 0.5) { close(); return; }
    anim = spring({ from: y, to: 0, velocity: vel, stiffness: 340, damping: 34, onFrame: setY, onDone: () => { if (sheetEl) sheetEl.style.willChange = ''; } });
  }

  // 非被动监听（Svelte 的 ontouchmove 是 passive 的，preventDefault 会被忽略）
  $effect(() => {
    const el = sheetEl;
    if (!el) return;
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  });
</script>

<div class="dim" class:closing bind:this={dimEl} role="presentation" onclick={close}>
  <div class="sheet" class:dragging class:fixed={!!height} style:height={height || null} role="dialog" aria-modal="true" tabindex="-1" bind:this={sheetEl} onclick={(e) => e.stopPropagation()} onkeydown={(e) => { if (e.key === 'Escape') close(); }}>
    <div class="grip"></div>
    {#if title}<div class="label title">{title}</div>{/if}
    {@render children?.()}
  </div>
</div>

<style>
  /* 遮罩不压暗，做毛玻璃：底色是半透明的纸色 + 背景模糊。只动 opacity（JS 随抽屉位置走），模糊半径不动 */
  .dim { visibility: visible; position: fixed; inset: 0; background: var(--dim, rgba(243, 242, 238, .42)); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); z-index: 20; display: flex; align-items: flex-end; opacity: 0; }
  .sheet { width: 100%; max-height: 80dvh; overflow-y: auto; overscroll-behavior: contain; background: var(--paper); border-top: 1px solid var(--rule); padding: 8px 20px calc(var(--sab) + 20px); transform: translateY(100%); touch-action: pan-y; }
  .sheet.dragging { overflow-y: hidden; }
  .sheet.fixed { max-height: none; }
  .grip { width: 28px; height: 2px; background: var(--rule); margin: 4px auto 14px; user-select: none; -webkit-user-select: none; }
  .title { margin-bottom: 14px; letter-spacing: .18em; user-select: none; -webkit-user-select: none; }
</style>
