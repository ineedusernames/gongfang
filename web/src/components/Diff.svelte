<script lang="ts">
  // 改动对比：左边行号（-63 / +63 / 64），右边代码，一行一行。照 Remote Control 的排法，颜色换成我们的：
  // 加的行 = 主色淡彩底 + 主色行号；删的行 = 墨色很淡的底 + 次墨色字；没动的行不上底。没有红绿（整套只有纸、墨、一个蓝）。
  // 代码横着滑，行号钉在左边不动。
  import type { TermHunk } from '../lib/term';

  // start：只摆一段文字（读文件）时，第一行的行号
  let { hunks = [], text = '', created = false, oldText = '', newText = '', start = 1 }:
    { hunks?: TermHunk[]; text?: string; created?: boolean; oldText?: string; newText?: string; start?: number } = $props();

  type Row = { t: ' ' | '+' | '-' | '~'; n: string; s: string };
  const MAX = 600;
  const rows = $derived.by(() => {
    const out: Row[] = [];
    if (hunks.length) {
      hunks.forEach((h, hi) => {
        if (hi > 0) out.push({ t: '~', n: '', s: '' });
        let o = h.oldStart, nn = h.newStart;
        for (const l of h.lines) {
          const t = (l[0] === '+' || l[0] === '-' ? l[0] : ' ') as Row['t'];
          const s = l.slice(1);
          if (t === '+') out.push({ t, n: '+' + nn++, s });
          else if (t === '-') out.push({ t, n: '-' + o++, s });
          else { out.push({ t, n: String(nn), s }); o++; nn++; }
          if (out.length >= MAX) return;
        }
      });
    } else if (created || text) {
      text.split('\n').slice(0, MAX).forEach((s, i) => out.push({ t: created ? '+' : ' ', n: (created ? '+' : '') + (i + start), s }));
    } else {
      // 老记录没有带行号的改动，只能按输入摆：旧的全删、新的全加
      for (const s of oldText.split('\n')) out.push({ t: '-', n: '−', s });
      for (const s of newText.split('\n')) out.push({ t: '+', n: '+', s });
    }
    return out;
  });
  const cut = $derived(rows.length >= MAX);
</script>

<div class="diff">
  <div class="scroll">
    <div class="lines">
      {#each rows as r, i (i)}
        {#if r.t === '~'}
          <div class="ln gap"><span class="g">⋯</span><span class="c"></span></div>
        {:else}
          <div class="ln" class:add={r.t === '+'} class:del={r.t === '-'}><span class="g">{r.n}</span><span class="c">{r.s || ' '}</span></div>
        {/if}
      {/each}
    </div>
  </div>
  {#if cut}<p class="label more">后面还有，太长了先不摆</p>{/if}
</div>

<style>
  .diff { margin: 0 -20px; border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); background: color-mix(in srgb, var(--paper) 70%, transparent); }
  .scroll { overflow-x: auto; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch; touch-action: pan-x pan-y; }
  .lines { display: inline-block; min-width: 100%; padding: 4px 0; font-family: var(--mono); font-weight: 300; font-size: 12px; line-height: 1.75; }
  .ln { display: flex; white-space: pre; }
  .g { position: sticky; left: 0; flex: none; width: 52px; padding: 0 10px 0 0; text-align: right; color: var(--ink-2); background: var(--paper); border-right: 1px solid var(--rule); user-select: none; -webkit-user-select: none; }
  .c { padding: 0 20px 0 12px; color: var(--ink); }
  .add { background: var(--blue-wash); }
  .add .g { color: var(--blue); background: color-mix(in srgb, var(--blue) 12%, var(--paper)); border-right-color: color-mix(in srgb, var(--blue) 45%, transparent); }
  .del { background: color-mix(in srgb, var(--ink) 5%, transparent); }
  .del .c { color: var(--ink-2); }
  .del .g { background: color-mix(in srgb, var(--ink) 6%, var(--paper)); }
  .gap .g { color: var(--ink-2); opacity: .6; }
  .more { padding: 8px 20px; }
</style>
