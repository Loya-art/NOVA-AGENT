import React, { useState, useEffect, useRef, useCallback } from "react";
import { render, Static, Box, Text, useInput, useApp, useStdin, useStdout } from "ink";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

// ============================================================
//  NOVA TUI  (name ✦ NOVA / icon = 代码地球)      v0.9.0
//  Claude Code / Hermes style terminal UI.
//  Talks to the DSH kernel via `dsh --profile headless --json`.
//
//  v0.2.0: thinking blocks (Chinese via data/AGENTS.md),
//          HH:MM:SS timestamps, animated kaomoji, token usage.
//  v0.3.0: interrupt & queue - type while busy to queue,
//          Esc to abort the running task.
//  v0.4.0: awareness - live elapsed timer + context usage in the
//          status bar, window title follows state, Ctrl+O toggles
//          verbose tool output, bell on long task completion.
//  v0.5.0: slash-command popup menu - type "/" to see commands,
//          filter as you type, arrows + Tab to complete, Enter to
//          run, and MOUSE CLICK support (SGR mouse protocol +
//          DSR cursor query to map screen row -> menu item).
//  v0.6.0: Hermes-style full-width welcome panel - framed start
//          screen with model/session status on the left and the
//          real tool catalog + commands on the right (all Chinese).
//  v0.7.0: long-term memory (Hermes-style) - workspace/MEMORY.md +
//          USER.md are assembled into data/AGENTS.md as a frozen
//          snapshot on every launch; /memory views them; the agent
//          maintains them with its own fs tools.
//  v0.8.0: procedural memory (Hermes skills) - workspace/skills/
//          holds one SKILL.md per class of task; the assembler
//          injects a name+description index into the frozen prompt,
//          so the agent knows which skill exists without loading it.
//          /skills lists the library. Memory/skill routing rules
//          (one fact -> one store; what NOT to capture) are baked in.
//  v0.9.0: identity - name NOVA (新星) + a live "code globe" on the
//          welcome panel: the whole sphere is one glyph, depth comes
//          from ANSI grey levels, built from a real Natural Earth
//          land mask (src/globe.js). Spin axis stays vertical.
//  v0.10.x: Hermes banner.ts 同款「ANSI Shadow」大字 logo（红色三档渐变）。
//  v0.11.0: Hermes SessionPanel 制式大面板 —— logo → 版本行 → 圆角面板
//          （左 hero：球+模型/工作区/会话；右：可用工具 + 可用技能 + 汇总行）；
//          状态栏换成 Hermes 内容：⏺ 模型 │ ctx 用量/上限 │ [条] 百分比 │
//          会话时长 │ ● 空闲，右端工作区路径。
//  v0.11.1: 撤掉代码地球（用户定论：bug 多、不像地球），hero 顶部留空位
//          待放新 logo（heroRows 分档保留位置）。
//  v0.11.2: 输入框钉底 —— 动态区垫高到 rows-2 行，输入框/状态栏永远在窗口
//          底部；空闲时停掉秒级心跳（不重绘，滚轮翻历史不被打扰）。
// ============================================================

// ---- locate the portable root from cwd (launcher cd's into app/) ----
const APP_DIR = process.cwd();
const ROOT = path.dirname(APP_DIR);
const NODE_EXE = path.join(ROOT, "runtime", "node", "bin", "node.exe");
const DSH_BIN = path.join(APP_DIR, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
const DSH_HOME = path.join(ROOT, "data");
const WORKSPACE = path.join(ROOT, "workspace");

const MODEL = "deepseek-flash";
const VERSION = "0.11.2";

// deepseek-flash: 1,048,576-token context window
const CONTEXT_WINDOW = 1048576;
// ring the terminal bell only for tasks that ran at least this long
const BELL_AFTER_MS = 10000;

const APP_TITLE = "NOVA Agent";

// ── 主题：整套移植自 Hermes 的 DARK_SEEDS（theme.ts）──
// primary 金 / accent 琥珀 / border 青铜 / text 奶油 / surface 深蓝
const C = {
  primary: "#FFD700", // 金
  accent: "#FFBF00", // 琥珀
  border: "#CD7F32", // 青铜
  text: "#FFF8DC", // 奶油
  prompt: "#FFF8DC",
  muted: "#88847A", // 文字向底色对半混（Hermes ladder 的 muted）
  label: "#C9C2AC", // muted:text 中间调（标签位）
  fade: "#C3BCA6", // muted:text 0.5（成员列表）
  ok: "#4caf50",
  error: "#ef5350",
  warn: "#ffa726",
  surface: "#1a1a2e", // 状态栏底
  selection: "#3a3a55",
  dollar: "#4dabf7",
};

// ── 品牌档：Hermes BRAND 的 NOVA 版 ──
const BRAND = {
  name: "NOVA Agent",
  icon: "✦",
  prompt: "❯",
  welcome: "输入消息，或 /help 查看命令。",
  goodbye: "Goodbye! ✦",
  tool: "┊",
  helpHeader: "(^_^)? 命令",
};

// ✦ NOVA 大字 logo —— 与 Hermes banner.ts 完全同款的 figlet「ANSI Shadow」字体
// （██╗ ███╗ 描边空心字，pyfiglet ansi_shadow 生成），名字带连字符：NOVA-AGENT，
// 与 Hermes 的「HERMES-AGENT」一致。单组 6 行、86 列。
// Hermes 的上色方式：LOGO_GRADIENT=[0,0,1,1,2,2]，前两行最亮、中间两行次之、
// 末两行最暗。NOVA 保持**红色**（用户指定）：亮红→正红→深红三档红阶。
const NOVA_LOGO_ART = [
  "███╗   ██╗ ██████╗ ██╗   ██╗ █████╗        █████╗  ██████╗ ███████╗███╗   ██╗████████╗",
  "████╗  ██║██╔═══██╗██║   ██║██╔══██╗      ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝",
  "██╔██╗ ██║██║   ██║██║   ██║███████║█████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║   ",
  "██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║╚════╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║   ",
  "██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║      ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║   ",
  "╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝      ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝   ",
];
// ⚠️ ink 的 ANSI 解析只认 CSI 里的数字和分号——真彩色 38;2;r,g;b 的逗号会让它
// 把整行吞掉，所以这里用 256 色红阶（亮红→正红→深红）。
const LOGO_GRADIENT = [203, 203, 196, 196, 124, 124]; // 亮红 / 正红 / 深红
const LOGO_RESET = "\x1b[0m";
const LOGO_ART = NOVA_LOGO_ART.map(
  (line, y) => `\x1b[38;5;${LOGO_GRADIENT[y]}m${line}${LOGO_RESET}`
).join("\n");

// 版本行（Hermes 制式：logo 下、面板上的那行）—— local 后是本版构建指纹
import crypto from "node:crypto";
const BUILD_DATE = "2026.10.11";
const BUILD_HASH = crypto.createHash("sha256").update(`NOVA Agent v${VERSION} · portable build ${BUILD_DATE}`).digest("hex").slice(0, 8);

const KEY_HINTS = [
  ["↑/↓", "翻阅输入历史"],
  ["Esc", "打断正在执行的任务"],
  ["Ctrl+O", "切换工具结果详略"],
  ["Ctrl+C", "连按两次退出"],
];

// ---- real tool names extracted from the installed kernel packages
//      (@deepseek-ai/dsh-tool-*), so nothing here is invented.
//      Hermes toolset 格式：「名字: 工具1, 工具2, …」 ----
const TOOL_GROUPS = [
  ["终端", "bash, pwsh, job_list, job_output, job_kill（后台任务）"],
  ["文件", "read, write, edit, read_image"],
  ["搜索", "glob, grep"],
  ["网络", "web_search, web_fetch"],
  ["任务", "todo_write, create_goal, update_goal, present, ask_user_question"],
  ["扩展", "skill 技能, 子代理 send_message, 插件管理"],
];
const TOOL_COUNT = TOOL_GROUPS.reduce((n, [, t]) => n + t.split(",").length, 0);

// ---- 技能库：workspace/skills/<名字>/SKILL.md（与 /skills 同一数据源） ----
function loadSkills() {
  const dir = path.join(WORKSPACE, "skills");
  let names = [];
  try {
    names = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {}
  return names.map((name) => {
    let desc = "";
    try {
      const t = fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
      const m = /^\s*description\s*:\s*(.+)$/m.exec(t);
      if (m) desc = m[1].trim();
    } catch {}
    return { name, desc };
  });
}

// Hermes SessionPanel 制式欢迎屏：logo → 版本行 → 圆角大面板。
// 面板内左右两栏（同 Hermes wide 布局，hero 列无内框）：
//   左 hero：顶部**预留 logo 位**（原代码地球已撤，位置保留待放新 logo）
//            + 模型·厂商 + 工作区 + 会话
//   右 info：可用工具（toolset 格式）+ 可用技能 + 「N 工具 · M 技能 · /help」汇总行
// LOGO_SPOT_ROWS：hero 顶部给 logo 预留的行数（按终端高度分档，见 App.layout）。
function WelcomePanel({ sessionShort, heroRows = 12, miniLogo = false, showSkills = true }) {
  const skills = React.useMemo(() => (showSkills ? loadSkills() : []), [showSkills]);
  const SKILLS_MAX = 6;
  const head = miniLogo ? (
    <Box justifyContent="center" marginBottom={1}>
      <Text bold color={C.primary}>{`${BRAND.icon} ${BRAND.name} v${VERSION}`}</Text>
    </Box>
  ) : (
    <Box flexDirection="column" alignItems="center" marginBottom={1}>
      <Text>{LOGO_ART}</Text>
      <Text>
        <Text bold color={C.primary}>{`NOVA Agent v${VERSION} (${BUILD_DATE}) · stable`}</Text>
        <Text color={C.muted}>{` · local ${BUILD_HASH}`}</Text>
      </Text>
    </Box>
  );
  return (
    <Box flexDirection="column" width="100%">
      {head}
      <Box borderStyle="round" borderColor={C.border} flexDirection="column" paddingX={2} paddingY={1} width="100%">
        <Box flexDirection="row">
          {/* 左 hero 列（无内框，同 Hermes heroColumn）；顶部为预留 logo 位 */}
          <Box width={30} flexDirection="column">
            {heroRows > 0 && <Box height={heroRows} flexShrink={0} />}
            <Text wrap="truncate-end">
              <Text color={C.accent}>{MODEL}</Text>
              <Text color={C.muted}> · DeepSeek</Text>
            </Text>
            <Text color={C.muted} wrap="truncate-end">{WORKSPACE}</Text>
            <Text>
              <Text color={C.label}>Session: </Text>
              <Text color={C.fade}>{sessionShort}</Text>
            </Text>
          </Box>
          {/* 右 info 列 */}
          <Box flexDirection="column" paddingLeft={2} flexGrow={1}>
            <Text bold color={C.accent}>可用工具</Text>
            {TOOL_GROUPS.map(([g, tools]) => (
              <Text key={g} wrap="truncate">
                <Text color={C.label}>{g}: </Text>
                <Text color={C.fade}>{tools}</Text>
              </Text>
            ))}
            {showSkills && (
              <>
                <Text> </Text>
                <Text bold color={C.accent}>可用技能</Text>
                {skills.length === 0 ? (
                  <Text color={C.muted}>（技能库为空 —— 对 Agent 说「把这件事沉淀成技能」即可新建）</Text>
                ) : (
                  <>
                    {skills.slice(0, SKILLS_MAX).map((s) => (
                      <Text key={s.name} wrap="truncate">
                        <Text color={C.label}>{s.name}: </Text>
                        <Text color={C.fade}>{s.desc || "（无描述）"}</Text>
                      </Text>
                    ))}
                    {skills.length > SKILLS_MAX && (
                      <Text color={C.muted}>{`(还有 ${skills.length - SKILLS_MAX} 个技能…)`}</Text>
                    )}
                  </>
                )}
              </>
            )}
            <Text> </Text>
            <Text color={C.text}>
              {`${TOOL_COUNT} 个工具${showSkills ? ` · ${skills.length} 个技能` : ""} · `}
              <Text color={C.muted}>/help 查看命令</Text>
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

// ---- slash commands: single source of truth for /help AND the menu ----
const COMMANDS = [
  { name: "/help",   desc: "显示这份帮助" },
  { name: "/new",    desc: "开新会话（清空上下文）" },
  { name: "/clear",  desc: "清屏（保留当前会话）" },
  { name: "/think",  desc: "显示 / 隐藏思考过程" },
  { name: "/status", desc: "查询账户余额" },
  { name: "/model",  desc: "查看当前模型" },
  { name: "/memory", desc: "查看长期记忆（MEMORY / USER）" },
  { name: "/skills", desc: "查看技能库（沉淀的“一类任务”做法）" },
  { name: "/exit",   desc: "退出（或连按两次 Ctrl+C）" },
];

const HELP_LINES = COMMANDS.map((c) => [`  ${c.name.padEnd(9)}`, c.desc]);

// waiting indicator — Hermes 式：表情脸 + 转动词（verbs.ts 的中文版）轮换
const KAOMOJI = [
  "(・ω・)",
  "(・∀・)",
  "(￣▽￣)",
  "(´▽｀)",
  "(＾▽＾)",
  "(*´ω｀*)",
  "(￣ω￣)",
  "(´∀｀)",
];
const VERBS = [
  "思考中",
  "沉思中",
  "推敲中",
  "琢磨中",
  "盘算中",
  "推演中",
  "酝酿中",
  "推理中",
  "分析中",
  "演算中",
  "综合中",
  "构思中",
  "斟酌中",
  "回味中",
  "灵光乍现中",
];

// HH:MM:SS
function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

function indentBlock(text, pad) {
  const p = " ".repeat(pad);
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => p + l)
    .join("\n");
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

// ---- terminal window title (OSC 0). Carries no width, so it does
//      not disturb ink's redraw bookkeeping. ----
function setWinTitle(t) {
  try {
    process.stdout.write(`\x1b]0;${t}\x07`);
  } catch {
    /* ignore */
  }
}

function bell() {
  try {
    process.stdout.write("\x07");
  } catch {
    /* ignore */
  }
}

let idCounter = 0;
const nextId = () => `h${++idCounter}`;

// ---------------- runner: spawn dsh headless --json ----------------
function runTask(task, sessionId, onEvent, onChild) {
  return new Promise((resolve) => {
    const args = [DSH_BIN, "--profile", "headless", "--json"];
    if (sessionId) args.push("--session-id", sessionId);
    args.push(task);
    const child = spawn(NODE_EXE, args, {
      cwd: WORKSPACE,
      env: { ...process.env, DSH_HOME },
      windowsHide: true,
    });
    if (onChild) onChild(child);
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
    child.stdout.on("data", feed);
    child.stderr.on("data", (d) => {
      const t = d.toString().trim();
      if (t) onEvent({ type: "diag", text: t.split("\n")[0] });
    });
    child.on("error", (e) => {
      onEvent({ type: "diag", text: `spawn error: ${e.message}` });
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 0));
  });
}

// kill a whole process tree on Windows
function killTree(pid) {
  try {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    /* fall through */
  }
}

// ---------------- /status: DeepSeek balance ----------------
async function queryBalance() {
  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY || ""}` },
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json();
    if (!j.balance_infos) return `  余额查询失败：${JSON.stringify(j).slice(0, 120)}`;
    const b = j.balance_infos[0];
    const flag = j.is_available ? "可用" : "不可用";
    return `  余额：${b.total_balance} ${b.currency}（${flag}）`;
  } catch (e) {
    return `  余额查询出错：${e.message}`;
  }
}

// ---------------- minimal single-line input (presentational) ----------------
function Prompt({ value, active }) {
  return (
    <Box borderStyle="round" borderColor={active ? C.accent : C.border} paddingX={1}>
      <Text color={C.prompt} bold>
        {BRAND.prompt + " "}
      </Text>
      <Text>{value}</Text>
      {active && <Text color={C.muted}>▌</Text>}
    </Box>
  );
}

function useInterval(cb, ms) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

// ---------------- main app ----------------
function App() {
  const app = useApp();
  const [feed, setFeed] = useState([]); // Static items: {id, node}
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [statusText, setStatusText] = useState("");
  const [sessionId, setSessionId] = useState(null);
  const [usage, setUsage] = useState(null);
  const [thinkOn, setThinkOn] = useState(true);
  const [verbose, setVerbose] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [lastMs, setLastMs] = useState(0);
  const [queue, setQueue] = useState([]);
  const [panelOn, setPanelOn] = useState(true); // 首屏欢迎面板（含转动的代码地球）
  const exitAttempt = useRef(0);

  // ---- 输入历史（↑/↓ 翻阅）----
  const historyRef = useRef([]);
  const histPosRef = useRef(-1); // -1 = 不在历史浏览中
  const draftRef = useRef("");   // 浏览历史前的未提交草稿

  // refs so the event handler never goes stale
  const frameRef = useRef(0);
  frameRef.current = frame;
  const thinkOnRef = useRef(true);
  thinkOnRef.current = thinkOn;
  const verboseRef = useRef(false);
  verboseRef.current = verbose;
  const textRunRef = useRef(false);
  const childRef = useRef(null);
  const interruptedRef = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const startRef = useRef(0);
  // Hermes 状态栏数据：会话起点 / 上次回合结束时刻 / 每秒心跳
  const sessionStartRef = useRef(Date.now());
  const lastEndRef = useRef(0);
  const [now, setNow] = useState(Date.now());
  // 只在干活时每秒心跳；空闲时完全不重绘 —— 否则钉底帧每秒重写一遍，
  // 用户用滚轮翻历史时会被持续打扰（若有 1 行误差还会每秒滚 1 行爬升）。
  useInterval(() => {
    if (busy) setNow(Date.now());
  }, 1000);

  // 脸与动词慢转只在忙时推进（空闲时零重绘，滚轮翻历史不被打扰）
  useInterval(() => {
    if (busy) setFrame((f) => (f + 1) % KAOMOJI.length);
  }, 2500); // Hermes FACE_TICK_MS
  useInterval(() => {
    if (busyRef.current) setElapsed(Date.now() - startRef.current);
  }, 250);

  const push = useCallback((node) => setFeed((f) => [...f, { id: nextId(), node }]), []);
  const pushText = useCallback(
    (text, opts = {}) => push(<Text {...opts}>{text}</Text>),
    [push]
  );

  // a line prefixed with the current time
  const pushLine = useCallback(
    (now, node) =>
      push(
        <Text>
          <Text color={C.muted}>{now}</Text>
          {node}
        </Text>
      ),
    [push]
  );

  // ---- greeting ----
  useEffect(() => {
    setWinTitle(APP_TITLE);
  }, []);

  // ---- interrupt the running task ----
  const interrupt = useCallback(() => {
    const c = childRef.current;
    if (!c) return;
    childRef.current = null;
    interruptedRef.current = true;
    killTree(c.pid);
    setWinTitle(`${APP_TITLE} — 已打断`);
          pushLine(stamp(), <Text color={C.warn}>{`  ⚡ 已打断当前任务`}</Text>);
  }, [pushLine]);

  // ---- input mirror + typing handler ----
  const inputRef = useRef("");
  inputRef.current = input;
  const handleInput = useCallback((t) => {
    setInput(t);
  }, []);

  const { stdout: inkStdout } = useStdout();
  // ---- terminal height: the welcome panel must NEVER exceed the viewport.
  // If it does, ink's per-frame cursor-up redraw falls off the top and every
  // frame prints a fresh screen — the "endless scrolling" bug. ----
  const [termRows, setTermRows] = useState(inkStdout?.rows || 30);
  useEffect(() => {
    const so = inkStdout;
    if (!so || typeof so.on !== "function") return;
    const onResize = () => setTermRows(so.rows || 30);
    so.on("resize", onResize);
    return () => {
      so.off("resize", onResize);
    };
  }, [inkStdout]);
  const layout = React.useMemo(() => {
    const rows = termRows || 30;
    // 高度账（按各档下限校核）：全屏 = marginTop1 + 头部(logo6+版本1+边距1) +
    // 面板(边框2+padding2+max(左=logo位+4, 右=工具7+技能区+汇总)) + 提示2 + 输入3 + 状态1。
    // 右栏满配 ≈19（技能 8 行时）→ 面板 23；42+: 1+8+23+2+3+1=38 ≤ 41 ✓
    // 36-41: mini 头 2 + 面板 23 + 2+3+1 = 31 ≤ 35 ✓
    // 30-35: 不显技能（右栏 9），logo 位 8 → 面板 16 → 1+2+16+2+3+1=25 ≤ 29 ✓
    // <30:   无 logo 位（左栏 3）→ 面板 13 → 1+2+13+2+3+1=22；<24 再砍提示行。
    if (rows >= 42) return { heroRows: 12, miniLogo: false, showSkills: true, showTips: true };
    if (rows >= 36) return { heroRows: 11, miniLogo: true, showSkills: true, showTips: true };
    if (rows >= 30) return { heroRows: 8, miniLogo: true, showSkills: false, showTips: true };
    if (rows >= 24) return { heroRows: 0, miniLogo: true, showSkills: false, showTips: true };
    return { heroRows: 0, miniLogo: true, showSkills: false, showTips: false };
  }, [termRows]);

  // ---- 输入框钉底（v0.11.2）----
  // 用户诉求：发消息后输入框/状态栏要一直钉在窗口底部，滚轮能正常翻历史。
  // 做法：把动态区垫高到 rows-3 行（留 2 行安全余量：ink 对每行都输出换行、
  // 块元素还会多一行，帧高 ≥ rows 会触发 ink 每帧重绘滚一行 → 无限上滚）。
  // 帧高账必须与 WelcomePanel 的 JSX 严格同步（见下方各常量注释）。
  const skillsCount = React.useMemo(
    () => (layout.showSkills ? loadSkills().length : 0),
    [layout.showSkills],
  );
  const frameRows = React.useMemo(() => {
    if (!panelOn) return 3 + 1; // 对话态：输入框 3 + 状态栏 1
    // 欢迎态：marginTop1 + 面板 + 欢迎行1 + 提示(0/1) + 输入3 + 状态1
    const headH = layout.miniLogo ? 2 : 8; // mini=标题1+边距1 / 全配=logo6+版本1+边距1
    const rightH = layout.showSkills
      ? 9 + 2 + (skillsCount === 0 ? 1 : Math.min(skillsCount, 6) + (skillsCount > 6 ? 1 : 0))
      : 9; // 工具头1+工具6+空行1+汇总1 = 9；技能区=空行1+头1+内容N
    const innerH = Math.max(layout.heroRows + 3, rightH); // hero=logo位+模型/工作区/会话3行
    const panelH = headH + 4 + innerH; // +上下边框2+paddingY2
    return 1 + panelH + 1 + (layout.showTips ? 1 : 0) + 3 + 1;
  }, [panelOn, layout, skillsCount]);
  const padRows = Math.max(0, (termRows || 30) - 3 - frameRows);

  // ---- global keys (chars, editing, history, commands) ----
  const submitRef2 = useRef(null); // set after onSubmit is defined below
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "o") {
        setVerbose((v) => !v);
        return;
      }
      // ↑/↓: browse input history
      if (key.upArrow || key.downArrow) {
        const h = historyRef.current;
        if (h.length === 0) return;
        if (key.upArrow) {
          if (histPosRef.current === -1) draftRef.current = inputRef.current;
          const p = Math.min(h.length - 1, histPosRef.current + 1);
          histPosRef.current = p;
          handleInput(h[h.length - 1 - p]);
        } else {
          if (histPosRef.current === -1) return;
          const p = histPosRef.current - 1;
          histPosRef.current = p;
          handleInput(p === -1 ? draftRef.current : h[h.length - 1 - p]);
        }
        return;
      }
      if (key.escape) {
        interrupt();
        return;
      }
      if (key.ctrl && ch === "c") {
        exitAttempt.current += 1;
        if (!busy || exitAttempt.current >= 2) app.exit();
        else setStatusText("再按一次 Ctrl+C 强制退出");
        return;
      }
      if (key.return) {
        submitRef2.current && submitRef2.current(inputRef.current);
        return;
      }
      if (key.backspace || key.delete) {
        handleInput(inputRef.current.slice(0, -1));
        return;
      }
      if (key.ctrl || key.meta) return;
      if (ch && ch >= " ") handleInput(inputRef.current + ch);
    },
    { isActive: true }
  );

  // ---- handle one json event from the kernel ----
  const handleEvent = useCallback(
    (ev) => {
      switch (ev.type) {
        case "session":
          // first turn: the kernel assigns the durable session id
          if (ev.sessionId || ev.id) setSessionId(ev.sessionId || ev.id);
          break;
        case "status": {
          textRunRef.current = false;
          const phase = ev.phase;
          if (phase === "turn_start") setStatusText("开始处理");
          else if (phase === "step_start")
            setStatusText(ev.step ? `思考中（第 ${ev.step} 步）` : "思考中");
          else if (phase === "step_end") {
            if (ev.usage) setUsage((u) => ({ ...(u || {}), ...ev.usage }));
            setStatusText("收尾中");
          } else if (phase === "turn_end") {
            setStatusText("");
            lastEndRef.current = Date.now();
            if (ev.reason && ev.reason.kind && ev.reason.kind !== "completed") {
              pushLine(stamp(), <Text color={C.warn}>{`  结束：${ev.reason.kind}`}</Text>);
            }
          }
          break;
        }

        case "thinking": {
          setWinTitle(`${APP_TITLE} — 思考中`);
          if (!thinkOnRef.current) break;
          const t = (ev.text || "").trim();
          if (!t) break;
          push(
            <Text color={C.muted} italic>
              <Text color={C.muted}>{stamp()}</Text>
              <Text color={C.label}>{`  ${BRAND.tool} 思考 · `}</Text>
              {indentBlock(t, 10)}
            </Text>
          );
          break;
        }

        case "text": {
          setWinTitle(`${APP_TITLE} — 回答中`);
          if (!ev.text) break;
          if (!textRunRef.current) {
            textRunRef.current = true;
            pushLine(stamp(), <Text color={C.accent}>{`  ${BRAND.tool} 回答 · `}</Text>);
            pushText(ev.text);
          } else {
            pushText(ev.text);
          }
          break;
        }

        case "tool_call": {
          textRunRef.current = false;
          const name = ev.name || ev.tool || "tool";
          setWinTitle(`${APP_TITLE} — 工具 ${name}`);
          const args = ev.args ?? ev.input ?? ev.params;
          let argStr = "";
          if (typeof args === "string") argStr = truncateOne(args, 80);
          else if (args) {
            if (args.command) argStr = truncateOne(String(args.command), 80);
            else if (args.path || args.file_path)
              argStr = String(args.path || args.file_path);
            else argStr = truncateOne(JSON.stringify(args), 80);
          }
          pushLine(
            stamp(),
            <>
              <Text color={C.accent}>{`  ${BRAND.tool} `}</Text>
              <Text color={C.accent}>{name}</Text>
              <Text color={C.muted}>{argStr ? `(${argStr})` : ""}</Text>
            </>
          );
          break;
        }

        case "tool_result": {
          textRunRef.current = false;
          const ok = (ev.ok ?? ev.success ?? !ev.error) !== false;
          const body = ev.output ?? ev.text ?? ev.result ?? ev.error ?? "";
          const hasBody = typeof body === "string" && body.trim();
          if (verboseRef.current && hasBody) {
            pushLine(
              stamp(),
              <Text color={ok ? C.ok : C.error}>{ok ? `  ${BRAND.tool} ✓ 结果` : `  ${BRAND.tool} ✗ 结果`}</Text>
            );
            push(<Text color={C.muted}>{indentBlock(body.trim(), 10)}</Text>);
          } else {
            const preview = hasBody ? truncateOne(body, 100) : "";
            pushLine(
              stamp(),
              <>
                <Text color={ok ? C.ok : C.error}>{`  ${BRAND.tool} ${ok ? "✓" : "✗"} `}</Text>
                <Text color={C.muted}>{preview}</Text>
              </>
            );
          }
          break;
        }

        case "diag":
          pushLine(stamp(), <Text color={C.muted}>{`  ${ev.text}`}</Text>);
          break;

        case "error":
          pushLine(
            stamp(),
            <Text color={C.error}>{`  错误：${ev.message || JSON.stringify(ev).slice(0, 120)}`}</Text>
          );
          break;

        default:
          break;
      }
    },
    [push, pushText, pushLine]
  );

  // ---- submit a task ----
  const submitTask = useCallback(
    async     (task) => {
      setPanelOn(false); // 开始干活，收起首屏
      pushLine(stamp(), <Text bold color={C.prompt}>{`  ${BRAND.prompt} ${task}`}</Text>);
      setBusy(true);
      exitAttempt.current = 0;
      interruptedRef.current = false;
      startRef.current = Date.now();
      setElapsed(0);
      setStatusText("已发送");
      setWinTitle(`${APP_TITLE} — 处理中`);
      const code = await runTask(task, sessionId, handleEvent, (c) => {
        childRef.current = c;
      });
      const took = Date.now() - startRef.current;
      childRef.current = null;
      setBusy(false);
      setStatusText("");
      textRunRef.current = false;
      if (interruptedRef.current) {
        // already announced by interrupt()
      } else {
        setLastMs(took);
        if (code !== 0) {
          pushLine(stamp(), <Text color={C.muted}>{`  （退出码 ${code}）`}</Text>);
        }
        pushLine(stamp(), <Text color={C.muted}>{`  ⏱ 用时 ${fmtSecs(took)}`}</Text>);
        if (took >= BELL_AFTER_MS) bell();
        setWinTitle(`${APP_TITLE} — 完成`);
      }
      pushText(" ");
    },
    [sessionId, handleEvent, pushText, pushLine]
  );

  // ---- queue: when idle, run the next queued instruction ----
  const submitRef = useRef(null);
  submitRef.current = submitTask;
  useEffect(() => {
    if (busy || queue.length === 0) return;
    const next = queue[0];
    setQueue((q) => q.slice(1));
    submitRef.current(next);
  }, [busy, queue]);

  const enqueue = useCallback(
    (task) => {
      setQueue((q) => [...q, task]);
      pushLine(stamp(), <Text color={C.warn}>{`  ⏳ 已排队：${task}`}</Text>);
    },
    [pushLine]
  );

  // ---- slash commands ----
  const runCommand = useCallback(
    async (cmd) => {
      setPanelOn(false); // 执行命令即进入工作状态，收起首屏
      const [name] = cmd.split(/\s+/);
      switch (name) {
        case "/help":
          pushText(`  ${BRAND.helpHeader}`, { bold: true, color: C.primary });
          pushText(" ");
          pushText("  常用命令", { bold: true, color: C.accent });
          for (const [c, d] of HELP_LINES) {
            push(
              <Text>
                <Text color={C.label}>{c}</Text>
                <Text color={C.muted}>{d}</Text>
              </Text>
            );
          }
          pushText(" ");
          pushText("  快捷键", { bold: true, color: C.accent });
          for (const [k, d] of KEY_HINTS) {
            push(
              <Text>
                <Text color={C.label}>{k.padEnd(10)}</Text>
                <Text color={C.muted}>{d}</Text>
              </Text>
            );
          }
          pushText(" ");
          break;
        case "/new":
          setSessionId(null);
          setUsage(null);
          setLastMs(0);
          pushText("  已开新会话（上下文已清空）", { color: C.muted });
          pushText(" ");
          break;
        case "/clear":
          setFeed([]);
          break;
        case "/think":
          setThinkOn((v) => {
            pushText(v ? "  已隐藏思考过程" : "  已显示思考过程", { color: C.muted });
            pushText(" ");
            return !v;
          });
          break;
        case "/status": {
          pushText("  正在查询余额…", { color: C.muted });
          const msg = await queryBalance();
          pushText(msg, { color: C.muted });
          pushText(" ");
          break;
        }
        case "/model":
          pushText(`  当前模型：${MODEL}  （provider: deepseek-official）`, { color: C.muted });
          pushText("  换供应商改 data/profiles/headless/cordis.patch.yml", { color: C.muted });
          pushText(" ");
          break;
        case "/memory": {
          const showMem = (label, file) => {
            let body;
            try {
              body = fs.readFileSync(file, "utf8").trim();
            } catch {
              body = "（暂无）";
            }
            pushText(`  ${label} —— ${file}`, { bold: true, color: C.accent });
            if (body === "（暂无）") pushText("  （暂无）", { color: C.muted });
            else for (const l of body.split("\n")) pushText("  " + l, { color: C.fade });
            pushText(" ");
          };
          showMem("长期记忆 · Agent 笔记", path.join(WORKSPACE, "MEMORY.md"));
          showMem("长期记忆 · 用户画像", path.join(WORKSPACE, "USER.md"));
          pushText("  提示：直接对 Agent 说「记住：…」即可写入；下次启动生效。", { color: C.muted });
          pushText(" ");
          break;
        }
        case "/skills": {
          const skillsDir = path.join(WORKSPACE, "skills");
          let entries = [];
          try {
            entries = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
          } catch {}
          if (entries.length === 0) {
            pushText("  技能库为空。", { color: C.muted });
            pushText("  对 Agent 说「把这件事沉淀成技能」即可新建（写进 skills/<名字>/SKILL.md）。", { color: C.muted });
          } else {
            pushText(`  技能库 —— ${skillsDir}  （共 ${entries.length} 个）`, { bold: true, color: C.accent });
            for (const e of entries) {
              const skillMd = path.join(skillsDir, e.name, "SKILL.md");
              let desc = "";
              try {
                const t = fs.readFileSync(skillMd, "utf8");
                const m = /^\s*description\s*:\s*(.+)$/m.exec(t);
                if (m) desc = m[1].trim().replace(/^["']|["']$/g, "");
              } catch {}
              pushText(`  · ${e.name}${desc ? "  —  " + desc : ""}`, { color: C.fade });
            }
          }
          pushText("  提示：技能内容在 skills/<名字>/SKILL.md，下次启动加载进提示。", { color: C.muted });
          pushText(" ");
          break;
        }
        case "/exit":
          pushText(`  ${BRAND.goodbye}`, { color: C.muted });
          setTimeout(() => app.exit(), 80);
          break;
        default:
          pushText(`  未知命令：${name}  （试试 /help）`, { color: C.error });
          pushText(" ");
      }
    },
    [push, pushText]
  );

  const onSubmit = useCallback(
    (raw) => {
      const task = raw.trim();
      if (!task) return;
      // 记进输入历史（↑ 可翻回）
      historyRef.current.push(task);
      if (historyRef.current.length > 100) historyRef.current.shift();
      histPosRef.current = -1;
      handleInput("");
      if (task.startsWith("/")) {
        pushText(`  ${BRAND.prompt} ${task}`, { bold: true, color: C.prompt });
        runCommand(task);
        return;
      }
      if (busy) {
        enqueue(task);
        return;
      }
      submitTask(task);
    },
    [busy, enqueue, runCommand, submitTask, pushText, handleInput]
  );

  // expose the latest onSubmit to the key handler above
  submitRef2.current = onSubmit;

  const short = sessionId ? sessionId.replace("session-", "").slice(0, 8) : "new";

  // ---- Hermes 状态栏数据 ----
  // ⏺ 状态 + 模型 │ ctx 已用/上限 │ [██░░] 百分比 │ 会话时长 │ ● 空闲 ── 右端工作区
  const ctxUsed = usage ? (usage.inputTokens || 0) + (usage.outputTokens || 0) : 0;
  const ctxPctV = ctxUsed > 0 ? (ctxUsed / CONTEXT_WINDOW) * 100 : null;
  const barFill = ctxPctV == null ? 0 : Math.round((Math.min(100, ctxPctV) / 100) * 10);
  const ctxBarStr = "█".repeat(barFill) + "░".repeat(10 - barFill);
  const barColor =
    ctxPctV == null ? C.muted : ctxPctV >= 95 ? C.error : ctxPctV > 80 ? C.error : ctxPctV >= 50 ? C.warn : C.ok;
  const sessDur = fmtSecs(now - sessionStartRef.current);
  const idleFor = !busy && lastEndRef.current ? fmtSecs(now - lastEndRef.current) : null;

  return (
    <Box flexDirection="column">
      <Static items={feed}>
        {(item) => (
          <Box key={item.id} flexDirection="column">
            {item.node}
          </Box>
        )}
      </Static>

      {/* 欢迎面板留在动态区（Static 只渲染一次，后续 logo 若带动画必须放这里） */}
      {panelOn && (
        <Box marginTop={1} flexDirection="column">
          <WelcomePanel
            sessionShort={sessionId ? short : "新会话（首条消息后生成）"}
            heroRows={layout.heroRows}
            miniLogo={layout.miniLogo}
            showSkills={layout.showSkills}
          />
          <Text color={C.muted}>{`  ${BRAND.icon} ${BRAND.welcome}`}</Text>
          {layout.showTips && (
            <Text color={C.muted}>
              {`  ✦ 提示：`}
              {KEY_HINTS.map(([k, d], i) => (
                <Text key={k}>
                  {i > 0 ? " · " : ""}
                  <Text color={C.label}>{k}</Text>
                  {" " + d}
                </Text>
              ))}
            </Text>
          )}
        </Box>
      )}

      {/* 钉底垫高：把输入框/状态栏推到窗口底部（动态区恒为 rows-2 行） */}
      {padRows > 0 && <Box height={padRows} flexShrink={0} />}

      <Prompt value={input} active={true} />

      {/* Hermes 状态栏：⏺ 模型 │ ctx │ [条]% │ 时长 │ ● 空闲 ── 右端工作区 */}
      <Box marginTop={0} justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text color={C.border}>─ </Text>
          {busy ? (
            <Text color={C.primary}>
              {`${KAOMOJI[frame % KAOMOJI.length]} ${VERBS[frame % VERBS.length]} ${fmtSecs(elapsed)}`}
              {queue.length > 0 ? <Text color={C.warn}>{`  ⏳ 排队 ${queue.length}`}</Text> : null}
            </Text>
          ) : (
            <Text color={C.ok}>⏺</Text>
          )}
          <Text color={C.muted}> │ </Text>
          <Text color={C.text}>{MODEL}</Text>
          <Text color={C.muted}>{` │ ctx ${ctxUsed > 0 ? `${fmtTokens(ctxUsed)}/${fmtTokens(CONTEXT_WINDOW)}` : "──"}`}</Text>
          <Text color={C.muted}> │ </Text>
          <Text color={barColor}>[{ctxBarStr}]</Text>
          <Text color={barColor}>{ctxPctV == null ? " ──" : ` ${ctxPctV.toFixed(1)}%`}</Text>
          <Text color={C.muted}>{` │ ${sessDur}`}</Text>
          {idleFor && (
            <>
              <Text color={C.muted}> │ </Text>
              <Text color={C.dollar}>● </Text>
              <Text color={C.muted}>{idleFor}</Text>
            </>
          )}
          {thinkOn ? null : <Text color={C.warn}> │ 思考已隐藏</Text>}
          {verbose ? <Text color={C.warn}> │ 详细模式</Text> : null}
        </Text>
        <Text color={C.muted}>{`${WORKSPACE} `}</Text>
      </Box>
    </Box>
  );
}

export { App };

// autorun unless a test harness imports this module
if (!process.env.TUI_NO_AUTORUN) {
  render(<App />);
}
