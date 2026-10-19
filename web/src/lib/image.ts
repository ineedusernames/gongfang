// 发图前在手机上压一下：长边 ≤1568、总像素 ≤1.15M（Claude 看图的最佳尺寸，再大也会被服务端缩），JPEG 0.86。
// 一张照片从几 MB 压到两三百 KB，上传快，存档也小。

export interface Picked {
  media_type: string;
  data: string;   // base64，不带 data: 前缀
  url: string;    // 本地预览（object URL），发出去之后还挂在消息上，直到服务器那张到位
  w: number;
  h: number;
}

const MAX_EDGE = 1568;
const MAX_PIXELS = 1_150_000;

async function decode(file: Blob): Promise<{ src: CanvasImageSource; w: number; h: number; close: () => void }> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
  } catch {
    // 老 WebView 不认 createImageBitmap 的参数：退回 <img>（它自己会按 EXIF 转正）
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } finally { URL.revokeObjectURL(url); }
    return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => {} };
  }
}

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

export async function prepImage(file: Blob): Promise<Picked> {
  const { src, w: w0, h: h0, close } = await decode(file);
  if (!w0 || !h0) { close(); throw new Error('读不了这张图'); }
  const k = Math.min(1, MAX_EDGE / Math.max(w0, h0), Math.sqrt(MAX_PIXELS / (w0 * h0)));
  const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#fff';                  // 透明 PNG 转 JPEG 时透明处是白的，不是黑的
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  close();
  const blob = await new Promise<Blob | null>(r => cv.toBlob(r, 'image/jpeg', 0.86));
  if (!blob) throw new Error('读不了这张图');
  return { media_type: 'image/jpeg', data: await toBase64(blob), url: URL.createObjectURL(blob), w, h };
}

/** 气泡里一张图的显示尺寸：放进 max 框里，不放大 */
export function fitBox(w: number | undefined, h: number | undefined, maxW: number, maxH: number) {
  if (!w || !h) return { w: maxW, h: Math.round(maxW * 0.75) };
  const k = Math.min(1, maxW / w, maxH / h);
  return { w: Math.round(w * k), h: Math.round(h * k) };
}
