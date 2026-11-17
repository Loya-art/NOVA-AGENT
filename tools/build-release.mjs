// ============================================================
//  build-release.mjs - 组装「解压即用」便携发布目录并打 zip
//  用法: node tools/build-release.mjs
//  产物: release/NOVA-Agent/  +  release/NOVA-Agent-v<ver>-portable.zip
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const OUT = path.join(ROOT, "release", "NOVA-Agent");

const read = (p) => fs.readFileSync(p, "utf8");
const copy = (src, dest) => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, force: true });
};

// ---- 0. 版本号从源码取 ----
const tuiSrc = read(path.join(ROOT, "app", "ui", "src", "tui.mjs"));
const VERSION = /const VERSION = "([^"]+)"/.exec(tuiSrc)?.[1] || "0.0.0";
const ZIP = path.join(ROOT, "release", `NOVA-Agent-v${VERSION}-portable.zip`);

console.log(`== NOVA-Agent v${VERSION} release build ==`);

// ---- 1. 先重新打包 TUI bundle（保证产物 = 源码）----
console.log("-- building TUI bundle...");
execSync("node ui/build.mjs", { cwd: path.join(ROOT, "app"), stdio: "inherit" });

// ---- 2. 组装输出目录（可续跑：不整树删除；node_modules 已在则跳过）----
console.log("-- assembling release dir...");
fs.mkdirSync(OUT, { recursive: true });

// 根部：启动脚本 + 文档 + 图标
for (const f of ["NOVA-AGENT.bat", "SETUP.bat", "INSTALL-USB.bat", "CHECK.bat", "README.md", "LICENSE"]) {
  fs.copyFileSync(path.join(ROOT, f), path.join(OUT, f));
}
fs.mkdirSync(path.join(OUT, "assets"), { recursive: true });
for (const f of ["icon.ico", "icon-512.png", "icon.svg", "icon-pixel.svg", "icon-pixel-512.png", "icon-pixel-map.txt"]) {
  fs.copyFileSync(path.join(ROOT, "assets", f), path.join(OUT, "assets", f));
}
// 文件夹图标（资源管理器里直接显示年兽）
fs.writeFileSync(
  path.join(OUT, "desktop.ini"),
  '[.ShellClassInfo]\r\nIconResource=assets\\icon.ico,0\r\nInfoTip=NOVA Agent - portable AI agent\r\n',
  "utf8"
);

// 运行时
copy(path.join(ROOT, "runtime", "node"), path.join(OUT, "runtime", "node"));

// app：代码 + 依赖（不含开发用抓帧/golden 产物）
for (const f of [".npmrc", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "vault.mjs", "assemble-memory.mjs"]) {
  const dest = path.join(OUT, "app", f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "app", f), dest);
}
fs.mkdirSync(path.join(OUT, "app", "ui"), { recursive: true });
copy(path.join(ROOT, "app", "templates"), path.join(OUT, "app", "templates"));
copy(path.join(ROOT, "app", "ui", "src"), path.join(OUT, "app", "ui", "src"));
fs.copyFileSync(path.join(ROOT, "app", "ui", "bundle.mjs"), path.join(OUT, "app", "ui", "bundle.mjs"));
const NM = path.join(OUT, "app", "node_modules");
if (fs.existsSync(path.join(NM, ".pnpm"))) {
  console.log("-- app/node_modules already present, skip copy (要强制重拷请删 release/NOVA-Agent)");
} else {
  copy(path.join(ROOT, "app", "node_modules"), NM);
}

// tools：只带用户用得到的
fs.mkdirSync(path.join(OUT, "tools"), { recursive: true });
for (const f of ["preflight.mjs", "make-shortcut.ps1", "make-icon.mjs", "make-pixel-icon.mjs", "check-secrets.mjs"]) {
  fs.copyFileSync(path.join(ROOT, "tools", f), path.join(OUT, "tools", f));
}

// ---- 3. 干净的默认 data/（无任何个人数据、无密钥）----
console.log("-- writing default data/...");
const DATA = path.join(OUT, "data");
for (const d of ["sessions", "storages", "skills", "personas", "attachments", "profiles/headless"]) {
  fs.mkdirSync(path.join(DATA, d), { recursive: true });
}
fs.writeFileSync(path.join(DATA, "skills", "README.txt"),
  "把带 SKILL.md 的技能目录平铺放进这里，重启界面即生效。\r\n", "utf8");
fs.writeFileSync(path.join(DATA, "personas", "README.txt"),
  "把人设 .md 文件放进这里，界面 /persona 选择启用。\r\n", "utf8");
// 默认路由：DeepSeek 官方（首次配置向导会按用户选择重写）
const tpl = read(path.join(ROOT, "app", "templates", "cordis.patch.yml.tpl"))
  .replace("{{DEFAULT_PROVIDER}}", "deepseek-official")
  .replace("{{DEFAULT_MODEL}}", "deepseek-flash")
  .replace("{{DEEPSEEK_BASEURL}}", "")
  .replace("{{PIAI_PROVIDERS}}", "      {}");
fs.writeFileSync(path.join(DATA, "profiles", "headless", "cordis.patch.yml"), tpl, "utf8");

// workspace：空目录 + 一份说明
fs.mkdirSync(path.join(OUT, "workspace"), { recursive: true });
fs.writeFileSync(path.join(OUT, "workspace", "README.txt"),
  "这是 Agent 的工作目录：它在这里读写文件。\r\n", "utf8");

// ---- 4. 密钥扫描（发布物里绝不许出现真 Key）----
console.log("-- scanning release for secrets...");
const secretRe = /sk-[a-zA-Z0-9_-]{16,}|曾智贤|C:\\Users\\/;
let found = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (e.name.endsWith(".node") || p.includes("node_modules")) continue; // 依赖不扫
    if (p.endsWith("check-secrets.mjs")) continue; // 扫描器自身含检测模式字符串
    try {
      const t = fs.readFileSync(p, "utf8");
      if (secretRe.test(t)) found.push(path.relative(OUT, p));
    } catch {}
  }
};
walk(OUT);
if (found.length) {
  console.error("  ✗ 发现疑似敏感内容，停止发布：");
  found.forEach((f) => console.error("    " + f));
  process.exit(1);
}
console.log("  ✓ clean");

// ---- 5. 打 zip（Windows 自带 bsdtar）----
console.log("-- zipping...");
fs.rmSync(ZIP, { force: true });
execSync(`& "${path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")}" -a -c -f "${ZIP}" NOVA-Agent`, {
  cwd: path.join(ROOT, "release"), stdio: "inherit", shell: "powershell.exe",
});

// ---- 6. 汇总 ----
const dirSize = (d) => {
  let s = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    s += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return s;
};
const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";
console.log(`\n== done ==`);
console.log(`dir : ${OUT}  (${mb(dirSize(OUT))})`);
console.log(`zip : ${ZIP}  (${mb(fs.statSync(ZIP).size)})`);
const require2 = createRequire(path.join(ROOT, "app", "package.json"));
try {
  const crypto = require2("node:crypto");
  const h = crypto.createHash("sha256").update(fs.readFileSync(ZIP)).digest("hex");
  console.log(`sha256: ${h}`);
} catch {}
