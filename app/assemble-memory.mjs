#!/usr/bin/env node
// ============================================================
//  Long-term memory + skill-index assembler (Hermes-style, adapted to DSH)
//
//  Hermes design we borrow (reverse-engineered 2026-10-11):
//    - MEMORY.md = agent notes, USER.md = user profile
//    - both are injected into the system prompt as a FROZEN
//      snapshot at session start; mid-session writes hit disk
//      but never change the running prompt (prefix-cache stable)
//    - skills are PROCEDURAL memory: SKILL.md per class of task,
//      listed by name + one-line description in the skill index
//    - "one fact goes to ONE store" routing prevents bloat
//
//  Our adaptation:
//    workspace/MEMORY.md + workspace/USER.md + workspace/skills/
//      -> this script assembles them into data/AGENTS.md
//      -> both launchers run it BEFORE booting dsh
//
//  Zero-dependency, run with the portable node.
// ============================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKSPACE = path.join(ROOT, "workspace");
const AGENTS_MD = path.join(ROOT, "data", "AGENTS.md");
const MEMORY_MD = path.join(WORKSPACE, "MEMORY.md");
const USER_MD = path.join(WORKSPACE, "USER.md");
const SKILLS_DIRS = [path.join(ROOT, "data", "skills"), path.join(WORKSPACE, "skills")];

// char budgets (Hermes uses 2200/1375; generous margin fits our 64KB cap)
const MEMORY_LIMIT = 2400;
const USER_LIMIT = 1400;
const SKILL_DESC_LIMIT = 60; // Hermes truncates the index at 57; we mirror the intent

// the frozen rules block: teaches the agent HOW to maintain memory + skills
const RULES = `# 工作约定

这个 Agent 的使用者是中文用户。

- **思考过程（reasoning / thinking）一律用简体中文。** 不要用英文思考。
- 回答也用简体中文，简洁直接，少客套。
- 引用代码、命令、路径、报错原文时保持原样，不要翻译。

# 长期记忆与技能（重要）

下面三块（用户画像 / Agent 笔记 / 技能库）是**启动时冻结的快照**，
会话中途的修改不会出现在本快照里，但**下次启动生效**。

## 一、事实该写在哪儿（一个事实只进一个地方）

| 事实类型 | 归属 | 例子 |
|---|---|---|
| **用户是谁** | \`USER.md\` | 身份、长期偏好、沟通风格、对你行为的期望 |
| **环境事实** | \`MEMORY.md\` | 工具特性、项目约定、配置坑、有用的路径/接口 |
| **一类任务怎么做** | 技能 \`data/skills/<名字>/SKILL.md\` | 步骤、命令、顺序、用户对结果的偏好、踩过的坑 |

一个事实**只写一处**，不要两处都写——两处都写会让两份文件都膨胀到上限，还把真正重要的事实挤掉。
任务相关的知识（某类活的流程/坑）属于技能，**不要塞进 MEMORY.md**：记忆每次会话都注入，
必须保持小；技能只在相关时才加载。

## 二、不要写入的东西（会变成自我设限，环境一变就咬你）

- **环境依赖的失败**：缺某个命令、没装包、路径对不上、"command not found"。
  用户能修好，这些不是持久规则。
- **对工具/功能的负面断言**（"XX 工具坏了""用不了 YY"）：环境修好后它还在，
  会变成你日后拿来自我拒绝的理由。
- **会话中已自愈的临时错误**：如果重试就好了，教训是"重试"这个模式，不是那次失败本身。
- **一次性的任务叙述**（"帮我总结今天的行情"）：不构成一类可复用的工作。
- **未解决的失败**：如果会话结束时你并没有找到真正可用的方法，不要把那些失败的尝试
  写成"可靠流程/推荐做法"——那是把没验证过的一串失败包装成经验，未来的你会照做。

> 如果某个工具因为环境没配好而失败，记的是**修复方法**（安装命令、配置步骤、要设的环境变量），
> 不是"这个工具不行"。

## 三、什么时候沉淀技能

会话中出现以下**任一**信号，就该写/更新技能：

- 用户纠正了你的**风格 / 格式 / 啰嗦程度 / 表达方式** → 把这条偏好写进管这类任务的技能，
  让下次会话一开始就知道（这属于技能信号，不只是记忆信号）。
- 用户纠正了你的**流程 / 步骤 / 顺序** → 把纠正写成一个明确的步骤或"坑"。
- 出现了**不平凡的技术、修复、绕法、调试路径、工具用法** → 记下来。
- 之前加载/查阅过的技能**有错、缺步骤、过时** → 现在就改。

**优先级（选最早能用的那一条）**：

1. **更新本次已加载/已读的技能**——它当时在场上，最该它来承载新教训。
2. **更新一个已有的伞形技能**（覆盖同一类任务的）。
3. **往已有伞技能里加支持文件**：\`references/<主题>.md\`（选填的深度：决策表、配方、坑）、
   \`templates/\`（可复制改的模板）、\`scripts/\`（可直接跑的脚本）。
4. 以上都不沾边时，才**新建一个"类级"技能**。名字必须是**一类任务**，
   不能是 PR 号 / 报错串 / 某天的临时名（"修-X-今天"这种名字只对今天有意义，说明它该往 1/2/3 走）。

## 四、技能文件格式

\`\`\`
---
name: 小写-连字符-名字
description: 一句话，≤60 字符，以句号结尾，说清"什么时候用这个技能"。
---

# 标题

2-3 句话：做什么、不做什么。

## 何时用
- 具体触发场景/说法

## 步骤
1. 按顺序的可复制命令/操作

## 坑
- 通则 + 一句为什么（机制），祈使句；不要写成"今天发生了什么"的流水账。
- 不要写 PR 号 / 日期 / 工单号 / 用户原话；规则要能脱离那次事件独立成立。

## 验证
- 一条能证明做对了的命令/检查
\`\`\`

**要点**：把工作流和坑写进技能，不要复述仓库里已有的 AGENTS.md 或工具的说明文字。
同一个教训学了两遍就是**一条规则**，先去技能里找有没有，加强它而不是再抄一遍。

## 五、记忆条目怎么写

- 每条一个 \`- \` 列表项，短句，带上下文。
- 修改已有条目用 edit，**不要追加重复项**。
- 预算：MEMORY.md ≤ ${MEMORY_LIMIT} 字符，USER.md ≤ ${USER_LIMIT} 字符。
  超预算时先合并/删除过时条目，保留最有长期价值的。
- **写入后告知**：写完用一句话告诉用户你记住了什么/更新了什么技能（不要复述全文）。
- **快照冻结**：不要在回答里假设本会话刚写的内容已出现在本提示中；需要时直接读文件。

## 六、提问格式

需要用户做选择/确认时，直接用编号选项提问（1. 2. 3.，推荐的放第一个并标注「（推荐）」），
用户回复编号即可；不要用不存在的提问工具。`;

function readBounded(file, label, limit) {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch {
    return `（暂无${label}）`;
  }
  if (!text) return `（暂无${label}）`;
  if (text.length > limit) {
    // keep the TAIL (newest entries are appended at the bottom)
    text = "…（前面已截断，超预算）\n" + text.slice(-limit);
  }
  return text;
}

// --- skill index (Hermes-style: name + one-line description) ------------
function parseFrontmatter(text) {
  const m = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const fm = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^\s*([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    // YAML 折叠块（> / |）：往下收集缩进行，拼成一行
    if (/^[>|][-+]?$/.test(v)) {
      const parts = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === "") continue;
        if (/^[ \t]/.test(lines[j])) parts.push(lines[j].trim());
        else break;
      }
      v = parts.join(" ");
    }
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    fm[kv[1]] = v;
  }
  return fm;
}

function collectSkills() {
  const seen = new Set();
  const out = [];
  for (const dir of SKILLS_DIRS) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const d of dirs) {
      if (seen.has(d.name)) continue;
      const skillMd = path.join(dir, d.name, "SKILL.md");
      let text = "";
      try {
        text = fs.readFileSync(skillMd, "utf8");
      } catch {
        continue;
      }
      seen.add(d.name);
      const fm = parseFrontmatter(text);
      const name = (fm.name || d.name).trim();
      let desc = (fm.description || "").trim();
      if (desc.length > SKILL_DESC_LIMIT) desc = desc.slice(0, SKILL_DESC_LIMIT - 3) + "...";
      out.push({ name, desc });
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

const skills = collectSkills();
let skillsBlock;
if (skills.length === 0) {
  skillsBlock = "（技能库为空。遇到值得沉淀的“一类任务”时，按上面的格式在 `data/skills/<名字>/SKILL.md` 建一个。）";
} else {
  // 注意：完整清单（名字 + 描述）由内核的 skill-filesystem 插件注入系统提示的
  // available_skills，这里再列一遍只会白烧 token，所以只给总数 + 一段速览。
  const names = skills.map((s) => s.name);
  const PREVIEW = 24;
  skillsBlock =
    `共 **${skills.length}** 个，实体在 \`data/skills/<名字>/SKILL.md\`（内核已把完整清单注入系统提示的 available_skills，这里不重复）。\n` +
    `按字母序前 ${Math.min(PREVIEW, names.length)} 个：${names.slice(0, PREVIEW).join("、")}${names.length > PREVIEW ? " …" : ""}\n` +
    `要用某个技能时，直接读它的 \`SKILL.md\` 全文，别凭技能名猜内容。`;
}

const memory = readBounded(MEMORY_MD, "Agent 记忆", MEMORY_LIMIT);
const user = readBounded(USER_MD, "用户画像", USER_LIMIT);

const out = `${RULES}

# 长期记忆 · 用户画像（USER.md 快照）

${user}

# 长期记忆 · Agent 笔记（MEMORY.md 快照）

${memory}

# 技能库（data/skills/ 快照 · 共 ${skills.length} 个）

${skillsBlock}
`;

fs.mkdirSync(path.dirname(AGENTS_MD), { recursive: true });
// only rewrite when content actually changed (avoid needless disk churn)
try {
  if (fs.readFileSync(AGENTS_MD, "utf8") === out) {
    process.stdout.write("AGENTS.md unchanged\n");
    process.exit(0);
  }
} catch {}
fs.writeFileSync(AGENTS_MD, out);
process.stdout.write(
  `AGENTS.md assembled (memory ${memory.length}/${MEMORY_LIMIT}, user ${user.length}/${USER_LIMIT}, skills ${skills.length})\n`
);
