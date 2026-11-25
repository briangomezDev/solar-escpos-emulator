import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EscPosParser } from '../src/escpos-parser.js';
import { getModel } from '../src/printer-model.js';
import { ImageMemory } from '../src/image-memory.js';
import { type Receipt, type ReceiptLine } from '../src/receipt.js';

const ESC = 0x1b, GS = 0x1d, FS = 0x1c, LF = 0x0a;

function print(bytes: number[], model = '2C-POS80', memory = new ImageMemory()): Receipt[] {
  const receipts: Receipt[] = [];
  const parser = new EscPosParser(getModel(model), r => receipts.push(r), memory);
  parser.process(Buffer.from(bytes));
  parser.flush();
  return receipts;
}

function imageLines(r: Receipt): ReceiptLine[] {
  return r.lines.filter(l => l.image);
}

function dot(line: ReceiptLine, x: number, y: number): boolean {
  const img = line.image!;
  const data = Buffer.from(img.data, 'base64');
  return (data[y * Math.ceil(img.widthDots / 8) + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
}

test('2Connect POS-80 profile: 576 dots, Font A 48 / Font B 64 columns, PC437 after ESC @', () => {
  const model = getModel('POS-80');
  assert.equal(model.vendor, '2Connect');
  assert.equal(model.fonts.A.charsPerLine * model.fonts.A.widthPx, 576);
  assert.equal(model.fonts.B.charsPerLine, 64);
  assert.equal(getModel('2c-pos80').name, '2C-POS80');
  // 0x82 is é in PC437 (0x82 is ‚ in ISO 8859-15 / CP1252)
  const [r] = print([ESC, 0x40, 0x82, LF]);
  assert.equal(r.lines[0].segments[0].text, 'é');
  assert.equal(r.printAreaDots, 576);
});

test('GS v 0: raster image, centered, with text after it', () => {
  // 2 bytes x 2 rows: first row all black, second row only the left dot
  const [r] = print([ESC, 0x61, 1, GS, 0x76, 0x30, 0, 2, 0, 2, 0, 0xff, 0xff, 0x80, 0x00, ...Buffer.from('OK'), LF]);
  const [img] = imageLines(r);
  assert.equal(img.image!.kind, 'raster');
  assert.equal(img.align, 'center');
  assert.deepEqual([img.image!.widthDots, img.image!.heightDots], [16, 2]);
  assert.ok(dot(img, 15, 0) && dot(img, 0, 1) && !dot(img, 1, 1));
  assert.equal(r.lines.at(-1)!.segments[0].text, 'OK');
  assert.ok(!r.lines.some(l => l.segments.some(s => s.text.includes('[IMAGE]'))));
});

test('GS v 0 m=3: quadruple size; images wider than the print area are cut', () => {
  const [r] = print([GS, 0x76, 0x30, 3, 1, 0, 1, 0, 0x80]);
  const [img] = imageLines(r);
  assert.deepEqual([img.image!.widthDots, img.image!.heightDots], [16, 2]);
  assert.ok(dot(img, 1, 1) && !dot(img, 2, 0));
  const [wide] = print([GS, 0x76, 0x30, 0, 80, 0, 1, 0, ...new Array(80).fill(0xff)]);
  assert.equal(imageLines(wide)[0].image!.widthDots, 576);
});

test('ESC * 24-dot bands joined into one logo image', () => {
  const band = (fill: number) => [ESC, 0x2a, 33, 4, 0, ...new Array(4 * 3).fill(fill), LF];
  const [r] = print([ESC, 0x33, 24, ...band(0xff), ...band(0x00), ...band(0xff), ESC, 0x32]);
  const imgs = imageLines(r);
  assert.equal(imgs.length, 1);
  assert.equal(imgs[0].image!.kind, 'bit-image');
  assert.deepEqual([imgs[0].image!.widthDots, imgs[0].image!.heightDots], [4, 72]);
  assert.ok(dot(imgs[0], 0, 0) && !dot(imgs[0], 0, 30) && dot(imgs[0], 3, 71));
});

test('ESC * 8-dot single density prints each dot 2x2', () => {
  const [r] = print([ESC, 0x2a, 0, 1, 0, 0x80, LF]);
  const [img] = imageLines(r);
  assert.deepEqual([img.image!.widthDots, img.image!.heightDots], [2, 16]);
  assert.ok(dot(img, 1, 1) && !dot(img, 0, 2));
});

test('FS q / FS p: NV logo stored on one connection prints on the next', () => {
  const memory = new ImageMemory();
  // one image: 1 x 8 columns, 1 byte (8 dots) per column, top dot of every column black
  const none = print([FS, 0x71, 1, 1, 0, 1, 0, ...new Array(8).fill(0x80)], '2C-POS80', memory);
  assert.equal(none.length, 0);
  assert.equal(memory.nvBitImages.length, 1);
  const [r] = print([ESC, 0x61, 1, FS, 0x70, 1, 0, ...Buffer.from('Gracias'), LF], '2C-POS80', memory);
  const [img] = imageLines(r);
  assert.equal(img.image!.kind, 'nv-image');
  assert.deepEqual([img.image!.widthDots, img.image!.heightDots], [8, 8]);
  assert.ok(dot(img, 7, 0) && !dot(img, 7, 1));
  assert.equal(r.lines.at(-1)!.segments[0].text, 'Gracias');
});

test('FS q with two images, FS p 2 prints the second, double width', () => {
  const memory = new ImageMemory();
  print([FS, 0x71, 2, 1, 0, 1, 0, ...new Array(8).fill(0xff), 2, 0, 1, 0, ...new Array(16).fill(0x01)], '2C-POS80', memory);
  assert.equal(memory.nvBitImages.length, 2);
  const [r] = print([FS, 0x70, 2, 1], '2C-POS80', memory);
  const [img] = imageLines(r);
  assert.deepEqual([img.image!.widthDots, img.image!.heightDots], [32, 8]);
  assert.ok(dot(img, 31, 7) && !dot(img, 31, 6));
});

test('GS * / GS /: downloaded bit image', () => {
  const [r] = print([GS, 0x2a, 1, 1, ...new Array(8).fill(0xf0), GS, 0x2f, 0]);
  const [img] = imageLines(r);
  assert.equal(img.image!.kind, 'download-image');
  assert.ok(dot(img, 0, 3) && !dot(img, 0, 4));
});

test('GS ( L fn 112 + fn 50: graphics buffer; GS 8 L; fn 67/69 NV graphics by key', () => {
  const fn112 = (w: number, h: number, data: number[]) => {
    const body = [48, 112, 48, 1, 1, 49, w & 0xff, w >> 8, h & 0xff, h >> 8, ...data];
    return body;
  };
  const body = fn112(8, 1, [0xaa]);
  const [r] = print([
    GS, 0x28, 0x4c, body.length, 0, ...body,
    GS, 0x28, 0x4c, 2, 0, 48, 50,
  ]);
  assert.equal(imageLines(r)[0].image!.kind, 'graphics');
  assert.ok(dot(imageLines(r)[0], 0, 0) && !dot(imageLines(r)[0], 1, 0));

  const [r8] = print([GS, 0x38, 0x4c, body.length, 0, 0, 0, ...body, GS, 0x28, 0x4c, 2, 0, 48, 50]);
  assert.equal(imageLines(r8).length, 1);

  const memory = new ImageMemory();
  const def = [48, 67, 48, 0x41, 0x31, 1, 8, 0, 1, 0, 49, 0xff];
  print([GS, 0x28, 0x4c, def.length, 0, ...def], '2C-POS80', memory);
  const [rn] = print([GS, 0x28, 0x4c, 6, 0, 48, 69, 0x41, 0x31, 1, 1], '2C-POS80', memory);
  assert.equal(imageLines(rn)[0].image!.kind, 'nv-image');
  assert.equal(imageLines(rn)[0].image!.widthDots, 8);
});

test('GS ( k: QR code with module size and error correction', () => {
  const data = Buffer.from('https://example.com/factura/123');
  const store = [49, 80, 48, ...data];
  const [r] = print([
    ESC, 0x61, 1,
    GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0,   // model 2
    GS, 0x28, 0x6b, 3, 0, 49, 67, 6,       // module size 6
    GS, 0x28, 0x6b, 3, 0, 49, 69, 49,      // ECC M
    GS, 0x28, 0x6b, store.length & 0xff, store.length >> 8, ...store,
    GS, 0x28, 0x6b, 3, 0, 49, 81, 48,      // print
    LF,
  ]);
  const [img] = imageLines(r);
  assert.equal(img.image!.kind, 'qr');
  assert.equal(img.image!.text, data.toString());
  assert.equal(img.align, 'center');
  // 31 bytes at ECC M fit in version 3 (29 modules)
  assert.equal(img.image!.widthDots, 29 * 6);
  assert.equal(img.image!.widthDots, img.image!.heightDots);
  // finder pattern: top-left corner dark, and the separator after the 7 module finder light
  assert.ok(dot(img, 0, 0) && dot(img, 6 * 6, 0) && !dot(img, 7 * 6, 6 * 7 + 1));
});

test('GS ( k: QR wider than the print area is not printed', () => {
  const data = new Array(200).fill(0x41);
  const store = [49, 80, 48, ...data];
  const [r] = print([
    GS, 0x28, 0x6b, 3, 0, 49, 67, 16,
    GS, 0x28, 0x6b, store.length & 0xff, store.length >> 8, ...store,
    GS, 0x28, 0x6b, 3, 0, 49, 81, 48,
    ...Buffer.from('x'), LF,
  ]);
  assert.equal(imageLines(r).length, 0);
});

test('Epson TM-M30III profile unchanged: ISO 8859-15 until ESC t', () => {
  const [r] = print([0xa4, LF], 'TM-M30III');
  assert.equal(r.lines[0].segments[0].text, '€');
});
