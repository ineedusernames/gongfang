// 触感：克制。只在切开关、选中、拖到吸附点时给一下。
export function haptic(kind: 'tick' | 'select' = 'tick') {
  try { navigator.vibrate?.(kind === 'select' ? 12 : 6); } catch { /* 没有就算了 */ }
}
