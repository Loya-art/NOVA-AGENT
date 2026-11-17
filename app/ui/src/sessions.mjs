// ============================================================
//  会话库 —— 读取 dsh 持久化的会话（/sessions、/resume 的数据层）
//
//  两处数据源：
//    ① data/sessions/<proj>/<sid>/session.v4.jsonl.zstd
//       dsh 用「追加一个 zstd 帧」的方式写 JSONL，所以一个文件里
//       有多帧（实测一次任务 83 帧 / 208KB）。node:zlib 一次只能解
//       第一帧，必须先扫帧边界再逐帧解。
//    ② data/storages/session_projcache/sessions/<sid>.json
//       内核写的投影检查点，含 LLM 生成的标题、首条消息、轮数、
//       token 用量 —— 列会话用它，不必解压。
//
//  ⚠️ proj 目录名是 cwd 转义来的（F:\AgentPortable\workspace →
//     --F-AgentPortable-workspace--）。U 盘换盘符后会变成新目录，
//     所以列表要跨所有 proj 目录扫，不能只认当前的。
// ============================================================
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ZSTD_MAGIC = 0x28b52ffd; // bytes 28 B5 2F FD

// ---- 多帧 zstd：扫出每帧的 [start, end) ----
export function frameRanges(buf) {
  const out = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    if (buf.readUInt32BE(i) !== ZSTD_MAGIC) break;
    const start = i;
    const fhd = buf[i + 4];
    const fcsFlag = fhd >> 6;
    const singleSeg = (fhd >> 5) & 1;
    const checksum = (fhd >> 2) & 1;
    const dictFlag = fhd & 3;
    let p = i + 5;
    if (!singleSeg) p += 1; // Window_Descriptor
    p += [0, 1, 2, 4][dictFlag]; // Dictionary_ID
    if (fcsFlag === 0) p += singleSeg ? 1 : 0;
    else p += [0, 2, 4, 8][fcsFlag]; // Frame_Content_Size
    for (;;) {
      if (p + 3 > buf.length) return out; // 尾帧不完整：丢弃
      const h = buf.readUIntLE(p, 3);
      const last = h & 1;
      const btype = (h >> 1) & 3;
      const bsize = h >>> 3;
      p += 3;
      if (btype === 0) p += bsize; // Raw_Block
      else if (btype === 1) p += 1; // RLE_Block
      else if (btype === 2) p += bsize; // Compressed_Block
      else return out; // reserved：不再信任后面的字节
      if (p > buf.length) return out;
      if (last) break;
    }
    if (checksum) p += 4;
    if (p > buf.length) return out;
    out.push([start, p]);
    i = p;
  }
  return out;
}

/** 解出一个 session 文件的全部事件对象。坏帧跳过，不抛。 */
export function readSessionEvents(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return [];
  }
  const out = [];
  for (const [a, b] of frameRanges(buf)) {
    let text;
    try {
      text = zlib.zstdDecompressSync(buf.subarray(a, b)).toString("utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        /* 半行或不完整帧 */
      }
    }
  }
  return out;
}

/** data/sessions 下所有项目目录 → [{dir, name}] */
function projectDirs(sessionsRoot) {
  let names;
  try {
    names = fs.readdirSync(sessionsRoot);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const d = path.join(sessionsRoot, n);
    try {
      if (fs.statSync(d).isDirectory()) out.push({ dir: d, name: n });
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** 读投影缓存目录 → Map<id, meta> */
function readProjCache(projCacheRoot) {
  const map = new Map();
  let files;
  try {
    files = fs.readdirSync(projCacheRoot);
  } catch {
    return map;
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const id = f.replace(/\.json$/, "");
    if (!id.startsWith("session-") && !/^[0-9a-f-]{36}$/.test(id)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(projCacheRoot, f), "utf8"));
      const rows = j?.record?.rows || {};
      const ident = j?.record?.identity || {};
      map.set(id, {
        title: rows.title?.val ?? null,
        firstPrompt: rows.titleInput?.val?.first?.text ?? null,
        turns: rows.turnBoundary?.val?.lastTurn ?? null,
        tokens: rows.tokenUsage?.val?.totals?.uncachedInputTokens ?? null,
        createdAt: ident.createdAt ?? null,
        cwd: ident.cwd ?? null,
      });
    } catch {
      /* 坏缓存跳过 */
    }
  }
  return map;
}

/**
 * 会话列表（新的在前）。
 * 以「真实存在的会话目录」为准，投影缓存只用来补标题等元数据。
 */
export function listSessions({ sessionsRoot, projCacheRoot, limit = 30 } = {}) {
  const meta = projCacheRoot ? readProjCache(projCacheRoot) : new Map();
  const rows = [];
  for (const { dir, name } of projectDirs(sessionsRoot)) {
    let subs;
    try {
      subs = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const sid of subs) {
      const file = path.join(dir, sid, "session.v4.jsonl.zstd");
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue; // 目录里没有会话文件（比如残留 tmpdir）
      }
      const m = meta.get(sid) || {};
      rows.push({
        id: sid,
        proj: name,
        cwd: m.cwd || null,
        title: m.title || null,
        firstPrompt: m.firstPrompt || null,
        turns: m.turns || 0,
        tokens: m.tokens || 0,
        createdAt: m.createdAt || Math.round(st.mtimeMs),
        mtime: st.mtimeMs,
        sizeBytes: st.size,
        file,
      });
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows.slice(0, limit);
}

/** 列表用的标题：LLM 标题 → 首条消息 → 占位 */
export function sessionLabel(row) {
  const t = (row.title || "").trim();
  if (t) return t;
  const f = (row.firstPrompt || "").trim().replace(/\s+/g, " ");
  if (f) return f.slice(0, 40) + (f.length > 40 ? "…" : "");
  return "（无标题）";
}

/**
 * 会话正文：按 seq 取出「用户说了什么 / Agent 答了什么」。
 * 只保留纯文本，跳过思考过程与工具细节（回显用）。
 * 内核会把工作区指令、运行时快照、技能清单当作 user 消息注入，
 * 这些不是用户打的字，回显时要滤掉。
 */
const INJECTED = [
  /^<system-reminder/i,
  /^Current runtime context/i,
  /^#\s*Workspace/i,
  /^The following workspace instructions/i,
];
function isInjected(text) {
  const t = text.trimStart();
  return INJECTED.some((re) => re.test(t));
}

export function loadSessionDetail(row, { maxTurns = 6 } = {}) {
  const events = readSessionEvents(row.file);
  const msgs = [];
  for (const ev of events) {
    if (ev.type === "user/message") {
      const text = (ev.data?.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text.trim() && !isInjected(text)) msgs.push({ role: "user", seq: ev.seq, text: text.trim() });
    } else if (ev.type === "assistant/message") {
      const text = (ev.data?.message?.content || [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      if (text.trim()) msgs.push({ role: "assistant", seq: ev.seq, text: text.trim() });
    }
  }
  // 只回显最近 maxTurns 组（取尾部）
  const tail = msgs.slice(-maxTurns * 2);
  return { msgs: tail, totalMsgs: msgs.length, file: row.file };
}

/** 按 id 或列表序号找会话 */
export function findSession(rows, key) {
  const k = String(key || "").trim();
  if (!k) return null;
  if (/^\d+$/.test(k)) {
    const i = parseInt(k, 10) - 1;
    return rows[i] || null;
  }
  return rows.find((r) => r.id === k || r.id === `session-${k}`) || null;
}
