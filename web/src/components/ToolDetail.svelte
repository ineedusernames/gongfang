<script lang="ts">
  // 一次工具调用点进去看到的东西：改文件 = 带行号的改动；跑命令 = 命令 + 输出；读 = 读到的内容或图；
  // 搜 = 搜什么 + 结果；子代理 = 派的活 + 它自己的调用；待办 = 清单。都放在抽屉里，抽屉自己滚。
  import Diff from './Diff.svelte';
  import ToolIcon from './ToolIcon.svelte';
  import { termImg } from '../lib/term.svelte';
  import { basename, toolInfo, stateLabel, type ToolItem } from '../lib/tools';

  let { t, subs = [], onopen }: { t: ToolItem; subs?: ToolItem[]; onopen?: (t: ToolItem) => void } = $props();

  const info = $derived(toolInfo(t));
  const i = $derived(t.input || {});
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  const out = $derived(t.result?.text ?? '');
  const todos = $derived(Array.isArray(i.todos) ? (i.todos as Array<{ content?: string; status?: string; activeForm?: string }>) : []);
  const pretty = (v: unknown) => { try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
</script>

{#if info.kind === 'edit' || info.kind === 'new'}
  <div class="path"><span class="mono">{info.detail}</span>
    {#if info.adds || info.dels}<span class="chips"><span class="add">+{info.adds}</span><span class="del">−{info.dels}</span></span>{/if}
  </div>
  {#if t.name === 'Write'}
    <Diff hunks={t.result?.patch} text={s(i.content)} created={!t.result?.patch?.length} />
  {:else if t.name === 'MultiEdit' && !t.result?.patch?.length && Array.isArray(i.edits)}
    {#each i.edits as e, k (k)}<Diff oldText={s((e as Record<string, unknown>).old_string)} newText={s((e as Record<string, unknown>).new_string)} />{/each}
  {:else}
    <Diff hunks={t.result?.patch} oldText={s(i.old_string)} newText={s(i.new_string)} />
  {/if}
{:else if info.kind === 'run'}
  {#if s(i.description)}<p class="desc">{s(i.description)}</p>{/if}
  {#if s(i.command)}
    <div class="sec label">-command-{i.run_in_background ? ' · 后台' : ''}</div>
    <pre class="code cmd">{s(i.command)}</pre>
  {/if}
  {#if t.result?.bgId}<p class="label bg">后台编号 {t.result.bgId}：跑完了 Claude 会看到</p>{/if}
  {#if out}
    <div class="sec label" class:err={t.result?.err}>{t.result?.err ? '-error-' : '-output-'}</div>
    <pre class="code">{out}</pre>
  {:else if t.state === 'run'}
    <p class="label breathe wait">跑着…</p>
  {/if}
{:else if info.kind === 'read'}
  <div class="path"><span class="mono">{info.detail}</span>
    {#if t.result?.file}<span class="label">{t.result.file.start}–{t.result.file.start + t.result.file.lines - 1} / {t.result.file.total} 行</span>{/if}
  </div>
  {#if t.result?.images?.length}
    <div class="shots">{#each t.result.images as im, k (k)}<img src={termImg(im.src)} alt="" loading="lazy" style:aspect-ratio={im.w && im.h ? `${im.w}/${im.h}` : null} />{/each}</div>
  {:else if out}
    <Diff text={out} start={t.result?.file?.start ?? 1} />
  {/if}
{:else if info.kind === 'search'}
  <div class="path"><span class="mono">{info.target}</span>{#if info.detail}<span class="label">{info.detail}</span>{/if}</div>
  {#if out}<pre class="code">{out}</pre>{:else if t.state !== 'run'}<p class="label wait">-nothing-</p>{/if}
{:else if info.kind === 'web'}
  <div class="path"><span class={t.name === 'WebFetch' ? 'mono' : ''}>{t.name === 'WebFetch' ? s(i.url) : s(i.query)}</span></div>
  {#if s(i.prompt)}<p class="desc">{s(i.prompt)}</p>{/if}
  {#if out}<div class="prose">{out}</div>{/if}
{:else if info.kind === 'task'}
  {#if s(i.description)}<p class="desc">{s(i.description)}</p>{/if}
  {#if s(i.prompt)}<div class="sec label">-brief-</div><div class="prose">{s(i.prompt)}</div>{/if}
  {#if subs.length}
    <div class="sec label">-它自己做了 {subs.length} 步-</div>
    <div class="subs">
      {#each subs as sub (sub.id)}
        {@const f = toolInfo(sub)}
        <button class="sub" onclick={() => onopen?.(sub)}>
          <ToolIcon icon={f.icon} size={16} />
          <span class="sv">{f.verb}</span><span class="st" class:mono={f.mono}>{f.target}</span>
        </button>
      {/each}
    </div>
  {/if}
  {#if out}<div class="sec label">-report-</div><div class="prose">{out}</div>{/if}
{:else if info.kind === 'todo' && todos.length}
  <ul class="todos">
    {#each todos as td, k (k)}
      <li class:done={td.status === 'completed'} class:doing={td.status === 'in_progress'}>
        <span class="box">
          {#if td.status === 'completed'}<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6.2l2.3 2.3L9.5 3.8"/></svg>{/if}
        </span>
        <span>{td.status === 'in_progress' && td.activeForm ? td.activeForm : td.content}</span>
      </li>
    {/each}
  </ul>
{:else}
  <div class="sec label">-input-</div>
  <pre class="code">{pretty(i)}</pre>
  {#if out}<div class="sec label" class:err={t.result?.err}>{t.result?.err ? '-error-' : '-output-'}</div><pre class="code">{out}</pre>{/if}
{/if}

{#if t.result?.images?.length && info.kind !== 'read'}
  <div class="shots">{#each t.result.images as im, k (k)}<img src={termImg(im.src)} alt="" loading="lazy" style:aspect-ratio={im.w && im.h ? `${im.w}/${im.h}` : null} />{/each}</div>
{/if}
{#if t.result?.cut}<p class="label wait">太长了，后面截掉了</p>{/if}
{#if t.state === 'denied'}<p class="label wait">这一步你没让 Claude 做（{stateLabel(t)}）</p>{/if}

<style>
  .path { display: flex; align-items: baseline; gap: 10px; justify-content: space-between; margin: 2px 0 12px; font-size: 13px; }
  .path .mono { font-size: 12.5px; word-break: break-all; color: var(--ink); }
  .chips { display: inline-flex; flex: none; font-family: var(--mono); font-size: 11px; }
  .chips .add { color: var(--blue); padding-right: 6px; }
  .chips .del { color: var(--ink-2); }
  .desc { font-size: 14px; line-height: 1.65; margin: 0 0 12px; }
  .sec { margin: 14px 0 6px; letter-spacing: .12em; font-size: 10px; }
  .sec.err, .err { color: var(--blue); }
  .code { font-family: var(--mono); font-weight: 300; font-size: 12px; line-height: 1.7; white-space: pre; overflow-x: auto; overscroll-behavior-x: contain; touch-action: pan-x pan-y;
    background: color-mix(in srgb, var(--paper-2) 80%, transparent); border-radius: 10px; padding: 10px 12px; margin: 0; -webkit-overflow-scrolling: touch; }
  .cmd { white-space: pre-wrap; word-break: break-all; }
  .prose { font-size: 13.5px; line-height: 1.7; white-space: pre-wrap; word-break: break-word; color: var(--ink); }
  .bg { margin-top: 8px; }
  .wait { margin-top: 10px; }
  .shots { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
  .shots img { width: 100%; border-radius: 10px; background: var(--paper-2); display: block; }
  .subs { display: flex; flex-direction: column; }
  .sub { display: flex; align-items: center; gap: 8px; padding: 8px 0; text-align: left; color: var(--ink-2); min-width: 0; }
  .sv { color: var(--ink); font-size: 14px; flex: none; }
  .st { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .st.mono { font-family: var(--mono); font-size: 12px; }
  .todos { list-style: none; display: flex; flex-direction: column; gap: 10px; margin-top: 4px; }
  .todos li { display: flex; gap: 10px; align-items: flex-start; font-size: 14.5px; line-height: 1.55; }
  .box { flex: none; width: 16px; height: 16px; margin-top: 3px; border-radius: 5px; border: 1px solid var(--ink-2); display: flex; align-items: center; justify-content: center; color: var(--accent-ink); }
  .done .box { background: var(--blue); border-color: var(--blue); }
  .done span:last-child { color: var(--ink-2); text-decoration: line-through; text-decoration-color: var(--rule); }
  .doing .box { border-color: var(--blue); box-shadow: inset 0 0 0 3px var(--paper), inset 0 0 0 8px var(--blue); }
</style>
