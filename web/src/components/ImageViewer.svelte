<script lang="ts">
  // 看大图。
  // 两根手指捏：以两指中间为中心放大缩小（1–5 倍，捏过头有阻尼，松手弹回）；放大了一根手指拖着看（拖出边有阻尼，松手回到边里）；
  // 双击：放大到 2.5 倍（点哪儿放大哪儿）/ 还原；没放大时往下（或往上）拖，背景跟着淡，拖够了松手收起，不够弹回去；
  // 点一下收起（等 260ms 确认不是双击）；系统返回键也收起（压一条历史）。只动 transform / opacity，手指在动时不加过渡。
  import { onMount } from 'svelte';
  import { fade, scale as scaleIn } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { backHandlers } from '../lib/state.svelte';
  import { haptic } from '../lib/haptic';

  let { src, onclose }: { src: string; onclose: () => void } = $props();

  let box: HTMLElement | undefined = $state();
  let img: HTMLImageElement | undefined = $state();
  let dim = $state(1);   // 往下拖时背景淡掉
  let s = 1, x = 0, y = 0;
  const MIN = 1, MAX = 5, DOUBLE = 2.5;
  const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

  function apply(settle = false) {
    if (!img) return;
    img.style.transition = settle ? `transform .34s ${EASE}` : 'none';
    img.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`;
  }
  // 原大（scale = 1）时图片在屏幕上的宽高，和容器的宽高：算拖的边界用
  function sizes() {
    const c = box!.getBoundingClientRect();
    const w0 = img!.offsetWidth, h0 = img!.offsetHeight;
    return { cw: c.width, ch: c.height, w0, h0 };
  }
  function bounds(sc: number) {
    const { cw, ch, w0, h0 } = sizes();
    return { bx: Math.max(0, (w0 * sc - cw) / 2), by: Math.max(0, (h0 * sc - ch) / 2) };
  }
  const rubber = (v: number, lim: number) => (Math.abs(v) <= lim ? v : Math.sign(v) * (lim + (Math.abs(v) - lim) * 0.35));
  const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
  // 屏幕上的点 → 相对容器中心的坐标（transform 的原点在图片中心，图片居中放）
  function local(px: number, py: number) { const c = box!.getBoundingClientRect(); return { x: px - c.left - c.width / 2, y: py - c.top - c.height / 2 }; }

  // 松手之后落到合法的位置：缩放夹回 1–5，没放大就回正中，放大了拖回边里
  function settle() {
    s = clamp(s, MIN, MAX);
    if (s <= 1.01) { s = 1; x = 0; y = 0; }
    else { const { bx, by } = bounds(s); x = clamp(x, -bx, bx); y = clamp(y, -by, by); }
    dim = 1;
    apply(true);
  }
  function zoomAt(px: number, py: number, to: number) {
    const p = local(px, py);
    x = p.x - (to * (p.x - x)) / s;
    y = p.y - (to * (p.y - y)) / s;
    s = to;
    const { bx, by } = bounds(s);
    x = clamp(x, -bx, bx); y = clamp(y, -by, by);
    apply(true);
  }

  // ---- 手势 ----
  const pts = new Map<number, { x: number; y: number }>();
  let g: null | { kind: 'pinch' | 'pan' | 'drag' | 'tap'; s0: number; x0: number; y0: number; mx: number; my: number; d0: number; px: number; py: number; t: number; moved: boolean } = null;
  let lastTap = { t: 0, x: 0, y: 0 };
  let tapTimer = 0;
  const mid = () => { const a = [...pts.values()]; return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) }; };

  function down(e: PointerEvent) {
    try { box!.setPointerCapture(e.pointerId); } catch { /* 合成的事件没有真的指针 */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    clearTimeout(tapTimer);
    if (pts.size === 2) {
      const m = mid(), p = local(m.x, m.y);
      g = { kind: 'pinch', s0: s, x0: x, y0: y, mx: p.x, my: p.y, d0: m.d || 1, px: m.x, py: m.y, t: performance.now(), moved: true };
    } else if (pts.size === 1) {
      g = { kind: 'tap', s0: s, x0: x, y0: y, mx: 0, my: 0, d0: 0, px: e.clientX, py: e.clientY, t: performance.now(), moved: false };
    }
  }
  function move(e: PointerEvent) {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.kind === 'pinch' && pts.size >= 2) {
      const m = mid(), p = local(m.x, m.y);
      let ns = g.s0 * (m.d / g.d0);
      // 捏过头：小于 1、大于 5 都有阻尼
      if (ns < MIN) ns = MIN - (MIN - ns) * 0.4;
      if (ns > MAX) ns = MAX + (ns - MAX) * 0.25;
      x = p.x - (ns * (g.mx - g.x0)) / g.s0;
      y = p.y - (ns * (g.my - g.y0)) / g.s0;
      s = ns;
      apply();
      return;
    }
    const dx = e.clientX - g.px, dy = e.clientY - g.py;
    if (g.kind === 'tap' && Math.hypot(dx, dy) > 8) {
      g.moved = true;
      // 没放大：竖着拖 = 收起的手势；放大了：拖着看
      g.kind = s > 1.01 ? 'pan' : Math.abs(dy) > Math.abs(dx) ? 'drag' : 'tap';
    }
    if (g.kind === 'pan') {
      const { bx, by } = bounds(s);
      x = rubber(g.x0 + dx, bx); y = rubber(g.y0 + dy, by);
      apply();
    } else if (g.kind === 'drag') {
      y = dy; x = dx * 0.3;
      dim = Math.max(0.35, 1 - Math.abs(dy) / 420);
      apply();
    }
  }
  function up(e: PointerEvent) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (!g) return;
    if (g.kind === 'pinch') {
      if (pts.size === 1) {
        // 两根手指抬起一根：剩下那根接着拖
        const [p] = [...pts.values()];
        g = { kind: s > 1.01 ? 'pan' : 'tap', s0: s, x0: x, y0: y, mx: 0, my: 0, d0: 0, px: p.x, py: p.y, t: performance.now(), moved: true };
      } else { g = null; settle(); }
      return;
    }
    if (pts.size) return;
    const kind = g.kind, dt = performance.now() - g.t, dy = e.clientY - g.py;
    const moved = g.moved;
    g = null;
    if (kind === 'drag') {
      if (Math.abs(dy) > 110 || Math.abs(dy) / Math.max(dt, 1) > 0.6) { close(); return; }
      settle();
      return;
    }
    if (kind === 'pan') { settle(); return; }
    if (moved) { settle(); return; }
    // 点：两下 = 放大 / 还原；一下 = 等一会儿确认不是双击，再收起
    const now = performance.now();
    if (now - lastTap.t < 280 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
      lastTap.t = 0;
      haptic('select');
      if (s > 1.01) { s = 1; x = 0; y = 0; apply(true); } else zoomAt(e.clientX, e.clientY, DOUBLE);
      return;
    }
    lastTap = { t: now, x: e.clientX, y: e.clientY };
    tapTimer = window.setTimeout(() => close(), 260);
  }
  function cancel(e: PointerEvent) { pts.delete(e.pointerId); if (!pts.size && g) { g = null; settle(); } }

  // ---- 收起：压过一条历史就退回去（popstate 里再真的关），系统返回键走同一条路 ----
  let closed = false;
  function close() {
    if (closed) return;
    if (history.state?.layer === 'viewer') history.back();
    else { closed = true; onclose(); }
  }
  const onBack = () => { if (closed) return false; closed = true; onclose(); return true; };
  // 手指在图上动的时候告诉浏览器"这串触摸我自己处理了"：不然快速往下一甩收起时浏览器会起一个惯性滚动（fling），
  // 图已经收了、惯性没地方落，下一次点任何东西都被当成"按住停下惯性"吞掉（甩下去收起后点下一张图会点不开）。
  // Svelte 挂的 touchmove 是 passive 的，preventDefault 没用，要自己挂
  const stopFling = (e: TouchEvent) => { if (e.cancelable) e.preventDefault(); };
  onMount(() => {
    try { history.pushState({ layer: 'viewer' }, ''); } catch { /* ignore */ }
    backHandlers.unshift(onBack);
    box?.addEventListener('touchmove', stopFling, { passive: false });
    return () => { const i = backHandlers.indexOf(onBack); if (i >= 0) backHandlers.splice(i, 1); clearTimeout(tapTimer); box?.removeEventListener('touchmove', stopFling); };
  });
</script>

<div class="viewer" role="dialog" tabindex="-1" aria-label="看大图" bind:this={box} style:--dim={dim}
  transition:fade={{ duration: 200, easing: cubicOut }}
  onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={cancel}>
  <img bind:this={img} {src} alt="" draggable="false" in:scaleIn={{ start: 0.96, duration: 280, easing: cubicOut }} />
</div>

<style>
  .viewer { position: fixed; inset: 0; z-index: 30; display: flex; align-items: center; justify-content: center; overflow: hidden;
    padding: calc(var(--sat) + 16px) 12px calc(var(--sab) + 16px); touch-action: none; user-select: none; -webkit-user-select: none; }
  /* 底色单独一层，往下拖时只淡它（--dim），图片不跟着变透明 */
  .viewer::before { content: ''; position: absolute; inset: 0; background: color-mix(in srgb, var(--paper) 94%, transparent);
    backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); opacity: var(--dim); transition: opacity .2s linear; }
  img { position: relative; max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 4px; transform-origin: 50% 50%;
    will-change: transform; -webkit-touch-callout: none; pointer-events: none; }
</style>
