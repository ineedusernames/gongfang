<script lang="ts">
  // 点"改了 3 个文件，跑了 2 条命令"那一行弹出来的抽屉（照 Remote Control）：一条竖线串起每一步，点一步进去看细节。
  // 抽屉高度固定，里面换页：列表 ⇄ 细节横着推（新的从右边进、回去从左边回），两页叠在同一格里，不上下跳。
  import Sheet from './Sheet.svelte';
  import ToolIcon from './ToolIcon.svelte';
  import ToolDetail from './ToolDetail.svelte';
  import type { TermItem } from '../lib/term';
  import { summarize, toolInfo, stateLabel, type ToolItem } from '../lib/tools';
  import { fly, fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { haptic } from '../lib/haptic';

  type Think = Extract<TermItem, { k: 'think' }>;
  type Step = ToolItem | Think;
  let { steps, onclose }: { steps: Step[]; onclose: () => void } = $props();

  let sheet: Sheet | undefined = $state();
  let stack = $state<Step[]>([]);            // 点进去的一层层（子代理里还能再点）
  let dir = $state(1);
  const view = $derived(stack.at(-1) ?? null);
  const scrolls: number[] = [];

  // 子代理里的调用（sub）挂到它前面最近的那个 Task 下面，不单独占一行
  const top = $derived(steps.filter(s => s.k !== 'tool' || !s.sub));
  function subsOf(t: Step): ToolItem[] {
    if (t.k !== 'tool' || (t.name !== 'Task' && t.name !== 'Agent')) return [];
    const i = steps.indexOf(t);
    const out: ToolItem[] = [];
    for (let j = i + 1; j < steps.length; j++) {
      const s = steps[j];
      if (s.k === 'tool' && s.sub) out.push(s);
      else if (s.k === 'tool') break;
    }
    return out;
  }
  const tools = $derived(steps.filter((s): s is ToolItem => s.k === 'tool'));
  const sum = $derived(summarize(tools));

  function open(s: Step) {
    haptic('tick');
    const el = sheet?.scroller();
    scrolls.push(el?.scrollTop ?? 0);
    dir = 1;
    stack = [...stack, s];
    requestAnimationFrame(() => { if (el) el.scrollTop = 0; });
  }
  function back() {
    const el = sheet?.scroller();
    const y = scrolls.pop() ?? 0;
    dir = -1;
    stack = stack.slice(0, -1);
    requestAnimationFrame(() => { if (el) el.scrollTop = y; });
  }
  const titleOf = (s: Step) => (s.k === 'think' ? '想了想' : (() => { const f = toolInfo(s); return `${f.verb} ${f.target}`; })());
  const thinkLine = (s: Think) => s.text.replace(/\s+/g, ' ').slice(0, 40);
</script>

<Sheet bind:this={sheet} height="min(82dvh, 760px)" {onclose}>
  <div class="panes">
    {#key stack.length}
      <div class="pane" in:fly={{ x: 36 * dir, duration: 320, easing: cubicOut, opacity: 0 }} out:fade={{ duration: 120 }}>
        {#if !view}
          <header class="sh">
            <button class="ib" aria-label="收起" onclick={() => sheet?.close()}>
              <svg width="18" height="18" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"><path d="M6 6l10 10M16 6L6 16"/></svg>
            </button>
            <div class="st">
              <h2>{sum.text}</h2>
              {#if sum.adds || sum.dels}<span class="chips"><span class="add">+{sum.adds}</span><span class="del">−{sum.dels}</span></span>{/if}
            </div>
          </header>
          <ol class="tl">
            {#each top as s (s.id)}
              {@const f = s.k === 'tool' ? toolInfo(s) : null}
              <li>
                <button class="step" onclick={() => open(s)}>
                  <span class="rail"><span class="ic" class:run={s.k === 'tool' && s.state === 'run'} class:bad={s.k === 'tool' && (s.state === 'err' || s.state === 'denied')}><ToolIcon icon={f ? f.icon : 'think'} /></span></span>
                  <span class="line">
                    {#if f && s.k === 'tool'}
                      <span class="verb">{f.verb}</span>
                      <span class="tg" class:mono={f.mono}>{f.target}</span>
                      {#if f.adds || f.dels}<span class="chips sm"><span class="add">+{f.adds}</span><span class="del">−{f.dels}</span></span>{/if}
                      {#if s.state !== 'ok'}<span class="label stt" class:breathe={s.state === 'run'}>{stateLabel(s)}</span>{/if}
                      {#if subsOf(s).length}<span class="label stt">{subsOf(s).length} 步</span>{/if}
                    {:else if s.k === 'think'}
                      <span class="verb soft">想了想</span><span class="tg">{thinkLine(s)}</span>
                    {/if}
                  </span>
                  <svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>
                </button>
              </li>
            {/each}
          </ol>
        {:else}
          <header class="sh">
            <button class="ib" aria-label="返回" onclick={back}>
              <svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 5l-6 6 6 6"/></svg>
            </button>
            <div class="st">
              <h2>{titleOf(view)}</h2>
              <span class="label">{view.k === 'tool' ? (view.name.replace(/^mcp__\w+?__/, '') + ' · ' + stateLabel(view)) : '-thinking-'}</span>
            </div>
          </header>
          <div class="detail">
            {#if view.k === 'think'}
              <p class="prose">{view.text}</p>
            {:else}
              <ToolDetail t={view} subs={subsOf(view)} onopen={open} />
            {/if}
          </div>
        {/if}
      </div>
    {/key}
  </div>
</Sheet>

<style>
  /* 两页叠在同一格：退场的那页还在的时候不把新的一页挤下去 */
  .panes { display: grid; }
  .pane { grid-area: 1 / 1; min-width: 0; }
  .sh { position: sticky; top: -8px; z-index: 2; display: flex; align-items: flex-start; gap: 6px; margin: -8px -20px 6px; padding: 10px 20px 10px 10px; background: var(--paper);
    -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 6px), transparent); mask-image: linear-gradient(to bottom, #000 calc(100% - 6px), transparent); }
  .ib { flex: none; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; color: var(--ink); margin-top: -3px; }
  .st { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; padding-top: 4px; }
  .st h2 { font-weight: 400; font-size: 16px; line-height: 1.5; letter-spacing: .04em; word-break: break-word; }
  .chips { display: inline-flex; font-family: var(--mono); font-weight: 400; font-size: 10.5px; border-radius: 6px; overflow: hidden; align-self: flex-start; }
  .chips span { padding: 1px 6px; }
  .add { color: var(--blue); background: var(--blue-wash); }
  .del { color: var(--ink-2); background: color-mix(in srgb, var(--ink) 7%, transparent); }
  .chips.sm { font-size: 10px; margin-left: 2px; }
  .tl { list-style: none; padding: 2px 0 8px; }
  .tl li { position: relative; }
  /* 竖线：从这一步的图标底下连到下一步的图标顶上 */
  .tl li:not(:last-child)::after { content: ''; position: absolute; left: 13px; top: 38px; bottom: -6px; width: 1px; background: var(--rule); }
  .step { width: 100%; display: flex; align-items: center; gap: 12px; padding: 9px 0; text-align: left; min-width: 0; }
  .step:active:not(:disabled) { transform: none; background: color-mix(in srgb, var(--paper-2) 70%, transparent); }
  .rail { flex: none; width: 27px; display: flex; justify-content: center; }
  .ic { width: 27px; height: 27px; display: flex; align-items: center; justify-content: center; color: var(--ink); border-radius: 50%; }
  .ic.run { color: var(--blue); animation: breathe 1.6s var(--ease-in-out) infinite; }
  .ic.bad { color: var(--ink-2); }
  .line { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 7px; overflow: hidden; white-space: nowrap; }
  .verb { flex: none; font-size: 15px; color: var(--ink); }
  .verb.soft { color: var(--ink-2); }
  .tg { font-size: 14px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .tg.mono { font-family: var(--mono); font-weight: 300; font-size: 13px; }
  .stt { flex: none; font-size: 10px; }
  .chev { flex: none; color: var(--ink-2); opacity: .6; }
  .detail { padding: 4px 0 20px; }
  .prose { font-size: 14px; line-height: 1.75; color: var(--ink-2); white-space: pre-wrap; word-break: break-word; }
</style>
