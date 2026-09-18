// Original cover art for each offering, one 1280x720 PNG apiece.
//
// Drawn rather than found: these go on a simulated product that offers subscriptions in real
// companies, so a photograph or a logo taken from the web would be both a licensing question
// and a claim of association nobody here is entitled to make. Every pixel below is computed.
//
// Each is the offering's own motif — the same drawing its card falls back to — over a ground
// mixed from its own colour, so a card is found by its colour before anybody reads its name.
// Anti-aliased from signed distance fields, which is why the strokes are clean without
// supersampling the whole frame.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 1280, H = 720;

// ---------------------------------------------------------------- distance fields
const len = (x, y) => Math.sqrt(x * x + y * y);
const ring = (px, py, cx, cy, r) => Math.abs(len(px - cx, py - cy) - r);
const seg = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return len(px - ax - vx * t, py - ay - vy * t);
};
const boxOutline = (px, py, x0, y0, x1, y1) => {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2, hy = (y1 - y0) / 2;
  const dx = Math.abs(px - cx) - hx, dy = Math.abs(py - cy) - hy;
  const outside = len(Math.max(dx, 0), Math.max(dy, 0));
  return Math.abs(outside + Math.min(Math.max(dx, dy), 0));
};
const ellipseRing = (px, py, cx, cy, rx, ry) => {
  // Good enough for a stroke at this size: scale to a circle and scale the distance back.
  const nx = (px - cx) / rx, ny = (py - cy) / ry;
  return Math.abs(len(nx, ny) - 1) * Math.min(rx, ry);
};

// ---------------------------------------------------------------- the motifs
// Coordinates are the 320x180 viewBox of the card marks, scaled up by 4.
const S = 4;
const motifs = {
  ANTH: [ // concentric rings
    { d: (x, y) => ring(x, y, 160 * S, 90 * S, 34 * S), w: 3.0, a: 1.0 },
    { d: (x, y) => ring(x, y, 160 * S, 90 * S, 56 * S), w: 2.4, a: 0.5 },
    { d: (x, y) => ring(x, y, 160 * S, 90 * S, 78 * S), w: 2.0, a: 0.22 },
  ],
  NSCL: [ // three racks, with their shelves
    { d: (x, y) => boxOutline(x, y, 52 * S, 60 * S, 112 * S, 120 * S), w: 3.0, a: 1.0 },
    { d: (x, y) => boxOutline(x, y, 130 * S, 60 * S, 190 * S, 120 * S), w: 3.0, a: 0.7 },
    { d: (x, y) => boxOutline(x, y, 208 * S, 60 * S, 268 * S, 120 * S), w: 3.0, a: 0.45 },
    { d: (x, y) => Math.min(
        seg(x, y, 66 * S, 76 * S, 98 * S, 76 * S), seg(x, y, 66 * S, 88 * S, 98 * S, 88 * S),
        seg(x, y, 144 * S, 76 * S, 176 * S, 76 * S), seg(x, y, 144 * S, 88 * S, 176 * S, 88 * S),
        seg(x, y, 222 * S, 76 * S, 254 * S, 76 * S), seg(x, y, 222 * S, 88 * S, 254 * S, 88 * S)),
      w: 2.2, a: 0.5 },
  ],
  OAI: [ // a cut diamond
    { d: (x, y) => Math.min(
        seg(x, y, 160 * S, 34 * S, 118 * S, 90 * S), seg(x, y, 118 * S, 90 * S, 160 * S, 146 * S),
        seg(x, y, 160 * S, 146 * S, 202 * S, 90 * S), seg(x, y, 202 * S, 90 * S, 160 * S, 34 * S)),
      w: 3.0, a: 1.0 },
    { d: (x, y) => seg(x, y, 96 * S, 90 * S, 224 * S, 90 * S), w: 2.4, a: 0.45 },
    { d: (x, y) => Math.min(seg(x, y, 160 * S, 34 * S, 160 * S, 146 * S)), w: 2.0, a: 0.25 },
  ],
  DBX: [ // stacked cylinders
    { d: (x, y) => ellipseRing(x, y, 160 * S, 62 * S, 62 * S, 18 * S), w: 3.0, a: 1.0 },
    { d: (x, y) => Math.min(seg(x, y, 98 * S, 62 * S, 98 * S, 96 * S), seg(x, y, 222 * S, 62 * S, 222 * S, 96 * S)), w: 3.0, a: 0.9 },
    { d: (x, y) => ellipseRing(x, y, 160 * S, 96 * S, 62 * S, 18 * S), w: 2.6, a: 0.6 },
    { d: (x, y) => Math.min(seg(x, y, 98 * S, 96 * S, 98 * S, 122 * S), seg(x, y, 222 * S, 96 * S, 222 * S, 122 * S)), w: 2.6, a: 0.6 },
    { d: (x, y) => ellipseRing(x, y, 160 * S, 122 * S, 62 * S, 18 * S), w: 2.4, a: 0.4 },
  ],
  SPCX: [ // an ascent and the arc it leaves
    { d: (x, y) => ring(x, y, 160 * S, 90 * S, 52 * S), w: 2.2, a: 0.35 },
    { d: (x, y) => seg(x, y, 40 * S, 146 * S, 232 * S, 44 * S), w: 3.2, a: 1.0 },
    { d: (x, y) => Math.min(seg(x, y, 232 * S, 44 * S, 198 * S, 50 * S), seg(x, y, 232 * S, 44 * S, 226 * S, 78 * S)), w: 3.0, a: 0.9 },
  ],
  CRNE: [ // a turbine against the sun
    { d: (x, y) => ring(x, y, 160 * S, 88 * S, 54 * S), w: 2.2, a: 0.35 },
    { d: (x, y) => ring(x, y, 160 * S, 88 * S, 10 * S), w: 3.0, a: 1.0 },
    { d: (x, y) => Math.min(
        seg(x, y, 160 * S, 78 * S, 160 * S, 40 * S),
        seg(x, y, 160 * S, 96 * S, 126 * S, 116 * S),
        seg(x, y, 160 * S, 96 * S, 194 * S, 116 * S)),
      w: 3.2, a: 1.0 },
  ],
  SKHY: [ // stacked memory dies
    { d: (x, y) => boxOutline(x, y, 96 * S, 104 * S, 224 * S, 124 * S), w: 3.0, a: 1.0 },
    { d: (x, y) => boxOutline(x, y, 96 * S, 80 * S, 224 * S, 100 * S), w: 3.0, a: 0.7 },
    { d: (x, y) => boxOutline(x, y, 96 * S, 56 * S, 224 * S, 76 * S), w: 3.0, a: 0.45 },
    { d: (x, y) => Math.min(
        seg(x, y, 118 * S, 56 * S, 118 * S, 42 * S),
        seg(x, y, 160 * S, 56 * S, 160 * S, 42 * S),
        seg(x, y, 202 * S, 56 * S, 202 * S, 42 * S)),
      w: 2.4, a: 0.5 },
  ],
  CBRS: [ // one wafer, scored into its grid
    { d: (x, y) => ring(x, y, 160 * S, 90 * S, 50 * S), w: 3.2, a: 1.0 },
    { d: (x, y) => Math.min(
        seg(x, y, 128 * S, 48 * S, 128 * S, 132 * S),
        seg(x, y, 160 * S, 40 * S, 160 * S, 140 * S),
        seg(x, y, 192 * S, 48 * S, 192 * S, 132 * S)),
      w: 2.2, a: 0.5 },
    { d: (x, y) => Math.min(
        seg(x, y, 114 * S, 68 * S, 206 * S, 68 * S),
        seg(x, y, 110 * S, 90 * S, 210 * S, 90 * S),
        seg(x, y, 114 * S, 112 * S, 206 * S, 112 * S)),
      w: 2.2, a: 0.5 },
  ],
};

const TINTS = {
  ANTH: [217, 119, 87], NSCL: [61, 125, 224], OAI: [15, 157, 118], DBX: [224, 74, 47],
  SPCX: [124, 135, 148], CRNE: [46, 158, 91], SKHY: [216, 69, 47], CBRS: [124, 92, 214],
};

// ---------------------------------------------------------------- png plumbing
const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len_ = Buffer.alloc(4); len_.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len_, body, crc]);
};

function render(asset) {
  const tint = TINTS[asset];
  const parts = motifs[asset];
  const raw = Buffer.alloc((W * 3 + 1) * H);
  let o = 0;

  for (let y = 0; y < H; y++) {
    raw[o++] = 0;
    for (let x = 0; x < W; x++) {
      // Ground: a dark base lifted toward the offering's colour from the top left, the same
      // direction the card's own wash runs.
      const gx = x / W, gy = y / H;
      const glow = Math.max(0, 1 - len(gx - 0.18, gy - 0.08) * 1.35) ** 1.6;
      const depth = 0.10 + 0.34 * (1 - gy) + 0.18 * (1 - gx);
      let r = 14 + tint[0] * (depth * 0.42 + glow * 0.55);
      let g = 15 + tint[1] * (depth * 0.42 + glow * 0.55);
      let b = 19 + tint[2] * (depth * 0.42 + glow * 0.55);

      // The motif, in light, over the top.
      let cover = 0;
      for (const part of parts) {
        const d = part.d(x * (1280 / W), y * (720 / H));
        const c = Math.max(0, Math.min(1, part.w - Math.abs(d))) * part.a;
        if (c > cover) cover = c;
      }
      if (cover > 0) {
        r += (246 - r) * cover * 0.86;
        g += (246 - g) * cover * 0.86;
        b += (246 - b) * cover * 0.86;
      }

      // A little grain, so a flat gradient does not band on a wide screen.
      const n = ((x * 13 + y * 7) % 11) - 5;
      raw[o++] = Math.max(0, Math.min(255, Math.round(r + n * 0.5)));
      raw[o++] = Math.max(0, Math.min(255, Math.round(g + n * 0.5)));
      raw[o++] = Math.max(0, Math.min(255, Math.round(b + n * 0.5)));
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = process.argv[2];
for (const asset of Object.keys(motifs)) {
  const png = render(asset);
  const path = `${dir}/${asset.toLowerCase()}.png`;
  writeFileSync(path, png);
  console.log(`${asset.padEnd(5)} ${String(png.length).padStart(7)} bytes  ${path}`);
}
