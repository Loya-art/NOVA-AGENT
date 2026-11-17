// ============================================================
//  NOVA-AGENT 换机自检 —— 插到别人电脑上，先跑这个
//
//  目的：一次性回答「这台电脑能不能直接跑」，不依赖对方装任何东西。
//  跑法：双击 U 盘根目录的「换机自检.bat」，或：
//        <盘>:\AgentPortable\runtime\node\bin\node.exe tools\preflight.mjs
//
//  只读检查：不写文件、不联网、不调用模型。
// ============================================================
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const APP = path.join(ROOT, "app");
const DATA = path.join(ROOT, "data");

const R = "\x1b[0m";
const c = (n) => (s) => `\x1b[38;5;${n}m${s}${R}`;
const ok = c(35), bad = c(203), warn = c(214), dim = c(245), gold = c(220), txt = c(230);
const OK = ok("✓"), NO = bad("✗"), WARN = warn("!");

const rows = [];
let hardFail = 0;
let softWarn = 0;
function line(mark, name, detail, tip) {
  rows.push([mark, name, detail, tip]);
  if (mark === NO) hardFail++;
  else if (mark === WARN) softWarn++;
}

const pad = (s, n) => {
  const w = [...String(s)].reduce((a, ch) => a + (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
  return String(s) + " ".repeat(Math.max(0, n - w));
};

console.log("");
console.log(gold("  ✦ NOVA-AGENT 换机自检") + dim("  —— 只读检查，不写文件、不联网、不花 token"));
console.log(dim(`  程序目录 ${ROOT}`));
console.log("");

// ---------- 1. 运行时：Node 是否随盘自带 ----------
{
  const v = process.version;
  const major = Number(v.replace("v", "").split(".")[0]);
  line(major >= 20 ? OK : NO, "Node 运行时", `${v} · ${process.arch} · 由 U 盘自带`, major >= 20 ? "" : "U 盘内 runtime/node 不完整，重新拷贝");
  line(os.platform() === "win32" ? OK : WARN, "操作系统", `${os.platform()} ${os.release()}${os.platform() === "win32" ? "（" + (Number(os.release().split(".")[2] || 0) >= 17763 ? "Win10 1809+ / 满足" : "版本偏旧") + "）" : ""}`, os.platform() === "win32" ? "" : "本 U 盘只打包了 Windows x64 二进制");
}

// ---------- 2. 架构匹配（原生模块是 win32-x64 预编译） ----------
{
  const isArm = process.arch === "arm64";
  line(isArm ? NO : OK, "CPU 架构", `本机 ${process.arch} · 原生模块 win32-x64`,
    isArm ? "ARM 设备需重新装一份 arm64 依赖" : "");
}

// ---------- 3. 内置能力：读会话用的 zstd ----------
line(typeof zlib.zstdDecompressSync === "function" ? OK : WARN, "内置 zstd",
  typeof zlib.zstdDecompressSync === "function" ? "可解压会话历史" : "缺 zstd —— /sessions 回显会失效",
  typeof zlib.zstdDecompressSync === "function" ? "" : "Node 需 ≥ 23.8，换回盘内自带的 node.exe");

// ---------- 4. 依赖完整性 ----------
{
  const must = [
    ["@deepseek-ai/dsh", "内核 CLI"],
    ["@deepseek-ai/dsh-skill-filesystem", "技能加载"],
    ["@deepseek-ai/dsh-session-persistence-jsonl", "会话持久化"],
    ["js-yaml", "模型目录解析"],
    ["wrap-ansi", "界面折行"],
  ];
  const miss = must.filter(([p]) => !fs.existsSync(path.join(APP, "node_modules", p)));
  line(miss.length === 0 ? OK : NO, "内置依赖",
    miss.length === 0 ? `${must.length}/${must.length} 个关键包就位（共 ${fs.readdirSync(path.join(APP, "node_modules")).length} 个顶层包）`
      : "缺 " + miss.map(([p, d]) => `${p}(${d})`).join("、"),
    miss.length ? "从原机重新拷一份 app/node_modules" : "");
}

// ---------- 5. 界面产物 ----------
{
  const bundle = path.join(APP, "ui", "bundle.mjs");
  let size = 0;
  try { size = fs.statSync(bundle).size; } catch {}
  line(size > 10000 ? OK : NO, "界面包", size ? `ui/bundle.mjs ${(size / 1024).toFixed(1)}KB` : "ui/bundle.mjs 不存在",
    size ? "" : "跑一次 启动界面.bat 会自动重建，或 node ui/build.mjs");
}

// ---------- 6. 数据目录可写（会话、技能、模型补丁都要写） ----------
{
  const probe = path.join(DATA, `.preflight-${Date.now()}.tmp`);
  let writable = false;
  try {
    fs.writeFileSync(probe, "x");
    fs.unlinkSync(probe);
    writable = true;
  } catch {}
  line(writable ? OK : NO, "数据目录可写", DATA, writable ? "" : "U 盘写保护开关？或 exFAT 权限异常");
}

// ---------- 7. 凭据 ----------
{
  const envKeys = ["DEEPSEEK_API_KEY", "SILICONFLOW_API_KEY", "OPENAI_API_KEY", "CUSTOM_API_KEY"].filter((k) => process.env[k]);
  const hasVault = fs.existsSync(path.join(DATA, "vault.enc"));
  const hasTxt = fs.existsSync(path.join(ROOT, "key.txt"));
  const state = envKeys.length ? `环境变量已带 ${envKeys.join("/")}` : hasVault ? "加密保管库 data/vault.enc" : hasTxt ? "明文 key.txt" : "";
  line(state ? OK : WARN, "API 凭据", state || "没找到（首启会弹设置向导）",
    state ? "" : "首次运行 启动界面.bat 时按提示粘贴一次即可，之后存 U 盘");
}

// ---------- 8. 技能库 ----------
{
  let n = 0, bad = 0;
  try {
    const dirs = fs.readdirSync(path.join(DATA, "skills"), { withFileTypes: true }).filter((e) => e.isDirectory());
    n = dirs.length;
    for (const d of dirs) if (!fs.existsSync(path.join(DATA, "skills", d.name, "SKILL.md"))) bad++;
  } catch {}
  line(n > 0 ? OK : WARN, "技能库", n ? `${n} 个技能（data/skills）` : "空",
    n ? (bad ? `${bad} 个缺 SKILL.md` : "") : "跑 tools/sync-skills.py 从知识库同步");
}

// ---------- 9. 历史会话 ----------
{
  let n = 0;
  try {
    for (const proj of fs.readdirSync(path.join(DATA, "sessions"))) {
      const p = path.join(DATA, "sessions", proj);
      if (!fs.statSync(p).isDirectory()) continue;
      for (const s of fs.readdirSync(p)) if (fs.existsSync(path.join(p, s, "session.v4.jsonl.zstd"))) n++;
    }
  } catch {}
  line(OK, "历史会话", `${n} 条（/sessions 可翻、/resume 可回）`);
}

// ---------- 10. 系统 shell（内核在 Windows 上禁用 bash，改用系统自带 PowerShell） ----------
{
  if (os.platform() !== "win32") {
    line(WARN, "系统 shell", "非 Windows —— 内核会改用它自己的 bash 工具");
  } else {
    const sysRoot = process.env.SystemRoot || "C:\\Windows";
    const ps5 = path.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const ps7 = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
    const have7 = fs.existsSync(ps7);
    const have5 = fs.existsSync(ps5);
    line(have5 || have7 ? OK : NO, "系统 PowerShell",
      have7 ? "PowerShell 7 已装（首选）" : have5 ? "用系统自带 PowerShell 5.1（无需另装）" : "没找到",
      have5 || have7 ? "" : "Windows 自带应有，可能被精简系统移除了");
  }
}

// ---------- 11. 外部程序（Python 之类）根本不需要 ----------
{
  // 只探测存在性，不去执行（避免在别人机器上触发 UAC / 弹窗 / 长时间等待）
  const cands = [
    "C:\\Python314\\python.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Python", "Python313", "python.exe"),
  ].filter((p) => p && fs.existsSync(p));
  line(OK, "Python / pip", cands.length ? "本机装了 Python（但运行时不需要它）" : "本机没装，也不影响（运行时零 Python 依赖）",
    "U 盘里 tools/sync-skills.py 是「在原机同步技能」用的，日常运行用不到");
}

// ---------- 12. 终端能力 ----------
{
  const wt = process.env.WT_SESSION ? "Windows Terminal" : process.env.TERM_PROGRAM ? process.env.TERM_PROGRAM : "传统控制台";
  const size = process.stdout.columns ? `${process.stdout.columns}×${process.stdout.rows}` : "非 TTY（导出重定向中）";
  const big = process.stdout.columns ? process.stdout.columns >= 80 : true; // 管道/重定向不算窄屏
  line(big ? OK : WARN, "终端", `${wt} · ${size}`,
    big ? "本界面用备用屏 + 鼠标上报，Windows Terminal 体验最好"
      : "窗口太窄，NOVA 大字与面板会退化；建议拉宽到 ≥80 列或换 Windows Terminal");
}

// ---------- 输出表格 ----------
const wName = Math.max(...rows.map(([, n]) => [...n].reduce((a, ch) => a + (/[\u4e00-\u9fff]/.test(ch) ? 2 : 1), 0))) + 2;
for (const [mark, name, detail, tip] of rows) {
  console.log(`   ${mark}  ${txt(pad(name, wName))}${dim(detail)}`);
  if (tip) console.log(`      ${dim("  ↳ " + tip)}`);
}
console.log("");
if (hardFail === 0 && softWarn === 0) {
  console.log(ok("  ✓ 这台电脑可以直接用 —— 不用装 Node，不用装 Python，不用装任何东西。"));
  console.log(dim("    双击 U 盘根目录「启动界面.bat」即可。"));
} else if (hardFail === 0) {
  console.log(warn(`  ! 可以启动，但有 ${softWarn} 处提醒（见上面的 ↳）。`));
  console.log(dim("    多半不影响使用；若是凭据那条，首次启动按向导填一次就行。"));
} else {
  console.log(bad(`  ✗ 有 ${hardFail} 项硬性缺失，先按上面的 ↳ 提示修。`));
}
console.log("");
