// 一个小弹簧：可打断，带初速度。只用来收尾手势（transform / opacity），不碰布局。
// 参数按 silky 系列的默认：阻尼比 ~0.8（几乎不回弹），中等刚度。

export interface SpringHandle { stop(): void }

export function spring(opts: {
  from: number; to: number; velocity?: number;       // velocity: 单位/毫秒
  stiffness?: number; damping?: number; mass?: number;
  onFrame: (v: number) => void; onDone?: () => void;
}): SpringHandle {
  const k = opts.stiffness ?? 320, c = opts.damping ?? 30, m = opts.mass ?? 1;
  let x = opts.from, v = (opts.velocity ?? 0) * 1000; // 转成 单位/秒
  let last = performance.now(), raf = 0, alive = true;
  const step = (now: number) => {
    if (!alive) return;
    let dt = Math.min(32, now - last) / 1000; last = now;
    // 细分积分，稳
    const n = 4; dt /= n;
    for (let i = 0; i < n; i++) {
      const a = (-k * (x - opts.to) - c * v) / m;
      v += a * dt; x += v * dt;
    }
    if (Math.abs(x - opts.to) < 0.1 && Math.abs(v) < 5) {
      alive = false; opts.onFrame(opts.to); opts.onDone?.(); return;
    }
    opts.onFrame(x);
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return { stop() { alive = false; cancelAnimationFrame(raf); } };
}

export const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
