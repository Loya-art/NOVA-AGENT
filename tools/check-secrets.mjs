// ============================================================
//  check-secrets.mjs - 提交前密钥/隐私扫描
//  用法: node tools/check-secrets.mjs [目录]
//  扫描将被 git 跟踪的文件，发现疑似密钥/个人路径即非零退出。
// ============================================================
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

let files;
try {
  files = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean);
} catch {
  console.error("[ERR] 请先 git init 再运行本扫描。");
  process.exit(2);
}

const patterns = [
  [/sk-[a-zA-Z0-9_-]{16,}/, "疑似 API Key (sk-...)"],
  [/gsk_[a-zA-Z0-9_-]{16,}/, "疑似 Groq Key"],
  [/ghp_[a-zA-Z0-9]{20,}|gho_[a-zA-Z0-9]{20,}/, "疑似 GitHub Token"],
  [/AKIA[0-9A-Z]{16}/, "疑似 AWS AccessKey"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "疑似私钥"],
  [/曾智贤/, "个人姓名/路径"],
  [/C:\\Users\\/, "本机用户路径"],
];

let bad = 0;
const SELF = "tools/check-secrets.mjs"; // 扫描器自身含检测模式字符串，跳过
for (const f of files) {
  if (f.replace(/\\/g, "/") === SELF) continue;
  const p = path.join(ROOT, f);
  let text;
  try { text = fs.readFileSync(p, "utf8"); } catch { continue; }
  for (const [re, label] of patterns) {
    const m = re.exec(text);
    if (m) {
      const lineNo = text.slice(0, m.index).split("\n").length;
      console.log(`  ✗ ${f}:${lineNo}  ${label}  →  ${text.split(/\r?\n/)[lineNo - 1].trim().slice(0, 60)}`);
      bad++;
    }
  }
}
console.log(bad ? `\n发现 ${bad} 处疑似敏感内容，禁止提交！` : "✓ 未发现密钥/隐私内容，可以提交。");
process.exit(bad ? 1 : 0);
