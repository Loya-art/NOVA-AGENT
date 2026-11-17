// 黄金对照：跑确定的交互，把每次 stdout.write 后的「屏幕状态」快照存下来。
// 用途：优化渲染前跑一遍 → 优化后再跑一遍 → 逐帧比对，保证画面零变化。
// 用法：node golden.mjs out.json
import { PassThrough } from "node:stream";
import fs from "node:fs";
import stringWidth from "string-width";

// 冻结时间 → 状态栏的计时/版本行完全确定（setTimeout 不受影响）
const FIXED = 1750000000000;
const RealNow = Date.now;
Date.now = () => FIXED;

process.env["TUI_" + "NO_AUTORUN"] = "1";
const mod = await import("./src/tui.mjs");
const { start, C, _ansi } = mod;
const { fg, bold } = _ansi;

const ROWS = 40, COLS = 108;

// ── 终端屏幕模拟器（只认应用真正发出的序列）──
function makeScreen(rows, cols) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
  let r = 0, c = 0;
  const put = (ch, w) => {
    if (c >= cols) { c = 0; r = Math.min(rows - 1, r + 1); }
    const row = grid[r];
    row[c] = ch;
    for (let k = 1; k < w; k++) if (c + k < cols) row[c + k] = "";
    c += w;
  };
  return {
    feed(chunk) {
      let i = 0;
      while (i < chunk.length) {
        if (chunk[i] === "\x1b") {
          if (chunk[i + 1] === "[") {
            const m = /^\x1b\[([0-9;?]*)([@-~])/.exec(chunk.slice(i));
            if (!m) { i += 2; continue; }
            const [, params, fin] = m;
            if (fin === "H") {
              const p = params.split(";");
              r = Math.min(rows - 1, Math.max(0, (parseInt(p[0], 10) || 1) - 1));
              c = Math.min(cols - 1, Math.max(0, (parseInt(p[1], 10) || 1) - 1));
            } else if (fin === "K") {
              for (let x = c; x < cols; x++) grid[r][x] = " ";
            }
            i += m[0].length;
            continue;
          }
          if (chunk[i + 1] === "]") { // OSC：吃到 BEL 或 ST
            const end = /[\x07\x1b]/.exec(chunk.slice(i + 2));
            i += end ? 2 + end.index + 1 : chunk.length - i;
            continue;
          }
          i += 2;
          continue;
        }
        const ch = chunk[i];
        if (ch === "\r") { c = 0; i++; continue; }
        if (ch === "\n") { r = Math.min(rows - 1, r + 1); c = 0; i++; continue; }
        const cp = chunk.codePointAt(i);
        const s = String.fromCodePoint(cp);
        put(s, stringWidth(s) || 0);
        i += s.length;
      }
    },
    snap() {
      return grid.map((row) => row.join("").replace(/\s+$/, "")).join("\n");
    },
  };
}

const screen = makeScreen(ROWS, COLS);
const hashes = [];
const sizes = [];
const rawChunks = [];
class FakeOut extends PassThrough {
  write(chunk) {
    const s = chunk.toString("utf8");
    rawChunks.push(s);
    sizes.push(Buffer.byteLength(s, "utf8"));
    screen.feed(s);
    hashes.push(JSON.stringify(screen.snap()));
    return true;
  }
}
const stdout = new FakeOut();
stdout.columns = COLS; stdout.rows = ROWS; stdout.isTTY = true;
stdout.getWindowSize = () => [ROWS, COLS];
const stdin = new PassThrough();
stdin.isTTY = true; stdin.setRawMode = () => stdin;
stdin.ref = () => {}; stdin.unref = () => {};

const ui = start({ stdin, stdout, rows: ROWS, cols: COLS });
ui.setOnExit(() => {});
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const type = async (t) => {
  for (const b of Buffer.from(t, "utf8")) { stdin.write(Buffer.from([b])); await sleep(25); }
  await sleep(120);
};

// ── 确定脚本 ──
await sleep(300);                                   // 欢迎屏
ui._S.transcript = []; ui._S.wrapCache = []; ui._S.scroll = 0; ui._render();
ui._pushRaw(fg(C.accent, "╭────────╮"));
ui._pushRaw(fg(C.accent, "│") + fg(C.accent, " ❯ ") + fg(C.text, "帮我把 README 重写") + fg(C.accent, " │"));
ui._pushRaw(fg(C.accent, "╰────────╯"));
ui._event({ type: "thinking", text: "先看现有 README 的结构，再决定怎么改。" });
ui._event({ type: "tool_call", name: "read", args: { file_path: "README.md" } });
ui._event({ type: "tool_result", ok: true, output: "共 412 行" });
ui._event({ type: "text", text: "看完了，这节有三个毛病：" });
ui._event({ type: "text", text: "  1. 启动命令散在三处" });
ui._event({ type: "text", text: "  2. 没写清楚换台电脑要不要先装环境" });
ui._event({ type: "tool_call", name: "edit", args: { file_path: "README.md" } });
ui._event({ type: "tool_result", ok: false, output: "lint 警告：第 88 行表格列数不齐" });
await sleep(200);
await type("/mo");                                   // 补全 ghost
stdin.write("\t"); await sleep(150);                 // Tab 进参数位
stdin.write("\x1b[B"); await sleep(150);             // ↓ 换选中
stdin.write("\x07".repeat(0)); await sleep(50);
await type("  普通输入也测一下中文宽度");             // 打字路径
stdin.write("\x1b[A"); await sleep(150);             // 上翻历史
await sleep(200);

Date.now = RealNow;
fs.writeFileSync(process.argv[2] || "golden.json", JSON.stringify({ rows: ROWS, cols: COLS, chunks: rawChunks.length, sizes, hashes }), "utf8");
console.log(`帧数 ${rawChunks.length}，总字节 ${sizes.reduce((a,b)=>a+b,0)}，均 ${Math.round(sizes.reduce((a,b)=>a+b,0)/sizes.length)}B/帧 → ${process.argv[2] || "golden.json"}`);
process.exit(0);
