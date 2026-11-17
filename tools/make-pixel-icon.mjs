// ============================================================
//  make-pixel-icon.mjs - pixel-art map → SVG (crisp) → ICO/PNG
//  Usage: node tools/make-pixel-icon.mjs <map.txt> <out-prefix>
//  Map: '#' 开头的行是图例，其余每行一个像素行；'.' = 透明
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const require = createRequire(path.join(ROOT, "app", "package.json"));
const sharp = require("sharp");

const [mapFile, outPrefix] = process.argv.slice(2);
if (!mapFile || !outPrefix) {
  console.error("usage: node tools/make-pixel-icon.mjs <map.txt> <out-prefix>");
  process.exit(1);
}

const raw = fs.readFileSync(mapFile, "utf8").split(/\r?\n/);
const palette = {};
const rows = [];
for (const line of raw) {
  if (!line.trim()) continue;
  if (line.startsWith("#")) {
    const m = /^#\s*(\S)\s*=\s*(#[0-9a-fA-F]{6,8})/.exec(line);
    if (m) palette[m[1]] = m[2];
    continue;
  }
  rows.push(line.trimEnd());
}

// 'M' = 绒毛棋盘格：2x2 块级红黄交替（块坐标奇偶决定）
// 描边：只描「原本是 M」且与 F 正交相邻的像素（把脸从鬃毛里抠出来，不动脸部细节）
const K = palette["K"];
const orig = rows.map((r) => [...r]);
for (let y = 0; y < rows.length; y++) {
  const chars = [...rows[y]];
  for (let x = 0; x < chars.length; x++) {
    if (chars[x] === "M") {
      chars[x] = (((x >> 1) + (y >> 1)) % 2 === 0 ? "R" : "Y");
    }
  }
  rows[y] = chars;
}
if (K) {
  const grid = rows.map((r) => [...r]);
  const isFace = (x, y) => grid[y]?.[x] === "F";
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      if (orig[y]?.[x] !== "M") continue;
      if (isFace(x + 1, y) || isFace(x - 1, y) || isFace(x, y + 1) || isFace(x, y - 1)) {
        rows[y][x] = "K";
      }
    }
  }
}

const H = rows.length;
const W = Math.max(...rows.map((r) => r.length));
let shapes = "";
for (let y = 0; y < H; y++) {
  const row = rows[y];
  let x = 0;
  while (x < row.length) {
    const ch = row[x];
    if (ch === "." || !palette[ch]) { x++; continue; }
    let run = 1;
    while (x + run < row.length && row[x + run] === ch) run++;
    shapes += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${palette[ch]}"/>`;
    x += run;
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 40}" height="${H * 40}" shape-rendering="crispEdges">
<rect width="${W}" height="${H}" fill="#0A0505" rx="2.8"/>
<g transform="translate(${W * 0.0625} ${H * 0.0625}) scale(${W * 0.875 / W})">
${shapes}
</g>
</svg>`;

const svgPath = outPrefix + ".svg";
fs.writeFileSync(svgPath, svg);

// 512 预览 + ICO（复用 make-icon 的尺寸表）
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const pngs = [];
for (const s of SIZES) {
  pngs.push({
    size: s,
    buf: await sharp(Buffer.from(svg), { density: Math.max(384, s * 4) })
      .resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  });
}
fs.writeFileSync(outPrefix + "-512.png", await sharp(Buffer.from(svg), { density: 384 }).resize(512, 512).png().toBuffer());

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(pngs.length, 4);
const entries = [];
let offset = 6 + 16 * pngs.length;
for (const p of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(p.size >= 256 ? 0 : p.size, 0);
  e.writeUInt8(p.size >= 256 ? 0 : p.size, 1);
  e.writeUInt32LE(p.buf.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += p.buf.length;
  entries.push(e);
}
fs.writeFileSync(outPrefix + ".ico", Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]));
console.log(`OK ${outPrefix}.ico (${(fs.statSync(outPrefix + ".ico").size / 1024).toFixed(1)} KB) + -512.png`);
