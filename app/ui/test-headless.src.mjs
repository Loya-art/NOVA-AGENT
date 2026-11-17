// Headless test for tui.mjs（v0.12.0 自绘引擎）
// 假 TTY stdin/stdout，喂原始字节流，断言帧内容。
// 关键不变量：每帧行数恒为 rows-1、无尾换行（备用屏幕固定帧 → 钉底由构造保证）。
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env["TUI_" + "NO_AUTORUN"] = "1";
// ⚠️ 必须和启动器一致：launcher 先 `cd app` 再跑 ui/bundle.mjs，
// tui.mjs 里 ROOT=dirname(cwd)/DSH_HOME=cwd/../data 都基于 cwd 解析。
// 测试若在仓库根跑，DSH_HOME 会错位成 F:\data，技能库就读不到。
process.chdir(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
// ⚠️ 状态隔离：上机用过的 /model、/persona 会留下 --patch 文件，
// 那会让「当前模型/当前人设」类断言从第一帧就带上前一次的残留。
// 但**不能直接删** —— 那是用户自己的选择。开局挪走，收尾原样放回。
const PROFILE_DIR = path.join(process.cwd(), "..", "data", "profiles", "headless");
const PATCH_FILES = ["model-override.yml", "persona-override.yml"];
const savedPatches = {};
for (const f of PATCH_FILES) {
  const p = path.join(PROFILE_DIR, f);
  if (fs.existsSync(p)) {
    savedPatches[f] = fs.readFileSync(p);
    fs.rmSync(p);
  }
}
const restorePatches = () => {
  for (const [f, buf] of Object.entries(savedPatches)) {
    try {
      fs.writeFileSync(path.join(PROFILE_DIR, f), buf);
    } catch {}
  }
};
const tuiMod = await import("./src/tui.mjs");
const { start } = tuiMod;
const THEME = tuiMod.C; // 当前配色主题（断言按它解析，不写死色号）

const ROWS = 44;
const COLS = 110;
const VERSION = "0.17.1";

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

let exitCode = null;
const ui = start({ stdin, stdout, rows: ROWS, cols: COLS });
ui.setOnExit((code) => {
  exitCode = code;
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const all = () => captured.join("");
const frames = () => all().split("\x1b[H").slice(1); // 每帧以光标回家开头
let failures = 0;
function check(name, cond) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failures++;
    console.log(`  ✗ ${name}`);
  }
}
async function type(text) {
  for (const ch of Buffer.from(text, "utf8")) {
    stdin.write(Buffer.from([ch]));
    await sleep(8);
  }
}
const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const TAB = "\t";
const WHEEL_UP = "\x1b[<64;10;10M";
const WHEEL_DOWN = "\x1b[<65;10;10M";

await sleep(400);

// --- 1. 启动帧 ---
check("启动帧渲染欢迎面板（可用工具/可用技能/汇总行）", all().includes("可用工具") && all().includes("可用技能") && all().includes("/help 查看命令"));
check("版本行 v + stable · local", all().includes(`v${VERSION}`) && all().includes("stable") && all().includes("local"));
check("大字 logo（NOVA-AGENT 描边字）", all().includes("███╗"));
check("年兽像素标志（hero 左栏：▀ 半格 ≥16 行，替代旧 USB 接头）", (all().split("\r\n").filter((l) => l.includes("▀")).length) >= 16);

// --- 2. 帧不变量：每帧行数 ≤ rows-1 ---
{
  const fs_ = frames();
  let ok = fs_.length > 0;
  for (const f of fs_.slice(-3)) {
    const nl = (f.match(/\r\n/g) || []).length;
    if (nl > ROWS - 1) ok = false;
  }
  check(`每帧行数 ≤ ${ROWS - 1}（固定帧）`, ok);
  check("无光标位置查询 \\x1b[6n", !all().includes("\x1b[6n"));
  check("启动即关闭 alternate scroll（?1007l）", all().includes("\x1b[?1007l"));
}

// --- 3. 斜杠提示：输入 / 出现命令列表 ---
// 解析渲染结果用的工具。颜色值一律从当前主题取，测试不写死色号。
const hexToRgbStr = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};
const BG_RGB = hexToRgbStr(THEME.bg);
const highlightLine = (frame) => {
  // 选中行 = 「非底色的底 + 底色的字」整行铺满（selRow）。
  // 普通行开头是「底色 + 某个前景色」，靠 lookahead 排掉。
  const re = new RegExp(`\\x1b\\[48;2;(?!${BG_RGB}m)(?:\\d+;\\d+;\\d+)m\\x1b\\[38;2;${BG_RGB}m([^\\x1b]*)\\x1b\\[39m`);
  const m = re.exec(frame);
  return m ? m[1] : "";
};
// 取某一行里「指定主题色」的那一段文字
const segOf = (line, hex) => {
  const re = new RegExp(`\\x1b\\[38;2;${hexToRgbStr(hex)}m([^\\x1b]*)\\x1b\\[39m`);
  const m = re.exec(line);
  return m ? m[1] : "";
};
const ghostOf = (line) => segOf(line, THEME.ghost);
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
// 输入框那一行：以框线 │ 开头且含提示符（历史里的 "❯ 任务" 行也含 ❯，得排除掉）
const inputBox = (frame) =>
  frame.split("\r\n").find((l) => {
    const p = plain(l);
    return p.startsWith("│ ") && p.includes("❯");
  }) || "";
await type("/");
await sleep(250);
{
  const last = frames().at(-1);
  check("输入 / 出现命令提示（/help…/exit）", last.includes("/help") && last.includes("/status") && last.includes("显示这份帮助"));
  // 列表方向：正向渲染（matches[0] 在上，末尾项紧贴输入框）
  const iHelp = last.indexOf("/help");
  const iModel = last.indexOf("/model");
  check("提示列表正向渲染（/help 在上、/model 在下）", iHelp > -1 && iModel > -1 && iHelp < iModel);
  // ↑ 进入选中：应落在最下方项 /exit（命令表末位），再按 ↑ 上移到 /memory
  stdin.write(UP);
  await sleep(220);
  check("按 ↑ 选中列表最下方项（/exit）", highlightLine(frames().at(-1)).includes("/exit"));
  stdin.write(UP);
  await sleep(220);
  check("再按 ↑ 上移到 /memory", highlightLine(frames().at(-1)).includes("/memory"));
  stdin.write(DOWN);
  await sleep(220);
  check("按 ↓ 下移回 /exit", highlightLine(frames().at(-1)).includes("/exit"));
  stdin.write(DOWN);
  await sleep(220);
  check("按 ↓ 停在末项（高亮不消失）", highlightLine(frames().at(-1)).includes("/exit"));
}
await type("h");
await sleep(250);
check("输入 /h 过滤到 /help", frames().at(-1).includes("/help") && !frames().at(-1).includes("/skills"));

// --- 4. Tab 补全 ---
stdin.write(TAB);
await sleep(250);
check("Tab 补全 /h → /help", plain(frames().at(-1)).includes("❯ /help "));

// --- 5. Enter 执行 /help ---
stdin.write(ENTER);
await sleep(400);
check("/help 输出帮助（常用命令/快捷键）", all().includes("常用命令") && all().includes("快捷键"));

// --- 5b. v0.14.0 补全引擎：行内 ghost / → 接受 / Tab 入参 / 参数补全 / 开窗 ---
const RIGHT = "\x1b[C";
const BACKSPACE = "\x7f";const clearInput = async (n = 60) => {
  stdin.write("\x7f".repeat(n));
  await sleep(180);
};

await type("/mo");
await sleep(250);
{
  const box = inputBox(frames().at(-1));
  check("输入 /mo 即浮出行内 ghost（框内已长成 /model）", plain(box).includes("❯ /model"));
  check("ghost 段用另一种颜色（与已输入部分区分）", /del/.test(ghostOf(box)));
}
stdin.write(RIGHT);
await sleep(250);
check("→ 接受 ghost：输入框变完整 /model", plain(inputBox(frames().at(-1))).includes("❯ /model"));

stdin.write(TAB);
await sleep(250);
check("Tab 独占命令后落进参数位（/model + 空格）", plain(frames().at(-1)).includes("❯ /model "));
check("参数位列出模型候选（含 default）", frames().at(-1).includes("deepseek-v4-pro") && frames().at(-1).includes("default"));
{
  const box = inputBox(frames().at(-1));
  check("参数位同样有行内 ghost（补全首个模型名）", /deepseek-flash/.test(ghostOf(box)));
}
stdin.write(TAB);
await sleep(250);
check("参数位 Tab 把首个模型补进输入框", plain(frames().at(-1)).includes("❯ /model deepseek-flash "));

// /skill 参数位：候选 166 个 → 必须开窗 + 溢出提示
await clearInput();
await type("/skill ");
await sleep(380);
{
  const last = frames().at(-1);
  check("/skill 参数位列出技能候选（含真实技能名）", last.includes("1password"));
  check("候选超一屏时开窗并给溢出提示", /共 \d+ 项/.test(last) && /下方 \d+ 项/.test(last));
}
{
  const h0 = highlightLine(frames().at(-1));
  check("参数位默认无高亮（靠 ghost 提示）", h0 === "");
  stdin.write(DOWN);
  await sleep(250);
  const h1 = highlightLine(frames().at(-1));
  check("参数位 ↓ 从首项进入选中", h1.includes("1password"));
  stdin.write(DOWN);
  await sleep(250);
  const h2 = highlightLine(frames().at(-1));
  check("参数位 ↓ 再下移一格", h2 !== "" && h2 !== h1);
  stdin.write(TAB);
  await sleep(250);
  const lit = frames().at(-1);
  check("参数位 Tab 把选中项补进输入框并清高亮", /❯ \/skill \S+ /.test(plain(lit)) && highlightLine(lit) === "");
}
await clearInput();

// --- 6. 输入历史 ↑/↓ ---
await type("/status");
await sleep(200);
stdin.write(ENTER);
await sleep(1200);
check("/status 有响应（余额查询发起）", all().includes("正在查询余额") || all().includes("余额"));
stdin.write(UP);
await sleep(200);
check("↑ 翻出上一条输入 /status", plain(frames().at(-1)).includes("❯ /status"));
stdin.write(DOWN);
await sleep(200);
check(
  "↓ 回到空草稿",
  frames()
    .at(-1)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .includes("❯ ▌"),
);

// --- 7. 滚轮翻历史 ---
{
  const before = frames().at(-1);
  stdin.write(WHEEL_UP);
  await sleep(250);
  const after = frames().at(-1);
  check("滚轮上翻出现「翻阅中」指示", after.includes("翻阅中"));
  check("滚轮上翻后画面变化", after !== before);
  stdin.write(WHEEL_DOWN);
  await sleep(250);
  check("滚轮下滚回到底部（指示消失）", !frames().at(-1).includes("翻阅中"));
}

// --- 7b. Ctrl+滚轮：放行给终端缩放，随后自动收回 ---
{
  const mark = all().length;
  stdin.write("\x1b[<80;10;10M"); // Ctrl+滚轮上（64|16=80）
  await sleep(220);
  const seg = all().slice(mark);
  const last = frames().at(-1);
  check("Ctrl+滚轮：关掉鼠标上报（?1000l?1006l）", seg.includes("\x1b[?1000l\x1b[?1006l"));
  check("Ctrl+滚轮：状态栏提示「滚轮已让给终端缩放」", last.includes("滚轮已让给终端缩放"));
  check("Ctrl+滚轮：不翻历史（无「翻阅中」）", !last.includes("翻阅中"));
  await type("x"); // 打字 → 立刻收回
  await sleep(200);
  check("打字后立刻收回滚轮（?1000h?1006h）", all().slice(mark).includes("\x1b[?1000h\x1b[?1006h"));
  check("收回后提示消失", !frames().at(-1).includes("滚轮已让给终端缩放"));
  stdin.write("\x7f"); // 清掉测试字符
  await sleep(120);
}

// --- 7c. 放行窗口：连滚续期 + 停手 1 秒自动收回 ---
{
  const mark = all().length;
  stdin.write("\x1b[<81;10;10M"); // Ctrl+滚轮下（65|16=81）
  await sleep(300);
  stdin.write("\x1b[<81;10;10M");
  await sleep(300);
  check("Ctrl+滚轮下：同样放行终端缩放", all().slice(mark).includes("\x1b[?1000l\x1b[?1006l"));
  // 模拟缩放引发的 resize（字号变了行列数就变）→ 应续期
  stdout.rows = ROWS + 1;
  stdout.emit("resize");
  stdout.rows = ROWS;
  await sleep(400);
  check("缩放 resize 后续期（窗口未收回）", !all().slice(mark).includes("\x1b[?1000h\x1b[?1006h"));
  await sleep(1300);
  check("停手 1 秒后自动收回滚轮（?1000h?1006h）", all().slice(mark).includes("\x1b[?1000h\x1b[?1006h"));
  const after = frames().at(-1);
  check("收回后状态栏提示消失", !after.includes("滚轮已让给终端缩放"));
  stdin.write(WHEEL_UP);
  await sleep(250);
  check("收回后滚轮恢复翻历史", frames().at(-1).includes("翻阅中"));
  stdin.write(WHEEL_DOWN);
  await sleep(200);
}

// --- 7b. /skills 读取真实技能库（与内核同源：data/skills）---
await type("/skills");
await sleep(200);
stdin.write(ENTER);
await sleep(700);
{
  const plain = all().replace(/\x1b\[[0-9;]*m/g, "");
  const m = /技能库 —— (\d+) 个/.exec(plain);
  check("/skills 列出真实技能库（>100 个）", !!m && Number(m[1]) > 100);
  check("/skills 内容来自内核同源目录（含真实技能名）", plain.includes("1password") && plain.includes("banwei-workflow"));
}

// --- 7c. v0.13.0 新命令：/sessions、/model、/skill ---
const OVF = path.join(process.cwd(), "..", "data", "profiles", "headless", "model-override.yml");
const OVP = path.join(process.cwd(), "..", "data", "profiles", "headless", "persona-override.yml");
const plainAll = () => all().replace(/\x1b\[[0-9;]*m/g, "");
{
  const run = async (cmd, wait = 500) => {
    await type(cmd);
    await sleep(180);
    stdin.write(ENTER);
    await sleep(wait);
  };

  // /sessions：列出历史会话（data/sessions + 投影缓存）
  await run("/sessions", 900);
  const p1 = plainAll();
  check("/sessions 列出历史会话（标题+轮数）", /历史会话 —— \d+ 个/.test(p1) && p1.includes("/resume <编号>"));
  check("/sessions 说明 ● 是当前会话", p1.includes("● = 当前会话"));

  // /model：列目录（官方两个 + profile 里声明的路由）
  await run("/model");
  const p2 = plainAll();
  check("/model 列出可用模型", p2.includes("可用模型") && p2.includes("deepseek-flash") && p2.includes("deepseek-v4-pro"));
  check("/model 标出当前模型", p2.includes("当前：deepseek-flash"));

  // /model 切换 → 写出 patch 文件（下一轮 spawn 时用 --patch 叠加）
  await run("/model deepseek-v4-pro");
  check(
    "/model 切换写出 --patch 补丁",
    all().includes("已切换到 deepseek-v4-pro") &&
      fs.existsSync(OVF) &&
      /model:\s*deepseek-v4-pro/.test(fs.readFileSync(OVF, "utf8")),
  );

  // /model default → 删补丁、回默认
  await run("/model default");
  check("/model default 回默认并清掉补丁", all().includes("已恢复默认模型") && !fs.existsSync(OVF));

  // /persona：人设列表 → 启用 → 关闭（v0.15.0）
  await run("/persona");
  const p3 = plainAll();
  check("/persona 列出人设库（含 seagull）", p3.includes("人设") && p3.includes("seagull") && p3.includes("当前：默认（未启用）"));
  check("/persona 给出自定义人设的目录", p3.includes("data\\personas") || p3.includes("data/personas"));

  await run("/persona seagull");
  const ovBody = fs.existsSync(OVP) ? fs.readFileSync(OVP, "utf8") : "";
  check("/persona 启用人设并写出 --patch 补丁", all().includes("已启用人设「seagull」") && fs.existsSync(OVP));
  check("补丁改的是 system-prompt.personaPrefix", /id:\s*system-prompt/.test(ovBody) && /personaPrefix:\s*\|-/.test(ovBody));
  check("补丁带上了人设正文（问候语在）", ovBody.includes("海鸥在线，你要整点薯条吗"));
  check("补丁重写了 personaSuffix（否则 cwd 提示会丢）", /personaSuffix:.*\{\{cwd\}\}/.test(ovBody));
  check("补丁里 personaSuffix 没被块标量吞掉", /^ {4}personaSuffix:/m.test(ovBody));
  await sleep(60);
  check("状态栏出现当前人设", all().includes("◈ seagull"));

  await run("/persona zzz-nope");
  check("/persona 未知人设明确报错", all().includes("没有这个人设"));

  await run("/persona off");
  check("/persona off 清掉补丁", all().includes("已关闭人设") && !fs.existsSync(OVP));

  // /persona 参数位补全：人设名 + off
  await type("/persona ");
  await sleep(260);
  const p4 = frames().at(-1);
  check("参数位列出人设候选（含 seagull 与 off）", p4.includes("seagull") && p4.includes("off"));
  for (let i = 0; i < 9; i++) stdin.write(BACKSPACE); // 清空输入
  await sleep(200);

  // /skill：把 SKILL.md 正文装上，下一条消息带上
  await run("/skill hermes-agent", 700);
  check("/skill 加载技能正文", all().includes("已加载技能 hermes-agent") && all().includes("下一条消息带上它"));
  await run("/skill zzz-does-not-exist", 400);
  check("/skill 未知技能明确报错", all().includes("没有这个技能"));

  // /resume 不存在的编号 → 报错而不是静默
  await run("/resume 9999", 700);
  check("/resume 找不到会话时明确报错", all().includes("找不到会话"));
}

// --- 8. Esc / Ctrl+C 退出 ---
stdin.write("\x03");
await sleep(150);
stdin.write("\x03");
await sleep(300);
check("连按 Ctrl+C 退出并恢复终端（?1049l）", all().includes("\x1b[?1049l"));
check("退出码 0", exitCode === 0);

// 落盘供 verify 工具分析
fs.writeFileSync(process.argv[2] || "F:/AgentPortable/logs/tui-frames.txt", all(), "utf8");
// 放回开局的用户选择（/model、/persona 留下的 --patch 文件）
restorePatches();
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
