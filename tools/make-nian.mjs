// ============================================================
//  make-nian.mjs - 年兽（多彩毛丛 + 金角 + 呆萌脸）参数化像素栅格器
//  用法: node tools/make-nian.mjs [网格尺寸=32] [输出前缀=assets/icon-nian]
//        加 --dump 会把网格结果打印成字符地图，便于手改后保存
//  形状全部按 N 归一化，同一份代码可出 24 / 32 / 48 像素
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const require = createRequire(path.join(ROOT, "app", "package.json"));
const sharp = require("sharp");

const argv = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const DUMP = process.argv.includes("--dump");
const N = Number(argv[0] || 32);
const outPrefix = argv[1] || path.join(ROOT, "assets", "icon-nian");

// ---------- 调色板（与界面 crimson 主题同源，毛丛用三色循环） ----------
const COL = {
  Y: "#FFC53D", // 金黄
  C: "#2BD9C8", // 青绿
  R: "#E23A3A", // 朱红
  F: "#FF4646", // 脸
  S: "#FFE8D9", // 吻部米白
  I: "#14100F", // 墨（鼻/瞳/嘴/描边）
  W: "#FFFFFF", // 眼白 / 牙 / 高光
  B: "#FF8A80", // 腮红
  G: "#E8A33D", // 金印暗面
  g: "#FFC53D", // 金印亮面
};

const cx = N / 2;
const cy = N * 0.53;
const u = N / 32; // 32 基准单位缩放

const grid = Array.from({ length: N }, () => new Array(N).fill("."));
const put = (x, y, c) => {
  if (x >= 0 && y >= 0 && x < N && y < N) grid[y][x] = c;
};
const at = (x, y) => grid[y]?.[x];
// 稳定伪随机（毛边抖动），同一坐标恒定
const rnd = (x, y, s = 0) => {
  const v = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return v - Math.floor(v);
};
const dist = (x, y, ox, oy) => Math.hypot(x + 0.5 - ox, y + 0.5 - oy);

// ---------- 1. 彩色毛丛：9 颗独立毛球绕脸一圈（布局/配色照矢量版年兽） ----------
const NB = 9;
const ringR = 10.8 * u;
const ballR = 3.0 * u;
const cycle = ["Y", "C", "R"];
const balls = [];
for (let i = 0; i < NB; i++) {
  const a = -Math.PI / 2 + (i * 2 * Math.PI) / NB;
  balls.push({ x: cx + Math.cos(a) * ringR, y: cy + Math.sin(a) * ringR, c: cycle[i % 3] });
}
for (const b of balls) {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = dist(x, y, b.x, b.y);
      if (d <= ballR - 0.3 * u) put(x, y, b.c);
      else if (d <= ballR + 0.9 * u && rnd(x, y) > 0.45) put(x, y, b.c); // 毛边
    }
  }
}

// ---------- 2. 金角：两段折线胶囊，根部粗、尖端细 ----------
const capsule = (ax, ay, bx, by, wa, wb, c) => {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const pxx = x + 0.5 - ax, pyy = y + 0.5 - ay;
      let t = (pxx * dx + pyy * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(pxx - dx * t, pyy - dy * t);
      if (d <= (wa + (wb - wa) * t) / 2) put(x, y, c);
    }
  }
};
for (const s of [1, -1]) {
  const mx = cx + s * 10.2 * u, my = cy - 11.0 * u;
  const px1 = cx + s * 8.2 * u, py1 = cy - 6.5 * u;
  const tipX = cx + s * 7.0 * u, tipY = cy - 15.0 * u;
  capsule(px1, py1, mx, my, 4.0 * u, 3.2 * u, "G");
  capsule(mx, my, tipX, tipY, 3.2 * u, 1.8 * u, "G");
}

// ---------- 3. 脸的深色描边（把脸从毛丛里抠出来） ----------
const faceRx = 8.2 * u, faceRy = 7.8 * u;
const ell = (x, y, ex, ey, rx, ry) => {
  const a = (x + 0.5 - ex) / rx, b = (y + 0.5 - ey) / ry;
  return a * a + b * b <= 1;
};
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (ell(x, y, cx, cy, faceRx + 0.9 * u, faceRy + 0.9 * u)) put(x, y, "I");
  }
}

// ---------- 4. 脸 ----------
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (ell(x, y, cx, cy, faceRx, faceRy)) put(x, y, "F");
  }
}

// ---------- 5. 额头金印 ----------
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const d = dist(x, y, cx, cy - 6.1 * u);
    if (d <= 1.8 * u) put(x, y, "g");
    else if (d <= 2.6 * u) put(x, y, "G");
  }
}

// ---------- 6. 腮红 ----------
for (const s of [1, -1]) {
  const bx = cx + s * 6.9 * u, by = cy + 4.2 * u;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (at(x, y) === "F" && dist(x, y, bx, by) <= 1.7 * u) put(x, y, "B");
    }
  }
}

// ---------- 7. 眼睛（白底 + 黑瞳 + 高光） ----------
const eyeY = cy - 1.1 * u, eyeX = 4.4 * u;
for (const s of [1, -1]) {
  const ex = cx + s * eyeX;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (at(x, y) !== "F" && at(x, y) !== "B") continue;
      if (ell(x, y, ex, eyeY, 2.7 * u, 3.0 * u)) put(x, y, "W");
    }
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (at(x, y) !== "W") continue;
      const d = dist(x, y, ex + s * 0.5 * u, eyeY + 0.6 * u);
      if (d <= 1.6 * u) put(x, y, "I");
      if (d <= 0.6 * u) put(x, y, "W"); // 高光
    }
  }
}

// ---------- 8. 吻部 + 鼻 + 嘴 + 牙 ----------
const mzY = cy + 4.4 * u;
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (at(x, y) === "F" && ell(x, y, cx, mzY, 4.8 * u, 3.1 * u)) put(x, y, "S");
  }
}
// 鼻（倒三角，小巧）
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (at(x, y) !== "S") continue;
    const dy = y + 0.5 - (mzY - 1.7 * u);
    const halfW = 1.2 * u - Math.max(0, dy) * 0.5;
    if (dy >= -0.6 && dy <= 0.9 && Math.abs(x + 0.5 - cx) <= Math.max(0.4, halfW)) put(x, y, "I");
  }
}
// 嘴（一条弧）+ 两颗牙
for (let x = 0; x < N; x++) {
  const t = (x + 0.5 - cx) / (2.2 * u);
  if (Math.abs(t) > 1) continue;
  const yy = mzY + 1.2 * u + (1 - t * t) * 1.1 * u;
  const yi = Math.floor(yy), xi = x;
  if (at(xi, yi) === "S" || at(xi, yi) === "I") put(xi, yi, "I");
}
for (const s of [1, -1]) {
  const tx = Math.round(cx + s * 1.2 * u - 0.5);
  const ty = Math.round(mzY + 2.4 * u - 0.5);
  if (at(tx, ty) !== ".") {
    put(tx, ty, "W");
    if (N >= 32) put(tx, ty + 1, "W");
  }
}

// ---------- 输出 ----------
const H = N, W = N;
if (DUMP) {
  const lines = [];
  for (let y = 0; y < H; y++) lines.push(grid[y].join(""));
  fs.writeFileSync(outPrefix + "-map.txt",
    `# 由 tools/make-nian.mjs 生成（N=${N}）。手改后可用 make-pixel-icon.mjs 直接渲染\n` + lines.join("\n") + "\n");
}

let shapes = "";
for (let y = 0; y < H; y++) {
  let x = 0;
  while (x < W) {
    const ch = grid[y][x];
    if (ch === "." || !COL[ch]) { x++; continue; }
    let run = 1;
    while (x + run < W && grid[y][x + run] === ch) run++;
    shapes += `<rect x="${x}" y="${y}" width="${run}" height="1" fill="${COL[ch]}"/>`;
    x += run;
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 32}" height="${H * 32}" shape-rendering="crispEdges">
<rect width="${W}" height="${H}" rx="${(W * 0.155).toFixed(2)}" fill="#0A0505"/>
<g transform="translate(${(W * 0.045).toFixed(3)} ${(H * 0.045).toFixed(3)}) scale(${(0.91).toFixed(4)})">
${shapes}
</g>
</svg>`;
fs.writeFileSync(outPrefix + ".svg", svg);

// 512 预览（放大用最近邻，保留像素感）
fs.writeFileSync(outPrefix + "-512.png",
  await sharp(Buffer.from(svg), { density: 384 })
    .resize(512, 512, { kernel: "nearest" })
    .png().toBuffer());

// ICO 多尺寸（小尺寸靠 sharp 的高质量缩放，像素图缩小仍是像素图）
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const baseBuf = await sharp(Buffer.from(svg), { density: 384 }).png().toBuffer();
const pngs = [];
for (const s of SIZES) {
  pngs.push({
    size: s,
    buf: await sharp(baseBuf)
      .resize(s, s, { fit: "contain", kernel: s < N ? "lanczos3" : "nearest", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toBuffer(),
  });
}
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
console.log(`OK ${N}x${N} -> ${path.basename(outPrefix)}.ico (${(fs.statSync(outPrefix + ".ico").size / 1024).toFixed(1)} KB) + -512.png`);
