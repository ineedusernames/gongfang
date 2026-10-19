<script lang="ts">
  // 页面的壳：从右边推进来、往右边退出去；顶上一抹淡淡的主色，纸的颗粒。宋体标题 + 等宽小标签，SVG 线条图标。
  // tab = 首页：没有返回箭头、不自己推进来。
  import type { Snippet } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';

  let { title, label = '', onclose, children, right, tab = false, body = $bindable() }:
    { title: string; label?: string; onclose?: () => void; children: Snippet; right?: Snippet; tab?: boolean; body?: HTMLElement } = $props();
  const inT = $derived(tab ? { duration: 0 } : { x: 56, duration: 380, easing: cubicOut, opacity: 0 });
  const outT = $derived(tab ? { duration: 0 } : { x: 56, duration: 260, easing: cubicOut, opacity: 0 });
</script>

<section class="page" class:tab in:fly={inT} out:fly={outT}>
  <header class="phead">
    {#if !tab}
      <button class="back" aria-label="返回" onclick={onclose}>
        <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 5l-6 6 6 6"/></svg>
      </button>
    {/if}
    <h1>{title}</h1>
    {#if label}<span class="label">{label}</span>{/if}
    {@render right?.()}
  </header>
  <div class="pbody" bind:this={body}>{@render children()}</div>
</section>

<style>
  .page {
    position: absolute; inset: 0; z-index: 8; display: flex; flex-direction: column;
    background-color: var(--paper);
    background-image: radial-gradient(130% 48% at 50% -6%, var(--wash), transparent 74%), var(--grain);
  }
  .page.tab { z-index: auto; }
  .phead { display: flex; align-items: center; gap: 8px; padding: calc(var(--sat) + 10px) 16px 6px 8px; }
  .tab .phead { padding-left: 20px; padding-top: calc(var(--sat) + 14px); }
  .phead h1 { font-weight: 400; font-size: 19px; letter-spacing: .14em; flex: 1; }
  .back { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; color: var(--ink); }
  /* 上边缘 10px 由透明渐入，内容不会硬切在标题栏底下 */
  .pbody { flex: 1; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 8px 16px calc(var(--sab) + 28px);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 10px); mask-image: linear-gradient(to bottom, transparent 0, #000 10px); }
  /* 底下有东西盖着时（--nav-h）：留出它的高度，下边缘也 10px 渐隐 */
  .tab .pbody { padding-bottom: calc(var(--nav-h, 0px) + 24px);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 10px, #000 calc(100% - var(--nav-h, 0px) - 10px), transparent calc(100% - var(--nav-h, 0px)));
    mask-image: linear-gradient(to bottom, transparent 0, #000 10px, #000 calc(100% - var(--nav-h, 0px) - 10px), transparent calc(100% - var(--nav-h, 0px))); }
</style>
