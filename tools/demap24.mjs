// 一次性：把 32×32 年兽 PNG 降采样到 24×24，逐像素匹配调色板 → 字符地图
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const require = createRequire(path.join(ROOT, "app", "package.json"));
const sharp = require("sharp");

const PAL = {
  ".": [10, 5, 5],   // 背景 #0A0505 → 透明
  Y: [255, 197, 61],
  C: [43, 217, 200],
  R: [226, 58, 58],
  F: [255, 70, 70],
  S: [255, 232, 217],
  I: [20, 16, 15],
  W: [255, 255, 255],
  B: [255, 138, 128],
  G: [232, 163, 61],
  g: [255, 197, 61],
};
const N = 24;
const { data, info } = await sharp(path.join(ROOT, "assets", "icon-nian32-512.png"))
  .resize(N, N, { kernel: "lanczos3" })
  .raw().toBuffer({ resolveWithObject: true });
const alpha = info.channels === 4;
let out = "";
for (let y = 0; y < N; y++) {
  let line = "";
  for (let x = 0; x < N; x++) {
    const o = (y * N + x) * info.channels;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const a = alpha ? data[o + 3] : 255;
    let best = ".", bd = 1e9;
    for (const [k, [pr, pg, pb]] of Object.entries(PAL)) {
      const d = a < 40 && k === "." ? 0 : (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    line += best;
  }
  out += line + "\n";
}
fs.writeFileSync(path.join(ROOT, "assets", "icon-nian24-map.txt"),
  `# 由 32x32 图降采样（tools/demap24.mjs）\n` + out);
console.log("OK assets/icon-nian24-map.txt");
console.log(out);
