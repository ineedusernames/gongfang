<script lang="ts">
  // 连接页：电脑地址 + 钥匙。电脑上启动工坊时会打印带钥匙的地址，在手机上直接点开就不用到这里来。
  import { app, connect, saveSettings, settings } from '../lib/state.svelte';
  import { loadSessions, startTermEvents } from '../lib/term.svelte';
  import { haptic } from '../lib/haptic';

  let base = $state(settings.baseUrl);
  let token = $state(settings.token);
  let busy = $state(false);

  async function go() {
    if (busy || !base.trim() || !token.trim()) return;
    haptic('tick');
    busy = true;
    settings.baseUrl = base.trim().replace(/\/+$/, '');
    settings.token = token.trim();
    const ok = await connect();
    busy = false;
    if (!ok) return;
    saveSettings();
    app.screen = 'main';
    startTermEvents();
    void loadSessions();
  }
</script>

<section class="setup">
  <div class="inner">
    <div class="blot"></div>
    <h1>工坊</h1>
    <p class="hint">在手机上看、接着用电脑上的 Claude Code。</p>

    <label class="field">
      <span class="label">-address-</span>
      <input bind:value={base} placeholder="http://192.168.1.10:4800" autocapitalize="off" autocomplete="off" spellcheck="false" inputmode="url" />
    </label>
    <label class="field">
      <span class="label">-token-</span>
      <input bind:value={token} placeholder="config.json 里的 token" autocapitalize="off" autocomplete="off" spellcheck="false" type="password"
        onkeydown={(e) => { if (e.key === 'Enter') void go(); }} />
    </label>

    {#if app.error}<p class="err label">{app.error}</p>{/if}
    <button class="go" disabled={busy || !base.trim() || !token.trim()} onclick={go}>{busy ? '…' : '连接'}</button>

    <p class="hint small">电脑上跑 <span class="mono">pnpm start</span> 时会打印带钥匙的地址，在手机上点开那个地址就不用填。</p>
  </div>
</section>

<style>
  .setup { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: calc(var(--sat) + 24px) 28px calc(var(--sab) + 24px);
    background-color: var(--paper); background-image: radial-gradient(130% 48% at 50% -6%, var(--wash), transparent 74%), var(--grain); overflow-y: auto; }
  .inner { width: 100%; max-width: 380px; display: flex; flex-direction: column; gap: 14px; }
  .blot { width: 22px; height: 22px; border-radius: 46% 54% 50% 50% / 52% 48% 52% 48%; background: var(--blue); }
  h1 { font-weight: 400; font-size: 26px; letter-spacing: .2em; margin-top: 4px; }
  .hint { font-size: 13.5px; color: var(--ink-2); margin-bottom: 14px; }
  .hint.small { font-size: 12px; line-height: 1.7; margin: 10px 0 0; }
  .field { display: flex; flex-direction: column; gap: 6px; }
  .field input { font-family: var(--mono); font-weight: 300; font-size: 16px; padding: 10px 14px; border-radius: 12px; background: var(--paper-2); }
  .err { color: var(--blue); }
  .go { margin-top: 6px; background: var(--blue); color: var(--accent-ink); font-size: 15px; letter-spacing: .2em; padding: 11px 0; border-radius: 22px; }
  .go:disabled { opacity: .35; }
</style>
