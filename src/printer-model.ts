export interface PrinterFont {
  charsPerLine: number;
  widthPx: number;
  heightPx: number;
}

export interface PrinterModel {
  name: string;
  vendor: string;
  paperWidthMm: number;
  printableWidthMm: number;
  dpi: number;
  fonts: Record<string, PrinterFont>;
  defaultFont: string;
  defaultCodePage: string;
  /** ESC t table in force after ESC @; unset: ISO 8859-15 until the host selects one */
  defaultCodeTable?: number;
  /** Datasheet facts shown in the API, informational only */
  printSpeedMmPerSec?: number;
  interfaces?: string[];
  notes?: string;
}

export const TM_M30III: PrinterModel = {
  name: 'TM-M30III',
  vendor: 'Epson',
  paperWidthMm: 80,
  printableWidthMm: 72,
  dpi: 203,
  fonts: {
    A: { charsPerLine: 48, widthPx: 12, heightPx: 24 },
    B: { charsPerLine: 64, widthPx: 9, heightPx: 24 },
  },
  defaultFont: 'A',
  defaultCodePage: 'iso-8859-15',
};

/**
 * 2Connect (2Connet) 2C-POS80 series, 80 mm thermal receipt printer (2C-POS80-01-V6 USB, 2C-POS80-01-V7
 * USB+LAN+Bluetooth, 2C-POS80-02 USB+LAN). Datasheet: 203 dpi (8 dots/mm), 79.5 mm paper, 300 mm/s,
 * ASCII fonts 12×24 and 9×17, ESC/POS compatible, 1D barcodes, QR Code and PDF417, auto cutter.
 * The print head is 72 mm / 576 dots wide, so Font A gives 48 and Font B 64 characters per line.
 * The firmware starts in code page 0 (PC437) after ESC @.
 */
export const TWOCONNECT_POS80: PrinterModel = {
  name: '2C-POS80',
  vendor: '2Connect',
  paperWidthMm: 80,
  printableWidthMm: 72,
  dpi: 203,
  fonts: {
    A: { charsPerLine: 48, widthPx: 12, heightPx: 24 },
    B: { charsPerLine: 64, widthPx: 9, heightPx: 17 },
  },
  defaultFont: 'A',
  defaultCodePage: 'cp437',
  defaultCodeTable: 0,
  printSpeedMmPerSec: 300,
  interfaces: ['USB', 'LAN', 'Bluetooth'],
  notes: 'ESC/POS compatible; raster/bit images, NV logos (FS q / FS p), QR Code (GS ( k), CODE128 and other 1D barcodes',
};

export const models: Record<string, PrinterModel> = {
  'TM-M30III': TM_M30III,
  '2C-POS80': TWOCONNECT_POS80,
  // Aliases for the 2Connect model, as it is written on labels and invoices
  'POS-80': TWOCONNECT_POS80,
  '2CONNECT-POS80': TWOCONNECT_POS80,
  '2C-POS80-01': TWOCONNECT_POS80,
  '2C-POS80-02': TWOCONNECT_POS80,
};

export function getModel(name: string): PrinterModel {
  const model = models[name] ?? models[name.toUpperCase()];
  if (!model) throw new Error(`Unknown printer model: ${name}. Available: ${Object.keys(models).join(', ')}`);
  return model;
}
