// ============================================================
//  make-icon.mjs - render assets/icon.svg into a multi-size ICO
//  Usage: node tools/make-icon.mjs [input.svg] [out.ico]
//  Deps: sharp (already in app/node_modules)
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

// sharp lives in app/node_modules
const require = createRequire(path.join(ROOT, "app", "package.json"));
const sharp = require("sharp");

const input = process.argv[2] || path.join(ROOT, "assets", "icon.svg");
const outIco = process.argv[3] || path.join(ROOT, "assets", "icon.ico");
const outPng = outIco.replace(/\.ico$/i, "-512.png");

const SIZES = [16, 24, 32, 48, 64, 128, 256];

const svg = fs.readFileSync(input);

// 512px 预览（README / 商店展示用）
fs.writeFileSync(outPng, await sharp(svg, { density: 384 }).resize(512, 512).png().toBuffer());

// 各尺寸 PNG
const pngs = [];
for (const s of SIZES) {
  const buf = await sharp(svg, { density: Math.max(384, s * 4) })
    .resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  pngs.push({ size: s, buf });
}

// ICO 容器（Vista+ 支持 PNG 压缩条目；256 用 0 表示）
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(pngs.length, 4);

const entries = [];
let offset = 6 + 16 * pngs.length;
for (const p of pngs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(p.size >= 256 ? 0 : p.size, 0); // width
  e.writeUInt8(p.size >= 256 ? 0 : p.size, 1); // height
  e.writeUInt8(0, 2); // palette
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(p.buf.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += p.buf.length;
  entries.push(e);
}

fs.writeFileSync(outIco, Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]));
console.log(`icon  : ${outIco}  (${(fs.statSync(outIco).size / 1024).toFixed(1)} KB, ${SIZES.join("/")})`);
console.log(`preview: ${outPng}`);
