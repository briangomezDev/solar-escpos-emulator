# Changelog

Cambios de **solar-escpos-emulator** respecto al proyecto original
[lezram/escpos-emulator](https://github.com/lezram/escpos-emulator). Licencia MIT, igual que el original
(ver [LICENSE](./LICENSE)).

## 0.4.0 — 2026-11-25

Base: escpos-emulator 0.3.0 (commit `41757d1`).

### Nuevo modelo de impresora: 2Connect POS-80

- Perfil `2C-POS80` en `src/printer-model.ts`. Se selecciona con `PRINTER_MODEL=2C-POS80` o con el campo `model` de
  `PRINTERS`. Alias aceptados (sin distinguir mayúsculas): `POS-80`, `2CONNECT-POS80`, `2C-POS80-01`, `2C-POS80-02`.
- Datos tomados de las fichas técnicas de 2Connect (2C-POS80-01-V6, 2C-POS80-01-V7 y 2C-POS80-02):

  | Característica | Valor |
  |---|---|
  | Papel | 80 mm (79,5 ± 0,5 mm) |
  | Resolución | 203 dpi (8 puntos/mm) |
  | Ancho de impresión | 72 mm = 576 puntos |
  | Fuente A | 12×24 puntos, 48 caracteres por línea |
  | Fuente B | 9×17 puntos, 64 caracteres por línea |
  | Página de códigos tras `ESC @` | 0 (PC437) |
  | Velocidad | 300 mm/s (informativo) |
  | Interfaces | USB, LAN, Bluetooth (informativo) |

- `PrinterModel` tiene campos opcionales nuevos: `defaultCodeTable` (tabla `ESC t` activa después de `ESC @`),
  `printSpeedMmPerSec`, `interfaces` y `notes`. El perfil Epson TM-M30III no cambia.
- `GET /api/printers` ahora devuelve el modelo de cada impresora (`model.name`, `vendor`, `paperWidthMm`, `dpi`).

### Imágenes (logos de empresa)

Antes las imágenes se descartaban (`GS v 0` dejaba un texto `[IMAGE]`). Ahora se dibujan punto por punto en la vista
previa y se devuelven en la API. Comandos soportados:

| Comando | Bytes | Qué hace |
|---|---|---|
| `GS v 0` | `1D 76 30 m xL xH yL yH d…` | Imagen raster. `m`: normal, doble ancho, doble alto o cuádruple. Corrige un error del original, que leía `m` como `xL`. |
| `ESC *` | `1B 2A m nL nH d…` | Franjas de imagen de 8 o 24 puntos (densidad simple o doble). Las franjas de líneas seguidas se unen en una sola imagen, respetando el espaciado de `ESC 3`. |
| `FS q` | `1C 71 n [xL xH yL yH d…]…` | Guarda logos en la memoria NV. |
| `FS p` | `1C 70 n m` | Imprime el logo NV número `n`, con escala `m`. |
| `GS *` / `GS /` | `1D 2A x y d…` / `1D 2F m` | Define e imprime una imagen descargada (se borra con `ESC @`). |
| `GS ( L` / `GS 8 L` | `1D 28 4C …` / `1D 38 4C …` | Gráficos Epson: fn 112 + fn 50 (buffer de impresión), fn 67 / 69 (gráficos NV por clave), fn 83 / 85 (gráficos descargados), fn 65 / 66 (borrar NV). |

- Las imágenes salen en su propia línea, con la justificación vigente (`ESC a`). Lo que pasa del área de impresión
  (`GS W`) se recorta, como en el papel.
- La memoria NV (`FS q`, `GS ( L` fn 67) se comparte entre todas las conexiones de una misma impresora virtual: un
  logo guardado una vez se puede imprimir en tickets posteriores. Vive mientras corre el emulador; al reiniciarlo hay
  que volver a enviarlo.

### Códigos QR

- `GS ( k` con `cn = 49`: fn 65 (modelo), fn 67 (tamaño de módulo, 1–16 puntos), fn 69 (corrección de errores
  L/M/Q/H), fn 80 (guardar datos) y fn 81 (imprimir).
- El modo (numérico, alfanumérico o bytes) se elige según los datos, como hace la impresora. Sin zona blanca alrededor.
- Un QR más ancho que el área de impresión no se imprime (se avisa en la consola).
- PDF417 (`cn = 48`) se muestra como texto `[PDF417] …`.
- La codificación usa la dependencia [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)
  (MIT, sin dependencias propias).

### API: líneas con imagen

Una línea con imagen trae un objeto `image` en lugar de segmentos de texto:

```json
{ "segments": [], "align": "center",
  "image": { "kind": "qr", "widthDots": 174, "heightDots": 174, "data": "<base64>", "text": "https://..." } }
```

- `kind`: `raster` (GS v 0), `bit-image` (ESC *), `nv-image` (FS p, GS ( L fn 69), `download-image` (GS /, fn 85),
  `graphics` (GS ( L fn 50) o `qr`.
- `data`: los bits en base64, fila por fila, bit más significativo primero, `ceil(widthDots / 8)` bytes por fila,
  1 = punto negro.
- `text`: solo en QR, el contenido codificado.

### Vista previa web

- Las imágenes se dibujan en un `<canvas>` a la misma escala que el texto (un logo de 576 puntos ocupa el ancho del
  papel, igual que 48 caracteres de la fuente A).
- Al pasar el ratón sobre un QR se ve su contenido.
- Los enlaces del pie apuntan a este fork y al proyecto original ("Upstream").

### Archivos nuevos

| Archivo | Contenido |
|---|---|
| `src/raster.ts` | Mapas de bits de 1 bit: conversión de datos raster y por columnas, escalado, recorte y apilado |
| `src/qr.ts` | Datos de `GS ( k` → imagen del QR |
| `src/image-memory.ts` | Memoria NV de imágenes por impresora |
| `test/images.test.ts` | 12 pruebas de los comandos nuevos y de los dos perfiles |
| `LICENSE` | Licencia MIT con el copyright original de lezram y el de este fork |
| `CHANGELOG.md` | Este archivo |

### Otros cambios

- Paquete renombrado a `solar-escpos-emulator`, versión 0.4.0. El comando `escpos-emulator` sigue funcionando, y se
  agrega `solar-escpos-emulator`.
- `npm test` ejecuta las pruebas (`node:test` con tsx) y el CI las corre después del build.
- `npm run test-print` ahora envía también un logo de ejemplo (`GS v 0`) y un QR.
- README y AGENTS.md actualizados con los comandos y el modelo nuevos.

### Cómo probarlo

```bash
npm ci
PRINTER_MODEL=POS-80 npm run dev   # emulador de la 2Connect POS-80
npm run test-print                 # en otra terminal: ticket con logo y QR
npm test                           # pruebas
```

Abrir http://localhost:3000 para ver el ticket.
