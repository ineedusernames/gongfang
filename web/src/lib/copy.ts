// 复制到剪贴板。navigator.clipboard 只在安全上下文（https、localhost、壳里）能用；
// 浏览器里走 http://192.168… 打开时它不存在或会抛错，退回老办法：藏一个 textarea 选中再 execCommand('copy')。
export async function copyText(t: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(t); return true; } catch { /* 退回老办法 */ }
  }
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;';
  document.body.appendChild(ta);
  const sel = document.getSelection();
  const keep = sel && sel.rangeCount ? sel.getRangeAt(0) : null;   // 别把用户手上的选区冲掉
  ta.select();
  ta.setSelectionRange(0, t.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  if (keep && sel) { sel.removeAllRanges(); sel.addRange(keep); }
  return ok;
}
