<script lang="ts">
  // 输入框上面浮出来的斜杠命令清单。
  // 打 / 就出来，接着打字就筛；点一个把 "/名字 " 填进框里，键盘不收（整块按下不抢焦点）。
  // 没打字时分三段：最近用过 / 你装的 skill / cc 自带的；打了字就是一列按像不像排好的，中的那几个字主色。
  // 样子和输入框是一家：圆角 18 的毛玻璃，只是纸色更实一点（底下是字，太透读不清）。从输入框那边长出来。
  import { tick } from 'svelte';
  import { cubicOut } from 'svelte/easing';
  import type { TermCmd } from '../lib/term';
  import { cmds, loadCommands } from '../lib/term.svelte';
  import { descOf, filterCmds, type CmdHit } from '../lib/cmds';

  let { cwd, query, onpick }: { cwd: string; query: string; onpick: (c: TermCmd) => void } = $props();

  const list = $derived(cmds.by[cwd]?.list ?? []);
  const loading = $derived(!list.length && cmds.loading === cwd);
  const failed = $derived(!list.length && !loading && cmds.failed === cwd);

  type Sec = { key: string; label: string; hits: CmdHit[] };
  const sections = $derived.by((): Sec[] => {
    if (query) return [{ key: 'q', label: '', hits: filterCmds(list, query, cmds.recent) }];
    const whole = (c: TermCmd): CmdHit => ({ c, at: -1, len: 0 });
    const byName = new Map(list.map(c => [c.name, c]));
    return [
      { key: 'r', label: '-recent-', hits: cmds.recent.map(n => byName.get(n)).filter((c): c is TermCmd => !!c).map(whole) },
      { key: 'm', label: '-skills-', hits: list.filter(c => !c.builtin).map(whole) },
      { key: 'b', label: '-built-in-', hits: list.filter(c => c.builtin).map(whole) },
    ].filter(s => s.hits.length);
  });
  const empty = $derived(!!list.length && !sections.some(s => s.hits.length));

  // 换了筛的字：回到最上面（最像的那个在顶上）
  let scrollEl: HTMLElement | undefined = $state();
  $effect(() => { void query; void tick().then(() => { if (scrollEl) scrollEl.scrollTop = 0; }); });

  // 从输入框那边长出来：上浮 10px + 微微放大 + 淡入；收回去快一点
  function pop(_: Element, { out = false } = {}) {
    return { duration: out ? 160 : 260, easing: cubicOut, css: (t: number) => `opacity:${t};transform:translateY(${(1 - t) * 10}px) scale(${0.97 + 0.03 * t})` };
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="menu" in:pop out:pop={{ out: true }} onmousedown={e => e.preventDefault()}>
  <div class="scroll" bind:this={scrollEl}>
    {#if loading}
      <p class="state"><span class="label breathe">…</span></p>
    {:else if failed}
      <button class="state" onclick={() => loadCommands(cwd, true)}>
        <span class="label">-offline-</span>
        <span class="hint">拿不到命令清单，点一下再试</span>
      </button>
    {:else if empty}
      <p class="state">
        <span class="label">没有叫 /{query} 的命令</span>
        <span class="hint">直接发出去也行，Claude 会当成一句话来读</span>
      </p>
    {:else}
      {#each sections as s (s.key)}
        {#if s.label}<p class="sec label">{s.label}</p>{/if}
        {#each s.hits as h (s.key + h.c.name)}
          {@const d = descOf(h.c)}
          <button class="row" onclick={() => onpick(h.c)}>
            <span class="nm">
              <span class="sl">/</span>{#if h.at >= 0}{h.c.name.slice(0, h.at)}<b>{h.c.name.slice(h.at, h.at + h.len)}</b>{h.c.name.slice(h.at + h.len)}{:else}{h.c.name}{/if}
              {#if h.c.hint}<span class="arg">{h.c.hint}</span>{/if}
            </span>
            {#if d}<span class="ds">{d}</span>{/if}
          </button>
        {/each}
      {/each}
    {/if}
  </div>
</div>

<style>
  .menu { position: absolute; left: 12px; right: 12px; bottom: calc(100% + 2px); z-index: 4; transform-origin: 50% 100%; overflow: hidden;
    border-radius: 18px; border: 1px solid var(--box-edge);
    background-image: var(--grain); background-color: color-mix(in srgb, var(--paper) 86%, transparent);
    backdrop-filter: blur(20px) saturate(1.3); -webkit-backdrop-filter: blur(20px) saturate(1.3);
    box-shadow: inset 0 1px 0 var(--box-hi), 0 12px 32px rgba(20, 20, 20, .12); }
  .scroll { max-height: min(44dvh, 340px); overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 6px 0;
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 8px, #000 calc(100% - 8px), transparent 100%);
    mask-image: linear-gradient(to bottom, transparent 0, #000 8px, #000 calc(100% - 8px), transparent 100%); }
  .sec { font-size: 10px; letter-spacing: .12em; padding: 10px 16px 3px; }
  .sec:first-child { padding-top: 6px; }
  .row { display: flex; flex-direction: column; gap: 1px; width: 100%; min-width: 0; padding: 7px 16px; text-align: left; transition: background .15s var(--ease-out); }
  .nm { display: flex; align-items: baseline; min-width: 0; white-space: nowrap; font-family: var(--mono); font-weight: 400; font-size: 13.5px; letter-spacing: .02em; color: var(--ink); }
  .sl { color: var(--blue); }
  .nm b { font-weight: 400; color: var(--blue); }
  .arg { margin-left: 8px; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-weight: 300; font-size: 11px; color: var(--ink-2); }
  .ds { font-size: 12.5px; line-height: 1.5; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%; padding: 18px 16px; text-align: center; }
  .hint { font-size: 12.5px; color: var(--ink-2); }
</style>
