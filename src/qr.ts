import qrcode from 'qrcode-generator';
import { createRaster, setDot, type Raster } from './raster.js';

export type QrErrorCorrection = 'L' | 'M' | 'Q' | 'H';

const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]*$/;

/**
 * Encodes the data stored with GS ( k <fn 80> into a QR symbol, `moduleSizeDots` dots per module (GS ( k <fn 67>),
 * without a quiet zone, as the printer does. The smallest version that fits is chosen, and the mode follows the data
 * like the printer's automatic mode selection: numeric, alphanumeric, or bytes as received.
 */
export function encodeQr(data: number[], moduleSizeDots: number, ecc: QrErrorCorrection): Raster | null {
  if (data.length === 0) return null;
  const text = String.fromCharCode(...data); // one char per byte: qrcode-generator writes charCode & 0xff in byte mode
  const mode = /^[0-9]+$/.test(text) ? 'Numeric' : ALPHANUMERIC.test(text) ? 'Alphanumeric' : 'Byte';
  let qr;
  try {
    qr = qrcode(0, ecc);
    qr.addData(text, mode);
    qr.make();
  } catch (err) {
    console.warn(`[qr] Cannot encode ${data.length} bytes: ${(err as Error).message}`);
    return null;
  }
  const count = qr.getModuleCount();
  const raster = createRaster(count * moduleSizeDots, count * moduleSizeDots);
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      for (let dy = 0; dy < moduleSizeDots; dy++) {
        for (let dx = 0; dx < moduleSizeDots; dx++) setDot(raster, col * moduleSizeDots + dx, row * moduleSizeDots + dy);
      }
    }
  }
  return raster;
}
