// Genera icon-192.png e icon-512.png (PNG manual, sin dependencias) con el logo de Aposento Alto.
const fs = require('fs'), zlib = require('zlib');

function crc32(buf) {
  let c, table = crc32.table || (crc32.table = (() => {
    const t = [];
    for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
    return t;
  })());
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function hexColor(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
const CAFE = hexColor('#382417'), CARAMELO = hexColor('#6D3C1C'), VAINILLA = hexColor('#E7C196'), MIEL = hexColor('#C57938');

function makeIcon(size) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  const cx = size / 2, cy = size / 2;
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 3);
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = (x - cx) / size, dy = (y - cy) / size;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let color;
      // fondo degradado café->caramelo (esquina sup-izq a inf-der)
      const t = (x + y) / (size * 2);
      color = [
        Math.round(CAFE[0] + (CARAMELO[0] - CAFE[0]) * t),
        Math.round(CAFE[1] + (CARAMELO[1] - CAFE[1]) * t),
        Math.round(CAFE[2] + (CARAMELO[2] - CAFE[2]) * t)
      ];
      // forma de "llama/paloma" simplificada: gota central en vainilla/miel
      const gx = dx, gy = dy + 0.08;
      const flame = (gx * gx) / 0.055 + (gy * gy) / 0.11;
      if (flame < 1) {
        const inner = flame < 0.45;
        color = inner ? MIEL : VAINILLA;
      }
      const off = rowStart + 1 + x * 3;
      raw[off] = color[0]; raw[off + 1] = color[1]; raw[off + 2] = color[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
  return png;
}
fs.writeFileSync(__dirname + '/icon-192.png', makeIcon(192));
fs.writeFileSync(__dirname + '/icon-512.png', makeIcon(512));
console.log('Iconos generados: icon-192.png, icon-512.png');
