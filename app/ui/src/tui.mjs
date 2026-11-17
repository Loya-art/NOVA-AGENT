// tui.mjs — NOVA Agent v0.16.11 全自绘终端 UI（默认霓虹主题·纯白正文）
// ============================================================
// v0.11.x 的教训：ink 的动态帧高度随内容变化，配合终端滚动语义
// 永远有「发消息画面跳顶 / 滚轮失灵」类毛病。v0.12 起彻底自绘：
//
//   1. 备用屏幕（?1049h）：整屏归 App 所有，无滚屏污染；
//   2. 固定帧：每帧恰好 rows-1 行、无尾换行 → 输入框**构造上**
//      永远钉在窗口底部，任何内容量都不会跳；
//   3. 聊天视口自管：会话记录存成 ANSI 行，滚轮（SGR 鼠标事件）
//      上下翻视口，新消息自动跟随底部；
//   4. 补全引擎（v0.14.0，Minecraft 聊天栏打指令的手感）：
//      打 / 之后每敲一个字符，输入框里立刻浮出**行内暗灰剩下段**（ghost）；
//      ↑/↓ 在候选间移动（↑ 从末项、↓ 从首项，两端对称），Tab / → 把候选
//      补进输入框（= 确认选择），Enter 才真正执行；打空格进「参数位」后
//      继续补该命令的取值（/model → 模型 … /skill → 技能 … /resume → 会话）。
//      候选多于一屏时围绕选中项开窗滚动，技能库 166 个也不会撑爆屏幕。
//   5. Ctrl+滚轮缩放的「放行」机制（v0.12.1）：终端（Windows Terminal /
//      conhost）的 Ctrl+滚轮缩放是**终端自身**功能，但应用一开 VT 鼠标
//      上报（?1000h?1006h），滚轮就只发给应用、终端不再缩放。所以收到
//      Ctrl+滚轮时临时关掉上报，把接下来每一格交给终端去缩放；鼠标停手
//      （或用户开始打字）后立刻收回，滚轮翻历史照旧。
//   6. 技能库接通（v0.12.2）：界面与内核统一读 U 盘自带的 data/skills
//      （内核认这个根，跟着 U 盘走）；知识库的技能由 tools/sync-skills.py
//      平铺同步过来。界面按 parseSkillDesc 解析（含 YAML 折叠块）。
//   7. 人设 /persona（v0.15.0）：内核 dsh-system-prompt 的 personaPrefix
//      就是注入口。启用时把 data/personas/<名字>.md 写成 persona-override.yml，
//      发消息时用 --patch 叠加 —— 与 /model 同一条已验证通道，不碰 profile。
// ============================================================
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import wrapAnsi from "wrap-ansi";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import yaml from "js-yaml";
import { listSessions, sessionLabel, loadSessionDetail, findSession } from "./sessions.mjs";

// ---- locate the portable root from cwd (launcher cd's into app/) ----
const APP_DIR = process.cwd();
const ROOT = path.dirname(APP_DIR);
const NODE_EXE = path.join(ROOT, "runtime", "node", "bin", "node.exe");
const DSH_BIN = path.join(APP_DIR, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const DSH_HOME = path.join(ROOT, "data");
const WORKSPACE = path.join(ROOT, "workspace");

// 默认模型（profile 里 agent-default-model 的值；/model 切换会写 model-override.yml）
const DEFAULT_PROVIDER = "deepseek-official";
const DEFAULT_MODEL = "deepseek-flash";
const PROFILE_PATCH = path.join(DSH_HOME, "profiles", "headless", "cordis.patch.yml");
// /model 写这里；启动 dsh 时用 --patch 叠加。文件不存在 = 用 profile 默认。
const MODEL_OVERRIDE = path.join(DSH_HOME, "profiles", "headless", "model-override.yml");
// 人设：data/personas/*.md，每份一个。启用时写成 persona-override.yml 走同一条 --patch 通道。
const PERSONA_DIR = path.join(DSH_HOME, "personas");
const PERSONA_OVERRIDE = path.join(DSH_HOME, "profiles", "headless", "persona-override.yml");
const SESSIONS_ROOT = path.join(DSH_HOME, "sessions");
const PROJCACHE_ROOT = path.join(DSH_HOME, "storages", "session_projcache", "sessions");
const VERSION = "0.17.1";
const CONTEXT_WINDOW = 1048576;
const BELL_AFTER_MS = 10000;
const APP_TITLE = "NOVA Agent";
const BUILD_DATE = "2026.11.17";
const BUILD_HASH = crypto
  .createHash("sha256")
  .update(`NOVA Agent v${VERSION} · portable build ${BUILD_DATE}`)
  .digest("hex")
  .slice(0, 8);

// ── 主题：Hermes DARK_SEEDS。自绘无 ink 逗号坑，直接真彩色 ──
// ────────────────────────── 配色主题 ──────────────────────────
// 「哪种字用哪种色」只在这张表里定义，渲染代码一律走 C.xxx，不写死颜色。
//
//   bg       界面背景（TUI 自己接管，不再跟终端主题走）
//   text     AI 的正文            ← 读得最多的字
//   prompt   你打进去的字          ← 必须和 text 拉开
//   accent   工具调用名 / 小标题（"回答 ·" "思考 ·"）
//   label    次级标签、命令名
//   muted    时间戳、工具结果、思考正文、各种说明
//   fade     比 muted 再弱一档（回显里的助手文字）
//   ghost    补全里"还没打出来的那段"（要暗到像占位符）
//   border   框线（输入框、欢迎面板）
//   ok/error/warn  状态
//   primary  品牌色（版本号、忙时动画）
//   dollar   命令行 / 账户信息
//   logo     NOVA 大字纯色（2026-10-12 用户不要渐变）
const THEMES = {
  // A 曜石青 —— 冷调、对比最强，长时间看不累（默认）
  "obsidian-cyan": {
    bg: "#0A0E13",
    text: "#D7DEE6",
    prompt: "#5FD3F3",
    accent: "#7FB2D9",
    label: "#8FA3B8",
    muted: "#5A6875",
    fade: "#46525E",
    ghost: "#333D47",
    border: "#2A3642",
    ok: "#4CD98A",
    error: "#FF6B6B",
    warn: "#FFC857",
    primary: "#4FC1E9",
    dollar: "#4FC1E9",
    logo: "#5FD3F3",
  },
  // B 曜金 —— 保留 NOVA 原来那身金，只把正文从黄改成暖白（最小改动）
  "amber-gold": {
    bg: "#0B0905",
    text: "#E6E3DC",
    prompt: "#FFD166",
    accent: "#E8A33D",
    label: "#A99A7C",
    muted: "#7A7060",
    fade: "#5C544A",
    ghost: "#3E392F",
    border: "#7A5C1E",
    ok: "#66BB6A",
    error: "#EF5350",
    warn: "#FFA726",
    primary: "#FFC300",
    dollar: "#4FC1E9",
    logo: "#FFB347",
  },
  // C 墨绿终端 —— 老 CRT 那股味，输入亮绿
  "crt-green": {
    bg: "#050A06",
    text: "#B8D9BC",
    prompt: "#5FE88A",
    accent: "#3FBF6F",
    label: "#7FA88A",
    muted: "#4E6B56",
    fade: "#3A5242",
    ghost: "#2A3B2F",
    border: "#1F4A2E",
    ok: "#4CD98A",
    error: "#E05252",
    warn: "#E8C24D",
    primary: "#39FF88",
    dollar: "#39FF88",
    logo: "#39FF88",
  },
  // E 赤红 —— 最开始那版：红色描边大字 + 纯黑背景，正文纯白，点缀红色系
  "crimson": {
    bg: "#080303",
    text: "#FFFFFF",
    prompt: "#ff4e4e",
    accent: "#f43b3b",
    label: "#e08c8c",
    muted: "#C9C9C9",
    fade: "#9A9A9A",
    ghost: "#6E6E6E",
    border: "#7E7E7E",
    ok: "#3DFFA0",
    error: "#ff4d4d",
    warn: "#FFD23F",
    primary: "#ff3d3d",
    dollar: "#ff5c5c",
    logo: "#FF2D2D",
  },
  // D 霓虹赛博 —— 洋红 + 电青。正文纯白不发灰；暗紫系全部提亮，不糊字
  "neon-cyber": {
    bg: "#070510",
    text: "#FFFFFF",
    prompt: "#26E5FF",
    accent: "#FF3D9A",
    label: "#B4A9E0",
    muted: "#8E82BE",
    fade: "#675C94",
    ghost: "#484070",
    border: "#5C3C90",
    ok: "#3DFFA0",
    error: "#FF4D6D",
    warn: "#FFD23F",
    primary: "#FF2E88",
    dollar: "#26E5FF",
    logo: "#FF3D9A",
  },
};
const THEME_NAMES = Object.keys(THEMES);
const THEME_NAME = THEMES[process.env.NOVA_THEME] ? process.env.NOVA_THEME : "crimson";
const C = THEMES[THEME_NAME];
// 导出给测试与抓帧工具用（它们要按主题色精确解析选中行 / ghost 段）
export { THEMES, THEME_NAMES, THEME_NAME, C };

const BRAND = {
  name: "NOVA Agent",
  icon: "✦",
  prompt: "❯",
  welcome: "输入消息，或 /help 查看命令。",
  goodbye: "Goodbye! ✦",
  tool: "┊",
  helpHeader: "(^_^)? 命令",
};

// ✦ NOVA-AGENT 大字：figlet「ANSI Shadow」纯色亮红，中带连字符（品牌名 NOVA-AGENT）
const NOVA_LOGO_ART = [
  "███╗   ██╗ ██████╗ ██╗   ██╗ █████╗        █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
  "████╗  ██║██╔═══██╗██║   ██║██╔══██╗      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
  "██╔██╗ ██║██║   ██║██║   ██║███████║█████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
  "██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║╚════╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
  "██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
  "╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
];
const LOGO_GRADIENT = [203, 203, 196, 196, 124, 124];

const KEY_HINTS = [
  ["Tab", "补全", "把候选补进输入框（也是确认选择）"],
  ["↑/↓", "选候选", "翻输入历史（输入框有候选时改为选候选）"],
  ["Esc", "打断", "打断正在执行的任务"],
  ["Ctrl+O", "详略", "切换工具结果详略"],
  ["Ctrl+滚轮", "缩放终端", "缩放终端字号（临时让给终端；键盘等价：Ctrl+加/减号）"],
  ["Ctrl+C", "退出", "连按两次退出"],
];

// Windows 上内核禁用 bash 工具、改用系统自带的 PowerShell（见 dump-config）
const IS_WIN = process.platform === "win32";
const TOOL_GROUPS = [
  ["终端", IS_WIN ? "pwsh, job_list, job_output, job_kill（后台任务）" : "bash, job_list, job_output, job_kill（后台任务）"],
  ["文件", "read, write, edit, read_image"],
  ["搜索", "glob, grep"],
  ["网络", "web_search, web_fetch"],
  ["任务", "todo_write, create_goal, update_goal, present, ask_user_question"],
  ["扩展", "skill 技能, 子代理 send_message, 插件管理"],
];
const TOOL_COUNT = TOOL_GROUPS.reduce((n, [, t]) => n + t.split(",").length, 0);

// ---- slash commands: single source of truth for /help AND 斜杠提示 ----
const COMMANDS = [
  { name: "/help",     desc: "显示这份帮助" },
  { name: "/new",      desc: "开新会话（清空上下文）" },
  { name: "/sessions", desc: "列出历史会话" },
  { name: "/resume",   desc: "恢复会话：/resume <编号|id>" },
  { name: "/clear",    desc: "清屏（保留当前会话）" },
  { name: "/think",    desc: "显示 / 隐藏思考过程" },
  { name: "/model",    desc: "查看或切换模型：/model [名字]" },
  { name: "/persona",  desc: "查看或启用人设：/persona [名字|off]" },
  { name: "/skill",    desc: "加载技能到本轮：/skill <名字>" },
  { name: "/skills",   desc: "查看技能库（沉淀的“一类任务”做法）" },
  { name: "/status",   desc: "查询账户余额" },
  { name: "/memory",   desc: "查看长期记忆（MEMORY / USER）" },
  { name: "/exit",     desc: "退出（或连按两次 Ctrl+C）" },
];

// waiting indicator — Hermes 式：表情脸 + 转动词轮换
const KAOMOJI = ["(・ω・)", "(・∀・)", "(￣▽￣)", "(´▽｀)", "(＾▽＾)", "(*´ω｀*)", "(￣ω￣)", "(´∀｀)"];
const VERBS = [
  "思考中", "沉思中", "推敲中", "琢磨中", "盘算中", "推演中", "酝酿中", "推理中",
  "分析中", "演算中", "综合中", "构思中", "斟酌中", "回味中", "灵光乍现中",
];

// ────────────────────────── ANSI 小工具 ──────────────────────────
function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const R = "\x1b[0m"; // 彻底复位（退出/收尾用）
// ⚠️ 上色一律用"精准复位"而不是 \x1b[0m：
// 0m 会把背景色也一起冲掉，导致每段文字中间背景断掉、行尾的 \x1b[K
// 只能填出一小截底色。分别复位前景/粗体/斜体/反色，背景才能从头铺到尾。
const RGB = (hex) => {
  const [r, g, b] = hexRgb(hex);
  return `38;2;${r};${g};${b}`;
};
const BGRGB = (hex) => {
  const [r, g, b] = hexRgb(hex);
  return `48;2;${r};${g};${b}`;
};
function fg(hex, s, mods = "") {
  return `\x1b[${mods ? mods + ";" : ""}${RGB(hex)}m${s}${mods ? "\x1b[22m\x1b[23m" : ""}\x1b[39m`;
}
const bold = (s) => `\x1b[1m${s}\x1b[22m`;
const italic = (s) => `\x1b[3m${s}\x1b[23m`;
const inv = (s) => `\x1b[7m${s}\x1b[27m`;
// 界面底色：TUI 自己画，不让终端主题透进来
const BG = `\x1b[${BGRGB(C.bg)}m`;
// 候选选中行：整行铺 brand 底 + 底色字（显式配色，比 7m 反色可控）
function selRow(hex, s, width) {
  return `\x1b[${BGRGB(hex)}m\x1b[${RGB(C.bg)}m${padVis(truncVis(s, width), width)}\x1b[39m\x1b[49m`;
}
const visWidth = (s) => stringWidth(stripAnsi(s));

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}
function fmtTokens(n) {
  if (!n && n !== 0) return "";
  if (n >= 1e6) return (n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1) + "M";
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}
function fmtSecs(ms) {
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + "s";
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}
function truncateOne(s, n) {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
// ANSI 感知的按显示宽度截断（状态栏用）
function truncVis(s, w) {
  if (visWidth(s) <= w) return s;
  let out = "", wsum = 0, i = 0;
  while (i < s.length && wsum < w - 1) {
    const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i));
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const ch = [...s.slice(i)][0];
    out += ch;
    wsum += stringWidth(ch);
    i += ch.length;
  }
  return out + "…";
}
function padVis(s, w) {
  const pad = Math.max(0, w - visWidth(s));
  return s + " ".repeat(pad);
}

// 先截断到 w 宽、再补空格到恰好 w 宽（配对边框对齐用）
function fitVis(s, w) {
  return padVis(truncVis(s, w), w);
}

// ---- 技能库 ----
// 内核（@deepseek-ai/dsh-skill-filesystem）只认这几个**平铺**技能根：
//   <workspace>/.dsh/skills、<workspace>/.agents/skills、<DSH_HOME>/skills、~/.agents/skills
// 我们用 U 盘自带的 data/skills 作为主库（跟着 U 盘走，换机器也在），
// workspace/skills 作为兼容的第二处，界面把两处合并显示。
const SKILL_ROOTS = [path.join(DSH_HOME, "skills"), path.join(WORKSPACE, "skills")];

// description 可能是单行，也可能是 YAML 折叠块（> / |），后者要往下收集缩进行。
function parseSkillDesc(text) {
  const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return "";
  const body = fm[1];
  const m = /^description\s*:\s*(.*)$/m.exec(body);
  if (!m) return "";
  const v = m[1].trim();
  if (/^[>|][-+]?$/.test(v)) {
    const rest = body.slice(m.index + m[0].length).split(/\r?\n/);
    const lines = [];
    for (const line of rest) {
      if (line.trim() === "") { lines.push(""); continue; }
      if (/^[ \t]/.test(line)) lines.push(line.trim());
      else break;
    }
    return lines.filter(Boolean).join(" ");
  }
  return v.replace(/^["']|["']$/g, "");
}

// ⚠️ 技能库与模型目录都会在「参数位补全」里按帧调用（打 /skill x 时每渲染一帧问一次），
// 而 loadSkills 要读 166 个 SKILL.md —— 不缓存的话打字会卡。进程内缓存足够
// （技能只在同步脚本重跑时变，那是离线动作）。
let SKILLS_CACHE = null;

function loadSkills() {
  if (SKILLS_CACHE) return SKILLS_CACHE;
  const seen = new Set();
  const out = [];
  for (const dir of SKILL_ROOTS) {
    let names = [];
    try {
      names = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      let desc = "";
      try {
        desc = parseSkillDesc(fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8"));
      } catch {}
      out.push({ name, desc, dir });
    }
  }
  SKILLS_CACHE = out;
  return out;
}

// ---- 模型目录（/model）----
// 官方两个（dsh-llm-deepseek 的 DEFAULT_MODELS）+ profile 里 llm-pi-ai 声明的路由。
// profile patch 里有 !!js 标签，js-yaml 默认会抛错，所以挂一个宽松的 tag 处理器。
let MODEL_CATALOG_CACHE = null;

function loadModelCatalog() {
  if (MODEL_CATALOG_CACHE) return MODEL_CATALOG_CACHE;
  const out = [
    { provider: DEFAULT_PROVIDER, model: "deepseek-flash", label: "DeepSeek-V41-Flash", note: "官方 · 默认" },
    { provider: DEFAULT_PROVIDER, model: "deepseek-v4-pro", label: "DeepSeek-V4-Pro", note: "官方 · 推理更强" },
  ];
  let doc = null;
  try {
    const S = yaml.DEFAULT_SCHEMA.extend([
      new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (d) => String(d) }),
      new yaml.Type("tag:yaml.org,2002:js", { kind: "sequence", construct: (d) => d }),
      new yaml.Type("tag:yaml.org,2002:js", { kind: "mapping", construct: (d) => d }),
    ]);
    doc = yaml.load(fs.readFileSync(PROFILE_PATCH, "utf8"), { schema: S });
  } catch {
    doc = null;
  }
  if (Array.isArray(doc)) {
    for (const row of doc) {
      if (!row || row.id !== "llm-pi-ai") continue;
      const provs = row.config?.providers || {};
      for (const [pid, p] of Object.entries(provs || {})) {
        if (!p || typeof p !== "object") continue;
        const env = p.apiKeyEnv;
        const hasKey = !env || !!process.env[env];
        for (const m of p.models || []) {
          out.push({
            provider: pid,
            model: m.id,
            label: m.name || m.id,
            note: `${p.displayName || pid}${hasKey ? "" : " · 缺 key"}`,
          });
        }
      }
    }
  }
  MODEL_CATALOG_CACHE = out;
  return out;
}

// /model 写这里，spawn 时用 --patch 叠加到 profile 之上
function readModelOverride() {
  try {
    const t = fs.readFileSync(MODEL_OVERRIDE, "utf8");
    const provider = /^\s*provider:\s*(\S+)/m.exec(t)?.[1];
    const model = /^\s*model:\s*(\S+)/m.exec(t)?.[1];
    if (provider && model) return { provider, model };
  } catch {}
  return null;
}

function writeModelOverride(provider, model) {
  const body = [
    "# 由界面 /model 写入 —— 当前选定的模型。",
    "# 这是叠加在 profile 之上的补丁；删掉本文件即回到 profile 默认（deepseek-flash）。",
    "- id: agent-default-model",
    "  name: '@deepseek-ai/dsh-agent-default-model'",
    "  config:",
    `    provider: ${provider}`,
    `    model: ${model}`,
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(MODEL_OVERRIDE), { recursive: true });
  fs.writeFileSync(MODEL_OVERRIDE, body, "utf8");
}

function clearModelOverride() {
  try {
    fs.unlinkSync(MODEL_OVERRIDE);
  } catch {}
}

// ---- 人设（/persona）----
// 内核 @deepseek-ai/dsh-system-prompt 的 personaPrefix / personaSuffix 就是人设注入口。
// 我们把它当成一条 --patch 补丁叠在 profile 之上 —— 与 /model 走完全相同的通道，
// 所以「改人设」不需要动 profile，也不影响内核的其他配置。
// ⚠️ 补丁是「整体替换」目标条目的 config：personaSuffix 必须重写一遍，否则 cwd 提示会丢。
const PERSONA_SUFFIX = "Your working directory is {{cwd}}.";

function listPersonas() {
  try {
    return fs
      .readdirSync(PERSONA_DIR)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => f.replace(/\.md$/i, ""))
      .sort();
  } catch {
    return [];
  }
}

function readPersonaBody(name) {
  try {
    return fs.readFileSync(path.join(PERSONA_DIR, `${name}.md`), "utf8");
  } catch {
    return null;
  }
}

// 一句话说明：取正文里第一个既不是标题也不是列表/表格/引用的非空行
function personaHint(name) {
  const body = readPersonaBody(name);
  if (!body) return "";
  for (const l of body.split(/\r?\n/)) {
    const s = l.trim();
    if (!s || /^[#>|\-*`]/.test(s)) continue;
    return truncateOne(s, 54);
  }
  return "";
}

// 当前生效的人设名（从补丁文件头部注释里读回来）；文件不存在 = 没启用人设
function readPersonaOverride() {
  try {
    const m = /^#\s*persona:\s*(\S+)/m.exec(fs.readFileSync(PERSONA_OVERRIDE, "utf8"));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function writePersonaOverride(name) {
  const body = readPersonaBody(name);
  if (!body) return false;
  // YAML 块标量 |- ：原样保留正文（含 # 开头、空行）。
  // ⚠️ 缩进必须是 6 空格 —— personaPrefix 这个键本身在 4 空格，
  //    块内容必须比它更深；写成 4 会让下面的 personaSuffix 也被吞进正文里。
  const block = body
    .replace(/\r\n/g, "\n")
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => (l === "" ? "" : "      " + l))
    .join("\n");
  const out = [
    `# persona: ${name}`,
    "# 由界面 /persona 写入 —— 叠加在 profile 之上的补丁（删掉本文件即回到默认部署人设）。",
    "# 机制：改 dsh-system-prompt 的 personaPrefix；personaSuffix 因「整体替换」必须重写。",
    "# 人设正文来自 data/personas/" + name + ".md，改那个文件后重新 /persona 一次即可。",
    "- id: system-prompt",
    "  name: '@deepseek-ai/dsh-system-prompt'",
    "  config:",
    "    personaPrefix: |-",
    block,
    `    personaSuffix: ${JSON.stringify(PERSONA_SUFFIX)}`,
    "",
  ].join("\n");
  fs.mkdirSync(path.dirname(PERSONA_OVERRIDE), { recursive: true });
  fs.writeFileSync(PERSONA_OVERRIDE, out, "utf8");
  return true;
}

function clearPersonaOverride() {
  try {
    fs.unlinkSync(PERSONA_OVERRIDE);
  } catch {}
}

function setWinTitle(t) {
  try {
    process.stdout.write(`\x1b]0;${t}\x07`);
  } catch {}
}
function bell() {
  try {
    process.stdout.write("\x07");
  } catch {}
}

// ────────────────────────── runner: spawn dsh headless --json ──────────────────────────
// ── 内核启动参数 ──────────────────────────────────────────────
// --patch 是 launcher 层参数，必须排在 app 参数（--json / --session-id / task）之前
function kernelArgs(sessionId, opts, taskOrDash) {
  const args = [DSH_BIN, "--profile", "headless"];
  if (opts.modelPatch && fs.existsSync(opts.modelPatch)) args.push("--patch", opts.modelPatch);
  if (opts.personaPatch && fs.existsSync(opts.personaPatch)) args.push("--patch", opts.personaPatch);
  args.push("--json");
  if (sessionId) args.push("--session-id", sessionId);
  args.push(taskOrDash);
  return args;
}

// 挂输出管线（NDJSON 逐行 → onEvent），返回「进程退出」的 Promise
function wireChild(child, onEvent, pending = [], pendingErr = []) {
  let buf = "";
  const feed = (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        onEvent(JSON.parse(line));
      } catch {
        /* non-JSON line, ignore */
      }
    }
  };
  const feedErr = (d) => {
    const t = d.toString().trim();
    if (t) onEvent({ type: "diag", text: t.split("\n")[0] });
  };
  child.stdout.removeAllListeners("data");
  child.stderr.removeAllListeners("data");
  child.stdout.on("data", feed);
  child.stderr.on("data", feedErr);
  pending.forEach(feed); // 待命期间若有缓冲输出，先补喂
  pendingErr.forEach(feedErr);
  return new Promise((resolve) => {
    child.removeAllListeners("error");
    child.removeAllListeners("close");
    child.on("error", (e) => {
      onEvent({ type: "diag", text: `spawn error: ${e.message}` });
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

// ── 内核预热池 ────────────────────────────────────────────────
// headless 内核是「一次性」进程，冷启 ≈ 2.2s（node 冷启 + profile 合成 + app 初始化），
// 实测 0→2.2s 全程无输出。用户敲回车才 spawn 的话这 2.2s 就是纯等待。
// 所以：空闲时先把内核起好待命（任务用 `-` 从 stdin 读 → 启动完即阻塞等输入），
// 发消息时把任务写进它的 stdin，起步延迟 ≈ 0（实测 20ms 出 session 事件）。
let WARM = null;

// 预热键：会话 + 两个 patch 文件的「内容指纹」。
// 注意必须带 mtime —— /model、/persona 是改写同名文件，只比路径会复用到配置过期的内核。
function warmKey(sessionId, opts) {
  const stamp = (p) => {
    if (!p) return "";
    try {
      return fs.existsSync(p) ? String(fs.statSync(p).mtimeMs) : "";
    } catch {
      return "";
    }
  };
  return [sessionId || "", stamp(opts.modelPatch), stamp(opts.personaPatch)].join("|");
}

function killWarm() {
  const rec = WARM;
  WARM = null;
  if (!rec) return;
  if (rec.idleTimer) clearTimeout(rec.idleTimer);
  try {
    rec.child.stdin.end();
  } catch {}
  killTree(rec.child.pid);
}

function prewarm(sessionId, opts = {}) {
  const key = warmKey(sessionId, opts);
  if (WARM && WARM.key === key && WARM.alive) return; // 已有同配置的待命内核
  killWarm();
  let child;
  try {
    child = spawn(NODE_EXE, kernelArgs(sessionId, opts, "-"), {
      cwd: WORKSPACE,
      env: { ...process.env, DSH_HOME },
      windowsHide: true,
    });
  } catch {
    return;
  }
  const rec = { child, key, alive: true, pending: [], pendingErr: [], idleTimer: null };
  // 待命期只缓冲输出（正常为空），喂任务改由 wireChild 接管
  child.stdout.on("data", (d) => rec.pending.push(d));
  child.stderr.on("data", (d) => rec.pendingErr.push(d));
  child.on("error", () => {
    rec.alive = false;
    if (WARM === rec) WARM = null;
  });
  child.on("close", () => {
    rec.alive = false;
    if (WARM === rec) WARM = null;
  });
  // 闲置回收：15 分钟没用上就放掉（省内存）；下次打字会按需重建
  rec.idleTimer = setTimeout(() => {
    if (WARM === rec) killWarm();
  }, 15 * 60 * 1000);
  rec.idleTimer.unref?.();
  WARM = rec;
}

function runTask(task, sessionId, onEvent, onChild, opts = {}) {
  // ① 预热路径：待命内核已起好，直接喂任务（省掉 ~2.2s 冷启动）
  if (WARM && WARM.alive && WARM.key === warmKey(sessionId, opts)) {
    const rec = WARM;
    WARM = null;
    if (rec.idleTimer) clearTimeout(rec.idleTimer);
    try {
      rec.child.stdin.write(task + "\n");
      rec.child.stdin.end();
      if (onChild) onChild(rec.child);
      return wireChild(rec.child, onEvent, rec.pending, rec.pendingErr);
    } catch {
      killTree(rec.child.pid); // 写不进去 → 退回冷启
    }
  }
  // ② 冷启路径
  return new Promise((resolve) => {
    const child = spawn(NODE_EXE, kernelArgs(sessionId, opts, task), {
      cwd: WORKSPACE,
      env: { ...process.env, DSH_HOME },
      windowsHide: true,
    });
    if (onChild) onChild(child);
    wireChild(child, onEvent).then(resolve);
  });
}

function killTree(pid) {
  try {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {}
}

// ---- /status: DeepSeek balance ----
async function queryBalance() {
  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY || ""}` },
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    if (j.balance_infos && j.balance_infos.length) {
      const b = j.balance_infos[0];
      return `  余额：${b.total_balance} ${b.currency}（DeepSeek 官方账户）`;
    }
    return `  余额查询异常：${JSON.stringify(j).slice(0, 100)}`;
  } catch (e) {
    return `  余额查询出错：${e.message}`;
  }
}

// ────────────────────────── 会话转写行（transcript）──────────────────────────
// transcript = ANSI 字符串数组（每元素一行，已按当前列宽预折行）。

// 多行 body：首行带 prefix，后续行带同样缩进
function bodyLines(prefix, body) {
  const raw = String(body).replace(/\r/g, "").split("\n");
  const out = [];
  raw.forEach((l, i) => out.push(i === 0 ? prefix + l : " ".repeat(visWidth(stripAnsi(prefix))) + l));
  return out;
}

// ────────────────────────── 主程序 ──────────────────────────
export function start({ stdin, stdout, rows, cols }) {
  const S = {
    rows: rows || stdout.rows || 30,
    cols: cols || stdout.columns || 100,
    transcript: [], // ANSI 行
    wrapCache: [], // 与 transcript 平行：折行后的显示行
    input: "",
    hist: [],
    histPos: -1,
    draft: "",
    busy: false,
    statusText: "",
    statusToast: "",
    sessionId: null,
    usage: null,
    model: DEFAULT_MODEL,
    provider: DEFAULT_PROVIDER,
    persona: null, // 当前启用的人设名（/persona），null = 默认部署人设
    pendingSkill: null, // /skill 加载的技能：下一条消息带上，随后清空
    thinkOn: true,
    verbose: false,
    queue: [],
    scroll: 0, // 0 = 跟随底部；>0 = 距底行数（滚轮翻历史）
    zoom: false, // true = Ctrl+滚轮缩放放行中（鼠标上报已临时关闭）
    mouseOn: true, // 滚轮上报（?1000h?1006h）当前是否开着
    hintSel: -1, // 斜杠提示选中项
    frame: 0, // 表情脸/动词轮换
    elapsed: 0,
    lastMs: 0,
    sessionStart: Date.now(),
    lastEnd: 0,
    exitAttempt: 0,
    dirty: true,
    live: true,
    child: null,
    interrupted: false,
    textRun: false,
    now: Date.now(),
  };
  let idCounter = 0;

  // 启动时恢复上次用 /model 选的模型（写在 model-override.yml 里）
  {
    const ov = readModelOverride();
    if (ov) {
      S.model = ov.model;
      S.provider = ov.provider;
    }
  }
  // 同理恢复上次 /persona 启用的人设（写在 persona-override.yml 里）
  // 补丁在、但记的人设名读不出来 → 报「?」，比假装没启用诚实
  S.persona = fs.existsSync(PERSONA_OVERRIDE) ? readPersonaOverride() || "?" : null;

  // ---- transcript push：自动折行 + 缓存 ----
  function pushRaw(line) {
    S.transcript.push(line);
    rewrap(S.transcript.length - 1);
  }
  function rewrap(i) {
    const cols = Math.max(20, S.cols);
    const src = S.transcript[i];
    const pieces = src.split("\n");
    const out = [];
    for (const p of pieces) {
      if (!p) {
        out.push("");
        continue;
      }
      const wrapped = wrapAnsi(p, cols, { hard: true, trim: false });
      for (const w of wrapped.split("\n")) out.push(w);
    }
    S.wrapCache[i] = out;
  }
  function rewrapAll() {
    for (let i = 0; i < S.transcript.length; i++) rewrap(i);
    S.scroll = 0; // 列宽变了，视口重置到跟随底部
  }
  // ---- 欢迎屏（Hermes SessionPanel 制式，整屏自绘版）----
  // 年兽像素标志（2026-11-17 定稿，32×32，assets/icon.svg 同源）。
  // 终端用半格渲染：每行 "▀" 上半块=前景色(上像素)、背景色=下像素，
  // 32×32 地图 → 16 行 × 32 列；24×24 降档 → 12 行（矮终端用）。
  // '.' = 界面底色 C.bg；配色与 ICO 完全一致（含暗金角 G 与亮黄毛球 Y 的区分）。
  const NIAN_PAL = {
    Y: "#FFC53D", C: "#2BD9C8", R: "#E23A3A", F: "#FF4646",
    S: "#FFE8D9", I: "#14100F", W: "#FFFFFF", B: "#FF8A80",
    G: "#E8A33D", g: "#FFC53D",
  };
  const NIAN32 = [
    "................................",
    "........GG............GG........",
    ".......GGG......Y.....GGG.......",
    "......GGG....Y.YY.Y....GGG......",
    ".....GGGG...Y.YYYY.....GGGG.....",
    "....GGGGR....YYYYYY....CGGGG....",
    "....GGGGRRRR.YYYYYY.CCCCGGGG....",
    ".....GGGRRR...YYYY.CCCCCGGG.....",
    ".....GGGGRRRR.IGGIYCCCCGGGG.....",
    ".....GGGGGRIIIGggGIIICGGGGG.....",
    "......GGGGIFFGggggGFFIGGGG......",
    ".....CGGGIFFFGggggGFFFIGGGRR....",
    "..CCCC..IFFFFFGggGFFFFFIR.RR....",
    "...CCCCCIFWWWFFFFFFWWWFIRRRRRR..",
    "..CCCCCIFWWWWWFFFFWWWWWFIRRRRR..",
    "..CCCCCIFWIIWWFFFFWWIIWFIRRRRRR.",
    "...CCCCIFWIWIWFFFFWIWIWFIRRRR...",
    "..C.CCCIFWIIWWFFFFWWIIWFIRRRR...",
    "....C.CIFFWWWFSSSSFWWWFFI..RR...",
    ".....YYIFFFFSSSIISSSFFFFIY......",
    ".....YYYIBBSSSSIISSSSBBIYYYY....",
    "...YYYYYIBBSSSSSSSSSSBBIYYYY....",
    "....YYYYYIFFSSSSSSSSFFIYYYYY....",
    "...YYYYYYYIIFSWIIWSFII.YYYYY....",
    "....YYYY..RIIIWFFWIIICCYYYY.....",
    ".....Y.YY.RRRRIIIICCCCCYY.YY....",
    "........RRRRRRRR.CCCCCCC........",
    "..........RRRRRRCCCCCC.C........",
    "..........RRRRRR.CCCCC..........",
    "...........RRR....CCC.C.........",
    "..........R.R.......C...........",
    "................................",
  ];
  const NIAN24 = [
    "........................",
    "......G..........G......",
    ".....GG....YYY...GG.....",
    "....GG...YYYYY....GG....",
    "...GGGR.RYYYYYYCCCGGG...",
    "...GGGRRR.YYYYCCCCGGG...",
    "....GGGRRRIGGICCCGGG....",
    "....GGGRIFGggGFICGGG....",
    "...CCGGIFFGggGFFIGGR....",
    "..CCCCIFFFFGGFFFFI.RRR..",
    ".CCCCCFWWWFFFFWWWFRRRR..",
    "..CCCIFIIWWFFWWIIFIRRRR.",
    "..CCCIFIWIWFFWIWIFIRRRR.",
    ".....IFWIWFFFFWIWFIR.R..",
    "...YYIFFFSSIISSFFFI.Y...",
    "..YYYYIBSSSIISSSBIYYY...",
    "...YYYIBSSSSSSSSBIYYYY..",
    "..YYYYYIFSIWWISFIYYYYY..",
    "....YYY.RIIFFIICC.YYY...",
    ".....YRRRRRRCCCCCCY.....",
    "......RRRRRR.CCCC.......",
    ".......RRRR.CCCCC.......",
    "........RRR..CCCC.......",
    "........................",
  ];
  const bg = (hex, s) => `\x1b[${BGRGB(hex)}m${s}\x1b[49m`;
  // 逐行合并同色段输出；整格同色用空格铺底，异色用 ▀ 上半块
  const nianLogoRows = (map) => {
    const W = map[0].length;
    const col = (row, x) => NIAN_PAL[row[x]] || C.bg;
    const rows = [];
    for (let y = 0; y + 1 < map.length; y += 2) {
      const top = map[y], bot = map[y + 1];
      let out = "", i = 0;
      while (i < W) {
        const t = col(top, i), b = col(bot, i);
        let j = i;
        while (j < W && col(top, j) === t && col(bot, j) === b) j++;
        out += t === b ? bg(t, " ".repeat(j - i)) : bg(b, fg(t, "▀".repeat(j - i), "1"));
        i = j;
      }
      rows.push(out);
    }
    return rows;
  };
  function pushWelcome() {
    const padL = Math.max(0, Math.floor((S.cols - 86) / 2));
    for (let y = 0; y < NOVA_LOGO_ART.length; y++) {
      pushRaw(" ".repeat(padL) + fg(C.logo, NOVA_LOGO_ART[y], "1")); // 纯色大字（亮红）+ 粗体：部分终端非粗体前景色渲染发暗
    }
    const ver = `NOVA Agent v${VERSION} (${BUILD_DATE}) · stable`;
    const verPad = Math.max(0, Math.floor((S.cols - (ver.length + 10)) / 2));
    pushRaw(" ".repeat(verPad) + bold(fg(C.primary, ver)) + fg(C.muted, ` · local ${BUILD_HASH}`));
    pushRaw("");

    // 面板：圆角框 + 左右两栏（窄终端退化为单栏）
    const boxW = Math.min(S.cols, 104);
    const innerW = boxW - 2; // 左右边框
    const leftW = Math.min(34, Math.floor(innerW * 0.34));
    const rightW = innerW - 4 - leftW; // 两侧 padding 各1
    const twoCol = rightW >= 24;
    // 右栏（工具+技能列表 ≈17 行）恒高于左栏，面板总高由右栏决定 ——
    // 因此 ≥30 行即可安全画 10 行标志（面板不会因此变高）；42 行以上额外留白更透气。
    // 年兽标志两档：≥40 行画满 32×32（16 行），≥30 行画 24×24（12 行），更矮留白。
    // 档位行数都含左栏 4 行信息，不会把面板撑得比右栏高太多。
    const heroRows = S.rows >= 40 ? 16 : S.rows >= 30 ? 12 : 2;

    const left = [];
    const logoArt = heroRows >= 16 ? nianLogoRows(NIAN32) : heroRows >= 12 ? nianLogoRows(NIAN24) : null; // 矮终端不画标志，只留白
    if (logoArt) {
      const mapW = heroRows >= 16 ? 32 : 24;
      const pad = Math.max(0, Math.floor((leftW - mapW) / 2));
      for (const r of logoArt) left.push(" ".repeat(pad) + r);
    } else {
      for (let i = 0; i < heroRows; i++) left.push(""); // logo 预留位
    }
    left.push(fg(C.accent, S.model) + fg(C.muted, ` · ${S.provider === DEFAULT_PROVIDER ? "DeepSeek" : S.provider}`));
    left.push(fg(C.muted, truncVis(WORKSPACE, leftW - 2)));
    left.push(fg(C.label, "Session: ") + fg(C.fade, S.sessionId ? String(S.sessionId).replace("session-", "").slice(0, 8) + "（/sessions 切换）" : "新会话（发第一条消息）"));
    left.push(fg(C.label, "Persona: ") + fg(S.persona ? C.ok : C.fade, S.persona || "默认（/persona 启用）"));

    const skills = loadSkills();
    const right = [];
    right.push(bold(fg(C.accent, "可用工具")));
    for (const [g, t] of TOOL_GROUPS) right.push(fg(C.label, `${g}: `) + fg(C.fade, truncVis(t, rightW - visWidth(g) - 2)));
    right.push("");
    right.push(bold(fg(C.accent, "可用技能")));
    if (skills.length === 0) {
      right.push(fg(C.muted, "（空 —— 说「把这件事沉淀成技能」即可新建）"));
    } else {
      for (const sk of skills.slice(0, 5)) right.push(fg(C.label, sk.name + ": ") + fg(C.fade, truncVis(sk.desc || "（无描述）", rightW - visWidth(sk.name) - 4)));
      if (skills.length > 5) right.push(fg(C.muted, `(还有 ${skills.length - 5} 个技能…)`));
    }
    right.push("");
    right.push(fg(C.text, `${TOOL_COUNT} 个工具 · ${skills.length} 个技能 · `) + fg(C.muted, "/help 查看命令"));

    const rowsN = twoCol ? Math.max(left.length, right.length) : left.length + right.length;
    const body = [];
    for (let i = 0; i < rowsN; i++) {
      if (!twoCol) {
        const l = left[i];
        const r = right[i - left.length];
        body.push(fitVis(" " + (l !== undefined ? l : r || "") + " ", innerW));
        continue;
      }
      const l = fitVis(left[i] || "", leftW);
      const r = fitVis(right[i] || "", rightW);
      body.push(fitVis(" " + l + "  " + r + " ", innerW));
    }
    pushRaw(fg(C.accent, "╭" + "─".repeat(boxW - 2) + "╮"));
    for (const b of body) pushRaw(fg(C.accent, "│") + b + fg(C.accent, "│"));
    pushRaw(fg(C.accent, "╰" + "─".repeat(boxW - 2) + "╯"));
    pushRaw("");
    pushRaw("  " + fg(C.muted, `${BRAND.icon} ${BRAND.welcome}`));
    pushRaw(
      "  " +
        fg(C.muted, "✦ 提示：") +
        KEY_HINTS.map(([k, d], i) => (i > 0 ? fg(C.muted, " · ") : "") + fg(C.label, k) + fg(C.muted, " " + d)).join(""),
    );
    pushRaw(" ");
  }

  // ────────────────────── 补全引擎（Minecraft 式） ──────────────────────
  // 手感对齐《我的世界》聊天栏打指令：
  //   ① 打一个字符，输入框里立刻浮出暗灰的「补全剩余」（ghost，行内）；
  //   ② 下方候选表实时过滤，↑↓ 移动高亮（↑ 从末项进、↓ 从首项进，两端对称）；
  //   ③ Tab / → 把当前候选补进输入框（确认选择），Enter 才真正执行 —— 不用背命令；
  //   ④ 打空格进入「参数位」后，继续补这条命令的合法取值（模型 / 技能 / 会话）。
  // items 统一成 { value, name, desc }，value 是最终补进输入框的文本。
  const EMPTY_COMP = { mode: null, cmd: null, items: [], partial: "" };
  let sessionItemsCache = null; // /resume 候选：缓存 30 秒，避免每帧扫盘
  let sessionItemsAt = 0;

  function sessionItems() {
    const now = Date.now();
    if (sessionItemsCache && now - sessionItemsAt < 30000) return sessionItemsCache;
    try {
      const rows = recentSessions(30);
      sessionItemsCache = rows.map((r, i) => ({
        value: String(i + 1),
        name: String(i + 1),
        desc: `${sessionLabel(r)} · ${r.turns || 0} 轮`,
      }));
    } catch {
      sessionItemsCache = [];
    }
    sessionItemsAt = now;
    return sessionItemsCache;
  }

  // 参数位取值表：命令 → 候选生成器。没列出的命令不收参数。
  const ARG_SOURCES = {
    "/model": () => [
      ...loadModelCatalog().map((m) => ({ value: m.model, name: m.model, desc: `${m.label} · ${m.note}` })),
      { value: "default", name: "default", desc: "回到默认模型 deepseek-flash" },
    ],
    "/skill": () => loadSkills().map((s) => ({ value: s.name, name: s.name, desc: s.desc })),
    "/persona": () => [
      ...listPersonas().map((p) => ({ value: p, name: p, desc: personaHint(p) })),
      { value: "off", name: "off", desc: "关闭人设，回到默认部署人设" },
    ],
    "/resume": () => sessionItems(),
  };

  function completion() {
    const t = S.input;
    if (!t.startsWith("/")) return EMPTY_COMP;
    const sp = t.indexOf(" ");
    if (sp === -1) {
      const items = COMMANDS.filter((c) => c.name.startsWith(t)).map((c) => ({ value: c.name, name: c.name, desc: c.desc }));
      return { mode: "cmd", cmd: null, items, partial: t };
    }
    const cmd = t.slice(0, sp);
    const src = ARG_SOURCES[cmd];
    if (!src) return EMPTY_COMP;
    const arg = t.slice(sp + 1);
    if (arg.includes(" ")) return EMPTY_COMP; // 只补第一个参数
    const lw = arg.toLowerCase();
    const items = src().filter((i) => i.value.toLowerCase().startsWith(lw));
    return { mode: "arg", cmd, items, partial: arg };
  }

  // ↑↓ 该不该被候选接管？输入已经打全某条命令时没有可补的，
  // 就把 ↑↓ 还给「翻输入历史」（例如打完 /status 想翻上一条）。
  function navItems() {
    const c = completion();
    if (c.mode === "cmd" && c.items.length === 1 && c.items[0].name === S.input) return [];
    return c.items;
  }

  // 行内 ghost：显示「当前候选比已输入多出来的那一段」。
  // 用 ↑↓ 选过就以选中项为准，否则用首个匹配（= Minecraft 的默认建议）。
  function ghostOf(comp) {
    if (!comp.items.length) return "";
    const pick = S.hintSel >= 0 && comp.items[S.hintSel] ? comp.items[S.hintSel] : comp.items[0];
    if (!pick) return "";
    const p = comp.partial || "";
    const full = comp.mode === "cmd" ? pick.name : pick.value;
    if (!full || full.length <= p.length) return "";
    if (!full.toLowerCase().startsWith(p.toLowerCase())) return "";
    return full.slice(p.length);
  }

  // ────────────────────── 渲染 ──────────────────────
  let renderTimer = null;
  function scheduleRender() {
    S.dirty = true;
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      if (S.dirty && S.live) {
        S.dirty = false;
        render();
      }
    }, 16);
  }

  function render() {
    const rows = S.rows,
      cols = S.cols;
    const comp = completion();
    const items = comp.items;
    if (S.hintSel >= items.length) S.hintSel = items.length ? items.length - 1 : -1;
    if (!items.length) S.hintSel = -1;
    // 候选最多 12 行；终端矮时按高度压，给历史区留位置。
    const HINT_MAX = Math.max(4, Math.min(12, rows - 14));
    // 候选多于一屏（技能库 166 个）时围绕选中项开窗，别把屏幕撑爆。
    const focus = S.hintSel < 0 ? 0 : S.hintSel;
    const hintStart =
      items.length > HINT_MAX ? Math.max(0, Math.min(items.length - HINT_MAX, focus - Math.floor(HINT_MAX / 2))) : 0;
    const hintRows = items.length ? Math.min(items.length, HINT_MAX) : 0;
    const moreUp = hintStart;
    const moreDown = Math.max(0, items.length - hintStart - hintRows);
    const moreRow = moreUp > 0 || moreDown > 0;

    const bottomRows = 3 + 1 + hintRows + (moreRow ? 1 : 0); // 输入框 + 状态栏 + 提示列表
    const viewH = Math.max(1, rows - 1 - bottomRows); // 留最后一行空白，绝不写满

    // 显示行总数（折行后）
    const totalDisp = S.wrapCache.reduce((n, w) => n + (w ? w.length : 0), 0);
    const maxScroll = Math.max(0, totalDisp - viewH);
    if (S.scroll > maxScroll) S.scroll = maxScroll;

    // 从尾部取 viewH 个显示行，但跳过最近的 scroll 行（滚轮翻历史）
    let skip = S.scroll;
    const vis = [];
    for (let i = S.wrapCache.length - 1; i >= 0 && vis.length < viewH; i--) {
      const w = S.wrapCache[i] || [];
      for (let j = w.length - 1; j >= 0 && vis.length < viewH; j--) {
        if (skip > 0) {
          skip--;
          continue;
        }
        vis.push(w[j]);
      }
    }
    vis.reverse();
    const shown = vis;
    // 顶部留白（内容不足一屏时）
    const topPad = viewH - shown.length;

    const lines = [];
    for (let i = 0; i < topPad; i++) lines.push("");
    lines.push(...shown);

    // 候选列表（选中项高亮）。必须**正序**推入：lines 自上而下排，先 push 的在上；
    // 序号越大越靠下，与 ↑↓ 的视觉方向一致，上下才不颠倒。
    // 名字列宽按本批候选自适应（命令 9 列就够，模型/技能名要留 20 列左右）。
    let nameW = 8;
    for (const it of items) nameW = Math.max(nameW, visWidth(it.name));
    nameW = Math.min(nameW, 22);
    for (let i = 0; i < hintRows; i++) {
      const idx = hintStart + i;
      const m = items[idx];
      const sel = idx === S.hintSel;
      const label = `  ${padVis(truncVis(m.name, nameW), nameW)} `;
      const desc = m.desc || "";
      lines.push(
        sel
          ? selRow(C.primary, label + desc, cols - 2)
          : fg(C.label, truncVis(label, cols - 2)) + fg(C.muted, truncVis(desc, cols - visWidth(label) - 2)),
      );
    }
    if (moreRow) {
      const bits = [];
      if (moreUp > 0) bits.push(`↑ 上方 ${moreUp} 项`);
      if (moreDown > 0) bits.push(`↓ 下方 ${moreDown} 项`);
      lines.push(fg(C.muted, `  ⋯ ${bits.join(" · ")}（共 ${items.length} 项 · Tab 补全）`));
    }

    // 输入框（圆角单行框）：已输入（亮） + 补全剩余（暗灰 ghost） + 光标块
    const innerRaw = ` ${BRAND.prompt} ${S.input}`;
    const ghost = ghostOf(comp);
    const ghostShown = ghost ? truncVis(ghost, Math.max(0, cols - 6 - visWidth(innerRaw) - 1)) : "";
    const innerW = visWidth(innerRaw) + visWidth(ghostShown) + 1;
    // 输入内容纯白（用户自己的字）；提示符与光标块用灰（用户指定），边框用 label 浅红
    const inner =
      fg(C.fade, ` ${BRAND.prompt} `, "1") +
      (S.input ? fg(C.text, S.input, "1") : "") +
      (ghostShown ? fg(C.ghost, ghostShown) : "") +
      fg(C.fade, "▌", "1");
    lines.push(fg(C.accent, "╭" + "─".repeat(Math.max(3, cols - 4)) + "╮"));
    lines.push(fg(C.accent, "│") + inner + " ".repeat(Math.max(0, cols - 4 - innerW)) + fg(C.accent, "│"));
    lines.push(fg(C.accent, "╰" + "─".repeat(Math.max(3, cols - 4)) + "╯"));

    // 状态栏
    lines.push(statusLine(cols));

    // 输出行：光标回家 + 逐行擦除重写，行数恒为 rows-1，无尾换行。
    // 每行先铺界面底色，行尾 \x1b[K 用同一底色补满 → 整屏没有一块露的是终端自己的底。
    let out = BG + "\x1b[H";
    out += lines.map((l) => BG + l + "\x1b[K").join("\r\n");
    // 预留给终端的那一行（从不写内容）也得铺底色，否则屏幕底会露一条异色边
    out += `\x1b[${rows};1H` + BG + "\x1b[K";
    // 光标定位到输入行（倒数第 3 行：底边框-2、输入-3；隐藏光标下仅辅助 IME）
    const inputRow = lines.length - 3; // 0-based
    const curCol = 4 + visWidth(S.input) + visWidth(ghostShown); // "│ " + "❯ " = 4，再接 ghost
    out += `\x1b[${Math.min(rows, inputRow + 1)};${Math.min(cols, curCol + 1)}H`;
    try {
      stdout.write(out);
    } catch {}
  }

  function statusLine(cols) {
    const ctxUsed = S.usage ? (S.usage.inputTokens || 0) + (S.usage.outputTokens || 0) : 0;
    const ctxPct = ctxUsed > 0 ? (ctxUsed / CONTEXT_WINDOW) * 100 : null;
    const fill = ctxPct == null ? 0 : Math.round((Math.min(100, ctxPct) / 100) * 10);
    const bar = "█".repeat(fill) + "░".repeat(10 - fill);
    const barColor = ctxPct == null ? C.muted : ctxPct >= 50 ? C.warn : C.ok;
    const sessDur = fmtSecs(S.now - S.sessionStart);
    const idleFor = !S.busy && S.lastEnd ? fmtSecs(S.now - S.lastEnd) : null;
    const short = S.sessionId ? String(S.sessionId).replace("session-", "").slice(0, 8) : "new";

    let left = fg(C.accent, "─ ") + (S.busy ? fg(C.primary, `${KAOMOJI[S.frame % KAOMOJI.length]} ${VERBS[S.frame % VERBS.length]} ${fmtSecs(S.elapsed)}`) : fg(C.ok, "⏺"));
    if (S.busy && S.queue.length) left += fg(C.warn, `  ⏳ 排队 ${S.queue.length}`);
    left += fg(C.muted, " │ ") + fg(C.text, S.model);
    left += fg(C.muted, ` │ ctx ${ctxUsed > 0 ? `${fmtTokens(ctxUsed)}/${fmtTokens(CONTEXT_WINDOW)}` : "──"} │ `);
    left += fg(barColor, `[${bar}]`) + (ctxPct == null ? fg(C.muted, " ──") : fg(barColor, ` ${ctxPct.toFixed(1)}%`));
    left += fg(C.muted, ` │ ${sessDur}`);
    if (idleFor) left += fg(C.muted, " │ ") + fg(C.dollar, "● ") + fg(C.muted, idleFor);
    if (S.persona) left += fg(C.muted, " │ ") + fg(C.accent, `◈ ${S.persona}`);
    if (!S.thinkOn) left += fg(C.warn, " │ 思考已隐藏");
    if (S.verbose) left += fg(C.warn, " │ 详细模式");
    if (S.scroll > 0) left += fg(C.primary, ` │ ↑ 翻阅中 距底${S.scroll}行`);
    if (S.zoom) left += fg(C.accent, " │ ⌗ 滚轮已让给终端缩放");
    if (S.statusToast) left += fg(C.warn, ` │ ${S.statusToast}`);

    const right = fg(C.muted, WORKSPACE + " ");
    const leftW = visWidth(left);
    const rightW = visWidth(right);
    const mid = Math.max(1, cols - leftW - rightW);
    return truncVis(left, cols - rightW) + " ".repeat(mid) + right;
  }

  // ────────────────────── 转写推送（事件 → 行）──────────────────────
  // v0.16.11 Hermes 式消息流：去时间戳；用户输入 = 灰色短框，NOVA 回复 = 红色全宽框

  // 合上 NOVA 回复框（若开着）；任何非 text 事件打断回答段时调用
  function closeTextFrame() {
    if (!S.textRun) return;
    S.textRun = false;
    pushRaw(fg(C.accent, "╰" + "─".repeat(Math.max(1, S.cols - 2)) + "╯"));
  }

  // 用户输入框：边框统一品牌红（accent），❯ 红、内容白
  function pushUserFrame(task) {
    const shown = truncVis(String(task).replace(/\r/g, ""), Math.max(10, S.cols - 10));
    const iw = 3 + visWidth(shown); // " ❯ " + 内容
    pushRaw(fg(C.accent, "╭" + "─".repeat(iw + 1) + "╮"));
    pushRaw(fg(C.accent, "│") + fg(C.accent, " ❯ ") + fg(C.text, shown) + fg(C.accent, " │"));
    pushRaw(fg(C.accent, "╰" + "─".repeat(iw + 1) + "╯"));
  }

  function handleEvent(ev) {
    switch (ev.type) {
      case "session":
        if (ev.sessionId || ev.id) {
          S.sessionId = ev.sessionId || ev.id;
          scheduleRender();
        }
        break;
      case "status": {
        closeTextFrame();
        const phase = ev.phase;
        if (phase === "turn_start") S.statusText = "开始处理";
        else if (phase === "step_start") S.statusText = ev.step ? `思考中（第 ${ev.step} 步）` : "思考中";
        else if (phase === "step_end") {
          if (ev.usage) S.usage = { ...(S.usage || {}), ...ev.usage };
          S.statusText = "收尾中";
        } else if (phase === "turn_end") {
          S.statusText = "";
          S.lastEnd = Date.now();
          if (ev.reason && ev.reason.kind && ev.reason.kind !== "completed") {
            pushRaw(fg(C.warn, `  结束：${ev.reason.kind}`));
          }
        }
        scheduleRender();
        break;
      }
      case "thinking": {
        setWinTitle(`${APP_TITLE} — 思考中`);
        if (!S.thinkOn) break;
        const t = (ev.text || "").trim();
        if (!t) break;
        closeTextFrame();
        for (const l of bodyLines(fg(C.label, `  ${BRAND.tool} 思考 · `), t)) pushRaw(italic(l));
        break;
      }
      case "text": {
        setWinTitle(`${APP_TITLE} — 回答中`);
        if (!ev.text) break;
        if (!S.textRun) {
          S.textRun = true;
          // NOVA 回复框顶：标题嵌在框线里
          const label = "▌ NOVA ";
          const fill = Math.max(1, S.cols - 3 - visWidth(label));
          pushRaw(fg(C.accent, "╭─") + bold(fg(C.primary, label)) + fg(C.accent, "─".repeat(fill) + "╮"));
        }
        for (const raw of String(ev.text).replace(/\r/g, "").split("\n")) {
          const wrapped = wrapAnsi(raw, Math.max(20, S.cols - 4), { hard: true, trim: false }).split("\n");
          for (const p of wrapped) pushRaw(fg(C.accent, "│ ") + fg(C.text, p));
        }
        break;
      }
      case "tool_call": {
        closeTextFrame();
        const name = ev.name || ev.tool || "tool";
        setWinTitle(`${APP_TITLE} — 工具 ${name}`);
        const args = ev.args ?? ev.input ?? ev.params;
        let argStr = "";
        if (typeof args === "string") argStr = truncateOne(args, 80);
        else if (args) {
          if (args.command) argStr = truncateOne(String(args.command), 80);
          else if (args.path || args.file_path) argStr = String(args.path || args.file_path);
          else argStr = truncateOne(JSON.stringify(args), 80);
        }
        pushRaw(fg(C.accent, `  ${BRAND.tool} `) + fg(C.accent, name) + fg(C.muted, argStr ? `(${argStr})` : ""));
        break;
      }
      case "tool_result": {
        closeTextFrame();
        const ok = (ev.ok ?? ev.success ?? !ev.error) !== false;
        const body = ev.output ?? ev.text ?? ev.result ?? ev.error ?? "";
        const hasBody = typeof body === "string" && body.trim();
        if (S.verbose && hasBody) {
          pushRaw(fg(ok ? C.ok : C.error, `  ${BRAND.tool} ${ok ? "✓ 结果" : "✗ 结果"}`));
          for (const l of bodyLines("", body.trim())) pushRaw(fg(C.muted, " ".repeat(10) + l));
        } else {
          const preview = hasBody ? truncateOne(body, 100) : "";
          pushRaw(fg(ok ? C.ok : C.error, `  ${BRAND.tool} ${ok ? "✓" : "✗"} `) + fg(C.muted, preview));
        }
        break;
      }
      case "diag":
        closeTextFrame();
        pushRaw(fg(C.muted, `  ${ev.text}`));
        break;
      case "error":
        closeTextFrame();
        pushRaw(fg(C.error, `  错误：${ev.message || JSON.stringify(ev).slice(0, 120)}`));
        break;
      default:
        break;
    }
    scheduleRender();
  }

  // 预热触发器：空闲且配置未变时把内核备好（重复调用无副作用）
  function ensureWarm() {
    if (process.env.TUI_NO_AUTORUN) return; // 测试/抓帧导入时不 spawn 内核
    if (!S.live || S.busy) return;
    prewarm(S.sessionId, { modelPatch: MODEL_OVERRIDE, personaPatch: PERSONA_OVERRIDE });
  }

  // ────────────────────── 提交 / 命令 ──────────────────────
  function submitTask(task) {
    pushUserFrame(task);
    // /skill 加载的技能：把 SKILL.md 正文拼在本轮消息前发给内核。
    // 只拼一次 —— 内容进入会话历史后，后续轮次本来就看得见。
    let payload = task;
    if (S.pendingSkill) {
      const sk = S.pendingSkill;
      S.pendingSkill = null;
      payload =
        `【本轮指定技能：${sk.name}】\n` +
        `用户显式要求使用这个技能，请严格按其中的步骤完成下面的请求。\n` +
        `<skill name="${sk.name}" file="${sk.file}">\n${sk.body}\n</skill>\n\n` +
        `用户请求：${task}`;
    }
    S.busy = true;
    S.exitAttempt = 0;
    S.interrupted = false;
    S.start = Date.now();
    S.elapsed = 0;
    S.statusText = "已发送";
    setWinTitle(`${APP_TITLE} — 处理中`);
    scheduleRender();
    runTask(payload, S.sessionId, handleEvent, (c) => {
      S.child = c;
    }, { modelPatch: MODEL_OVERRIDE, personaPatch: PERSONA_OVERRIDE }).then((code) => {
      const took = Date.now() - S.start;
      S.child = null;
      S.busy = false;
      S.statusText = "";
      closeTextFrame();
      if (!S.interrupted) {
        S.lastMs = took;
        if (code !== 0) pushRaw(fg(C.muted, `  （退出码 ${code}）`));
        pushRaw(fg(C.muted, `  ⏱ 用时 ${fmtSecs(took)}`));
        if (took >= BELL_AFTER_MS) bell();
        setWinTitle(`${APP_TITLE} — 完成`);
      }
      pushRaw(" ");
      scheduleRender();
      ensureWarm(); // 本轮结束：立刻用新的 session id 备好下一轮内核
    });
  }

  // ---- 会话列表（/sessions、/resume 共用）----
  function recentSessions(limit = 20) {
    return listSessions({ sessionsRoot: SESSIONS_ROOT, projCacheRoot: PROJCACHE_ROOT, limit });
  }
  function printSessionRow(row, i) {
    const cur = row.id === S.sessionId ? fg(C.ok, "●") : " ";
    const no = String(i + 1).padStart(2);
    const title = padVis(truncVis(sessionLabel(row), 38), 40);
    const d = new Date(row.mtime);
    const two = (n) => String(n).padStart(2, "0");
    const when = `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
    pushRaw(
      "  " +
        cur +
        fg(C.label, ` ${no}. `) +
        fg(C.text, title) +
        fg(C.muted, ` ${when}  ${String(row.turns || 0).padStart(2)} 轮 ${String(Math.round(row.sizeBytes / 1024)).padStart(4)}KB`),
    );
  }

  function enqueue(task) {
    S.queue.push(task);
    pushRaw(fg(C.warn, `  ⏳ 已排队：${task}`));
  }

  async function runCommand(cmd) {
    const [name, ...rest] = cmd.trim().split(/\s+/);
    switch (name) {
      case "/help":
        pushRaw(bold(fg(C.primary, `  ${BRAND.helpHeader}`)));
        pushRaw(" ");
        pushRaw(bold(fg(C.accent, "  常用命令")));
        for (const c of COMMANDS) pushRaw(fg(C.label, `  ${c.name.padEnd(11)}`) + fg(C.muted, c.desc));
        pushRaw(" ");
        pushRaw(bold(fg(C.accent, "  快捷键")));
        for (const [k, , d] of KEY_HINTS) pushRaw(fg(C.label, `  ${k.padEnd(10)}`) + fg(C.muted, d));
        pushRaw(" ");
        break;
      case "/new":
        S.sessionId = null;
        S.usage = null;
        S.lastMs = 0;
        S.sessionStart = Date.now();
        S.pendingSkill = null;
        pushRaw(fg(C.muted, "  已开新会话（上下文已清空）"));
        pushRaw(" ");
        break;
      case "/clear":
        S.transcript = [];
        S.wrapCache = [];
        S.scroll = 0;
        pushRaw(fg(C.muted, "  已清屏（会话保留）"));
        break;
      case "/sessions": {
        const rows = recentSessions();
        if (!rows.length) {
          pushRaw(fg(C.muted, "  还没有历史会话（发出第一条消息后就会在这里出现）。"));
          pushRaw(" ");
          break;
        }
        pushRaw(bold(fg(C.accent, `  历史会话 —— ${rows.length} 个`)));
        for (let i = 0; i < rows.length; i++) printSessionRow(rows[i], i);
        pushRaw(fg(C.muted, "  /resume <编号> 回到某个会话（● = 当前会话）"));
        pushRaw(" ");
        break;
      }
      case "/resume": {
        const key = rest.join(" ").trim();
        if (!key) {
          pushRaw(fg(C.muted, "  用法：/resume <编号|会话id>   —— 先用 /sessions 看列表"));
          pushRaw(" ");
          break;
        }
        const rows = recentSessions();
        const row = findSession(rows, key);
        if (!row) {
          pushRaw(fg(C.error, `  找不到会话：${key}`));
          pushRaw(" ");
          break;
        }
        S.sessionId = row.id;
        S.usage = null;
        S.lastMs = 0;
        S.sessionStart = Date.now();
        S.pendingSkill = null;
        S.transcript = [];
        S.wrapCache = [];
        S.scroll = 0;
        pushRaw(bold(fg(C.accent, `  已恢复会话：${sessionLabel(row)}`)));
        pushRaw(fg(C.muted, `  ${row.id}`));
        pushRaw(
          fg(C.muted, `  ${new Date(row.mtime).toLocaleString("zh-CN")} · ${row.turns || 0} 轮 · `) +
            fg(C.fade, truncVis(row.cwd || "?", 60)),
        );
        const det = loadSessionDetail(row, { maxTurns: 3 });
        if (det.msgs.length) {
          pushRaw(fg(C.muted, `  ── 最近回显（显示 ${det.msgs.length} 条，全会话 ${det.totalMsgs} 条）──`));
          for (const m of det.msgs) {
            const who = m.role === "user" ? fg(C.prompt, "你  ") : fg(C.accent, "NOVA");
            const one = m.text.replace(/\s+/g, " ").trim();
            const body = one.length > 160 ? one.slice(0, 160) + "…" : one;
            pushRaw("  " + who + fg(C.muted, " │ ") + fg(m.role === "user" ? C.text : C.fade, body));
          }
        }
        pushRaw(fg(C.muted, "  之后的消息会接在这个会话后面。"));
        pushRaw(" ");
        break;
      }
      case "/think":
        S.thinkOn = !S.thinkOn;
        pushRaw(fg(C.muted, S.thinkOn ? "  已显示思考过程" : "  已隐藏思考过程"));
        pushRaw(" ");
        break;
      case "/status":
        pushRaw(fg(C.muted, "  正在查询余额…"));
        {
          const msg = await queryBalance();
          pushRaw(fg(C.muted, msg));
        }
        pushRaw(" ");
        break;
      case "/model": {
        const want = rest.join(" ").trim();
        const cat = loadModelCatalog();
        const cur = readModelOverride() || { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
        if (!want) {
          pushRaw(bold(fg(C.accent, "  可用模型")) + fg(C.muted, `  当前：${cur.model} · ${cur.provider}`));
          for (let i = 0; i < cat.length; i++) {
            const m = cat[i];
            const on = m.provider === cur.provider && m.model === cur.model ? fg(C.ok, "●") : " ";
            pushRaw(
              "  " +
                on +
                fg(C.label, ` ${String(i + 1).padStart(2)}. `) +
                fg(C.text, padVis(m.model, 30)) +
                fg(C.muted, `${m.label} · ${m.note}`),
            );
          }
          pushRaw(fg(C.muted, "  切换：/model <编号|模型名>      恢复默认：/model default"));
          pushRaw(fg(C.muted, "  想加供应商：改 data/profiles/headless/cordis.patch.yml 的 llm-pi-ai.providers"));
          pushRaw(" ");
          break;
        }
        if (want === "default" || want === "reset") {
          clearModelOverride();
          S.model = DEFAULT_MODEL;
          S.provider = DEFAULT_PROVIDER;
          pushRaw(fg(C.muted, `  已恢复默认模型：${DEFAULT_MODEL}（${DEFAULT_PROVIDER}）`));
          pushRaw(" ");
          break;
        }
        let hit = null;
        if (/^\d+$/.test(want)) hit = cat[parseInt(want, 10) - 1] || null;
        else {
          const lw = want.toLowerCase();
          hit = cat.find((m) => m.model === want) || cat.find((m) => m.model.toLowerCase() === lw) || cat.find((m) => m.model.toLowerCase().includes(lw));
        }
        if (!hit) {
          pushRaw(fg(C.error, `  没有这个模型：${want}`) + fg(C.muted, "（用 /model 看列表）"));
          pushRaw(" ");
          break;
        }
        S.model = hit.model;
        S.provider = hit.provider;
        if (hit.provider === DEFAULT_PROVIDER && hit.model === DEFAULT_MODEL) {
          clearModelOverride();
          pushRaw(fg(C.muted, `  已切回默认：${hit.model}（官方）`));
        } else {
          writeModelOverride(hit.provider, hit.model);
          pushRaw(fg(C.ok, `  已切换到 ${hit.model}`) + fg(C.muted, `（${hit.provider}）—— 下一条消息生效`));
          pushRaw(fg(C.muted, `  记住这个选择：${MODEL_OVERRIDE}`));
        }
        pushRaw(" ");
        break;
      }
      case "/memory": {
        const showMem = (label, file) => {
          let body;
          try {
            body = fs.readFileSync(file, "utf8").trim();
          } catch {
            body = "（暂无）";
          }
          pushRaw(bold(fg(C.accent, `  ${label} —— ${file}`)));
          if (body === "（暂无）") pushRaw(fg(C.muted, "  （暂无）"));
          else for (const l of body.split("\n")) pushRaw(fg(C.fade, "  " + l));
          pushRaw(" ");
        };
        showMem("长期记忆 · Agent 笔记", path.join(WORKSPACE, "MEMORY.md"));
        showMem("长期记忆 · 用户画像", path.join(WORKSPACE, "USER.md"));
        pushRaw(fg(C.muted, "  提示：直接对 Agent 说「记住：…」即可写入；下次启动生效。"));
        pushRaw(" ");
        break;
      }
      case "/persona": {
        const want = rest.join(" ").trim();
        const all = listPersonas();
        if (!want) {
          pushRaw(bold(fg(C.accent, "  人设")) + fg(C.muted, `  当前：${S.persona || "默认（未启用）"}`));
          if (!all.length) {
            pushRaw(fg(C.muted, `  ${PERSONA_DIR} 里还没有 .md —— 放一份进去，文件名就是人设名`));
          } else {
            for (let i = 0; i < all.length; i++) {
              const on = all[i] === S.persona ? fg(C.ok, "●") : " ";
              pushRaw(
                "  " +
                  on +
                  fg(C.label, ` ${String(i + 1).padStart(2)}. `) +
                  fg(C.text, padVis(all[i], 14)) +
                  fg(C.muted, personaHint(all[i])),
              );
            }
          }
          pushRaw(fg(C.muted, "  启用：/persona <编号|名字>        关闭：/persona off"));
          pushRaw(fg(C.muted, `  自己写人设：往 ${PERSONA_DIR} 丢一个 md，正文就是人设`));
          pushRaw(" ");
          break;
        }
        if (want === "off" || want === "none" || want === "default") {
          clearPersonaOverride();
          S.persona = null;
          pushRaw(fg(C.muted, "  已关闭人设 —— 下一条消息回到默认部署人设"));
          pushRaw(" ");
          break;
        }
        let hit = null;
        if (/^\d+$/.test(want)) hit = all[parseInt(want, 10) - 1] || null;
        else hit = all.find((p) => p === want) || all.find((p) => p.toLowerCase().includes(want.toLowerCase())) || null;
        if (!hit) {
          pushRaw(fg(C.error, `  没有这个人设：${want}`) + fg(C.muted, "（用 /persona 看列表）"));
          pushRaw(" ");
          break;
        }
        if (!writePersonaOverride(hit)) {
          pushRaw(fg(C.error, `  人设文件读不出来：${hit}.md`));
          pushRaw(" ");
          break;
        }
        S.persona = hit;
        pushRaw(fg(C.ok, `  已启用人设「${hit}」`) + fg(C.muted, " —— 下一条消息生效"));
        pushRaw(fg(C.muted, `  补丁：${PERSONA_OVERRIDE}`));
        pushRaw(" ");
        break;
      }
      case "/skill": {
        const want = rest.join(" ").trim();
        const skills = loadSkills();
        if (!want) {
          pushRaw(fg(C.muted, `  用法：/skill <技能名>     —— 共 ${skills.length} 个技能，/skills 看全部`));
          if (skills.length) pushRaw(fg(C.fade, "  " + skills.map((s) => s.name).join("  ")));
          pushRaw(" ");
          break;
        }
        const lw = want.toLowerCase();
        const hit =
          skills.find((s) => s.name === want) ||
          skills.find((s) => s.name.toLowerCase() === lw) ||
          skills.find((s) => s.name.toLowerCase().includes(lw));
        if (!hit) {
          pushRaw(fg(C.error, `  没有这个技能：${want}`));
          const near = skills.filter((s) => s.name.toLowerCase().includes(lw.slice(0, 3))).slice(0, 8).map((s) => s.name);
          if (near.length) pushRaw(fg(C.muted, "  相近的：" + near.join("  ")));
          pushRaw(" ");
          break;
        }
        const skFile = path.join(hit.dir, hit.name, "SKILL.md");
        let body = "";
        try {
          body = fs.readFileSync(skFile, "utf8");
        } catch {}
        if (!body.trim()) {
          pushRaw(fg(C.error, `  技能文件读不到：${skFile}`));
          pushRaw(" ");
          break;
        }
        const MAX = 16000;
        const cut = body.length > MAX;
        S.pendingSkill = { name: hit.name, file: skFile, body: cut ? body.slice(0, MAX) + "\n…（过长已截断）" : body };
        pushRaw(fg(C.ok, `  已加载技能 ${hit.name}`) + fg(C.muted, `（${(body.length / 1024).toFixed(1)}KB）—— 下一条消息带上它`));
        pushRaw(fg(C.muted, `  ${skFile}`));
        if (hit.desc) pushRaw(fg(C.muted, "  " + truncVis(hit.desc, 100)));
        pushRaw(" ");
        break;
      }
      case "/skills": {
        const skills = loadSkills();
        if (skills.length === 0) {
          pushRaw(fg(C.muted, "  技能库为空。"));
          pushRaw(fg(C.muted, `  对 Agent 说「把这件事沉淀成技能」即可新建（写进 ${SKILL_ROOTS[0]}\\<名字>\\SKILL.md）。`));
        } else {
          // 名字密集排列（每行按终端宽度装尽可能多的名字）——
          // 技能多的时候（知识库同步过来一百多个）逐行一条会把整屏刷掉。
          pushRaw(bold(fg(C.accent, `  技能库 —— ${skills.length} 个`)) + fg(C.muted, `  （${SKILL_ROOTS[0]}）`));
          const maxW = Math.max(24, S.cols - 4);
          let line = "  ";
          for (const sk of skills) {
            const piece = sk.name + "  ";
            if (visWidth(line) + visWidth(piece) > maxW) {
              pushRaw(fg(C.fade, line));
              line = "  ";
            }
            line += piece;
          }
          if (line.trim()) pushRaw(fg(C.fade, line));
        }
        pushRaw(fg(C.muted, "  提示：技能内容在 <技能根>/<名字>/SKILL.md，内核启动时载入摘要，用到才读全文。"));
        pushRaw(" ");
        break;
      }
      case "/exit":
        pushRaw(fg(C.muted, `  ${BRAND.goodbye}`));
        scheduleRender();
        setTimeout(() => exit(0), 120);
        return;
      default:
        pushRaw(fg(C.error, `  未知命令：${name}  （试试 /help）`));
        pushRaw(" ");
    }
    scheduleRender();
    ensureWarm(); // 命令可能改了会话/模型/人设 → key 变了自动重建待命内核
  }

  function onSubmit(raw) {
    const task = raw.trim();
    if (!task) return;
    S.hist.push(task);
    if (S.hist.length > 100) S.hist.shift();
    S.histPos = -1;
    S.draft = "";
    S.input = "";
    S.hintSel = -1;
    S.scroll = 0; // 发消息 → 立即跟随底部（聊天习惯）
    if (task.startsWith("/")) {
      pushRaw(bold(fg(C.prompt, `  ${BRAND.prompt} `) + fg(C.text, task)));
      runCommand(task);
      return;
    }
    if (S.busy) {
      enqueue(task);
      scheduleRender();
      return;
    }
    submitTask(task);
  }

  function interrupt() {
    if (!S.busy) return;
    S.interrupted = true;
    if (S.child) {
      killTree(S.child.pid);
      S.child = null;
    }
    S.busy = false;
    S.statusText = "";
    closeTextFrame();
    pushRaw(fg(C.warn, "  ⏹ 已打断"));
    scheduleRender();
  }

  // ────────────────────── 输入（原始字节解析）──────────────────────
  // mouse SGR 序列在这里被剥掉、转成滚轮事件，永远不会污染按键流。
  let pending = Buffer.alloc(0);
  let escTimer = null;
  const dec = new TextDecoder("utf-8", { stream: true });

  function feedBytes(buf) {
    pending = Buffer.concat([pending, buf]);
    processPending(false);
  }

  function processPending(force) {
    // 循环解析 pending
    while (pending.length) {
      const b = pending[0];
      // 放行缩放期间用户开始打字 → 立刻收回滚轮（ESC 开头的序列交给下面判断）
      if (S.zoom && b !== 0x1b) endZoomHandoff();
      if (b === 0x1b) {
        // 转义序列
        if (pending.length === 1) {
          if (!force && !escTimer) {
            escTimer = setTimeout(() => {
              escTimer = null;
              processPending(true);
            }, 50);
          }
          if (!force) return; // 等更多字节（可能是序列开头）
          pending = pending.slice(1);
          onEsc();
          continue;
        }
        if (pending[1] === 0x5b || pending[1] === 0x4f) {
          // CSI / SS3：找到终结字节
          let end = -1;
          for (let i = 2; i < pending.length; i++) {
            const c = pending[i];
            if ((c >= 0x40 && c <= 0x7e) || c === 0x7e) {
              end = i;
              break;
            }
          }
          if (end === -1) {
            if (!force) {
              if (!escTimer) escTimer = setTimeout(() => { escTimer = null; processPending(true); }, 50);
              return;
            }
            pending = Buffer.alloc(0); // 残缺序列，丢弃
            return;
          }
          const seq = pending.slice(0, end + 1).toString("latin1");
          pending = pending.slice(end + 1);
          onCsi(seq);
          continue;
        }
        // Alt+键 等：丢弃 ESC
        pending = pending.slice(1);
        continue;
      }
      if (b === 0x03) {
        pending = pending.slice(1);
        onCtrlC();
        continue;
      }
      if (b === 0x0f) {
        pending = pending.slice(1);
        S.verbose = !S.verbose;
        scheduleRender();
        continue;
      }
      if (b === 0x09) {
        pending = pending.slice(1);
        onTab();
        continue;
      }
      if (b === 0x0d || b === 0x0a) {
        pending = pending.slice(1);
        onEnter();
        continue;
      }
      if (b === 0x7f || b === 0x08) {
        pending = pending.slice(1);
        S.input = S.input.slice(0, -1);
        S.hintSel = -1;
        scheduleRender();
        continue;
      }
      if (b < 0x20) {
        pending = pending.slice(1);
        continue; // 其他控制字符忽略
      }
      // 文本字节（含 UTF-8 多字节）：找到下一控制字符为止的一段
      let j = 0;
      while (j < pending.length && pending[j] >= 0x20 && pending[j] !== 0x7f) j++;
      const textBytes = pending.slice(0, j);
      pending = pending.slice(j);
      const text = dec.decode(textBytes, { stream: true });
      if (text) {
        S.input += text;
        S.hintSel = -1;
        ensureWarm(); // 打字即补预热（被闲置回收 / 配置变了会自动重建）
        scheduleRender();
      }
    }
    if (force) dec.decode(); // flush
  }

  function onEsc() {
    // 单独 Esc：打断 / 关闭提示
    if (S.hintSel >= 0) {
      S.hintSel = -1;
      scheduleRender();
      return;
    }
    interrupt();
  }

  function onCsi(seq) {
    // SGR 鼠标：\x1b[<B;x;yM。B 低 2 位是键、bit2=Shift bit3=Alt bit4=Ctrl，
    // 滚轮上 = 64、下 = 65，所以 Ctrl+滚轮上 = 64|16 = 80、下 = 81。
    const mw = /^\x1b\[<(\d+);(\d+);(\d+)M$/.exec(seq);
    if (mw) {
      const btn = +mw[1];
      const base = btn & ~(4 | 8 | 16); // 剥掉修饰位
      if (base === 64 || base === 65) {
        if (btn & 16) {
          // Ctrl+滚轮 = 用户想缩放终端 → 放行（详见文件头第 5 条）
          beginZoomHandoff();
          return;
        }
        if (!(btn & (4 | 8))) wheel(base === 64 ? 3 : -3); // 仅裸滚轮翻历史
      }
      return; // 其余鼠标事件（点击/拖动）一律忽略
    }
    // 放行期间终端可能把滚轮当 ↑/↓ 或 Ctrl+↑/↓ 发回来（alternate scroll）：
    // 一律吞掉并续期，别让它污染输入历史/光标位置。
    if (S.zoom && /^\x1b\[(1;5)?[AB]$/.test(seq)) {
      armZoomTimer();
      return;
    }
    if (S.zoom) endZoomHandoff(); // 其它按键 = 回来打字了，立刻收回鼠标
    if (seq === "\x1b[A") onArrow(-1);
    else if (seq === "\x1b[B") onArrow(1);
    else if (seq === "\x1b[C") acceptGhost(); // → 接受行内补全（shell 手感）
    else if (seq === "\x1b[5~") wheel(10); // PgUp
    else if (seq === "\x1b[6~") wheel(-10); // PgDn
    // 其余序列忽略
  }

  function wheel(d) {
    const totalDisp = S.wrapCache.reduce((n, w) => n + (w ? w.length : 0), 0);
    const items = completion().items;
    const HINT_MAX = Math.max(4, Math.min(12, S.rows - 14));
    const hintRows = items.length ? Math.min(items.length, HINT_MAX) : 0;
    const moreRow = items.length > hintRows;
    const viewH = Math.max(1, S.rows - 1 - (3 + 1 + hintRows + (moreRow ? 1 : 0)));
    const maxScroll = Math.max(0, totalDisp - viewH);
    S.scroll = Math.max(0, Math.min(maxScroll, S.scroll + d));
    scheduleRender();
  }

  // ── Ctrl+滚轮缩放：临时把滚轮还给终端 ──────────────────────────
  // 终端自己的 Ctrl+滚轮缩放会被我们的鼠标上报抢走（上报开着时滚轮只发应用），
  // 所以收到 Ctrl+滚轮就关掉上报让终端接管；缩放每一步都会引发 resize
  // （字号变了行列数就变），据此续期，连续缩放不会中途被收回。
  const ZOOM_HOLD_MS = 1000;
  let zoomTimer = null;

  function setMouseCapture(on) {
    S.mouseOn = on;
    try {
      stdout.write(on ? "\x1b[?1000h\x1b[?1006h" : "\x1b[?1000l\x1b[?1006l");
    } catch {}
  }

  function armZoomTimer() {
    if (zoomTimer) clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      zoomTimer = null;
      endZoomHandoff();
    }, ZOOM_HOLD_MS);
  }

  function beginZoomHandoff() {
    if (S.zoom) {
      armZoomTimer(); // 已经在放行中：只续期
      return;
    }
    S.zoom = true;
    setMouseCapture(false);
    armZoomTimer();
    scheduleRender();
  }

  function endZoomHandoff() {
    if (zoomTimer) {
      clearTimeout(zoomTimer);
      zoomTimer = null;
    }
    if (!S.zoom) return;
    S.zoom = false;
    setMouseCapture(true);
    scheduleRender();
  }

  function onArrow(dir) {
    const items = navItems();
    if (items.length) {
      // 候选在场时 ↑↓ 只走候选（Minecraft 语义）；想翻输入历史就先清空输入。
      // 两端对称进入：↑ 从末项（紧贴输入框那项）进，↓ 从首项进。
      if (dir === -1) S.hintSel = S.hintSel === -1 ? items.length - 1 : Math.max(0, S.hintSel - 1);
      else S.hintSel = S.hintSel === -1 ? 0 : Math.min(items.length - 1, S.hintSel + 1);
      scheduleRender();
      return;
    }
    // 输入历史
    if (S.hist.length === 0) return;
    if (dir === -1) {
      if (S.histPos === -1) S.draft = S.input;
      S.histPos = Math.min(S.hist.length - 1, S.histPos + 1);
    } else {
      if (S.histPos === -1) return;
      S.histPos = S.histPos - 1;
    }
    S.input = S.histPos === -1 ? S.draft : S.hist[S.hist.length - 1 - S.histPos];
    scheduleRender();
  }

  // Tab：把候选补进输入框 —— 这是「确认选择」，不是执行（执行仍旧归 Enter）。
  // 有 ↑↓ 选中就听用户的，否则取行内 ghost 指向的那一项（首个匹配）；
  // 补完若是唯一候选、或输入本来就打全了这条命令，顺手补个空格直接落进参数位。
  function onTab() {
    const comp = completion();
    const items = comp.items;
    if (!items.length) return;
    const pick = S.hintSel >= 0 && items[S.hintSel] ? items[S.hintSel] : items[0];
    if (!pick) return;
    if (comp.mode === "cmd") {
      const ready = items.length === 1 || pick.name === S.input;
      S.input = pick.name + (ready ? " " : "");
    } else {
      S.input = `${comp.cmd} ${pick.value} `;
    }
    S.hintSel = -1;
    scheduleRender();
  }

  // → 接受行内 ghost（有选中项就补选中项，否则补首个匹配）
  function acceptGhost() {
    const g = ghostOf(completion());
    if (!g) return;
    S.input += g;
    S.hintSel = -1;
    scheduleRender();
  }

  function onEnter() {
    const comp = completion();
    const items = comp.items;
    if (items.length && S.hintSel >= 0) {
      const pick = items[S.hintSel];
      const line = comp.mode === "arg" ? `${comp.cmd} ${pick.value}` : pick.name;
      S.input = "";
      S.hintSel = -1;
      onSubmit(line);
      return;
    }
    // 没显式选，但输入恰好是唯一候选的前缀 → 先补全再执行（省得打全命令）
    if (comp.mode === "cmd" && items.length === 1 && S.input.startsWith("/") && items[0].name.startsWith(S.input)) {
      const line = items[0].name;
      S.input = "";
      S.hintSel = -1;
      onSubmit(line);
      return;
    }
    const raw = S.input;
    S.input = "";
    S.hintSel = -1;
    onSubmit(raw);
  }

  function onCtrlC() {
    S.exitAttempt += 1;
    if (!S.busy || S.exitAttempt >= 2) exit(0);
    else {
      S.statusToast = "再按一次 Ctrl+C 强制退出";
      scheduleRender();
      setTimeout(() => {
        S.statusToast = "";
        S.exitAttempt = 0;
        scheduleRender();
      }, 2000);
    }
  }

  // ────────────────────── 定时器 ──────────────────────
  // 忙时动画 + 计时；闲时零定时器（不重绘，省电不打扰）
  setInterval(() => {
    if (!S.live) return;
    if (S.busy) {
      S.now = Date.now();
      S.elapsed = Date.now() - S.start;
      scheduleRender();
    }
  }, 250);
  setInterval(() => {
    if (!S.live || !S.busy) return;
    S.frame = (S.frame + 1) % KAOMOJI.length;
    scheduleRender();
  }, 2500);

  // resize
  if (typeof stdout.on === "function") {
    stdout.on("resize", () => {
      const nr = stdout.rows || S.rows;
      const nc = stdout.columns || S.cols;
      if (nr !== S.rows || nc !== S.cols) {
        S.rows = nr;
        S.cols = nc;
        rewrapAll();
        if (S.zoom) armZoomTimer(); // 缩放引起的变化 → 续期放行窗口
        scheduleRender();
      }
    });
  }

  // ────────────────────── 启停 ──────────────────────
  function exit(code) {
    if (!S.live) return;
    S.live = false;
    killWarm(); // 待命内核一并收掉（别留孤儿进程）
    if (zoomTimer) {
      clearTimeout(zoomTimer);
      zoomTimer = null;
    }
    try {
      // 退出前先 \x1b[0m 收干净（否则我们设的底色会跟着回到主屏）
      stdout.write(`\x1b[0m\x1b[?1006l\x1b[?1000l\x1b[?25h\x1b[?1049l`);
    } catch {}
    try {
      stdin.setRawMode?.(false);
    } catch {}
    process.exitCode = code;
    if (typeof onExit === "function") onExit(code);
    else process.exit(code);
  }
  let onExit = null;

  // 进入备用屏 + 开滚轮上报 + 藏光标。
  // ?1007l：显式关掉「alternate scroll」（WT 1.21+ 默认开启的那个）——它会把
  // 放行期间的滚轮变成 ↑/↓ 而不是终端的 Ctrl+滚轮缩放。
  try {
    stdout.write("\x1b[?1049h\x1b[?25l\x1b[?1007l\x1b[?1000h\x1b[?1006h");
    stdout.write(BG + "\x1b[2J"); // 先上底色再清屏，备用屏开场就是我们的底
  } catch {}

  pushWelcome();
  scheduleRender();
  ensureWarm(); // 启动即预热：用户打完第一句话时内核已待命

  // stdin：raw + 数据过滤（mouse 序列已在 onCsi 处理，不会污染）
  try {
    stdin.setRawMode?.(true);
  } catch {}
  stdin.resume?.();
  stdin.on?.("data", feedBytes);

  return {
    setOnExit(fn) {
      onExit = fn;
    },
    exit,
    // 供测试注入
    _S: S,
    _feed: feedBytes,
    _render: render,
    // 抓帧/样机用：把内核事件或原始行直接喂进渲染，不必真跑一次 API
    _event: handleEvent,
    _pushRaw: pushRaw,
    // 性能测试用：直接驱动预热池与任务执行
    _warm: {
      prewarm,
      killWarm,
      runTask,
      state: () => (WARM ? { key: WARM.key, alive: WARM.alive, pid: WARM.child.pid } : null),
    },
  };
}

// 给抓帧 / 样机脚本用的 ANSI 工具（纯函数，不参与运行时逻辑）
export const _ansi = { fg, bold, italic, inv, stamp, BRAND };

// autorun：正常启动（测试导入时置 TUI_NO_AUTORUN=1 跳过）
if (!process.env.TUI_NO_AUTORUN) {
  if (process.stdout.isTTY) {
    start({ stdin: process.stdin, stdout: process.stdout });
  } else {
    console.log("[NOVA] 需要 TTY 运行。双击 U 盘根目录的 启动界面.bat");
  }
}
