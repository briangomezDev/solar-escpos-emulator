import { type Raster } from './raster.js';

/**
 * The printer's non-volatile image memory, shared by every connection to one virtual printer — a logo stored once
 * (FS q, GS ( L fn 67) prints on later receipts (FS p, GS ( L fn 69) like on the real printer. It lives as long as
 * the emulator process.
 */
export class ImageMemory {
  /** FS q: NV bit images, numbered from 1 in the order they were defined. FS q replaces all of them. */
  nvBitImages: Raster[] = [];
  /** GS ( L fn 67: NV graphics by key code (kc1, kc2) */
  nvGraphics = new Map<string, Raster>();

  static key(kc1: number, kc2: number): string {
    return String.fromCharCode(kc1, kc2);
  }
}
