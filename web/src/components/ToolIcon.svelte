<script lang="ts">
  // 终端里工具调用的小图标：线条，和全 app 的图标同一套（1.25 描边，圆头）
  import type { Icon } from '../lib/tools';
  let { icon, size = 18 }: { icon: Icon; size?: number } = $props();
</script>

<svg width={size} height={size} viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  {#if icon === 'edit'}
    <path d="M14 4.5l3.5 3.5L8.5 17 4.5 17.5 5 13.5z"/><path d="M12.5 6l3.5 3.5"/>
  {:else if icon === 'new'}
    <path d="M6 3.5h6.5l4 4v11H6z"/><path d="M12.5 3.5v4h4M11.3 10.5v5M8.8 13h5"/>
  {:else if icon === 'read'}
    <path d="M2.8 11s3-5.5 8.2-5.5 8.2 5.5 8.2 5.5-3 5.5-8.2 5.5S2.8 11 2.8 11z"/><circle cx="11" cy="11" r="2.4"/>
  {:else if icon === 'run'}
    <rect x="3.5" y="4.5" width="15" height="13" rx="2.5"/><path d="M7 9l2.5 2L7 13M11.5 13.5H15"/>
  {:else if icon === 'search'}
    <circle cx="10" cy="10" r="5.5"/><path d="M14.2 14.2l3.8 3.8"/>
  {:else if icon === 'web'}
    <circle cx="11" cy="11" r="7.5"/><path d="M3.5 11h15M11 3.5c2.2 2.1 3.2 4.6 3.2 7.5s-1 5.4-3.2 7.5c-2.2-2.1-3.2-4.6-3.2-7.5s1-5.4 3.2-7.5z"/>
  {:else if icon === 'task'}
    <circle cx="6.5" cy="6" r="2"/><circle cx="6.5" cy="16" r="2"/><circle cx="15.5" cy="11" r="2"/><path d="M6.5 8v6M8.3 7l5.4 3M8.3 15l5.4-3"/>
  {:else if icon === 'todo'}
    <path d="M9.5 6.5h8M9.5 11h8M9.5 15.5h8"/><path d="M4.3 6.4l1 1 1.9-2M4.3 10.9l1 1 1.9-2"/><circle cx="5.3" cy="15.5" r="1.1"/>
  {:else if icon === 'think'}
    <path d="M11 4.5a5 5 0 0 0-3 9v2.5h6V13.5a5 5 0 0 0-3-9z"/><path d="M9 18.5h4"/>
  {:else}
    <path d="M8.5 4.5v3M13.5 4.5v3M6.5 7.5h9v3.5a4.5 4.5 0 0 1-9 0z"/><path d="M11 15.5v3"/>
  {/if}
</svg>
