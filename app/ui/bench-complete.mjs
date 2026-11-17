// 补全引擎性能基准：统计 fs.readFileSync 调用次数，证明「参数位补全」走缓存。
// 背景：/skill 的参数候选来自 166 个 SKILL.md，若每帧重读，打字会卡；
//       所以 loadSkills/loadModelCatalog 都做了进程内缓存。改补全逻辑后跑一遍它复查。
// 跑法：cd app && node ui/bench-complete.mjs
import fs from "node:fs";
import { PassThrough } from "node:stream";
const orig = fs.readFileSync;
let total = 0, skillMd = 0;
fs.readFileSync = function (p, ...rest) {
  total++;
  if (String(p).endsWith("SKILL.md")) skillMd++;
  return orig.apply(this, [p, ...rest]);
};
process.env["TUI_" + "NO_AUTORUN"] = "1";
const { start } = await import("./src/tui.mjs");

const captured = [];
class FakeOut extends PassThrough { write(c) { captured.push(c.toString("utf8")); return true; } }
const stdout = new FakeOut();
stdout.columns = 120; stdout.rows = 44; stdout.isTTY = true; stdout.getWindowSize = () => [44, 120];
const stdin = new PassThrough();
stdin.isTTY = true; stdin.setRawMode = () => stdin; stdin.ref = () => {}; stdin.unref = () => {};
start({ stdin, stdout, rows: 44, cols: 120 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(800);
const baseAll = total, baseSkill = skillMd;

// 输入 18 个字符（会触发十几帧渲染）——其中有 8 个字符处于 /skill 参数位
const t0 = performance.now();
for (const b of Buffer.from("/skill architecture-diagram ", "utf8")) { stdin.write(Buffer.from([b])); await sleep(15); }
await sleep(400);
const dt = performance.now() - t0;

const frames = captured.join("").split("\x1b[H").length - 1;
console.log(`输入 18 字符（${frames} 帧渲染）耗时 ${dt.toFixed(0)}ms`);
console.log(`SKILL.md 读取：启动 ${baseSkill} 次 → 输入完 ${skillMd} 次（增量 ${skillMd - baseSkill}，应为 0）`);
console.log(`readFileSync 总调用：启动 ${baseAll} → ${total}（增量 ${total - baseAll}）`);
process.exit(0);
