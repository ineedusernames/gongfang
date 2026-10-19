<script lang="ts">
  // 首页：这台电脑上的 cc 会话，新的在上，按天分组。点一条推进去接着说；右上角加号在某个目录里新开一个。
  // 在干活的会话一粒呼吸的主色点，等你点头的描一圈主色线；电脑上正开着的标 -on pc-（接着说会分出一条新的，不和电脑上的抢）。
  import Page from '../components/Page.svelte';
  import Sheet from '../components/Sheet.svelte';
  import TermSession from './TermSession.svelte';
  import { familyPick, loadDirs, loadSessions, openSession, startNew, term } from '../lib/term.svelte';
  import type { TermSession as TS } from '../lib/term';
  import { haptic } from '../lib/haptic';
  import { app } from '../lib/state.svelte';
  import { untrack } from 'svelte';

  $effect(() => { untrack(() => { if (!term.loaded) void loadSessions(); }); });

  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  // 同一家的会话（电脑上开着时从手机分出来的那条，和原来那条）并成一张卡片：显示该点开的那一条，状态取一家里最要紧的
  type Card = { key: string; s: TS; n: number; updated: number; waiting: boolean; busy: boolean; live: boolean; pcBusy: boolean };
  const cards = $derived.by(() => {
    const by = new Map<string, TS[]>();
    for (const s of term.sessions) { const k = s.root || s.id; const f = by.get(k); if (f) f.push(s); else by.set(k, [s]); }
    const out: Card[] = [];
    for (const [key, fam] of by) out.push({
      key, s: familyPick(fam), n: fam.length, updated: Math.max(...fam.map(x => x.updated)),
      waiting: fam.some(x => x.waiting), busy: fam.some(x => x.busy), live: fam.some(x => x.live), pcBusy: fam.some(x => x.pcBusy),
    });
    return out.sort((a, b) => b.updated - a.updated);
  });
  const groups = $derived.by(() => {
    const out: Array<{ key: string; label: string; wd: string; items: Card[] }> = [];
    const today = new Date().toDateString();
    for (const c of cards) {
      const d = new Date(c.updated);
      const key = d.toDateString();
      let g = out.at(-1);
      if (!g || g.key !== key) { g = { key, label: `#${pad(d.getMonth() + 1)}${pad(d.getDate())}`, wd: key === today ? '今天' : '星期' + '日一二三四五六'[d.getDay()], items: [] }; out.push(g); }
      g.items.push(c);
    }
    return out;
  });
  function stats(s: TS) {
    const p: string[] = [];
    if (s.stats.edits) p.push(`改 ${s.stats.edits}`);
    if (s.stats.cmds) p.push(`跑 ${s.stats.cmds}`);
    if (s.stats.turns) p.push(`说了 ${s.stats.turns} 句`);
    return p.join(' · ');
  }
  const statusOf = (c: Card) => (c.waiting ? '-waiting-' : c.busy ? '-working-' : c.pcBusy ? '-on pc-' : c.live ? '-live-' : '');

  // 新开：先挑在哪个目录
  let sheetRef: Sheet | undefined = $state();
  let custom = $state('');
  function openNew() { haptic('tick'); term.sheet = 'new'; void loadDirs(); }
  function pickDir(cwd: string) {
    const c = cwd.trim().replace(/\\/g, '/');
    if (!c) return;
    haptic('select');
    sheetRef?.close();
    setTimeout(() => startNew(c), 160);
  }
  function open(s: TS) { haptic('tick'); void openSession(s.id); }
</script>

<Page tab title="工坊" label={cards.length ? `-${cards.length}-` : ''}>
  {#snippet right()}
    <button class="icon" aria-label="新开一个会话" onclick={openNew}>
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"><path d="M11 5v12M5 11h12"/></svg>
    </button>
  {/snippet}

  {#if app.problem}<p class="problem">{app.problem}</p>{/if}

  <div class="stagger">
    {#each groups as g, gi (g.key)}
      <div class="dday" style="--i:{gi}"><span class="chip">{g.label}</span><span class="label">{g.wd}</span></div>
      {#each g.items as c (c.key)}
        {@const s = c.s}
        {@const st = statusOf(c)}
        <button class="card" class:wait={c.waiting} style="--i:{gi}" onclick={() => open(s)}>
          <span class="head">
            <span class="label proj">{s.project}</span>
            {#if c.n > 1}<span class="label vers">{c.n} 版</span>{/if}
            {#if st}<span class="label st" class:warn={c.busy || c.waiting} class:breathe={c.busy && !c.waiting}>{st}</span>{/if}
            <span class="label time">{hhmm(c.updated)}</span>
          </span>
          <span class="title">{s.title || '（没有标题）'}</span>
          <span class="foot">
            {#if s.stats.adds || s.stats.dels}<span class="chips"><span class="add">+{s.stats.adds}</span><span class="del">−{s.stats.dels}</span></span>{/if}
            <span class="label">{stats(s)}</span>
          </span>
        </button>
      {/each}
    {/each}
  </div>

  {#if term.loaded && !term.sessions.length}
    <div class="empty">
      <div class="blot"></div>
      <p class="label">{term.failed ? '-offline-' : '-还没有会话-'}</p>
      {#if !term.failed}<p class="hint">右上角加号，挑个目录让 Claude 开工。</p>
      {:else}<button class="relink label" onclick={() => { app.screen = 'setup'; }}>换个地址 / 钥匙</button>{/if}
    </div>
  {/if}
  {#if !term.loaded}<p class="label breathe more">…</p>{/if}
</Page>

{#if term.view}<TermSession />{/if}

{#if term.sheet === 'new'}
  <Sheet bind:this={sheetRef} title="-new-" onclose={() => { term.sheet = null; }}>
    <div class="pane soft-in">
      <p class="hint lead">在哪个目录里开？</p>
      {#each term.dirs as d (d.cwd)}
        <button class="row" onclick={() => pickDir(d.cwd)}>
          <svg width="18" height="18" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7a2 2 0 0 1 2-2h3.5l2 2h6a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-11.5a2 2 0 0 1-2-2z"/></svg>
          <span class="dl"><span>{d.project}</span><span class="label mono">{d.cwd}</span></span>
          <span class="label">{d.count}</span>
        </button>
      {/each}
      <div class="custom">
        <input bind:value={custom} placeholder="别的目录的完整路径" autocapitalize="off" autocomplete="off" spellcheck="false" enterkeyhint="go" onkeydown={(e) => { if (e.key === 'Enter') pickDir(custom); }} />
        <button class="go" disabled={!custom.trim()} onclick={() => pickDir(custom)}>开</button>
      </div>
    </div>
  </Sheet>
{/if}

<style>
  .icon { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; color: var(--ink); }
  .dday { display: flex; align-items: center; gap: 10px; margin: 18px 2px 10px; }
  .dday:first-child { margin-top: 4px; }
  .chip { font-family: var(--mono); font-weight: 300; font-size: 11px; letter-spacing: .14em; color: var(--tint-ink); background: var(--tint); padding: 3px 9px; border-radius: 10px; }
  .card { width: 100%; display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 11px 16px 12px; border-radius: 16px; margin-bottom: 8px;
    background: color-mix(in srgb, var(--tint) 58%, transparent); border: 1px solid transparent; transition: border-color .3s var(--ease-out), transform 150ms var(--ease-out); }
  .card:active:not(:disabled) { transform: scale(0.985); }
  .card.wait { border-color: color-mix(in srgb, var(--blue) 45%, transparent); }
  .head { display: flex; align-items: baseline; gap: 8px; }
  .proj { font-size: 10.5px; }
  .st { font-size: 10px; }
  /* 一家有好几版：小小一格，和会话页顶上的 ‹1/2› 同一个意思 */
  .vers { font-size: 10px; color: var(--ink-2); background: color-mix(in srgb, var(--ink) 7%, transparent); padding: 0 6px; border-radius: 8px; letter-spacing: .06em; }
  .warn { color: var(--blue); }
  .time { margin-left: auto; font-size: 10px; }
  .title { font-size: 15.5px; line-height: 1.55; color: var(--ink); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .foot { display: flex; align-items: center; gap: 8px; }
  .foot .label { font-size: 10px; }
  .chips { display: inline-flex; font-family: var(--mono); font-size: 10px; border-radius: 6px; overflow: hidden; }
  .chips span { padding: 0 5px; }
  .add { color: var(--blue); background: var(--blue-wash); }
  .del { color: var(--ink-2); background: color-mix(in srgb, var(--ink) 7%, transparent); }
  .empty { height: 50dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; }
  .blot { width: 22px; height: 22px; border-radius: 46% 54% 50% 50% / 52% 48% 52% 48%; background: var(--blue); margin-bottom: 4px; }
  .hint { font-size: 13px; color: var(--ink-2); }
  .more { text-align: center; margin-top: 30px; }
  .problem { font-size: 12.5px; line-height: 1.65; color: var(--ink-2); padding: 10px 14px; margin: 4px 0 10px; border-radius: 14px; border: 1px solid color-mix(in srgb, var(--blue) 45%, transparent); }
  .relink { color: var(--blue); padding: 6px 10px; }

  .lead { margin: -4px 0 6px; }
  .row { width: 100%; display: flex; align-items: center; gap: 12px; padding: 11px 4px; text-align: left; font-size: 15px; border-bottom: 1px solid var(--rule); }
  .dl { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .dl .mono { font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .custom { display: flex; gap: 8px; margin-top: 14px; }
  .custom input { flex: 1; min-width: 0; font-family: var(--mono); font-size: 16px; padding: 8px 12px; border-radius: 12px; background: var(--paper-2); }
  .go { flex: none; background: var(--blue); color: var(--accent-ink); font-size: 14px; padding: 0 18px; border-radius: 18px; }
  .go:disabled { opacity: .35; }
</style>
