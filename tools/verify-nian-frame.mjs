// 验证：解析 capture-themes 抓的帧，重建 ▀ 半格像素 → PNG
// 用法: node tools/verify-nian-frame.mjs <frame.json> <out.png>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const require = createRequire(path.join(ROOT, "app", "package.json"));
const sharp = require("sharp");

const [frameFile, outFile] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(frameFile, "utf8"));
const sc = j.scenes.welcome;
const text = typeof sc === "string" ? sc : sc.text || sc.content || "";

// 极简 ANSI 状态机：只关心 38;2 / 48;2 / 39 / 49 / 0
let fgC = null, bgC = null;
const lines = text.split("\n");
const screen = lines.map((line) => {
  const cells = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      const end = line.indexOf("m", i);
      if (end < 0) break;
      const params = line.slice(i + 2, end).split(";").map(Number);
      let k = 0;
      while (k < params.length) {
        if (params[k] === 38 && params[k + 1] === 2) { fgC = params.slice(k + 2, k + 5); k += 5; }
        else if (params[k] === 48 && params[k + 1] === 2) { bgC = params.slice(k + 2, k + 5); k += 5; }
        else if (params[k] === 39) { fgC = null; k++; }
        else if (params[k] === 49) { bgC = null; k++; }
        else if (params[k] === 0) { fgC = bgC = null; k++; }
        else k++;
      }
      i = end + 1;
      continue;
    }
    cells.push({ ch: line[i], fg: fgC, bg: bgC });
    i++;
  }
  return cells;
});

// 找 ▀ 区域
let y0 = screen.findIndex((r) => r.some((c) => c.ch === "▀"));
if (y0 < 0) { console.error("帧里没有 ▀ 半格像素！"); process.exit(1); }
let y1 = y0;
while (y1 + 1 < screen.length && screen[y1 + 1].some((c) => c.ch === "▀")) y1++;
const cellsRow = screen[y0];
let x0 = cellsRow.findIndex((c) => c.ch === "▀");
let x1 = x0;
while (x1 + 1 < cellsRow.length && cellsRow[x1 + 1].ch === "▀" || x1 + 1 < cellsRow.length && cellsRow[x1+1].ch === " ") {
  if (cellsRow[x1 + 1].ch !== "▀" && cellsRow[x1 + 1].ch !== " ") break;
  x1++;
  if (x1 - x0 > 40) break;
}
const W = x1 - x0 + 1, H = (y1 - y0 + 1) * 2;
console.log(`logo 区域: 行 ${y0}-${y1}（${y1 - y0 + 1} 行终端 = ${H} 像素）, 列 ${x0}-${x1}（${W} 格）`);
const scale = 16;
const img = sharp({
  create: { width: W * scale, height: H * scale, channels: 3, background: { r: 8, g: 3, b: 3 } },
});
const comps = [];
for (let y = y0; y <= y1; y++) {
  const row = screen[y];
  for (let x = x0; x <= Math.min(x1, row.length - 1); x++) {
    const c = row[x];
    if (!c || (c.ch !== "▀" && c.ch !== " ")) continue;
    const px = (x - x0) * scale, py = (y - y0) * scale * 2;
    if (c.bg) comps.push({ input: { create: { width: scale, height: scale * 2, channels: 3, background: { r: c.bg[0], g: c.bg[1], b: c.bg[2] } } }, left: px, top: py });
    if (c.ch === "▀" && c.fg) comps.push({ input: { create: { width: scale, height: scale, channels: 3, background: { r: c.fg[0], g: c.fg[1], b: c.fg[2] } } }, left: px, top: py });
  }
}
await img.composite(comps).png().toFile(outFile);
console.log("OK", outFile);
