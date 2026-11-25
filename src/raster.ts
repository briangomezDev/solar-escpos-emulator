/**
 * Monochrome bitmaps for the ESC/POS image commands (logos, NV/download images, QR codes).
 *
 * A raster is stored row by row, MSB first, ceil(width / 8) bytes per row, 1 = black dot — the layout GS v 0 and
 * GS ( L fn 112 send. Column-format data (ESC *, GS *, FS q) is converted into it.
 */
export interface Raster {
  widthDots: number;
  heightDots: number;
  /** Row-major packed bits, MSB first, `bytesPerRow(widthDots)` bytes per row */
  data: Uint8Array;
}

export function bytesPerRow(widthDots: number): number {
  return Math.ceil(widthDots / 8);
}

export function createRaster(widthDots: number, heightDots: number): Raster {
  return { widthDots, heightDots, data: new Uint8Array(bytesPerRow(widthDots) * heightDots) };
}

export function getDot(r: Raster, x: number, y: number): boolean {
  return (r.data[y * bytesPerRow(r.widthDots) + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
}

export function setDot(r: Raster, x: number, y: number): void {
  r.data[y * bytesPerRow(r.widthDots) + (x >> 3)] |= 0x80 >> (x & 7);
}

/** Raster data as sent by GS v 0 / GS ( L fn 112 / fn 67: `widthBytes` bytes per row */
export function fromRasterBytes(widthBytes: number, heightDots: number, bytes: ArrayLike<number>, widthDots = widthBytes * 8): Raster {
  const r = createRaster(widthDots, heightDots);
  const dstRow = bytesPerRow(widthDots);
  for (let y = 0; y < heightDots; y++) {
    for (let b = 0; b < dstRow; b++) {
      r.data[y * dstRow + b] = bytes[y * widthBytes + b] ?? 0;
    }
    // Clear the padding bits past widthDots
    const extra = dstRow * 8 - widthDots;
    if (extra > 0) r.data[y * dstRow + dstRow - 1] &= (0xff << extra) & 0xff;
  }
  return r;
}

/**
 * Column-format data (ESC *, GS *, FS q): each column is `bytesPerColumn` bytes from top to bottom, MSB = top dot,
 * columns from left to right.
 */
export function fromColumnBytes(columns: number, bytesPerColumn: number, bytes: ArrayLike<number>): Raster {
  const r = createRaster(columns, bytesPerColumn * 8);
  for (let x = 0; x < columns; x++) {
    for (let b = 0; b < bytesPerColumn; b++) {
      const v = bytes[x * bytesPerColumn + b] ?? 0;
      if (!v) continue;
      for (let bit = 0; bit < 8; bit++) {
        if (v & (0x80 >> bit)) setDot(r, x, b * 8 + bit);
      }
    }
  }
  return r;
}

/** Nearest-neighbour scale by whole factors (the double width/height modes of the image commands) */
export function scaleRaster(r: Raster, sx: number, sy: number): Raster {
  if (sx === 1 && sy === 1) return r;
  const out = createRaster(r.widthDots * sx, r.heightDots * sy);
  for (let y = 0; y < r.heightDots; y++) {
    for (let x = 0; x < r.widthDots; x++) {
      if (!getDot(r, x, y)) continue;
      for (let dy = 0; dy < sy; dy++) for (let dx = 0; dx < sx; dx++) setDot(out, x * sx + dx, y * sy + dy);
    }
  }
  return out;
}

/** The left `widthDots` of the raster: what a printer prints of an image wider than the print area */
export function cropWidth(r: Raster, widthDots: number): Raster {
  if (widthDots >= r.widthDots) return r;
  const out = createRaster(widthDots, r.heightDots);
  for (let y = 0; y < r.heightDots; y++) {
    for (let x = 0; x < widthDots; x++) if (getDot(r, x, y)) setDot(out, x, y);
  }
  return out;
}

/** Stacks `bottom` under `top`, `gapDots` blank rows between them; the result is as wide as the wider one */
export function stackRasters(top: Raster, bottom: Raster, gapDots = 0): Raster {
  const out = createRaster(Math.max(top.widthDots, bottom.widthDots), top.heightDots + gapDots + bottom.heightDots);
  const copy = (src: Raster, offsetY: number) => {
    for (let y = 0; y < src.heightDots; y++) {
      for (let x = 0; x < src.widthDots; x++) if (getDot(src, x, y)) setDot(out, x, y + offsetY);
    }
  };
  copy(top, 0);
  copy(bottom, top.heightDots + gapDots);
  return out;
}

/** Scale factors of the `m` parameter of GS v 0, GS / and FS p: 0 normal, 1 double width, 2 double height, 3 both */
export function scaleFromMode(m: number): { sx: number; sy: number } {
  const n = (m >= 48 ? m - 48 : m) & 0x03;
  return { sx: n & 0x01 ? 2 : 1, sy: n & 0x02 ? 2 : 1 };
}
