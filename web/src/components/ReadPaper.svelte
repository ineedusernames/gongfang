<script lang="ts">
  // "选择文字"：把一轮回复摊在一张全屏的纸上，只有字，不再长、不再往前加载，想从哪划到哪都行。
  // 会话页里内容一直在变（流式、往前翻、钉底），系统的划选手柄跨屏拖着拖着就丢了；这里是静止的一页。
  // 右上角复制全部；系统返回键 / 左上角收起。
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { renderMd } from '../lib/md';
  import { codeBlocks } from '../lib/codeblock';
  import { copyText } from '../lib/copy';
  import { haptic } from '../lib/haptic';
  import { backHandlers } from '../lib/state.svelte';

  let { text, onclose }: { text: string; onclose: () => void } = $props();
  let copied = $state(false);

  onMount(() => {
    try { history.pushState({ layer: 'paper' }, ''); } catch { /* ignore */ }
    const h = () => { onclose(); return true; };
    backHandlers.unshift(h);   // 压在会话页上面：返回键先收这张纸
    return () => { const i = backHandlers.indexOf(h); if (i >= 0) backHandlers.splice(i, 1); };
  });
  function close() { if (history.state?.layer === 'paper') history.back(); else onclose(); }
  async function copyAll() {
    if (!await copyText(text)) return;
    haptic('select');
    copied = true;
    setTimeout(() => { copied = false; }, 1200);
  }
</script>

<section class="rp" in:fly={{ y: 24, duration: 320, easing: cubicOut, opacity: 0 }} out:fly={{ y: 24, duration: 220, easing: cubicOut, opacity: 0 }}>
  <header class="top">
    <button class="icon" aria-label="收起" onclick={close}>
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l10 10M16 6L6 16"/></svg>
    </button>
    <span class="label">-select-</span>
    <button class="icon" aria-label="复制全部" onclick={copyAll}>
      {#if copied}
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>
      {:else}
        <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 5V4.5A1.5 1.5 0 0 0 11.5 3h-7A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13H5"/></svg>
      {/if}
    </button>
  </header>
  <div class="body">
    <div class="md" use:codeBlocks>{@html renderMd(text)}</div>
  </div>
</section>

<style>
  .rp { position: absolute; inset: 0; z-index: 30; display: flex; flex-direction: column; background-color: var(--paper); background-image: var(--grain); }
  .top { flex: none; display: flex; align-items: center; justify-content: space-between; padding: calc(var(--sat) + 8px) 8px 4px; }
  .icon { width: 40px; height: 40px; display: flex; align-items: center; justify-content: center; color: var(--ink); }
  /* 普通的滚动框：不加遮罩、不加动画，划选手柄拖到边上就跟着滚 */
  .body { flex: 1; overflow-y: auto; padding: 6px 20px calc(var(--sab) + 40px); -webkit-user-select: text; user-select: text; }
  .md { font-size: 16px; line-height: 1.8; word-break: break-word; }
  .md :global(p) { margin: 0 0 .7em; }
  .md :global(ul), .md :global(ol) { margin: .1em 0 .7em 1.2em; }
  .md :global(li) { margin: .12em 0; }
  .md :global(strong) { font-weight: 500; }
  .md :global(blockquote) { margin: .2em 0 .7em; padding-left: 10px; border-left: 1px solid var(--rule); color: var(--ink-2); }
  .md :global(code) { font-family: var(--mono); font-weight: 300; font-size: .82em; color: var(--blue); background: var(--blue-wash); padding: .08em .35em; border-radius: 4px; word-break: break-all; }
  .md :global(pre) { font-family: var(--mono); font-weight: 300; font-size: 12.5px; line-height: 1.7; margin: .3em 0 .8em; }
  .md :global(pre code) { color: var(--ink); word-break: normal; }
  .md :global(a) { color: var(--blue); text-decoration: none; border-bottom: 1px solid var(--blue); }
  .md :global(hr) { border: 0; border-top: 1px solid var(--rule); margin: .8em 0; }
  .md :global(table) { display: block; overflow-x: auto; border-collapse: collapse; font-size: 13px; }
  .md :global(th), .md :global(td) { padding: 3px 12px 3px 0; text-align: left; border-bottom: 1px solid var(--rule); font-weight: 400; }
</style>
