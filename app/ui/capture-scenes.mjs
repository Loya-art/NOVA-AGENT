// 补全引擎场景抓帧（v0.14.0）：按脚本喂键，在关键状态把**真实渲染帧**存下来。
// 产物 logs/scenes.json —— 给预览页做 ANSI→HTML 还原，避免手画样机失真。
// 跑法：cd app && node ui/capture-scenes.mjs
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";

process.env["TUI_" + "NO_AUTORUN"] = "1";
const { start } = await import("./src/tui.mjs");

const ROWS = 44;
const COLS = 120;
const OUT = process.argv[2] || "F:/AgentPortable/logs/scenes.json";

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
stdout.getWindowSize = () => [ROWS, COLS];

const stdin = new PassThrough();
stdin.isTTY = true;
stdin.setRawMode = () => stdin;
stdin.ref = () => {};
stdin.unref = () => {};

const ui = start({ stdin, stdout, rows: ROWS, cols: COLS });
ui.setOnExit(() => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const all = () => captured.join("");
const lastFrame = () => {
  const parts = all().split("\x1b[H").slice(1);
  return "\x1b[H" + (parts.at(-1) ?? "");
};
const type = async (text) => {
  for (const b of Buffer.from(text, "utf8")) {
    stdin.write(Buffer.from([b]));
    await sleep(10);
  }
  await sleep(260);
};
const clearInput = async (n = 60) => {
  stdin.write("\x7f".repeat(n));
  await sleep(200);
};

const scenes = {};

await sleep(700);
scenes.welcome = lastFrame();

// ① 打一个斜杠：12 条命令全列
await type("/");
scenes.commands = lastFrame();

// ② 再打两个字母：命令列表收敛 + 行内 ghost
await type("mo");
scenes.ghost = lastFrame();

// ③ → 接受 ghost（补全成 /model），再 Tab 落进参数位 → 模型候选
stdin.write("\x1b[C");
await sleep(260);
scenes.accepted = lastFrame();
stdin.write("\t");
await sleep(300);
scenes.modelArgs = lastFrame();

// ④ /skill 参数位：166 个候选 → 开窗 + 溢出提示；↓ 从首项进入选中
await clearInput();
await type("/skill ");
stdin.write("\x1b[B");
await sleep(260);
scenes.skillArgs = lastFrame();

// ⑤ /resume 参数位：会话编号候选
await clearInput();
await type("/resume ");
scenes.resumeArgs = lastFrame();

await clearInput();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ rows: ROWS, cols: COLS, version: "0.14.0", scenes }, null, 1), "utf8");
console.log("scenes ->", OUT);
console.log("keys:", Object.keys(scenes).join(", "));
process.exit(0);
