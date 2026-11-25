import { randomUUID } from 'node:crypto';

export type Alignment = 'left' | 'center' | 'right';

export interface TextSegment {
  text: string;
  bold: boolean;
  underline: 0 | 1 | 2;
  font: string;
  width: number;  // 1-8 multiplier
  height: number; // 1-8 multiplier
  reverse: boolean;
}

export interface Barcode {
  /** One character per module: '1' bar, '0' space */
  modules: string;
  moduleWidthDots: number; // GS w
  heightDots: number;      // GS h
}

export type ImageKind = 'raster' | 'bit-image' | 'nv-image' | 'download-image' | 'graphics' | 'qr';

export interface ReceiptImage {
  /** Command that printed it: GS v 0 'raster', ESC * 'bit-image', FS p / GS ( L fn 69 'nv-image', GS / and
   * GS ( L fn 85 'download-image', GS ( L fn 50 'graphics', GS ( k 'qr' */
  kind: ImageKind;
  widthDots: number;
  heightDots: number;
  /** Base64 of the packed bits: row by row, MSB first, ceil(widthDots / 8) bytes per row, 1 = black */
  data: string;
  /** QR only: the data the symbol encodes */
  text?: string;
}

export interface ReceiptLine {
  segments: TextSegment[];  // empty on a barcode or image line
  align: Alignment;
  barcode?: Barcode;
  image?: ReceiptImage;
}

export interface Receipt {
  id: string;
  lines: ReceiptLine[];
  printAreaDots: number; // print area width (GS W) in force when the paper was cut
  receivedAt: string; // ISO timestamp
}

export function createReceipt(lines: ReceiptLine[], printAreaDots: number): Receipt {
  return {
    id: randomUUID(),
    lines,
    printAreaDots,
    receivedAt: new Date().toISOString(),
  };
}
