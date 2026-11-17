// ── 终端「代码地球」 ─────────────────────────────────────────────
// 整颗球由同一个字符构成，靠 ANSI 灰度深浅表现陆地 / 海洋与球面明暗。
// 数据源：Natural Earth 110m 陆地轮廓 → 180×90 二值掩码 → base64。
// 自转轴竖直固定；终端字符高≈宽×2，所以列数恒为行数的 2 倍（正圆）。
const MW = 180, MH = 90;
const MASK_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAf4AP/AAAAAAAAAAAAAAAAAAAAAAAAX/z///+AAAAAAAABAAAAAAAAAAAAAYd8P///wAA+AAAAAA8AAAAAAAAAAAwAnw////4AAIAAAAAAGAAAAAAAAAAADivwAf//wAAAAADAAf/wAHYAAAAAADoi3sAP//gAAAAAMAD///sAAAAgBgACfwz/AD/+gAAAwAEHf///+/8gBAP/7/nJdjwD/+AAAH/AA7f///////f4P//////h8H/gAAAf/6//f////////Mf/////9H4D8AeAA+ev///////////AP/////4A0B4AAAD5/////////////Af3////gHgA4AAAH5///////////LwAHgH///gHkAAAAAH4/////////+CIAABAB///4D+AAAAGCx/////////4A8AAIAAf///n/gAAAOCD/////////wA4AAAAAf///n/wAAAbP///////////AgAAAAAP/////wAAADf//////////9AAAAAAAF////0YAAAB///////////9AAAAAAAD////8EAAAB///////////5AAAAAAAD////2AAAAB/f5fP//////wAAAAAAAD////gAAAAfxnwPP//////jAAAAAAAD////AAAAAPCb3/n/////+CAAAAAAAD///8AAAAAfALf/n////+ECAAAAAAAB///8AAAAAGHQP/n/////mMAAAAAAAA///8AAAAAH+Ai///////E8AAAAAAAAf//wAAAAAP/AA///////BgAAAAAAAAP//gAAAAAf/73///////gAAAAAAAAAD/AQAAAAAf////f/////gAAAAAAAAAF+AQAAAAB///+/n/////AAAAAAAAAAC+AAAAAAB///+f0H////AAAAAAAAAAAeAwAAAAD////f/B///8gAAAAAAAAAAeGEAAAAH////v+B/z/AAAAAAAAAAAAPMAgAAAD////n+A/B+gAAAAAAAAAAAD8AAAAAD////n4AeB/AgAAAAAAAAAAAPAAAAAH////3gAcAfAgAAAAAAAAAAADAAAAAD////6AAcAfggAAAAAAAAAAABDwAAAD////8wAMATAIAAAAAAAAAAAAr/AAAB/////gAKASAAAAAAAAAAAAAAH/gAAA/////gACAAAIAAAAAAAAAAAAH/8AAAaH///AAAAsGAAAAAAAAAAAAAH/+AAAAB//+AAAAUOAAAAAAAAAAAAAP/+AAAAB//8AAAAYegAAAAAAAAAAAAP//gAAAD//4AAAAMeBgAAAAAAAAAAAP//8AAAB//wAAAAGdiuAAAAAAAAAAAf///AAAA//wAAAACAQHgAAAAAAAAAAP///gAAA//wAAAABwAHwgAAAAAAAAAH///AAAA//wAAAAACIDQIAAAAAAAAAH//+AAAAf/wAAAAAAAAAAAAAAAAAAAD//+AAAA//wgAAAAABxAAAAAAAAAAAD//+AAAA//wgAAAAAPxgBAAAAAAAAAA//8AAAA//jgAAAAAf5gAAAAAAAAAAAf/8AAAA//DgAAAAAf/gAAAAAAAAAAAf/8AAAAf/DAAAAAD//4CAAAAAAAAAAf/wAAAAf/DAAAAAH//4AAAAAAAAAAAf/AAAAAf+CAAAAAH//8AAAAAAAAAAAf/AAAAAP8AAAAAAH//+AAAAAAAAAAA/+AAAAAP8AAAAAAH//+AAAAAAAAAAA/+AAAAAH4AAAAAAD//+AAAAAAAAAAA/8AAAAAHwAAAAAADwf8AAAAAAAAAAA/gAAAAAAAAAAAAACAH4AIAAAAAAAAB/wAAAAAAAAAAAAAAAD4AEAAAAAAAAB+AAAAAAAAAAAAAAAAAAAGAAAAAAAAB6AAAAAAAAAAAAAAAAAwAMAAAAAAAAA8AAAAAAAAAAAAAAAAAQAYAAAAAAAAB4AAAAAAAAAAAAAAAAAAAwAAAAAAAAB4AAAAAAAAAAAAAAAAAAAAAAAAAAAADwAAAAAAAAAACAAAAAAAAAAAAAAAAADgAAAAAAAAAAAAAAAAAAAAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAAAAAAAeAAIP+f/gAAAAAAAAAAAMAAAAAAABP/+H//////AAAAAAAAAAA+AAAAAf////8////////AAAAAAAOEAPAAAB///////////////gAAAP//T//8AAAH//////////////+AAAH/////4AAAH///////////////8AAE//////4ABw////////////////8AAAD//////gCA////////////////wAAAf/////////////////////////+A/4A///////////////////////////////////////////////////////////////////////////////////////";
const BITS = Buffer.from(MASK_B64, "base64");

function landBit(x, y) {
  if (y < 0) y = 0; else if (y >= MH) y = MH - 1;
  x = ((x % MW) + MW) % MW;               // 经度方向环绕
  const i = y * MW + x;
  return (BITS[i >> 3] >> (7 - (i & 7))) & 1;
}

// 双线性采样，海岸线不留锯齿
function landAt(lon, lat) {
  const fx = ((lon + Math.PI) / (2 * Math.PI)) * MW - 0.5;
  const fy = (0.5 - lat / Math.PI) * MH - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  return landBit(x0, y0) * (1 - tx) * (1 - ty) + landBit(x0 + 1, y0) * tx * (1 - ty)
       + landBit(x0, y0 + 1) * (1 - tx) * ty + landBit(x0 + 1, y0 + 1) * tx * ty;
}

// 光源：左上偏前（屏幕系）
const LIGHT = (() => {
  const a = [-0.42, 0.36, 0.83];
  const m = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / m, a[1] / m, a[2] / m];
})();

const CH = "#";
const SPIN0 = 0.35;            // 初始停在非洲—欧洲正面
const SPEED = 0.10;            // 弧度 / 秒

/**
 * 渲染一帧地球。
 * @param {number} rows  行数（列数 = rows*2）
 * @param {number} spin  自转角（弧度）
 * @returns {string[]}   每行一个字符串（含 ANSI 转义码）
 */
export function renderGlobe(rows, spin) {
  const cols = rows * 2;
  const lines = [];
  for (let r = 0; r < rows; r++) {
    const V = (r + 0.5 - rows / 2) / (rows / 2);
    let line = "", cur = -1;
    for (let c = 0; c < cols; c++) {
      const U = (c + 0.5 - cols / 2) / (cols / 2);
      const q = U * U + V * V;
      if (q > 1) { line += " "; continue; }     // 球外留白
      const zc = Math.sqrt(1 - q);
      const xc = U, yc = -V;                    // 屏幕 → 相机（y 轴向上）
      const lat = Math.asin(yc);
      const lon = Math.atan2(xc, zc) + spin;
      const land = landAt(lon, lat) > 0.5;
      let d = xc * LIGHT[0] + yc * LIGHT[1] + zc * LIGHT[2];
      d = (d < 0 ? 0 : d) * (0.55 + 0.45 * zc); // 边缘渐隐 → 球面感
      const g = land ? 249 + Math.round(d * 6)  // 陆地 249→255 亮白
                     : 237 + Math.round(d * 6); // 海洋 237→243 暗灰
      if (g !== cur) { line += "\u001b[38;5;" + g + "m"; cur = g; }
      line += CH;
    }
    lines.push(line + "\u001b[0m");
  }
  return lines;
}

export { CH as GLOBE_CHAR, SPIN0 as GLOBE_SPIN0, SPEED as GLOBE_SPEED };
