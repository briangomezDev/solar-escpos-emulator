# solar-escpos-emulator

> Fork of [lezram/escpos-emulator](https://github.com/lezram/escpos-emulator) (MIT) that adds a **2Connect POS-80** printer
> profile and renders **images (company logos)** and **QR codes**. All credit for the original emulator goes to lezram;
> this fork is distributed under the same MIT license (see [LICENSE](./LICENSE)).

### What this fork adds

- **2Connect 2C-POS80 profile** (`PRINTER_MODEL=2C-POS80`, aliases `POS-80`, `2CONNECT-POS80`, `2C-POS80-01`,
  `2C-POS80-02`): 80 mm paper, 203 dpi, 576-dot print head, Font A 12×24 (48 columns), Font B 9×17 (64 columns),
  PC437 code page after `ESC @`, as in the 2Connect datasheets (2C-POS80-01-V6/V7, 2C-POS80-02).
- **Images / logos**, drawn dot for dot in the preview and returned in the API:
  `GS v 0` raster images, `ESC *` bit-image bands (joined into one logo), NV logos stored with `FS q` and printed with
  `FS p` (kept across connections, like the printer's flash), `GS *` / `GS /` downloaded images, and the Epson
  graphics commands `GS ( L` / `GS 8 L` (fn 112/50 print buffer, fn 67/69 NV graphics, fn 83/85 download graphics).
- **QR codes** with `GS ( k` (model, module size 1–16, error correction L/M/Q/H, store, print). PDF417 shows its data
  as text.
- `npm test` with unit tests for the new commands.

The full list of changes (in Spanish) is in [CHANGELOG.md](./CHANGELOG.md).

![ESC/POS Emulator](./assets/escpos_emulator.jpg)

A lightweight ESC/POS thermal receipt printer emulator for development and testing. Receives raw ESC/POS byte streams over TCP (like a real printer), parses them, and provides:

- **Live HTML preview** — receipts render in your browser as they arrive
- **REST API** — retrieve and validate receipt content in automated tests
- **WebSocket** — real-time updates pushed to connected browsers
- **Multiple printers** — run several virtual printers on different TCP ports, each with its own receipt view

Emulates an **Epson TM-M30III** (default) or a **2Connect POS-80** (80mm paper, Font A: 48 chars/line, Font B: 64 chars/line).

## Quick Use

```bash
npx escpos-emulator          # no install, just run
npm i -g escpos-emulator     # or install globally
escpos-emulator              # then run anytime
```

### Docker

Single printer (default):

```bash
docker run -p 9100:9100 -p 3000:3000 ghcr.io/lezram/escpos-emulator
```

Multiple printers — expose one host port per TCP printer port, then pass the `PRINTERS` config:

```bash
docker run \
  -p 3000:3000 \
  -p 9100:9100 \
  -p 9101:9101 \
  -e PRINTERS='[{"id":"counter","name":"Counter","tcpPort":9100},{"id":"kitchen","name":"Kitchen","tcpPort":9101}]' \
  ghcr.io/lezram/escpos-emulator
```

> Each printer `tcpPort` in the JSON must match a `-p <host>:<container>` port mapping so the POS app can reach it.

## Quick Start (from source)

```bash
npm ci
npm run dev
```

- **TCP printer**: `localhost:9100` — point your POS app here
- **Web UI**: `http://localhost:3000` — live receipt viewer
- **API**: `http://localhost:3000/api/printers` — JSON access

## Test Print

```bash
npm run test-print
```

Sends a sample formatted receipt to verify the emulator works.

## Configuration

### Single printer

| Variable | Default | Description |
|----------|---------|-------------|
| `TCP_PORT` | `9100` | Port the virtual printer listens on |
| `HTTP_PORT` | `3000` | Port for web UI and REST API |
| `PRINTER_MODEL` | `TM-M30III` | Printer model to emulate: `TM-M30III` or `2C-POS80` (alias `POS-80`) |
| `PRINTER_NAME` | `Printer` | Display name shown in the UI |

### Multiple printers

Set `PRINTERS` to a JSON array. Each entry defines one virtual printer. When `PRINTERS` is set, the single-printer variables above are ignored.

```bash
PRINTERS='[
  {"id":"counter", "name":"Counter",  "tcpPort":9100},
  {"id":"kitchen", "name":"Kitchen",  "tcpPort":9101},
  {"id":"bar",     "name":"Bar",      "tcpPort":9102, "model":"POS-80"}
]' escpos-emulator
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier used in API paths |
| `name` | yes | Display name shown in the UI tab |
| `tcpPort` | yes | TCP port this printer listens on |
| `model` | no | Printer model (default: `TM-M30III`; `2C-POS80` / `POS-80` for the 2Connect) |

The web UI shows a tab per printer. Selecting a tab switches the receipt list and the online/offline toggle to that printer.

## REST API

### Printer list

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/printers` | All printers with id, name, tcpPort, enabled state |

### Per-printer endpoints

Replace `:id` with the printer `id` from the config.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/printers/:id/receipts` | All stored receipts for this printer |
| GET | `/api/printers/:id/receipts/last` | Most recent receipt |
| GET | `/api/printers/:id/receipts/:receiptId` | Single receipt by ID |
| DELETE | `/api/printers/:id/receipts` | Clear all receipts for this printer |
| GET | `/api/printers/:id/status` | `{ enabled: true\|false }` |
| POST | `/api/printers/:id/toggle` | Toggle printer on/off |

## Supported ESC/POS Commands

| Command | Bytes | Function |
|---------|-------|----------|
| ESC @ | `1B 40` | Initialize printer |
| ESC ! | `1B 21 n` | Select print mode (font/bold/size/underline) |
| ESC - | `1B 2D n` | Underline on/off |
| ESC 2 | `1B 32` | Default line spacing |
| ESC 3 | `1B 33 n` | Set line spacing |
| ESC E | `1B 45 n` | Bold on/off |
| ESC M | `1B 4D n` | Select font (A/B) |
| ESC R | `1B 52 n` | International charset |
| ESC a | `1B 61 n` | Justification (left/center/right) |
| ESC d | `1B 64 n` | Feed n lines |
| ESC t | `1B 74 n` | Select code table (0 PC437, 2 PC850, 3 PC860, 4 PC863, 5 PC865, 16 WPC1252, 17 PC866, 18 PC852, 19 PC858, 40 ISO 8859-15; ISO 8859-15 until one is selected) |
| ESC p | `1B 70 m t1 t2` | Cash drawer pulse |
| ESC * | `1B 2A m nL nH d...` | Bit image band (8/24 dots, single/double density); consecutive bands form one image |
| FS q | `1C 71 n [xL xH yL yH d...]...` | Define NV bit images (logos), kept while the emulator runs |
| FS p | `1C 70 n m` | Print NV bit image n (m: normal / double width / double height / quadruple) |
| GS * | `1D 2A x y d...` | Define downloaded bit image |
| GS / | `1D 2F m` | Print downloaded bit image |
| GS ! | `1D 21 n` | Character size (width/height multiplier) |
| GS B | `1D 42 n` | Reverse print on/off |
| GS V | `1D 56 m` | Paper cut |
| GS L | `1D 4C nL nH` | Left margin (skipped) |
| GS P | `1D 50 x y` | Motion units (skipped) |
| GS W | `1D 57 nL nH` | Print area width: sets the paper width in the preview, text wraps at it |
| GS v 0 | `1D 76 30 m xL xH yL yH d...` | Raster bit image (logos), cut at the print area |
| GS ( L / GS 8 L | `1D 28 4C ...` / `1D 38 4C ...` | Graphics: print buffer (fn 112 + fn 50), NV graphics (fn 67 / 69), download graphics (fn 83 / 85) |
| GS ( k | `1D 28 6B ...` | QR Code (cn 49: fn 65 model, 67 module size, 69 error correction, 80 store, 81 print); PDF417 shown as text |
| GS k | `1D 6B m ...` | Barcode: CODE128 (`m` = 73) is drawn, and not printed when wider than the print area; other symbologies show their data as text |
| GS H | `1D 48 n` | Barcode HRI position (none/above/below/both) |
| GS f | `1D 66 n` | Barcode HRI font |
| GS h | `1D 68 n` | Barcode height |
| GS w | `1D 77 n` | Barcode module width |

Unsupported commands are gracefully skipped with a console warning.

## Adding a Printer Model

Edit `src/printer-model.ts` and add a new object conforming to `PrinterModel`:

```typescript
export const MY_PRINTER: PrinterModel = {
  name: 'My-Printer',
  vendor: 'Vendor',
  paperWidthMm: 80,
  printableWidthMm: 72,
  dpi: 203,
  fonts: {
    A: { charsPerLine: 42, widthPx: 12, heightPx: 24 },
    B: { charsPerLine: 56, widthPx: 9, heightPx: 24 },
  },
  defaultFont: 'A',
  defaultCodePage: 'iso-8859-15',
};
```

Then add it to the `models` record and set `model` to `My-Printer` in the printer config.

## Architecture

```
POS App ──TCP:9100──► EscPosParser ──► ReceiptStore (printer 1) ──┐
POS App ──TCP:9101──► EscPosParser ──► ReceiptStore (printer 2) ──┼──► HTTP API + WebSocket ──► Browser
POS App ──TCP:910N──► EscPosParser ──► ReceiptStore (printer N) ──┘
```

## Images in the API

A line that holds an image carries an `image` object instead of text segments:

```json
{ "segments": [], "align": "center",
  "image": { "kind": "qr", "widthDots": 174, "heightDots": 174, "data": "<base64>", "text": "https://..." } }
```

`kind` is `raster` (GS v 0), `bit-image` (ESC *), `nv-image` (FS p, GS ( L fn 69), `download-image` (GS /, fn 85),
`graphics` (GS ( L fn 50) or `qr`. `data` is the base64 of the packed bits: row by row, MSB first,
`ceil(widthDots / 8)` bytes per row, 1 = black dot. QR images also carry the encoded `text`.

## License

MIT — see [LICENSE](./LICENSE). Original work © lezram ([escpos-emulator](https://github.com/lezram/escpos-emulator));
fork modifications © Brian Gomez. QR encoding uses [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
(MIT, © Kazuhiko Arase).
