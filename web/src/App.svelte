<script lang="ts">
  import { onMount } from 'svelte';
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { app, connect, settings, takeTokenFromUrl } from './lib/state.svelte';
  import { loadSessions, startTermEvents, termBadge } from './lib/term.svelte';
  import Setup from './screens/Setup.svelte';
  import Term from './screens/Term.svelte';

  onMount(async () => {
    takeTokenFromUrl();
    if (settings.token && await connect()) {
      app.screen = 'main';
      startTermEvents();
      void loadSessions();
    } else {
      app.screen = 'setup';
    }
    window.addEventListener('online', () => { if (app.screen === 'main') void connect().then(ok => { if (ok) startTermEvents(); }); });
  });

  // 切到别的应用时，标签页标题上看得出有没有会话在等你点头
  $effect(() => {
    const b = app.screen === 'main' ? termBadge() : '';
    document.title = (b === 'wait' ? '● ' : b === 'busy' ? '○ ' : '') + '工坊';
  });
</script>

{#key app.screen}
  <div class="screen" in:fly={{ x: 48, duration: 420, easing: cubicOut, opacity: 0 }} out:fly={{ x: -28, duration: 260, easing: cubicOut, opacity: 0 }}>
    {#if app.screen === 'setup'}<Setup />{:else if app.screen === 'main'}<Term />{/if}
  </div>
{/key}

<style>
  .screen { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--paper); }
</style>
