// 手机浏览器的软键盘：根容器 position:fixed，页面本身没有可滚的余地，键盘来了只改根容器的高度。
//   安卓 Chrome：index.html 里 interactive-widget=resizes-content，浏览器自己把可视区缩矮，这里只是兜底；
//   iOS Safari：可视区不缩、页面会被顶上去，所以按 visualViewport 的高度把根容器收矮，再把页面钉回顶上。
// 键盘开着时 <html> 上挂 kb-open（底部安全区不用再留）。

export function installKeyboardFit(root: HTMLElement) {
  const vv = window.visualViewport;
  if (!vv) return;
  let fullH = window.innerHeight;
  const pin = () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); };
  function fit() {
    if (vv!.height > fullH - 60) fullH = Math.max(vv!.height, window.innerHeight);   // 横竖屏切换、地址栏收起
    const kb = fullH - vv!.height;
    pin();
    if (kb > 60) {
      root.style.setProperty('height', Math.round(vv!.height) + 'px', 'important');
      document.documentElement.classList.add('kb-open');
    } else {
      root.style.removeProperty('height');
      document.documentElement.classList.remove('kb-open');
    }
  }
  vv.addEventListener('resize', fit);
  vv.addEventListener('scroll', fit);
  window.addEventListener('scroll', pin, { passive: true });
}
