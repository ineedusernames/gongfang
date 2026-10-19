// 输入框里没发出去的字和图：退回列表、切到别的应用、浏览器重开都还在。
// 一个会话一份（还没发第一句的新会话按目录）。内存里一份（切页面时立刻拿回来），IndexedDB 里一份（重开用）；停手 400ms 再写。
import { cacheGet, cacheSet } from './cache';
import type { Picked } from './image';

export interface Draft { text: string; picks: Picked[] }
type Stored = { text: string; picks: Array<Omit<Picked, 'url'>> };

const mem = new Map<string, Draft>();
const timers = new Map<string, number>();
const empty = (d: Draft) => !d.text.trim() && !d.picks.length;

export async function loadDraft(key: string): Promise<Draft | null> {
  const m = mem.get(key);
  if (m) return empty(m) ? null : m;
  const s = await cacheGet<Stored>('draft:' + key);
  if (!s) return null;
  // 本地预览的 object URL 活不过重开，用图本身拼一个 data: 地址
  const d: Draft = { text: s.text || '', picks: (s.picks || []).map(p => ({ ...p, url: `data:${p.media_type};base64,${p.data}` })) };
  mem.set(key, d);
  return empty(d) ? null : d;
}

export function saveDraft(key: string, d: Draft) {
  const copy: Draft = { text: d.text, picks: [...d.picks] };
  mem.set(key, copy);
  clearTimeout(timers.get(key));
  timers.set(key, window.setTimeout(() => {
    timers.delete(key);
    // 存进 IndexedDB 的要是普通对象：Svelte 的 $state 是 Proxy，结构化克隆不了（会悄悄存不进去）
    void cacheSet('draft:' + key, empty(copy) ? null : {
      text: copy.text,
      picks: copy.picks.map(({ media_type, data, w, h }) => ({ media_type, data, w, h })),
    } satisfies Stored);
  }, 400));
}
