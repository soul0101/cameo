/**
 * Client-side image prep for product images: uploads are downscaled before they are
 * persisted as data URLs, so `cameo-project` stays small.
 * - Long edge ≤ 1200 px, JPEG at 0.82 on a white ground (packshots sit on a white plate anyway).
 * - A PNG / WebP / GIF with real transparency stays PNG when the result is small (≤ 400 KB).
 */

const MAX_EDGE = 1200;
const JPEG_QUALITY = 0.82;
const MAX_PNG_BYTES = 400 * 1024;

export class ImageError extends Error {}

/** True for files the browser can treat as an image (by type, or by extension when the type is empty). */
export const isImageFile = (f: File) => f.type.startsWith('image/') || (!f.type && /\.(png|jpe?g|webp|gif|avif|bmp)$/i.test(f.name));

function load(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => (URL.revokeObjectURL(url), resolve(img));
    img.onerror = () => (URL.revokeObjectURL(url), reject(new ImageError(`Couldn’t read ${file.name}`)));
    img.src = url;
  });
}

/** Any pixel meaningfully transparent? Samples a grid so big images stay cheap. */
function hasAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  const step = Math.max(1, Math.floor((w * h) / 40000)) * 4;
  for (let i = 3; i < data.length; i += step) if (data[i] < 250) return true;
  return false;
}

/** Downscale and re-encode one image file. Resolves to a data URL; rejects with ImageError for non-images. */
export async function compressImage(file: File): Promise<string> {
  if (!isImageFile(file)) throw new ImageError(`${file.name} isn’t an image`);
  const img = await load(file);
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new ImageError(`Couldn’t read ${file.name}`);
  const scale = Math.min(1, MAX_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new ImageError('This browser can’t process images');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);

  if (/png|webp|gif/.test(file.type) && hasAlpha(ctx, w, h)) {
    const png = canvas.toDataURL('image/png');
    if (png.length * 0.75 <= MAX_PNG_BYTES) return png;
  }
  // Flatten onto white: transparent areas read as the packshot plate.
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}
