import { type PrinterModel } from './printer-model.js';
import { CODE_TABLES } from './code-tables.js';
import { encodeCode128 } from './code128.js';
import { type Alignment, type TextSegment, type ReceiptLine, type ImageKind, createReceipt, type Receipt } from './receipt.js';
import {
  type Raster, createRaster, getDot, setDot, fromRasterBytes, fromColumnBytes, scaleRaster, cropWidth, stackRasters, scaleFromMode,
} from './raster.js';
import { encodeQr, type QrErrorCorrection } from './qr.js';
import { ImageMemory } from './image-memory.js';

// Control bytes
const LF = 0x0a;
const CR = 0x0d;
const HT = 0x09;
const ESC = 0x1b;
const FS = 0x1c;
const GS = 0x1d;

// GS k barcode system (format 2) and GS H bits
const CODE128 = 73;
const HRI_ABOVE = 0x01;
const HRI_BELOW = 0x02;

// ISO 8859-15 differs from 8859-1 at these byte positions
const ISO_8859_15_MAP: Record<number, string> = {
  0xa4: '\u20ac', 0xa6: '\u0160', 0xa8: '\u0161', 0xb4: '\u017d',
  0xb8: '\u017e', 0xbc: '\u0152', 0xbd: '\u0153', 0xbe: '\u0178',
};

type ParserCallback = (receipt: Receipt) => void;

interface PrintState {
  font: string;
  bold: boolean;
  underline: 0 | 1 | 2;
  align: Alignment;
  width: number;
  height: number;
  reverse: boolean;
  codeTable: number | null; // ESC t n; null until a supported table is selected, decoded as ISO 8859-15
  barcodeModuleWidth: number; // GS w n, dots
  barcodeHeight: number;      // GS h n, dots
  hriPosition: number;        // GS H n, HRI_ABOVE | HRI_BELOW
  hriFont: string;            // GS f n
  printAreaWidth: number;     // GS W nL nH, dots
  lineSpacing: number | null; // ESC 3 n, dots; null = default (ESC 2)
  qrModuleSize: number;       // GS ( k <fn 67>, dots per module
  qrEcc: QrErrorCorrection;   // GS ( k <fn 69>
}

const QR_ECC: Record<number, QrErrorCorrection> = { 48: 'L', 49: 'M', 50: 'Q', 51: 'H' };

export class EscPosParser {
  private model: PrinterModel;
  private state: PrintState;
  private lines: ReceiptLine[];
  private onReceipt: ParserCallback;
  private memory: ImageMemory;

  // Volatile image buffers, cleared by ESC @
  private qrData: number[] = [];          // GS ( k <fn 80>
  private pdf417Data: number[] = [];      // GS ( k cn=48 <fn 80>
  private downloadedBitImage: Raster | null = null;        // GS *
  private downloadGraphics = new Map<string, Raster>();    // GS ( L <fn 83>
  private graphicsBuffer: Raster | null = null;            // GS ( L <fn 112>

  // Current line accumulation
  private lineSegments: TextSegment[] = [];
  private currentText: string = '';
  private currentPosDots: number = 0;
  private lineUsedAbsPos: boolean = false; // true if ESC $ was used on this line

  // Command parsing state
  private commandHandler: ((byte: number) => boolean) | null = null;

  constructor(model: PrinterModel, onReceipt: ParserCallback, memory: ImageMemory = new ImageMemory()) {
    this.model = model;
    this.onReceipt = onReceipt;
    this.memory = memory;
    this.lines = [];
    this.state = this.defaultState();
  }

  private defaultState(): PrintState {
    return {
      font: this.model.defaultFont,
      bold: false,
      underline: 0,
      align: 'left',
      width: 1,
      height: 1,
      reverse: false,
      codeTable: this.model.defaultCodeTable !== undefined && CODE_TABLES[this.model.defaultCodeTable]
        ? this.model.defaultCodeTable : null,
      barcodeModuleWidth: 3,
      barcodeHeight: 162,
      hriPosition: 0,
      hriFont: 'A',
      printAreaWidth: this.printableWidthDots,
      lineSpacing: null,
      qrModuleSize: 3,
      qrEcc: 'L',
    };
  }

  /** Width of the printable area in dots: a full line of Font A */
  private get printableWidthDots(): number {
    const font = this.model.fonts.A || this.model.fonts[this.model.defaultFont];
    return font.charsPerLine * font.widthPx;
  }

  /** Width of one character in dots at current settings */
  private get charWidthDots(): number {
    const font = this.model.fonts[this.state.font] || this.model.fonts[this.model.defaultFont];
    return font.widthPx * this.state.width;
  }

  /** Base character width in dots (no size multiplier) */
  private get baseCharWidthDots(): number {
    const font = this.model.fonts[this.state.font] || this.model.fonts[this.model.defaultFont];
    return font.widthPx;
  }

  process(data: Buffer): void {
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];

      if (this.commandHandler) {
        const currentHandler = this.commandHandler;
        const done = currentHandler(byte);
        if (done && this.commandHandler === currentHandler) {
          this.commandHandler = null;
        }
        continue;
      }

      switch (byte) {
        case LF:
        case CR:
          this.flushLine();
          break;

        case HT:
          this.currentText += '    ';
          this.currentPosDots += this.charWidthDots * 4;
          break;

        case ESC:
          this.commandHandler = this.handleEsc();
          break;

        case FS:
          this.commandHandler = this.handleFs();
          break;

        case GS:
          this.commandHandler = this.handleGs();
          break;

        default:
          if (byte >= 0x20) {
            // A character that does not fit in the print area goes to the next line, as on paper
            if (this.currentPosDots > 0 && this.currentPosDots + this.charWidthDots > this.state.printAreaWidth) {
              this.flushLine();
            }
            this.currentText += this.decodeChar(byte);
            this.currentPosDots += this.charWidthDots;
          }
          break;
      }
    }
  }

  flush(): void {
    if (this.currentText.length > 0 || this.lineSegments.length > 0) {
      this.flushLine();
    }
    if (this.lines.length > 0) {
      this.emitReceipt();
    }
  }

  private decodeChar(byte: number): string {
    if (byte < 0x80) return String.fromCharCode(byte);
    const table = this.state.codeTable !== null ? CODE_TABLES[this.state.codeTable] : undefined;
    if (table) return table[byte - 0x80];
    return ISO_8859_15_MAP[byte] ?? String.fromCharCode(byte);
  }

  private flushLine(): void {
    this.flushSegment();
    if (this.pendingBand) {
      this.finishBand();
      return;
    }
    const segments = this.lineSegments.length > 0
      ? this.lineSegments
      : [{ text: '', bold: false, underline: 0 as const, font: this.state.font, width: 1, height: 1, reverse: false }];
    // If absolute positioning was used, alignment is handled by spacing — force left
    const align = this.lineUsedAbsPos ? 'left' as const : this.state.align;
    this.lines.push({ segments, align });
    this.lineSegments = [];
    this.currentPosDots = 0;
    this.lineUsedAbsPos = false;
  }

  private flushSegment(): void {
    if (this.currentText.length > 0) {
      this.lineSegments.push({
        text: this.currentText,
        bold: this.state.bold,
        underline: this.state.underline,
        font: this.state.font,
        width: this.state.width,
        height: this.state.height,
        reverse: this.state.reverse,
      });
      this.currentText = '';
    }
  }

  private setAbsolutePosition(posDots: number): void {
    // Positions outside the print area are ignored by the printer
    if (posDots > this.state.printAreaWidth) return;
    this.flushSegment();
    this.lineUsedAbsPos = true;
    if (posDots > this.currentPosDots) {
      const gapDots = posDots - this.currentPosDots;
      const spaces = Math.round(gapDots / this.baseCharWidthDots);
      if (spaces > 0) {
        this.lineSegments.push({
          text: ' '.repeat(spaces),
          bold: false,
          underline: 0,
          font: this.state.font,
          width: 1,
          height: 1,
          reverse: false,
        });
      }
    }
    this.currentPosDots = posDots;
  }

  private emitReceipt(): void {
    if (this.lines.length === 0) return;
    const receipt = createReceipt(this.lines, this.state.printAreaWidth);
    this.lines = [];
    this.onReceipt(receipt);
  }

  // --- ESC commands (0x1B ...) ---

  private handleEsc(): (byte: number) => boolean {
    return (byte: number): boolean => {
      switch (byte) {
        case 0x40: // ESC @ — Initialize printer
          this.state = this.defaultState();
          this.currentText = '';
          this.lineSegments = [];
          this.currentPosDots = 0;
          this.pendingBand = null;
          this.qrData = [];
          this.pdf417Data = [];
          this.downloadedBitImage = null;
          this.downloadGraphics.clear();
          this.graphicsBuffer = null;
          return true;

        case 0x21: // ESC ! n — Select print mode
          this.commandHandler = this.readBytes(1, ([n]) => {
            this.flushSegment();
            this.state.font = (n & 0x01) ? 'B' : 'A';
            this.state.bold = !!(n & 0x08);
            this.state.height = (n & 0x10) ? 2 : 1;
            this.state.width = (n & 0x20) ? 2 : 1;
            this.state.underline = (n & 0x80) ? 1 : 0;
          });
          return true;

        case 0x24: // ESC $ nL nH — Set absolute print position
          this.commandHandler = this.readBytes(2, ([nL, nH]) => {
            this.setAbsolutePosition(nL + nH * 256);
          });
          return true;

        case 0x2d: // ESC - n — Underline
          this.commandHandler = this.readBytes(1, ([n]) => {
            this.flushSegment();
            this.state.underline = (n === 0 || n === 48) ? 0 : (n === 2 || n === 50) ? 2 : 1;
          });
          return true;

        case 0x32: // ESC 2 — Default line spacing
          this.state.lineSpacing = null;
          return true;

        case 0x33: // ESC 3 n — Set line spacing
          this.commandHandler = this.readBytes(1, ([n]) => { this.state.lineSpacing = n; });
          return true;

        case 0x2a: // ESC * m nL nH d1...dk — Select bit-image mode (one band of 8 or 24 dots)
          this.commandHandler = this.handleEscBitImage();
          return true;

        case 0x45: // ESC E n — Bold on/off
          this.commandHandler = this.readBytes(1, ([n]) => {
            this.flushSegment();
            this.state.bold = !!(n & 0x01);
          });
          return true;

        case 0x4d: // ESC M n — Select font
          this.commandHandler = this.readBytes(1, ([n]) => {
            this.flushSegment();
            if (n === 0 || n === 48) this.state.font = 'A';
            else if (n === 1 || n === 49) this.state.font = 'B';
          });
          return true;

        case 0x52: // ESC R n — Select international charset
          this.commandHandler = this.readBytes(1, () => {});
          return true;

        case 0x61: // ESC a n — Justification
          this.commandHandler = this.readBytes(1, ([n]) => {
            this.flushSegment();
            if (n === 0 || n === 48) this.state.align = 'left';
            else if (n === 1 || n === 49) this.state.align = 'center';
            else if (n === 2 || n === 50) this.state.align = 'right';
          });
          return true;

        case 0x64: // ESC d n — Feed n lines
          this.commandHandler = this.readBytes(1, ([n]) => {
            this.flushLine();
            for (let i = 0; i < n - 1; i++) {
              this.lines.push({ segments: [{ text: '', bold: false, underline: 0, font: this.state.font, width: 1, height: 1, reverse: false }], align: this.state.align });
            }
          });
          return true;

        case 0x74: // ESC t n — Select code table
          this.commandHandler = this.readBytes(1, ([n]) => {
            this.flushSegment();
            if (!CODE_TABLES[n]) console.warn(`[escpos-parser] Unsupported code table: ${n}`);
            this.state.codeTable = CODE_TABLES[n] ? n : null;
          });
          return true;

        case 0x70: // ESC p m t1 t2 — Generate pulse (cash drawer)
          this.commandHandler = this.readBytes(3, () => {});
          return true;

        case 0x5c: // ESC \ nL nH — Set relative print position
          this.commandHandler = this.readBytes(2, ([nL, nH]) => {
            const offset = nL + nH * 256;
            this.setAbsolutePosition(this.currentPosDots + offset);
          });
          return true;

        case 0x63: // ESC c — Paper sensor (subcommand + 1 byte)
          this.commandHandler = this.readBytes(2, () => {});
          return true;

        case 0x69: // ESC i — Partial cut (obsolete)
          this.flushLine();
          this.emitReceipt();
          return true;

        case 0x6d: // ESC m — Full cut (obsolete)
          this.flushLine();
          this.emitReceipt();
          return true;

        default:
          console.warn(`[escpos-parser] Unknown ESC command: 0x${byte.toString(16)}`);
          this.commandHandler = this.readBytes(1, () => {});
          return true;
      }
    };
  }

  // --- FS commands (0x1C ...) ---

  private handleFs(): (byte: number) => boolean {
    return (byte: number): boolean => {
      switch (byte) {
        case 0x2e: // FS . — Cancel Kanji character mode
          return true;

        case 0x70: // FS p n m — Print NV bit image
          this.commandHandler = this.readBytes(2, ([n, m]) => {
            const image = this.memory.nvBitImages[n - 1];
            if (!image) {
              console.warn(`[escpos-parser] FS p: NV bit image ${n} is not defined (${this.memory.nvBitImages.length} stored)`);
              return;
            }
            const { sx, sy } = scaleFromMode(m);
            this.printImage(scaleRaster(image, sx, sy), 'nv-image');
          });
          return true;

        case 0x71: // FS q n [xL xH yL yH d1...dk]1...[...]n — Define NV bit images
          this.commandHandler = this.handleFsDefineNv();
          return true;

        case 0x28: // FS ( — multi-byte FS commands
          this.commandHandler = this.handleFsExtended();
          return true;

        default:
          console.warn(`[escpos-parser] Unknown FS command: 0x${byte.toString(16)}`);
          return true;
      }
    };
  }

  private handleFsExtended(): (byte: number) => boolean {
    const prefix: number[] = [];
    return (byte: number): boolean => {
      prefix.push(byte);
      if (prefix.length < 3) return false;
      const pL = prefix[1], pH = prefix[2];
      const dataLen = pL + pH * 256 - 2;
      if (dataLen > 0) {
        this.commandHandler = this.readBytes(dataLen, () => {});
      }
      return true;
    };
  }

  // --- GS commands (0x1D ...) ---

  private handleGs(): (byte: number) => boolean {
    return (byte: number): boolean => {
      switch (byte) {
        case 0x21: // GS ! n — Select character size
          this.commandHandler = this.readBytes(1, ([n]) => {
            this.flushSegment();
            this.state.width = ((n >> 4) & 0x07) + 1;
            this.state.height = (n & 0x07) + 1;
          });
          return true;

        case 0x42: // GS B n — Reverse print
          this.commandHandler = this.readBytes(1, ([n]) => {
            this.flushSegment();
            this.state.reverse = !!(n & 0x01);
          });
          return true;

        case 0x56: // GS V m [n] — Cut paper
          this.commandHandler = this.handleGsCut();
          return true;

        case 0x76: // GS v 0 — Print raster bit image
          this.commandHandler = this.handleGsRasterImage();
          return true;

        case 0x2a: // GS * x y d1...d(x*y*8) — Define downloaded bit image
          this.commandHandler = this.handleGsDefineDownloaded();
          return true;

        case 0x2f: // GS / m — Print downloaded bit image
          this.commandHandler = this.readBytes(1, ([m]) => {
            if (!this.downloadedBitImage) {
              console.warn('[escpos-parser] GS /: no downloaded bit image defined');
              return;
            }
            const { sx, sy } = scaleFromMode(m);
            this.printImage(scaleRaster(this.downloadedBitImage, sx, sy), 'download-image');
          });
          return true;

        case 0x38: // GS 8 L p1 p2 p3 p4 m fn ... — graphics commands with a 4-byte length
          this.commandHandler = this.handleGs8();
          return true;

        case 0x28: // GS ( — multi-byte GS commands
          this.commandHandler = this.handleGsExtended();
          return true;

        case 0x6b: // GS k — Print barcode
          this.commandHandler = this.handleGsBarcode();
          return true;

        case 0x4c: // GS L nL nH — Set left margin
        case 0x50: // GS P x y — Set horizontal and vertical motion units
          this.commandHandler = this.readBytes(2, () => {});
          return true;

        case 0x57: // GS W nL nH — Set print area width
          this.commandHandler = this.readBytes(2, ([nL, nH]) => {
            // At least one character wide, and never past the printable area
            const width = Math.max(nL + nH * 256, this.charWidthDots);
            this.state.printAreaWidth = Math.min(width, this.printableWidthDots);
          });
          return true;

        case 0x48: // GS H n — HRI position
          this.commandHandler = this.readBytes(1, ([n]) => {
            this.state.hriPosition = (n >= 48 ? n - 48 : n) & (HRI_ABOVE | HRI_BELOW);
          });
          return true;

        case 0x68: // GS h n — Barcode height
          this.commandHandler = this.readBytes(1, ([n]) => {
            if (n > 0) this.state.barcodeHeight = n;
          });
          return true;

        case 0x77: // GS w n — Barcode width
          this.commandHandler = this.readBytes(1, ([n]) => {
            if (n > 0) this.state.barcodeModuleWidth = n;
          });
          return true;

        case 0x66: // GS f n — HRI font
          this.commandHandler = this.readBytes(1, ([n]) => {
            this.state.hriFont = (n === 1 || n === 49) ? 'B' : 'A';
          });
          return true;

        default:
          console.warn(`[escpos-parser] Unknown GS command: 0x${byte.toString(16)}`);
          return true;
      }
    };
  }

  private handleGsCut(): (byte: number) => boolean {
    return (byte: number): boolean => {
      if (byte === 65 || byte === 66) {
        this.commandHandler = this.readBytes(1, () => {
          this.flushLine();
          this.emitReceipt();
        });
      } else {
        this.flushLine();
        this.emitReceipt();
      }
      return true;
    };
  }

  /** GS v 0 m xL xH yL yH d1...dk: x bytes wide, y dots high, raster rows */
  private handleGsRasterImage(): (byte: number) => boolean {
    const header: number[] = [];
    return (byte: number): boolean => {
      header.push(byte);
      if (header.length < 6) return false;
      const [, m, xL, xH, yL, yH] = header;
      const widthBytes = xL + xH * 256, height = yL + yH * 256;
      const dataLen = widthBytes * height;
      if (dataLen > 0) {
        this.commandHandler = this.readBytes(dataLen, (data) => {
          const { sx, sy } = scaleFromMode(m);
          this.printImage(scaleRaster(fromRasterBytes(widthBytes, height, data), sx, sy), 'raster');
        });
      }
      return true;
    };
  }

  /**
   * ESC * m nL nH d1...dk: one band of column data. m = 0/1 are 8 dots high, 32/33 24 dots high; the single-density
   * modes (0, 32) print each column 2 dots wide, and the 8-dot modes print each dot 2 dots high on a 203 dpi head.
   * Hosts print a logo as a stack of bands, each followed by LF with ESC 3 set to the band height; the bands are joined
   * into one image here, with the line spacing beyond the band height as a blank gap.
   */
  private handleEscBitImage(): (byte: number) => boolean {
    const header: number[] = [];
    return (byte: number): boolean => {
      header.push(byte);
      if (header.length < 3) return false;
      const [m, nL, nH] = header;
      const columns = nL + nH * 256;
      const bytesPerColumn = m === 32 || m === 33 ? 3 : 1;
      if (![0, 1, 32, 33].includes(m)) console.warn(`[escpos-parser] ESC *: unknown mode ${m}, read as 8-dot`);
      const sx = m === 0 || m === 32 ? 2 : 1;
      const sy = bytesPerColumn === 1 ? 2 : 1;
      if (columns > 0) {
        this.commandHandler = this.readBytes(columns * bytesPerColumn, (data) => {
          const band = scaleRaster(fromColumnBytes(columns, bytesPerColumn, data), sx, sy);
          // A band starts at the current print position (after text or ESC $ on the same line)
          const offset = this.currentPosDots;
          this.pendingBand = offset > 0 ? stackRasterOffset(band, offset) : band;
          this.currentPosDots += band.widthDots;
        });
      }
      return true;
    };
  }

  /** The ESC * band of the current line, printed when the line ends */
  private pendingBand: Raster | null = null;

  private finishBand(): void {
    const band = cropWidth(this.pendingBand!, this.state.printAreaWidth);
    this.pendingBand = null;
    this.lineSegments = [];
    this.currentPosDots = 0;
    this.lineUsedAbsPos = false;
    const last = this.lines[this.lines.length - 1];
    if (last && last === this.lastBandLine && last.image) {
      // The previous line was a band too: the paper moved by the line spacing, so the band goes right under it
      const gap = this.state.lineSpacing !== null ? Math.max(0, this.state.lineSpacing - this.lastBandHeight) : 0;
      last.image = encodeImage(stackRasters(decodeImage(last.image), band, gap), 'bit-image');
    } else {
      this.lastBandLine = { segments: [], align: 'left', image: encodeImage(band, 'bit-image') };
      this.lines.push(this.lastBandLine);
    }
    this.lastBandHeight = band.heightDots;
  }

  private lastBandLine: ReceiptLine | null = null;
  private lastBandHeight = 0;

  /**
   * Prints an image on a line of its own, in the current justification; the part past the print area is cut off as on
   * paper.
   */
  private printImage(raster: Raster, kind: ImageKind, text?: string): void {
    if (this.currentText.length > 0 || this.lineSegments.length > 0) this.flushLine();
    if (raster.widthDots > this.state.printAreaWidth) {
      console.warn(`[escpos-parser] ${kind} image is ${raster.widthDots} dots wide, cut to the ${this.state.printAreaWidth} dot print area`);
    }
    const image = encodeImage(cropWidth(raster, this.state.printAreaWidth), kind);
    if (text !== undefined) image.text = text;
    this.lines.push({ segments: [], align: this.state.align, image });
  }

  /** FS q n [xL xH yL yH d1...dk]1...[xL xH yL yH d1...dk]n: x*8 dots wide, y*8 dots high, column data */
  private handleFsDefineNv(): (byte: number) => boolean {
    let count = -1;
    const images: Raster[] = [];
    const readImage = (): ((byte: number) => boolean) => {
      const header: number[] = [];
      return (byte: number): boolean => {
        header.push(byte);
        if (header.length < 4) return false;
        const x = header[0] + header[1] * 256, y = header[2] + header[3] * 256;
        const done = (data: number[]) => {
          images.push(fromColumnBytes(x * 8, y, data));
          if (images.length < count) this.commandHandler = readImage();
          else this.memory.nvBitImages = images;
          return images.length >= count;
        };
        if (x * y === 0) {
          done([]);
          return true;
        }
        // When a callback sets another handler (the next image), process() keeps it
        this.commandHandler = this.readBytes(x * y * 8, (data) => {
          if (done(data)) console.log(`[escpos-parser] FS q: ${images.length} NV bit image(s) stored`);
        });
        return true;
      };
    };
    return (byte: number): boolean => {
      count = byte;
      if (count === 0) {
        this.memory.nvBitImages = [];
        return true;
      }
      this.commandHandler = readImage();
      return true;
    };
  }

  /** GS * x y d1...d(x*y*8): x*8 dots wide, y*8 dots high, column data */
  private handleGsDefineDownloaded(): (byte: number) => boolean {
    const header: number[] = [];
    return (byte: number): boolean => {
      header.push(byte);
      if (header.length < 2) return false;
      const [x, y] = header;
      if (x * y > 0) {
        this.commandHandler = this.readBytes(x * y * 8, (data) => {
          this.downloadedBitImage = fromColumnBytes(x * 8, y, data);
        });
      }
      return true;
    };
  }

  /** GS ( k / GS ( L / other GS ( commands: GS ( <cmd> pL pH <payload of pL + pH*256 bytes> */
  private handleGsExtended(): (byte: number) => boolean {
    const header: number[] = [];
    return (byte: number): boolean => {
      header.push(byte);
      if (header.length < 3) return false;
      const [cmd, pL, pH] = header;
      const dataLen = pL + pH * 256;
      if (dataLen > 0) {
        this.commandHandler = this.readBytes(dataLen, (payload) => {
          if (cmd === 0x6b) this.handle2dCode(payload);
          else if (cmd === 0x4c) this.handleGraphics(payload);
        });
      }
      return true;
    };
  }

  /** GS 8 L p1 p2 p3 p4 <payload>: the 4-byte length form of GS ( L, for large graphics */
  private handleGs8(): (byte: number) => boolean {
    const header: number[] = [];
    return (byte: number): boolean => {
      header.push(byte);
      if (header.length < 5) return false;
      const [cmd, p1, p2, p3, p4] = header;
      const dataLen = p1 + p2 * 0x100 + p3 * 0x10000 + p4 * 0x1000000;
      if (cmd !== 0x4c) console.warn(`[escpos-parser] Unknown GS 8 command: 0x${cmd.toString(16)}`);
      if (dataLen > 0) {
        this.commandHandler = this.readBytes(dataLen, (payload) => {
          if (cmd === 0x4c) this.handleGraphics(payload);
        });
      }
      return true;
    };
  }

  /** GS ( k cn fn ...: 2D symbols. cn = 49 QR Code, cn = 48 PDF417 (data shown as text) */
  private handle2dCode(payload: number[]): void {
    const [cn, fn] = payload;
    if (cn === 49) {
      switch (fn) {
        case 65: break; // model (1 or 2): model 2 is always used
        case 67: { // module size
          const n = payload[2];
          if (n >= 1 && n <= 16) this.state.qrModuleSize = n;
          break;
        }
        case 69: { // error correction level
          const ecc = QR_ECC[payload[2]];
          if (ecc) this.state.qrEcc = ecc;
          break;
        }
        case 80: // store data: cn fn m d1...dk
          this.qrData = payload.slice(3);
          break;
        case 81: { // print the stored symbol
          const raster = encodeQr(this.qrData, this.state.qrModuleSize, this.state.qrEcc);
          if (!raster) {
            console.warn('[escpos-parser] QR: no data stored or too much data, symbol not printed');
            return;
          }
          if (raster.widthDots > this.state.printAreaWidth) {
            console.warn(`[escpos-parser] QR is ${raster.widthDots} dots wide, past the ${this.state.printAreaWidth} dot print area: not printed`);
            return;
          }
          this.printImage(raster, 'qr', Buffer.from(this.qrData).toString('latin1'));
          break;
        }
        default: break; // 82: transmit size information (no back channel)
      }
    } else if (cn === 48) {
      if (fn === 80) this.pdf417Data = payload.slice(3);
      if (fn === 81 && this.pdf417Data.length) {
        console.warn('[escpos-parser] PDF417 not rendered, showing its data only');
        if (this.currentText.length > 0 || this.lineSegments.length > 0) this.flushLine();
        this.lines.push({
          segments: [{ text: `[PDF417] ${Buffer.from(this.pdf417Data).toString('latin1')}`, bold: false, underline: 0, font: 'B', width: 1, height: 1, reverse: false }],
          align: this.state.align,
        });
      }
    } else {
      console.warn(`[escpos-parser] GS ( k: unsupported symbol cn=${cn}`);
    }
  }

  /** GS ( L / GS 8 L m fn ...: graphics. Raster data only (a = 48, monochrome; for multi-tone the first plane is used) */
  private handleGraphics(payload: number[]): void {
    const [, fn] = payload; // payload[0] = m (48)
    const readGraphic = (offset: number): Raster | null => {
      // a bx by c xL xH yL yH d1...dk, from `offset`
      const bx = payload[offset + 1], by = payload[offset + 2];
      const w = payload[offset + 4] + payload[offset + 5] * 256, h = payload[offset + 6] + payload[offset + 7] * 256;
      if (!w || !h) return null;
      const data = payload.slice(offset + 8, offset + 8 + Math.ceil(w / 8) * h);
      return scaleRaster(fromRasterBytes(Math.ceil(w / 8), h, data, w), bx === 2 || bx === 50 ? 2 : 1, by === 2 || by === 50 ? 2 : 1);
    };
    const readDefinition = (): { key: string; raster: Raster } | null => {
      // a kc1 kc2 b xL xH yL yH [c d1...dk]1...b
      const kc1 = payload[3], kc2 = payload[4];
      const w = payload[6] + payload[7] * 256, h = payload[8] + payload[9] * 256;
      if (!w || !h) return null;
      const data = payload.slice(11, 11 + Math.ceil(w / 8) * h);
      return { key: ImageMemory.key(kc1, kc2), raster: fromRasterBytes(Math.ceil(w / 8), h, data, w) };
    };
    const printByKey = (store: Map<string, Raster>, kind: ImageKind) => {
      // kc1 kc2 x y
      const key = ImageMemory.key(payload[2], payload[3]);
      const raster = store.get(key);
      if (!raster) {
        console.warn(`[escpos-parser] GS ( L fn ${fn}: graphic "${key}" is not defined`);
        return;
      }
      const sx = payload[4] === 2 ? 2 : 1, sy = payload[5] === 2 ? 2 : 1;
      this.printImage(scaleRaster(raster, sx, sy), kind);
    };

    switch (fn) {
      case 112: // store graphics data in the print buffer (raster)
        this.graphicsBuffer = readGraphic(2);
        break;
      case 50: // print the graphics in the print buffer
      case 2:
        if (this.graphicsBuffer) this.printImage(this.graphicsBuffer, 'graphics');
        this.graphicsBuffer = null;
        break;
      case 67: { // define NV graphics (raster)
        const def = readDefinition();
        if (def) this.memory.nvGraphics.set(def.key, def.raster);
        break;
      }
      case 69: // print NV graphics
        printByKey(this.memory.nvGraphics, 'nv-image');
        break;
      case 83: { // define download graphics (raster)
        const def = readDefinition();
        if (def) this.downloadGraphics.set(def.key, def.raster);
        break;
      }
      case 85: // print download graphics
        printByKey(this.downloadGraphics, 'download-image');
        break;
      case 65: // delete all NV graphics
        this.memory.nvGraphics.clear();
        break;
      case 66: // delete one NV graphic: kc1 kc2
        this.memory.nvGraphics.delete(ImageMemory.key(payload[2], payload[3]));
        break;
      default:
        break; // 48/49/64/80/81...: capacity queries, column format and other functions with no visible effect
    }
  }

  private handleGsBarcode(): (byte: number) => boolean {
    let m = -1;
    return (byte: number): boolean => {
      if (m === -1) {
        m = byte;
        const system = m;
        const print = (data: number[]) => this.printBarcode(system, data);
        this.commandHandler = m >= 65 ? this.readBarcodeLengthPrefixed(print) : this.readUntilNull(print);
        return true;
      }
      return true;
    };
  }

  private readBarcodeLengthPrefixed(onData: (data: number[]) => void): (byte: number) => boolean {
    let len = -1;
    const data: number[] = [];
    return (byte: number): boolean => {
      if (len === -1) {
        len = byte;
        if (len === 0) onData(data);
        return len === 0;
      }
      data.push(byte);
      if (data.length >= len) { onData(data); return true; }
      return false;
    };
  }

  private readUntilNull(onData: (data: number[]) => void): (byte: number) => boolean {
    const data: number[] = [];
    return (byte: number): boolean => {
      if (byte === 0x00) { onData(data); return true; }
      data.push(byte);
      return false;
    };
  }

  /**
   * Prints the barcode on lines of its own, in the current justification, with the HRI text above and/or below it as
   * GS H asks. CODE128 is drawn module by module, at the module width and height set with GS w and GS h; the other
   * symbologies are not encoded and show their data only.
   */
  private printBarcode(system: number, data: number[]): void {
    if (this.currentText.length > 0 || this.lineSegments.length > 0) this.flushLine();

    const code128 = system === CODE128 ? encodeCode128(data) : null;
    if (system === CODE128 && !code128) {
      console.warn('[escpos-parser] Invalid CODE128 data, barcode not printed');
      return;
    }
    if (code128 && code128.modules.length * this.state.barcodeModuleWidth > this.state.printAreaWidth) {
      console.warn(`[escpos-parser] CODE128 is ${code128.modules.length * this.state.barcodeModuleWidth} dots wide, `
        + `past the ${this.state.printAreaWidth} dot print area: barcode not printed`);
      return;
    }
    const text = code128 ? code128.text : String.fromCharCode(...data);
    const hriLine = (): ReceiptLine => ({
      segments: [{ text, bold: false, underline: 0, font: this.state.hriFont, width: 1, height: 1, reverse: false }],
      align: this.state.align,
    });

    if (this.state.hriPosition & HRI_ABOVE) this.lines.push(hriLine());
    if (code128) {
      this.lines.push({
        segments: [],
        align: this.state.align,
        barcode: {
          modules: code128.modules,
          moduleWidthDots: this.state.barcodeModuleWidth,
          heightDots: this.state.barcodeHeight,
        },
      });
    } else {
      console.warn(`[escpos-parser] Barcode system ${system} not rendered, showing its data only`);
    }
    if ((this.state.hriPosition & HRI_BELOW) || !code128) this.lines.push(hriLine());
  }

  private readBytes(count: number, fn: (bytes: number[]) => void): (byte: number) => boolean {
    const buf: number[] = [];
    return (byte: number): boolean => {
      buf.push(byte);
      if (buf.length >= count) { fn(buf); return true; }
      return false;
    };
  }
}

/** Moves a band right by `offsetDots` (printed after text or an ESC $ position on the same line) */
function stackRasterOffset(band: Raster, offsetDots: number): Raster {
  const out = createRaster(band.widthDots + offsetDots, band.heightDots);
  for (let y = 0; y < band.heightDots; y++) {
    for (let x = 0; x < band.widthDots; x++) if (getDot(band, x, y)) setDot(out, x + offsetDots, y);
  }
  return out;
}

function encodeImage(raster: Raster, kind: ImageKind): NonNullable<ReceiptLine['image']> {
  return {
    kind,
    widthDots: raster.widthDots,
    heightDots: raster.heightDots,
    data: Buffer.from(raster.data).toString('base64'),
  };
}

function decodeImage(image: NonNullable<ReceiptLine['image']>): Raster {
  return { widthDots: image.widthDots, heightDots: image.heightDots, data: new Uint8Array(Buffer.from(image.data, 'base64')) };
}
