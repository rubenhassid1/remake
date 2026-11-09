// Pixel comparison. A pixel "differs" when any colour channel is off by more than `tol` (of 255).
// Pixels that change between two loads of the original itself are "noise": they're masked out,
// and the share of masked pixels is reported next to every score.
import { PNG } from "pngjs";

export const decode = (buf) => PNG.sync.read(buf);
export const encode = (img) => PNG.sync.write(img);

export function blank(width, height, rgba = [255, 255, 255, 255]) {
  const img = new PNG({ width, height });
  for (let i = 0; i < img.data.length; i += 4) img.data.set(rgba, i);
  return img;
}

// 1 where a and b differ. Images of different sizes are compared over their shared area.
export function differMask(a, b, tol = 24) {
  const w = Math.min(a.width, b.width);
  const h = Math.min(a.height, b.height);
  const mask = new Uint8Array(a.width * a.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * a.width + x) * 4;
      const j = (y * b.width + x) * 4;
      if (
        Math.abs(a.data[i] - b.data[j]) > tol ||
        Math.abs(a.data[i + 1] - b.data[j + 1]) > tol ||
        Math.abs(a.data[i + 2] - b.data[j + 2]) > tol
      ) {
        mask[y * a.width + x] = 1;
      }
    }
  }
  return mask;
}

export function dilate(mask, w, h, r = 3) {
  if (!r) return mask;
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const row = yy * w;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) out[row + xx] = 1;
        }
      }
    }
  }
  return out;
}

export function maskToPng(mask, w, h) {
  const img = new PNG({ width: w, height: h });
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 255 : 0;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  return encode(img);
}

export function pngToMask(buf) {
  const img = decode(buf);
  const mask = new Uint8Array(img.width * img.height);
  for (let i = 0; i < mask.length; i++) mask[i] = img.data[i * 4] > 127 ? 1 : 0;
  return mask;
}

// Score the remake against the original on the pixels that are stable in the original.
export function compare(orig, remake, noise, tol = 24) {
  const w = orig.width;
  const h = orig.height;
  const sizeMismatch = remake.width !== w || remake.height !== h;
  const diff = differMask(orig, remake, tol);
  let considered = 0;
  let off = 0;
  let masked = 0;
  for (let i = 0; i < diff.length; i++) {
    if (noise && noise[i]) {
      masked++;
      continue;
    }
    considered++;
    if (diff[i]) off++;
  }
  const unscorable = considered === 0;
  const score = unscorable ? 0 : 100 * (1 - off / considered);
  return { score, off, considered, masked, unscorable, maskedPct: (100 * masked) / diff.length, sizeMismatch, diff };
}

// Remake greyed out, differences in red, masked noise in blue.
export function diffImage(remake, diff, noise) {
  const img = new PNG({ width: remake.width, height: remake.height });
  for (let i = 0; i < remake.width * remake.height; i++) {
    const g = Math.round(0.3 * remake.data[i * 4] + 0.59 * remake.data[i * 4 + 1] + 0.11 * remake.data[i * 4 + 2]);
    const soft = 200 + Math.round(g * 0.2);
    let rgb = [soft, soft, soft];
    if (noise && noise[i]) rgb = [150, 185, 255];
    else if (diff[i]) rgb = [235, 40, 30];
    img.data.set([...rgb, 255], i * 4);
  }
  return img;
}

export function downscale(img, factor = 2) {
  const w = Math.max(1, Math.floor(img.width / factor));
  const h = Math.max(1, Math.floor(img.height / factor));
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0, 0];
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const sx = x * factor + dx;
          const sy = y * factor + dy;
          if (sx >= img.width || sy >= img.height) continue;
          const i = (sy * img.width + sx) * 4;
          for (let c = 0; c < 4; c++) acc[c] += img.data[i + c];
          n++;
        }
      }
      out.data.set(acc.map((v) => Math.round(v / n)), (y * w + x) * 4);
    }
  }
  return out;
}

// Original | remake | difference, side by side at half size.
export function strip(orig, remake, diffImg) {
  const gap = 12;
  const w = orig.width;
  const h = Math.max(orig.height, remake.height);
  const out = blank(w * 3 + gap * 2, h, [255, 255, 255, 255]);
  const paste = (img, ox) => {
    for (let y = 0; y < img.height; y++) {
      img.data.copy(out.data, (y * out.width + ox) * 4, y * img.width * 4, (y + 1) * img.width * 4);
    }
  };
  paste(orig, 0);
  paste(remake, w + gap);
  paste(diffImg, (w + gap) * 2);
  return encode(downscale(out, 2));
}
