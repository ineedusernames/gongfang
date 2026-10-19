<script lang="ts">
  // 打开的一个会话（从右边推进来，盖住列表）。排法照 Remote Control：
  //   你的话 = 右边灰气泡；Claude 的话不套框，直接写在纸上（它在干活，字多，气泡压着难读）；
  //   连着的一串工具调用收成一行"改了 3 个文件，跑了 2 条命令 +13 −7 ›"，点开是抽屉；读到的图在那一行下面排小图；
  //   要你点头的（权限 / 选项）是一张描了主色细线的卡片；每轮结束一行小字：时间 · 模型 · 用了多久。
  // 输入条是一个毛玻璃框：左下角加号（照片）、斜杠命令、权限模式、模型、effort，右边发 / 停。
  import { tick, untrack } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { app, EFFORTS, effortLabel, modelShort } from '../lib/state.svelte';
  import { closeProcess, closeSession, cmds, familyOf, interruptTerm, loadCommands, loadEarlier, MODES, modeLabel, openSession, sendTerm, setTermEffort, setTermMode, setTermModel, term, termImg, type TermView } from '../lib/term.svelte';
  import type { TermCmd, TermItem } from '../lib/term';
  import { summarize, toolInfo, type ToolItem } from '../lib/tools';
  import { renderMd, renderMdLive, renderOut } from '../lib/md';
  import { splitCmd } from '../lib/cmds';
  import CmdMenu from '../components/CmdMenu.svelte';
  import { prepImage, type Picked } from '../lib/image';
  import { loadDraft, saveDraft } from '../lib/drafts';
  import { haptic } from '../lib/haptic';
  import Sheet from '../components/Sheet.svelte';
  import ToolSheet from '../components/ToolSheet.svelte';
  import ToolIcon from '../components/ToolIcon.svelte';
  import AskCard from '../components/AskCard.svelte';
  import ImageViewer from '../components/ImageViewer.svelte';

  // 关掉时 term.view 马上变成 null，但页面还要往右滑出去 260ms：这段时间照旧显示最后那一份，不先变空白
  let keep: TermView | null = term.view;
  const v = $derived.by(() => { if (term.view) keep = term.view; return keep!; });
  const s = $derived(v?.session);
  const project = $derived((v?.cwd || '').replace(/\/+$/, '').split('/').pop() || v?.cwd || '');
  const busy = $derived(!!s?.busy);

  // ---- 记录 → 一块块 ----
  type Think = Extract<TermItem, { k: 'think' }>;
  type Block =
    | { type: 'item'; key: string; item: TermItem }
    | { type: 'tools'; key: string; steps: Array<ToolItem | Think>; running: ToolItem | null };
  const blocks = $derived.by(() => {
    const items = v?.items ?? [];
    const out: Block[] = [];
    let g: Extract<Block, { type: 'tools' }> | null = null;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.k === 'tool') {
        if (!g) { g = { type: 'tools', key: 'g-' + it.id, steps: [], running: null }; out.push(g); }
        g.steps.push(it);
        if (it.state === 'run' && !it.sub) g.running = it;
        continue;
      }
      if (it.k === 'think') {
        // 夹在工具中间的思考、以及紧跟着就去调工具的思考，算进那一串（抽屉里一行"想了想"）
        let j = i + 1;
        while (j < items.length && items[j].k === 'think') j++;
        if (g || items[j]?.k === 'tool') {
          if (!g) { g = { type: 'tools', key: 'g-' + it.id, steps: [], running: null }; out.push(g); }
          g.steps.push(it);
          continue;
        }
      }
      g = null;
      out.push({ type: 'item', key: it.id, item: it });
    }
    return out;
  });
  // 这一轮还在跑、最后一块也不是正在长的字：底下挂一行"在干什么"
  const lastBlock = $derived(blocks.at(-1));
  const activity = $derived.by(() => {
    if (!busy) return '';
    if (lastBlock?.type === 'tools' && lastBlock.running) return '';   // 那一行底下已经写着在跑什么
    if (lastBlock?.type === 'item' && lastBlock.item.k === 'ask' && lastBlock.item.state === 'wait') return '';
    if (lastBlock?.type === 'item' && lastBlock.item.k === 'text') return '';
    return '在想';
  });

  // 打开之前就有的不播进场（整列加载直接落定），打开之后来的才柔进场
  const openedAt = $derived.by(() => { void v?.sid; return Date.now() - 1500; });
  const fresh = (b: Block) => (b.type === 'tools' ? b.steps[0].t : b.item.t) > openedAt;

  // ---- 滚动：在底部就跟着长；翻上去看旧的就不动 ----
  let listEl: HTMLElement | undefined = $state();
  let flowEl: HTMLElement | undefined = $state();
  let barEl: HTMLElement | undefined = $state();
  let topEl: HTMLElement | undefined = $state();
  let stick = true;
  let showDown = $state(false);
  function onScroll() {
    if (!listEl) return;
    const gap = listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight;
    stick = gap < 60;
    showDown = gap > 400;
    if (listEl.scrollTop < 600 && v?.before !== null && !v?.more) void earlier();
  }
  function toBottom(smooth = false) {
    if (!listEl) return;
    listEl.scrollTo({ top: listEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }
  $effect(() => {
    const f = flowEl, l = listEl;
    if (!f || !l) return;
    const ro = new ResizeObserver(() => { if (stick) l.scrollTop = l.scrollHeight; });
    ro.observe(f);
    return () => ro.disconnect();
  });
  // 推进来的那 380ms 里不排记录（几十条消息一起排版会让推进掉帧）：推到位了再一次性铺上、淡进来。
  // 快照到了：直接落到底，不平滑滚
  let entered = $state(false);
  $effect(() => { const t = setTimeout(() => { entered = true; }, 450); return () => clearTimeout(t); });   // 兜底：没播进场也照样铺上
  $effect(() => {
    const loading = v?.loading;
    if (loading === false && entered) untrack(() => { stick = true; void tick().then(() => toBottom(false)); });
  });
  // 往前翻：拿到更早的一段后保持眼前这条不动
  async function earlier() {
    if (!listEl) return;
    const h0 = listEl.scrollHeight, t0 = listEl.scrollTop;
    await loadEarlier();
    await tick();
    if (listEl) listEl.scrollTop = t0 + (listEl.scrollHeight - h0);
  }

  // 顶栏 / 输入条的高度给列表留位置
  function measure() {
    const host = listEl?.parentElement;
    if (!host || !barEl || !topEl) return;
    host.style.setProperty('--ts-top', topEl.offsetHeight + 'px');
    host.style.setProperty('--ts-bar', barEl.offsetHeight + 'px');
  }
  $effect(() => {
    if (!barEl || !topEl) return;
    measure();
    const ro = new ResizeObserver(measure); ro.observe(barEl); ro.observe(topEl);
    return () => ro.disconnect();
  });
  // 键盘弹起、列表变矮：本来在底部的话还钉在底部
  $effect(() => {
    const l = listEl;
    if (!l) return;
    const ro = new ResizeObserver(() => { if (stick) l.scrollTop = l.scrollHeight; });
    ro.observe(l);
    return () => ro.disconnect();
  });

  // ---- 输入 ----
  let draft = $state('');
  let picks = $state<Picked[]>([]);
  let taEl: HTMLTextAreaElement | undefined = $state();
  let taWrap: HTMLElement | undefined = $state();
  let photoEl: HTMLInputElement | undefined = $state();
  function autosize() {
    if (!taEl || !taWrap) return;
    taEl.style.height = '0px';
    const h = Math.min(taEl.scrollHeight, 160) + 'px';
    taEl.style.height = h;
    taWrap.style.height = h;
    persistDraft();
  }
  // 没发出去的字和图：一个会话一份（lib/drafts.ts），退回列表、浏览器重开都还在。
  // 换了会话（切版本、新会话拿到 id、分叉跟过去）：框里有字就带过去，空的就拿那个会话自己存的
  const dkey = $derived(v?.sid ?? 'new:' + (v?.cwd ?? ''));
  let loadedKey = '';
  function persistDraft() { if (loadedKey) saveDraft(loadedKey, { text: draft, picks }); }
  $effect(() => {
    const k = dkey;
    untrack(() => {
      if (k === loadedKey) return;
      loadedKey = k;
      if (draft.trim() || picks.length) { persistDraft(); return; }
      void loadDraft(k).then(d => {
        if (loadedKey !== k || !d || draft.trim() || picks.length) return;
        draft = d.text; picks = d.picks;
        void tick().then(autosize);
      });
    });
  });
  async function onPhotos(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    for (const f of files) {
      if (picks.length >= 4) break;
      try { picks = [...picks, await prepImage(f)]; } catch { /* 读不了的跳过 */ }
    }
    persistDraft();
  }
  async function submit() {
    const t = draft, ps = picks;
    if (!t.trim() && !ps.length) return;
    haptic('tick');
    draft = ''; picks = []; caret = 0;
    await tick(); autosize();
    stick = true;
    await sendTerm(t, ps);
  }

  // ---- 斜杠命令：光标落在开头那个 /词 里就浮出清单（CmdMenu），点一个替掉那个词 ----
  // 清单按目录拿一次（打开会话就先拿着，打 / 时不用等）
  $effect(() => { const c = v?.cwd; if (c) untrack(() => { void loadCommands(c); }); });
  let focused = $state(false);
  let caret = $state(0);
  const syncCaret = () => { if (taEl) caret = taEl.selectionStart ?? draft.length; };
  const cmdTok = $derived(draft.match(/^\/([^\s/]*)/));
  const menuOpen = $derived(!!v?.cwd && focused && !!cmdTok && caret >= 1 && caret <= cmdTok[0].length);
  function pickCmd(c: TermCmd) {
    haptic('select');
    const m = draft.match(/^\/[^\s/]*\s?/);
    draft = '/' + c.name + ' ' + (m ? draft.slice(m[0].length) : draft);
    const pos = c.name.length + 2;
    void tick().then(() => { taEl?.focus(); taEl?.setSelectionRange(pos, pos); caret = pos; autosize(); });
  }
  // 输入框左下角的 / ：手机键盘上找斜杠麻烦，点它就开清单；开着时再点收起
  function toggleCmds() {
    haptic('tick');
    if (menuOpen) {
      if (draft === '/') draft = '';
      const end = draft.length;
      void tick().then(() => { taEl?.setSelectionRange(end, end); caret = end; autosize(); });
      return;
    }
    if (!draft.startsWith('/')) draft = '/' + (draft ? ' ' + draft : '');
    const pos = (draft.match(/^\/[^\s/]*/)?.[0].length) ?? 1;
    void tick().then(() => { taEl?.focus(); taEl?.setSelectionRange(pos, pos); caret = pos; autosize(); });
  }
  // 选好的命令要参数（/model <model>）：框顶上一行小字提示，打了参数就收起
  const argHint = $derived.by(() => {
    const m = draft.match(/^\/([^\s/]+) $/);
    if (!m || !v?.cwd) return null;
    const c = cmds.by[v.cwd]?.list.find(x => x.name === m[1]);
    return c?.hint ? { name: c.name, hint: c.hint } : null;
  });
  let lastHint = $state<{ name: string; hint: string } | null>(null);   // 收起的 0.28s 里字还留着
  $effect(() => { if (argHint) lastHint = argHint; });
  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void submit(); }
  }

  // ---- 抽屉 ----
  let toolSteps = $state<Array<ToolItem | Think> | null>(null);
  let sheetRef: Sheet | undefined = $state();
  function openTools(b: Extract<Block, { type: 'tools' }>) { haptic('tick'); toolSteps = b.steps; }

  const pad = (n: number) => String(n).padStart(2, '0');
  const hhmm = (t: number) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const secs = (ms?: number) => (!ms ? '' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m${pad(Math.round((ms % 60000) / 1000))}s`);
  const status = $derived(!s ? '' : s.waiting ? '-waiting-' : s.busy ? '-working-' : s.pcBusy ? '-on pc-' : s.live ? '-live-' : '');
  // 同一家有好几版（电脑上开着时从手机分出来的）：顶上 ‹ 1/2 › 切
  const fam = $derived(familyOf(s));
  const famAt = $derived(fam.findIndex(x => x.id === v?.sid));
  function goVer(d: number) {
    const to = fam[famAt + d];
    if (!to) return;
    haptic('select');
    void openSession(to.id);
  }
  // 一串工具里读到的图，排在那一行下面
  // 图按内容命名：同一张图看了两遍（一模一样的截图）src 就一样，只留一张——不然下面按 src 当 key 的 each 会撞 key，整页空白
  const shotsOf = (b: Extract<Block, { type: 'tools' }>) => b.steps.flatMap(x => (x.k === 'tool' ? x.result?.images ?? [] : [])).filter((im, i, all) => all.findIndex(o => o.src === im.src) === i).slice(0, 6);
  let viewer = $state<string | null>(null);
</script>

<section class="ts" onintroend={() => { entered = true; }} in:fly={{ x: 56, duration: 380, easing: cubicOut, opacity: 0 }} out:fly={{ x: 56, duration: 260, easing: cubicOut, opacity: 0 }}>
  <header class="top" bind:this={topEl}>
    <button class="icon" aria-label="返回" onclick={closeSession}>
      <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 5l-6 6 6 6"/></svg>
    </button>
    <div class="tt">
      <h1>{s?.title || (v?.sid ? '…' : '新会话')}</h1>
      <span class="sub">
        <span class="label">{project}</span>
        {#if fam.length > 1 && famAt >= 0}
          <span class="ver">
            <button class="vbtn" aria-label="上一版" disabled={famAt === 0} onclick={() => goVer(-1)}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 2.5L4 6l3.5 3.5"/></svg>
            </button>
            <span class="label vnum">{famAt + 1}/{fam.length}</span>
            <button class="vbtn" aria-label="下一版" disabled={famAt === fam.length - 1} onclick={() => goVer(1)}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>
            </button>
          </span>
        {/if}
        {#key status}{#if status}<span class="label st" class:breathe={s?.busy} class:warn={s?.waiting || s?.busy} in:fade={{ duration: 200 }}>{status}</span>{/if}{/key}
      </span>
    </div>
    <button class="icon" aria-label="更多" onclick={() => { term.sheet = 'more'; }} disabled={!v?.sid}>
      <svg width="20" height="20" viewBox="0 0 22 22" fill="currentColor"><circle cx="5.5" cy="11" r="1.2"/><circle cx="11" cy="11" r="1.2"/><circle cx="16.5" cy="11" r="1.2"/></svg>
    </button>
  </header>

  <main class="list" bind:this={listEl} onscroll={onScroll}>
    <div class="flow" bind:this={flowEl}>
      {#if v?.more}<p class="label breathe center">…</p>{/if}
      {#if v?.loading && !v.items.length}
        <p class="label breathe center pad">…</p>
      {:else if v?.failed && !v.items.length}
        <div class="empty"><p class="label">-offline-</p><p class="hint">{v.failed}</p></div>
      {:else if !v?.items.length}
        <div class="empty" in:fade={{ duration: 320 }}>
          <div class="blot"></div>
          <p class="line">在 <span class="mono">{project}</span> 里开一个新会话</p>
          <p class="hint mono">{v?.cwd}</p>
          <p class="hint">第一句发出去，Claude 就在电脑上开工。</p>
        </div>
      {/if}

      {#if entered}{#key v?.sid}<div class="all">
      {#each blocks as b (b.key)}
        {#if b.type === 'tools'}
          {@const sm = summarize(b.steps.filter((x): x is ToolItem => x.k === 'tool'))}
          {@const shots = shotsOf(b)}
          <div class="run" class:soft-in={fresh(b)}>
            <button class="runrow" onclick={() => openTools(b)}>
              {#if b.running}<i class="pulse"></i>{/if}
              <span class="rt">{sm.text}</span>
              {#if sm.adds || sm.dels}<span class="chips"><span class="add">+{sm.adds}</span><span class="del">−{sm.dels}</span></span>{/if}
              <svg class="chev" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>
            </button>
            {#if b.running}
              {@const f = toolInfo(b.running)}
              {#key b.running.id}<p class="now" in:fade={{ duration: 220 }}><ToolIcon icon={f.icon} size={14} /><span>{f.verb}</span><span class="tg" class:mono={f.mono}>{f.target}</span></p>{/key}
            {/if}
            {#if shots.length}
              <div class="shots">
                {#each shots as im (im.src)}
                  <button class="shot soft-in" onclick={() => { viewer = termImg(im.src); }}><img src={termImg(im.src)} alt="" loading="lazy" style:aspect-ratio={im.w && im.h ? `${im.w}/${im.h}` : null} /></button>
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          {@const it = b.item}
          {#if it.k === 'user'}
            <div class="u" class:fade-in={fresh(b)}>
              {#if it.images?.length}
                <div class="pics">{#each it.images as im, k (k)}<button class="pic" onclick={() => { viewer = termImg(im.src); }}><img src={termImg(im.src)} alt="" /></button>{/each}</div>
              {/if}
              {#if it.text}
                {@const sc = splitCmd(it.text)}
                <div class="b">{#if sc}<span class="cmd">/{sc.name}</span>{sc.rest}{:else}{it.text}{/if}</div>
              {/if}
            </div>
          {:else if it.k === 'out'}
            <!-- 斜杠命令的输出：一张淡底卡片，左上角 -output-，表格横着滑 -->
            <div class="out" class:err={it.tone === 'err'} class:soft-in={fresh(b)}>
              <span class="label ol">-output-</span>
              <div class="md">{@html renderOut(it.text)}</div>
            </div>
          {:else if it.k === 'text'}
            <div class="x md" class:soft-in={fresh(b)}>{@html busy && b === lastBlock ? renderMdLive(it.text) : renderMd(it.text)}</div>
          {:else if it.k === 'think'}
            <details class="think" class:soft-in={fresh(b)}>
              <summary class="label">-thinking-</summary>
              <p>{it.text}</p>
            </details>
          {:else if it.k === 'ask'}
            <div class:soft-in={fresh(b)}><AskCard {it} /></div>
          {:else if it.k === 'note'}
            <div class="note" class:err={it.tone === 'err'} class:fade-in={fresh(b)}><span class="label">{it.text}</span></div>
          {:else if it.k === 'end'}
            <p class="meta label" class:fade-in={fresh(b)}>{hhmm(it.t)}{it.model ? ' · ' + modelShort(it.model) : ''}{it.ms ? ' · ' + secs(it.ms) : ''}</p>
          {/if}
        {/if}
      {/each}

      </div>{/key}{/if}

      {#if activity}
        <p class="doing" in:fade={{ duration: 200 }}><i class="pulse"></i><span class="label">{activity}…</span></p>
      {/if}
      <div class="tail"></div>
    </div>
  </main>

  {#if showDown && !menuOpen}
    <button class="down" aria-label="到底" transition:fade={{ duration: 180 }} onclick={() => { stick = true; toBottom(true); }}>
      <svg width="18" height="18" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5v12M6 12l5 5 5-5"/></svg>
    </button>
  {/if}

  <footer class="bar" bind:this={barEl}>
    {#if menuOpen && v?.cwd}<CmdMenu cwd={v.cwd} query={cmdTok?.[1] ?? ''} onpick={pickCmd} />{/if}
    <div class="box">
      <div class="fold" class:open={!!argHint}>
        <div><p class="arghint"><span class="label">/{lastHint?.name}</span><span class="ah">{lastHint?.hint}</span></p></div>
      </div>
      {#if picks.length}
        <div class="picks" transition:fade={{ duration: 160 }}>
          {#each picks as p, k (p.url)}
            <div class="pick"><img src={p.url} alt="" />
              <button class="unpick" aria-label="去掉这张" onclick={() => { picks = picks.filter((_, j) => j !== k); persistDraft(); }}>
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5"/></svg>
              </button>
            </div>
          {/each}
        </div>
      {/if}
      <div class="ta" bind:this={taWrap}>
        <textarea bind:this={taEl} bind:value={draft} oninput={() => { autosize(); syncCaret(); }} onkeydown={onKey} onkeyup={syncCaret} onclick={syncCaret} onselect={syncCaret}
          onfocus={() => { focused = true; syncCaret(); }} onblur={() => { focused = false; }} rows="1" placeholder="派点活给 Claude…" enterkeyhint="enter"></textarea>
      </div>
      <div class="row2">
        <div class="lead">
          <button class="icon sm" aria-label="添加照片" onclick={() => photoEl?.click()}>
            <svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"><path d="M11 5v12M5 11h12"/></svg>
          </button>
          <button class="icon sm slash" class:on={menuOpen} aria-label="命令" onmousedown={e => e.preventDefault()} onclick={toggleCmds}>
            <svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"><path d="M13.6 4.5L8.4 17.5"/></svg>
          </button>
          <button class="chip label" onclick={() => { term.sheet = 'mode'; }}>-{modeLabel(term.mode)}-</button>
          <button class="chip label" onclick={() => { term.sheet = 'model'; }}>-{term.model ? modelShort(term.model) : '默认'}-</button>
          <button class="chip label" onclick={() => { term.sheet = 'effort'; }}>-{effortLabel(term.effort)}-</button>
        </div>
        {#key busy}
          <div in:fade={{ duration: 180 }}>
            {#if busy}
              <button class="icon" aria-label="停" onclick={() => { haptic('tick'); void interruptTerm(); }}>
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="6" y="6" width="10" height="10"/></svg>
              </button>
            {:else}
              <button class="icon send" aria-label="发" onclick={submit} disabled={!draft.trim() && !picks.length}>
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M11 18V5M5 11l6-6 6 6"/></svg>
              </button>
            {/if}
          </div>
        {/key}
      </div>
    </div>
    <input type="file" accept="image/*" multiple bind:this={photoEl} onchange={onPhotos} hidden />
  </footer>

  {#if viewer}<ImageViewer src={viewer} onclose={() => { viewer = null; }} />{/if}
</section>

{#if toolSteps}
  <ToolSheet steps={toolSteps} onclose={() => { toolSteps = null; }} />
{/if}

{#if term.sheet === 'mode' || term.sheet === 'model' || term.sheet === 'effort' || term.sheet === 'more'}
  <Sheet bind:this={sheetRef} title={term.sheet === 'mode' ? '-permission-' : term.sheet === 'model' ? '-model-' : term.sheet === 'effort' ? '-effort-' : ''} onclose={() => { term.sheet = null; }}>
    <div class="pane soft-in">
      {#if term.sheet === 'mode'}
        {#each MODES as m (m.id)}
          <button class="row" onclick={() => { haptic('select'); setTermMode(m.id); sheetRef?.close(); }}>
            <span class="radio" class:on={term.mode === m.id}></span>
            <span class="rl"><span>{m.label}</span><span class="label">{m.hint}</span></span>
          </button>
        {/each}
        <p class="hint label">下一句发出去时生效。电脑上的会话设置不受影响。</p>
      {:else if term.sheet === 'model'}
        {#each [{ id: '', label: '默认' }, ...app.models.filter(x => x.id)] as m (m.id)}
          <button class="row" onclick={() => { haptic('select'); setTermModel(m.id); sheetRef?.close(); }}>
            <span class="radio" class:on={term.model === m.id}></span>
            <span>{m.id ? m.label : '默认'}</span>
            <span class="label">{m.id || 'cc 自己的设置'}</span>
          </button>
        {/each}
      {:else if term.sheet === 'effort'}
        {#each EFFORTS as e (e.id)}
          <button class="row" onclick={() => { haptic('select'); setTermEffort(e.id); sheetRef?.close(); }}>
            <span class="radio" class:on={term.effort === e.id}></span>
            <span class="rl"><span>{e.label}</span><span class="label">{e.hint}</span></span>
          </button>
        {/each}
        <p class="hint label">下一句发出去时生效，不用重开。电脑上的 cc 设置不受影响。haiku 没有这个设置。</p>
      {:else}
        {#if s?.busy}
          <button class="row" onclick={() => { sheetRef?.close(); void interruptTerm(); }}>
            <svg width="18" height="18" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25"><rect x="6" y="6" width="10" height="10"/></svg>
            <span>停下这一轮</span>
          </button>
        {/if}
        <button class="row" disabled={!s?.live} onclick={() => { sheetRef?.close(); void closeProcess(); }}>
          <svg width="18" height="18" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"><path d="M11 4v7"/><path d="M6.8 6.6a6.5 6.5 0 1 0 8.4 0"/></svg>
          <span>关掉后台</span>
          <span class="label">{s?.live ? '记录留着，下次说话再拉起来' : '没在跑'}</span>
        </button>
        <button class="row" onclick={() => { void navigator.clipboard?.writeText(v?.cwd || ''); sheetRef?.close(); }}>
          <svg width="18" height="18" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7a2 2 0 0 1 2-2h3.5l2 2h6a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-11.5a2 2 0 0 1-2-2z"/></svg>
          <span>复制路径</span>
          <span class="label mono">{v?.cwd}</span>
        </button>
      {/if}
    </div>
  </Sheet>
{/if}

<style>
  .ts { position: absolute; inset: 0; z-index: 8; background-color: var(--paper); background-image: radial-gradient(130% 40% at 50% -6%, var(--wash), transparent 74%), var(--grain); }
  .top { position: absolute; top: 0; left: 0; right: 0; z-index: 3; display: flex; align-items: center; gap: 4px; padding: calc(var(--sat) + 8px) 8px 6px 6px; }
  .tt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .tt h1 { font-weight: 400; font-size: 16.5px; letter-spacing: .06em; line-height: 1.45; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { display: flex; gap: 8px; align-items: baseline; min-width: 0; }
  .ver { display: inline-flex; align-items: center; gap: 0; align-self: center; margin: -6px 0; }
  .vbtn { width: 22px; height: 24px; display: flex; align-items: center; justify-content: center; color: var(--ink-2); }
  .vbtn:disabled { opacity: .3; }
  .vnum { font-size: 10px; }
  .sub .label { font-size: 10px; white-space: nowrap; }
  .st.warn { color: var(--blue); }
  .icon { width: 38px; height: 38px; flex: none; display: flex; align-items: center; justify-content: center; color: var(--ink); }
  .icon:disabled { color: var(--ink-2); opacity: .4; }
  .icon.sm { width: 32px; height: 32px; margin-left: -6px; }

  .list { position: absolute; top: var(--ts-top, 64px); left: 0; right: 0; bottom: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; padding: 8px 18px var(--ts-bar, 110px);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 10px); mask-image: linear-gradient(to bottom, transparent 0, #000 10px); }
  .tail { height: 14px; }
  .all { animation: fade-in .26s var(--ease-out) both; }
  .center { text-align: center; padding: 8px 0; }
  .pad { padding-top: 30dvh; }
  .empty { height: 56dvh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; }
  .blot { width: 22px; height: 22px; border-radius: 46% 54% 50% 50% / 52% 48% 52% 48%; background: var(--blue); margin-bottom: 8px; }
  .line { font-size: 15px; }
  .hint { font-size: 12.5px; color: var(--ink-2); }
  .mono { font-family: var(--mono); font-weight: 300; }
  .hint.mono { font-size: 11px; word-break: break-all; }

  /* 你：右边灰气泡 */
  .u { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; margin: 14px 0 14px auto; max-width: 84%; }
  .u .b { background: var(--you-bg); color: var(--you-ink); border-radius: 16px; padding: 7px 13px; font-size: 15px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .pics { display: flex; gap: 3px; flex-wrap: wrap; justify-content: flex-end; }
  .pic { width: 96px; height: 96px; border-radius: 12px; overflow: hidden; background: var(--paper-2); }
  .u .cmd { font-family: var(--mono); font-weight: 400; font-size: .92em; letter-spacing: .02em; color: var(--blue); }

  /* 斜杠命令的输出 */
  .out { margin: 2px 0 14px; padding: 10px 14px 12px; border-radius: 16px; background: color-mix(in srgb, var(--tint) 58%, transparent); font-size: 13.5px; line-height: 1.65; }
  .out .ol { display: block; font-size: 10px; letter-spacing: .12em; margin-bottom: 4px; }
  .out.err .ol { color: var(--blue); }
  .out :global(table) { display: block; overflow-x: auto; border-collapse: collapse; margin: .3em 0 .6em; font-size: 12px; white-space: nowrap; touch-action: pan-x pan-y; }
  .out :global(th), .out :global(td) { padding: 3px 12px 3px 0; text-align: left; border-bottom: 1px solid var(--rule); font-weight: 400; }
  .out :global(th) { font-family: var(--mono); font-weight: 300; font-size: 10.5px; letter-spacing: .06em; color: var(--ink-2); }
  .pic img, .shot img { width: 100%; height: 100%; object-fit: cover; display: block; }

  /* Claude：直接写在纸上 */
  .x { font-size: 15.5px; line-height: 1.75; margin: 4px 0 10px; }
  .md { word-break: break-word; }
  .md :global(p) { margin: 0 0 .6em; }
  .md :global(p:last-child) { margin-bottom: 0; }
  .md :global(ul), .md :global(ol) { margin: .1em 0 .6em 1.2em; }
  .md :global(li) { margin: .12em 0; }
  .md :global(strong) { font-weight: 500; }
  .md :global(blockquote) { margin: .2em 0 .6em; padding-left: 10px; border-left: 1px solid var(--rule); color: var(--ink-2); }
  .md :global(code) { font-family: var(--mono); font-weight: 300; font-size: .82em; color: var(--blue); background: var(--blue-wash); padding: .08em .35em; border-radius: 4px; word-break: break-all; }
  .md :global(pre) { font-family: var(--mono); font-weight: 300; font-size: 12px; line-height: 1.7; background: color-mix(in srgb, var(--paper-2) 85%, transparent); padding: 10px 12px; border-radius: 10px; overflow-x: auto; margin: .3em 0 .7em; touch-action: pan-x pan-y; }
  .md :global(pre code) { background: none; padding: 0; color: var(--ink); font-size: inherit; word-break: normal; }
  .md :global(a) { color: var(--blue); text-decoration: none; border-bottom: 1px solid var(--blue); }
  .md :global(hr) { border: 0; border-top: 1px solid var(--rule); margin: .8em 0; }

  .think { margin: 2px 0 8px; }
  .think summary { list-style: none; cursor: pointer; font-size: 10px; padding: 2px 0; }
  .think summary::-webkit-details-marker { display: none; }
  .think p { font-size: 13px; line-height: 1.7; color: var(--ink-2); white-space: pre-wrap; word-break: break-word; padding: 4px 0 4px 10px; border-left: 1px solid var(--rule); margin-top: 4px; }

  /* 一串工具调用收成的一行 */
  .run { margin: 2px 0 12px; }
  .runrow { display: flex; align-items: flex-start; gap: 8px; max-width: 100%; padding: 4px 0; text-align: left; color: var(--ink-2); }
  .rt { font-size: 13.5px; line-height: 1.55; overflow: hidden; min-width: 0; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; }
  .chips { flex: none; display: inline-flex; font-family: var(--mono); font-size: 10.5px; border-radius: 6px; overflow: hidden; }
  .chips span { padding: 1px 6px; }
  .add { color: var(--blue); background: var(--blue-wash); }
  .del { color: var(--ink-2); background: color-mix(in srgb, var(--ink) 7%, transparent); }
  .chev { flex: none; opacity: .6; margin-top: 5px; }
  .runrow .chips { margin-top: 2px; }
  .runrow .pulse { margin-top: 8px; }
  .pulse { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--blue); animation: breathe 1.6s var(--ease-in-out) infinite; }
  .now { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink-2); margin: 1px 0 0 14px; min-width: 0; }
  .now :global(svg) { flex: none; color: var(--blue); }
  .now .tg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .now .tg.mono { font-family: var(--mono); font-weight: 300; font-size: 12px; }
  .shots { display: flex; gap: 6px; overflow-x: auto; margin: 8px -18px 0; padding: 0 18px 2px; scrollbar-width: none; touch-action: pan-x pan-y; overscroll-behavior-x: contain; }
  .shots::-webkit-scrollbar { display: none; }
  .shot { flex: none; height: 104px; max-width: 220px; border-radius: 12px; overflow: hidden; background: var(--paper-2); box-shadow: 0 0 0 1px var(--rule); }
  .shot img { width: auto; height: 104px; max-width: 220px; }

  .note { display: flex; align-items: center; gap: 10px; margin: 16px 0; }
  .note::before, .note::after { content: ''; flex: 1; height: 1px; background: var(--rule); }
  .note .label { font-size: 10px; letter-spacing: .12em; }
  .note.err .label { color: var(--blue); }
  .meta { font-size: 9.5px; margin: -2px 0 16px; opacity: .8; }
  .doing { display: flex; align-items: center; gap: 8px; margin: 4px 0 10px; }

  .down { position: absolute; right: 16px; bottom: calc(var(--ts-bar, 110px) + 8px); z-index: 4; width: 38px; height: 38px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--ink);
    background: var(--glass-box); backdrop-filter: blur(16px) saturate(1.2); -webkit-backdrop-filter: blur(16px) saturate(1.2); border: 1px solid var(--box-edge); box-shadow: 0 6px 18px rgba(20, 20, 20, .08); }

  /* 输入条：毛玻璃框 */
  .bar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 3; padding: 6px 12px calc(var(--sab) + 12px); }
  .box { position: relative; background-image: var(--grain); background-color: var(--glass-box); backdrop-filter: blur(20px) saturate(1.3); -webkit-backdrop-filter: blur(20px) saturate(1.3);
    border: 1px solid var(--box-edge); border-radius: 18px; padding: 8px 8px 4px 14px; box-shadow: inset 0 1px 0 var(--box-hi), 0 10px 30px rgba(20, 20, 20, .10);
    transition: border-color .2s var(--ease-out), box-shadow .2s var(--ease-out); }
  .box:focus-within { border-color: color-mix(in srgb, var(--blue) 35%, transparent); }
  .ta { overflow: clip; transition: height .18s var(--ease-out); }
  .box textarea { display: block; width: 100%; max-height: 160px; padding: 3px 0; line-height: 1.55; font-size: 16px; }
  .box textarea::placeholder { color: var(--ink-2); opacity: .55; }
  .row2 { display: flex; align-items: center; justify-content: space-between; }
  .lead { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .chip { padding: 6px 6px; white-space: nowrap; }
  .slash { margin-left: -4px; transition: transform 150ms var(--ease-out), color .2s var(--ease-out); }
  .slash.on { color: var(--blue); }
  .arghint { display: flex; align-items: baseline; gap: 8px; padding: 1px 0 5px; min-width: 0; }
  .arghint .label { color: var(--blue); font-size: 10.5px; flex: none; }
  .ah { font-family: var(--mono); font-weight: 300; font-size: 11px; color: var(--ink-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .send { color: var(--blue); }
  .send:disabled { color: var(--ink-2); opacity: .4; }
  .picks { display: flex; gap: 6px; padding: 2px 0 8px; }
  .pick { position: relative; width: 56px; height: 56px; border-radius: 10px; overflow: hidden; }
  .pick img { width: 100%; height: 100%; object-fit: cover; }
  .unpick { position: absolute; top: 3px; right: 3px; width: 18px; height: 18px; border-radius: 50%; background: rgba(20, 20, 20, .55); color: #fff; display: flex; align-items: center; justify-content: center; }


  /* 抽屉里的行 */
  .row { width: 100%; display: flex; align-items: center; gap: 12px; padding: 12px 4px; text-align: left; font-size: 15px; border-bottom: 1px solid var(--rule); }
  .row:disabled { opacity: .45; }
  .row .label { margin-left: auto; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rl { display: flex; flex-direction: column; gap: 2px; }
  .rl .label { margin-left: 0; max-width: none; white-space: normal; }
  .radio { flex: none; width: 14px; height: 14px; border-radius: 50%; border: 1px solid var(--ink-2); transition: box-shadow .2s var(--ease-out), border-color .2s var(--ease-out); }
  .radio.on { border-color: var(--blue); box-shadow: inset 0 0 0 3px var(--paper), inset 0 0 0 7px var(--blue); }
  .pane .hint { margin-top: 12px; line-height: 1.6; }
</style>
