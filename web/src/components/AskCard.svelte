<script lang="ts">
  // Claude 停下来等你的地方：要跑一条命令 / 改一个文件（权限），或者给了几个选项让你挑（AskUserQuestion）。
  // 等着的时候是一张描了主色细线的卡片；回完收成一行小字留在记录里（grid 行高收拢，不跳）。
  import { onDestroy, onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import type { TermItem, TermQuestion } from '../lib/term';
  import { answerAsk } from '../lib/term.svelte';
  import { toolInfo, type ToolItem } from '../lib/tools';
  import ToolIcon from './ToolIcon.svelte';
  import { haptic } from '../lib/haptic';
  import { renderMd } from '../lib/md';

  type Ask = Extract<TermItem, { k: 'ask' }>;
  let { it }: { it: Ask } = $props();

  const waiting = $derived(it.state === 'wait');
  // 借工具那套说法：动词 + 对象（把 ask 当成一次还没跑的调用）
  const info = $derived(toolInfo({ k: 'tool', id: it.id, t: it.t, name: it.tool, input: it.input, state: 'run' } as ToolItem));
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const code = $derived(s(it.input.command) || s(it.input.file_path) || s(it.input.url) || s(it.input.pattern) || s(it.input.plan));
  const qs = $derived(it.questions ?? []);
  // 只出方案模式：Claude 把方案摆出来（ExitPlanMode），等你说照这个做
  const plan = $derived(it.tool === 'ExitPlanMode' ? s(it.input.plan) : '');
  // 动词后面那半句：Claude 写的说明（"打 APK"）优先，没有就用对象（文件名）；和下面代码框里的一样就不重复
  const whatLabel = $derived.by(() => {
    const l = s(it.input.description) || it.desc || info.target;
    return l === code ? '' : l;
  });

  // 选项题：每题选了什么（多选用集合）；"其他"可以自己写
  let picked = $state<Record<string, string[]>>({});
  let other = $state<Record<string, string>>({});
  let lastPick = $state<Record<string, string>>({});   // 每题最后点的那个（多选时摊开它的样稿）
  const answered = (q: TermQuestion) => (picked[q.question]?.length ?? 0) > 0 || !!(other[q.question] ?? '').trim();
  const ready = $derived(qs.every(answered));

  // 几道题一题一页：顶上一排题签，选中那签底下一粒主色点滑过去（带一点过冲的曲线），
  // 答过的签变主色、前面一个小勾；题和题之间横着推（往后翻新的从右边进 28px，往前翻从左边进），
  // 卡片高度跟着这一题 0.32s 收放。单选题点了，停 280ms 让你看见点上了，再自动翻到下一道没答的
  let qi = $state(0);
  let dir = 1;
  let mounted = false;
  onMount(() => { mounted = true; });
  const nextOpen = $derived(qs.findIndex((x, j) => j > qi && !answered(x)));
  function go(i: number) {
    if (i === qi || i < 0 || i >= qs.length) return;
    clearTimeout(advance);
    dir = i > qi ? 1 : -1;
    qi = i;
    haptic('tick');
  }
  let advance: ReturnType<typeof setTimeout> | undefined;
  function toggle(q: TermQuestion, label: string) {
    haptic('select');
    const multi = !!q.multiSelect;
    const cur = picked[q.question] ?? [];
    const on = multi && cur.includes(label);
    picked[q.question] = multi ? (on ? cur.filter(x => x !== label) : [...cur, label]) : [label];
    lastPick[q.question] = on ? (picked[q.question].at(-1) ?? '') : label;
    if (multi) return;
    other[q.question] = '';
    clearTimeout(advance);
    const at = qi;
    const nx = qs.findIndex((x, j) => j > at && !answered(x));
    if (nx >= 0) advance = setTimeout(() => { if (qi === at) go(nx); }, 280);
  }
  onDestroy(() => clearTimeout(advance));

  // 题签下面那粒点：量当前那签的中心
  let tabEls = $state<HTMLElement[]>([]);
  let dotX = $state(0);
  let dotReady = $state(false);
  $effect(() => {
    const el = tabEls[qi];
    if (!el) return;
    dotX = el.offsetLeft + el.offsetWidth / 2 - 2;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: dotReady ? 'smooth' : 'auto' });
    if (!dotReady) requestAnimationFrame(() => { dotReady = true; });
  });
  // 卡片高度跟着当前这一题（两页叠在同一格里，退场那页被裁掉）
  let pageH = $state(0);
  function measure(node: HTMLElement, key: number) {
    const ro = new ResizeObserver(() => { if (key === qi) pageH = node.offsetHeight; });
    ro.observe(node);
    return { destroy() { ro.disconnect(); } };
  }
  function pageIn(_: Element) {
    const d = dir;
    return { duration: mounted ? 340 : 0, easing: cubicOut, css: (t: number) => `opacity:${t};transform:translateX(${(1 - t) * 28 * d}px)` };
  }
  function pageOut(_: Element) {
    const d = dir;
    return { duration: 200, easing: cubicOut, css: (t: number) => `opacity:${t};transform:translateX(${(t - 1) * 14 * d}px)` };
  }
  function submitAnswers() {
    const answers: Record<string, string> = {};
    for (const q of qs) {
      const o = (other[q.question] ?? '').trim();
      answers[q.question] = [...(picked[q.question] ?? []), ...(o ? [o] : [])].join(', ');
    }
    haptic('select');
    void answerAsk(it.id, 'allow', { answers });
  }
  function allow(always = false) { haptic('select'); void answerAsk(it.id, 'allow', { always }); }
  function deny() { haptic('tick'); void answerAsk(it.id, 'deny', { message: '先别这样做' }); }
</script>

<div class="fold" class:open={waiting}>
  <div>
    <div class="card" class:q={qs.length}>
      {#if qs.length}
        <div class="head"><span class="label warn">-question-</span>{#if qs.length > 1}<span class="label cnt">{qi + 1} / {qs.length}</span>{/if}</div>
        {#if qs.length > 1}
          <div class="tabs">
            {#each qs as q, i (q.question)}
              <button class="tab" class:cur={i === qi} class:ok={answered(q)} bind:this={tabEls[i]} onclick={() => go(i)}>{q.header || `第 ${i + 1} 题`}</button>
            {/each}
            <i class="dot" class:ready={dotReady} style:transform="translateX({dotX}px)"></i>
          </div>
        {/if}
        <div class="pages" style:height={pageH ? pageH + 'px' : null}>
          {#key qi}
            {@const q = qs[qi]}
            {@const pv = q.options.find(o => o.label === lastPick[q.question] && (picked[q.question] ?? []).includes(o.label))?.preview}
            <div class="qq" use:measure={qi} in:pageIn out:pageOut>
              {#if q.header && qs.length === 1}<span class="hdr">{q.header}</span>{/if}
              <p class="qt">{q.question}</p>
              {#if q.multiSelect}<p class="multi label">可以选好几个</p>{/if}
              <div class="opts">
                {#each q.options as o (o.label)}
                  {@const on = (picked[q.question] ?? []).includes(o.label)}
                  <button class="opt" class:on onclick={() => toggle(q, o.label)}>
                    <span class="mark" class:sq={q.multiSelect}>
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2l2.3 2.3L9.5 3.8"/></svg>
                    </span>
                    <span class="ot"><span class="ol">{o.label}</span>{#if o.description}<span class="od">{o.description}</span>{/if}</span>
                  </button>
                {/each}
                <input class="other" placeholder="其他，自己写…" bind:value={other[q.question]} oninput={() => { if (!q.multiSelect && (other[q.question] ?? '').trim()) picked[q.question] = []; }} />
              </div>
              {#if pv}
                {#key lastPick[q.question]}<pre class="pv" in:fade={{ duration: 220, easing: cubicOut }}>{pv}</pre>{/key}
              {/if}
            </div>
          {/key}
        </div>
        <div class="acts">
          {#if !ready && nextOpen >= 0 && answered(qs[qi])}
            <button class="solid" in:fade={{ duration: 180 }} onclick={() => go(nextOpen)}>下一题</button>
          {:else}
            <button class="solid" in:fade={{ duration: 180 }} disabled={!ready} onclick={submitAnswers}>就这样</button>
          {/if}
          <button class="plain" onclick={deny}>先不选</button>
        </div>
      {:else if plan}
        <div class="head"><span class="label warn">-plan-</span><span class="label tool">Claude 想这么做</span></div>
        <div class="plan md">{@html renderMd(plan)}</div>
        <div class="acts">
          <button class="solid" onclick={() => allow(false)}>照这个做</button>
          <button class="plain" onclick={deny}>再想想</button>
        </div>
      {:else}
        <div class="head">
          <span class="ico"><ToolIcon icon={info.icon} size={16} /></span>
          <span class="label warn">-permission-</span>
          <span class="label tool">{it.tool.replace(/^mcp__\w+?__/, '')}</span>
        </div>
        <p class="what">{info.verb} {whatLabel}</p>
        {#if code}<pre class="code">{code}</pre>{/if}
        <div class="acts">
          <button class="solid" onclick={() => allow(false)}>允许</button>
          {#if it.canAlways}<button class="line" onclick={() => allow(true)}>这次会话都允许</button>{/if}
          <button class="plain" onclick={deny}>不让</button>
        </div>
      {/if}
    </div>
  </div>
</div>
<!-- 回完了：一行小字 -->
<div class="fold" class:open={!waiting}>
  <div>
    <p class="done label">
      <span class="tag">{it.state === 'allow' ? (qs.length ? '-answered-' : plan ? '-go-' : '-allowed-') : it.state === 'deny' ? (qs.length ? '-skipped-' : plan ? '-rethink-' : '-denied-') : '-gone-'}</span>
      <span class="dt">{qs.length ? Object.values(it.answers ?? {}).join(' / ') || '选好了' : plan ? (plan.split('\n').find(l => l.trim())?.replace(/^[#\s*-]+/, '') ?? '方案') : `${info.verb} ${code ? code.split('\n')[0] : info.target}`}</span>
    </p>
  </div>
</div>

<style>
  .card { margin: 4px 0 14px; padding: 12px 14px 12px; border-radius: 16px; background: color-mix(in srgb, var(--tint) 62%, transparent); border: 1px solid color-mix(in srgb, var(--blue) 40%, transparent); }
  .head { display: flex; align-items: center; gap: 7px; margin-bottom: 6px; }
  .ico { color: var(--blue); display: flex; }
  .warn { color: var(--blue); }
  .tool { margin-left: auto; font-size: 10px; }
  .what { font-size: 15px; line-height: 1.6; margin-bottom: 8px; }
  .code { font-family: var(--mono); font-weight: 300; font-size: 12px; line-height: 1.65; white-space: pre-wrap; word-break: break-all; max-height: 30dvh; overflow: auto;
    background: color-mix(in srgb, var(--paper) 70%, transparent); border-radius: 10px; padding: 9px 11px; margin: 0 0 12px; }
  .plan { font-size: 14.5px; line-height: 1.7; margin: 2px 0 12px; max-height: 46dvh; overflow-y: auto; }
  .plan :global(p) { margin: 0 0 .5em; }
  .plan :global(ul), .plan :global(ol) { margin: .1em 0 .5em 1.2em; }
  .plan :global(strong) { font-weight: 500; }
  .plan :global(code) { font-family: var(--mono); font-size: .82em; color: var(--blue); background: var(--blue-wash); padding: .05em .3em; border-radius: 4px; }
  .acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .solid { background: var(--blue); color: var(--accent-ink); font-size: 14px; padding: 7px 18px; border-radius: 18px; }
  .solid:disabled { opacity: .35; }
  .line { border: 1px solid color-mix(in srgb, var(--blue) 55%, transparent); color: var(--blue); font-size: 13.5px; padding: 6px 14px; border-radius: 18px; }
  .plain { color: var(--ink-2); font-size: 13.5px; padding: 7px 10px; margin-left: auto; }
  .cnt { margin-left: auto; font-size: 10px; }
  .tabs { position: relative; display: flex; gap: 2px; overflow-x: auto; scrollbar-width: none; margin: -2px -14px 6px; padding: 0 6px 9px; touch-action: pan-x pan-y; overscroll-behavior-x: contain; }
  .tabs::-webkit-scrollbar { display: none; }
  .tab { flex: none; font-family: var(--mono); font-weight: 300; font-size: 11px; letter-spacing: .08em; color: var(--ink-2); padding: 4px 8px; transition: transform 150ms var(--ease-out), color .25s var(--ease-out); }
  .tab.ok { color: var(--blue); }
  .tab.cur { color: var(--ink); }
  .tab.cur.ok { color: var(--blue); }
  .dot { position: absolute; left: 0; bottom: 3px; width: 4px; height: 4px; border-radius: 50%; background: var(--blue); }
  .dot.ready { transition: transform .52s cubic-bezier(.25, 1.25, .4, 1); }
  /* 两页叠在同一格，高度跟着当前这页；横着推的时候裁在卡片边上 */
  .pages { display: grid; overflow: hidden; margin: 0 -14px; padding: 0 14px; transition: height .32s var(--ease-out); }
  .qq { grid-area: 1 / 1; min-width: 0; padding: 2px 0 12px; }
  .multi { font-size: 10px; margin: -4px 0 8px; }
  .pv { font-family: var(--mono); font-weight: 300; font-size: 11.5px; line-height: 1.55; white-space: pre; overflow: auto; max-height: 34dvh; margin: 10px 0 0; padding: 9px 11px; border-radius: 10px;
    background: color-mix(in srgb, var(--paper) 70%, transparent); touch-action: pan-x pan-y; }
  .hdr { display: inline-block; font-family: var(--mono); font-weight: 300; font-size: 10.5px; letter-spacing: .12em; color: var(--tint-ink); background: var(--tint); padding: 2px 8px; border-radius: 9px; margin-bottom: 6px; }
  .qt { font-size: 15.5px; line-height: 1.6; margin-bottom: 8px; }
  .opts { display: flex; flex-direction: column; gap: 6px; }
  .opt { display: flex; align-items: flex-start; gap: 10px; text-align: left; padding: 9px 12px; border-radius: 12px; background: color-mix(in srgb, var(--paper) 72%, transparent); border: 1px solid transparent; transition: border-color .2s var(--ease-out), background .2s var(--ease-out); }
  .opt:active:not(:disabled) { transform: scale(0.985); }
  .opt.on { border-color: color-mix(in srgb, var(--blue) 55%, transparent); background: color-mix(in srgb, var(--blue-wash) 60%, var(--paper)); }
  /* 单选：里面一粒主色圆点弹出来；多选：方块填满主色，勾弹出来（只动 transform / opacity） */
  .mark { position: relative; flex: none; width: 15px; height: 15px; margin-top: 3px; border-radius: 50%; border: 1px solid var(--ink-2); display: flex; align-items: center; justify-content: center; color: var(--accent-ink); transition: background .2s var(--ease-out), border-color .2s var(--ease-out); }
  .mark::after { content: ''; position: absolute; inset: 3px; border-radius: 50%; background: var(--blue); transform: scale(0); transition: transform .28s var(--ease-spring); }
  .mark svg { opacity: 0; transform: scale(.5); transition: opacity .18s var(--ease-out), transform .28s var(--ease-spring); }
  .mark.sq { border-radius: 4px; }
  .mark.sq::after, .mark:not(.sq) svg { display: none; }
  .on .mark { border-color: var(--blue); }
  .on .mark:not(.sq)::after { transform: scale(1); }
  .on .mark.sq { background: var(--blue); }
  .on .mark.sq svg { opacity: 1; transform: none; }
  .ot { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .ol { font-size: 14.5px; line-height: 1.5; }
  .od { font-size: 12.5px; line-height: 1.5; color: var(--ink-2); }
  .other { font-size: 16px; padding: 7px 12px; border-radius: 12px; background: color-mix(in srgb, var(--paper) 50%, transparent); border: 1px dashed var(--rule); }
  .other::placeholder { color: var(--ink-2); opacity: .6; font-size: 14px; }
  .done { margin: 0 0 10px; display: flex; gap: 8px; align-items: baseline; font-size: 10.5px; }
  .tag { flex: none; }
  .dt { color: var(--ink-2); font-family: var(--serif); font-size: 12.5px; letter-spacing: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
</style>
