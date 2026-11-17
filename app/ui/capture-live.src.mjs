// 真机字节流抓取（60 行终端，v0.12.0 自绘引擎）：渲染 → 发一句真话 → 等稳定 → 存字节流
import { PassThrough } from "node:stream";
import fs from "node:fs";

process.env["TUI_" + "NO_AUTORUN"] = "1";
const { start } = await import("./src/tui.mjs");

const logPath = process.argv[2] || "F:/AgentPortable/logs/tui-live.txt";
const MSG = process.argv[3] || "你好";
const ROWS = Number(process.argv[4] || 60);
const COLS = Number(process.argv[5] || 120);

const captured = [];
class FakeOut extends PassThrough {
  write(chunk) {
    captured.push(chunk.toString("utf8"));
    return true;
  }
}
const stdout = new FakeOut();
stdout.columns = COLS;
stdout.rows = ROWS;
stdout.isTTY = true;
stdout.getWindowSize = () => [COLS, ROWS];

const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => stdin;
stdin.ref = () => {};
stdin.unref = () => {};

let exited = false;
const ui = start({ stdin, stdout, rows: ROWS, cols: COLS });
ui.setOnExit(() => {
  exited = true;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(600); // 首屏

for (const ch of Buffer.from(MSG, "utf8")) {
  stdin.write(Buffer.from([ch]));
  await sleep(20);
}
stdin.write("\r");
console.log(`sent: ${MSG}（等一轮结束…）`);

// 等输出稳定（连续 5 秒无新字节），最多 90 秒
let lastLen = -1, stable = 0;
for (let i = 0; i < 90; i++) {
  await sleep(1000);
  const len = captured.join("").length;
  if (len === lastLen) {
    stable++;
    if (stable >= 5) break;
  } else {
    stable = 0;
    lastLen = len;
  }
}
await sleep(300);

fs.writeFileSync(logPath, captured.join(""), "utf8");
console.log("captured:", logPath, captured.join("").length, "bytes", exited ? "(exited)" : "");
process.exit(0);
