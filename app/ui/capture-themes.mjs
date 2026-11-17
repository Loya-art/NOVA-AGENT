// 配色样机抓帧：把「当前主题」的真实渲染帧抓下来，供对比页做 ANSI→HTML 还原。
// 为什么要它：换配色最怕"看着像那么回事，上手才发现正文和输入糊在一起"。
// 所以这里不是手画的示意图，是真跑一遍渲染引擎、逐字节存下来。
//
// 跑法：
//   cd app && node ui/capture-themes.mjs out.json            # 抓当前主题
//   NOVA_THEME=crt-green node ui/capture-themes.mjs out.json  # 抓指定主题
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";

process.env["TUI_" + "NO_AUTORUN"] = "1";
const mod = await import("./src/tui.mjs");
const { start, C, THEME_NAME, _ansi } = mod;
const { fg, bold, stamp, BRAND } = _ansi;

const ROWS = 40;
const COLS = 108;
const OUT = process.argv[2] || `F:/AgentPortable/logs/themes/${THEME_NAME}.json`;

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
  await sleep(240);
};
const clearInput = async (n = 80) => {
  stdin.write("\x7f".repeat(n));
  await sleep(200);
};

const scenes = {};

// ① 欢迎面板：logo 渐变 + 面板文字
await sleep(700);
scenes.welcome = lastFrame();

// ② 一段完整对话：用户输入 → 思考 → 工具调用 → 工具结果 → 正文回答
//    （直接喂事件，不真调 API；这样每套主题看到的字完全一样，可以横着比）
//    先把欢迎面板腾掉，否则一屏 40 行里对话只剩 9 行，比色的时候看不清。
ui._S.transcript = [];
ui._S.wrapCache = [];
ui._S.scroll = 0;
ui._render();
await sleep(200);
// 用户输入框（v0.16.9 边框统一 accent 红，与 tui.mjs pushUserFrame 同步）
const vw = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) > 0xff ? 2 : 1), 0);
const task = "帮我把 README 的启动那节重写一下";
const iw = 3 + vw(task); // " ❯ " + 内容
ui._pushRaw(fg(C.accent, "╭" + "─".repeat(iw + 1) + "╮"));
ui._pushRaw(fg(C.accent, "│") + fg(C.accent, " ❯ ") + fg(C.text, task) + fg(C.accent, " │"));
ui._pushRaw(fg(C.accent, "╰" + "─".repeat(iw + 1) + "╯"));
ui._event({ type: "thinking", text: "先看现有 README 的结构，再决定怎么改。原来的表格别拆了。" });
ui._event({ type: "tool_call", name: "read", args: { file_path: "README.md" } });
ui._event({ type: "tool_result", ok: true, output: "共 412 行" });
ui._event({
  type: "text",
  text: "看完了，这节有三个毛病：",
});
ui._event({ type: "text", text: "  1. 启动命令散在三处，新人不晓得从哪下手" });
ui._event({ type: "text", text: "  2. 没写清楚换台电脑要不要先装环境" });
ui._event({ type: "text", text: "  3. 缺一段「跑起来长什么样」" });
ui._event({ type: "text", text: "我按这三条重排，表格保留。" });
ui._event({ type: "tool_call", name: "edit", args: { file_path: "README.md" } });
ui._event({ type: "tool_result", ok: true, output: "412 行 → 456 行" });
ui._event({ type: "tool_result", ok: false, output: "lint 警告：第 88 行表格列数不齐" });
await sleep(500);
scenes.chat = lastFrame();

// ③ 补全：打两个字母 → 行内 ghost + 候选列表
await type("/mo");
scenes.ghost = lastFrame();

// ④ 参数位：候选列表 + ↓ 选中（看选中行的反白效果）
stdin.write("\t");
await sleep(300);
stdin.write("\x1b[B");
await sleep(300);
scenes.modelArgs = lastFrame();

await clearInput();

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify({ rows: ROWS, cols: COLS, theme: THEME_NAME, themeColors: C, scenes }, null, 1),
  "utf8",
);
console.log("theme ->", THEME_NAME, "|", OUT);
process.exit(0);
