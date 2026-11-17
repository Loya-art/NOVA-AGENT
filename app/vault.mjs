#!/usr/bin/env node
// ============================================================
//  USB Portable Agent - credential vault
//  Zero-dependency CLI. Runs with the portable Node on the drive.
//
//  Commands:
//    init       first-run wizard (provider + key + optional password)
//    unlock     verify password, print KEY=VALUE lines to stdout
//    status     show vault state (no secrets)
//    setkey     re-enter / change API key(s)
//    changepw   change the startup password
//    remove     decrypt and go back to plaintext key.txt
//
//  Storage (all under <root>/data/):
//    vault.enc  encrypted JSON { keys: {...} }  (AES-256-GCM, scrypt)
//    lock.json  { mode: "password" | "none", hint }
//    key.txt    plaintext fallback (only when no password set)
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// AGENT_HOME override exists for automated tests; default = <usb>/AgentPortable/data
const HOME = process.env.AGENT_HOME || path.join(__dirname, '..', 'data');
const VAULT = path.join(HOME, 'vault.enc');
const LOCK = path.join(HOME, 'lock.json');
const KEYFILE = path.join(HOME, '..', 'key.txt');

const KDF = { N: 16384, r: 8, p: 1, keylen: 32 };

// 供应商注册表：id 是 cordis.patch.yml 里 llm-pi-ai.providers 的路由键；
// official=true 走内核自带 DeepSeek 直连（不进 pi-ai）。
const PROVIDERS = [
  {
    n: 1, id: 'deepseek-official', env: 'DEEPSEEK_API_KEY', official: true,
    label: 'DeepSeek 官方（国内直连 · 推荐）',
    verifyURL: 'https://api.deepseek.com/v1',
  },
  {
    n: 2, id: 'siliconflow', env: 'SILICONFLOW_API_KEY',
    label: '硅基流动 SiliconFlow（国内直连 · 聚合多模型）',
    baseURL: 'https://api.siliconflow.cn/v1',
  },
  {
    n: 3, id: 'moonshot', env: 'MOONSHOT_API_KEY',
    label: '月之暗面 Kimi（国内直连）',
    baseURL: 'https://api.moonshot.cn/v1',
  },
  {
    n: 4, id: 'zhipu', env: 'ZHIPU_API_KEY',
    label: '智谱 GLM 开放平台（国内直连）',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    n: 5, id: 'dashscope', env: 'DASHSCOPE_API_KEY',
    label: '阿里云百炼 · 通义千问（国内直连）',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    n: 6, id: 'openrouter', env: 'OPENROUTER_API_KEY',
    label: 'OpenRouter（全球聚合 · 需代理）',
    baseURL: 'https://openrouter.ai/api/v1',
  },
  {
    n: 7, id: 'openai', env: 'OPENAI_API_KEY',
    label: 'OpenAI 官方（需代理）',
    baseURL: 'https://api.openai.com/v1',
  },
  {
    n: 8, id: 'custom', env: 'CUSTOM_API_KEY',
    label: '自定义 OpenAI 兼容网关（自填地址）',
  },
];

const PATCH_TPL = path.join(__dirname, 'templates', 'cordis.patch.yml.tpl');
const PATCH_OUT = path.join(HOME, 'profiles', 'headless', 'cordis.patch.yml');

// ---------------- small helpers ----------------

const say = (s = '') => process.stderr.write(s + '\n');

function parseKeysFromText(text) {
  const keys = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) {
      if (!keys.DEEPSEEK_API_KEY) keys.DEEPSEEK_API_KEY = line;
    } else {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k) keys[k] = v;
    }
  }
  for (const k of Object.keys(keys)) if (!keys[k]) delete keys[k];
  return keys;
}

function loadPlaintextKeys() {
  try {
    return parseKeysFromText(fs.readFileSync(KEYFILE, 'utf8'));
  } catch { return {}; }
}

function mask(k) {
  if (!k) return '(not set)';
  return k.length <= 12 ? k.slice(0, 4) + '...' : k.slice(0, 8) + '...' + k.slice(-4);
}

// ---- input layer ----
// non-TTY (piped / tests): lazy async line pump - stdin is only touched
// when a line is actually requested (so pure-print commands never block).
// TTY: self-implemented raw-mode line reader (supports hidden input).
const stdinState = { started: false, chunks: [], lines: [], eof: false, pending: [] };

function startPump() {
  if (stdinState.started) return;
  stdinState.started = true;
  process.stdin.resume();
  process.stdin.on('data', (c) => {
    stdinState.chunks.push(c);
    const all = stdinState.chunks.map(String).join('');
    const parts = all.split(/\r?\n/);
    stdinState.chunks = [parts.pop()];
    stdinState.lines.push(...parts);
    stdinState._drain();
  });
  process.stdin.on('end', () => {
    const rest = stdinState.chunks.map(String).join('');
    if (rest) stdinState.lines.push(rest);
    stdinState.eof = true;
    stdinState._drain();
  });
  stdinState._drain = stdinState._drain || (() => {});
}

function nextLine() {
  return new Promise((resolve) => {
    const deliver = () => {
      if (stdinState.lines.length) resolve(stdinState.lines.shift());
      else if (stdinState.eof) resolve('');
      else stdinState.pending.push(resolve);
    };
    stdinState._drain = () => {
      const q = stdinState.pending.splice(0);
      stdinState.pending = [];
      for (const r of q) {
        if (stdinState.lines.length) r(stdinState.lines.shift());
        else if (stdinState.eof) r('');
        else stdinState.pending.push(r);
      }
    };
    deliver();
  });
}

async function readLineRaw(prompt, echo) {
  process.stderr.write(prompt);
  if (!process.stdin.isTTY) {
    startPump();
    return (await nextLine()).trim();
  }
  return new Promise((resolve) => {
    const buf = [];
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const cleanup = () => {
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
    };
    const onData = (chunk) => {
      for (const s of chunk.toString()) {
        if (s === '\r' || s === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(buf.join('').trim());
          return;
        } else if (s === '\b' || s === '\x7f') {
          if (buf.length) { buf.pop(); if (echo) process.stderr.write('\b \b'); }
        } else if (s === '\x03') {
          cleanup(); process.exit(130);
        } else if (s >= ' ') {
          buf.push(s);
          if (echo) process.stderr.write(s);
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

async function ask(prompt) {
  return readLineRaw(prompt, true);
}

async function askHidden(prompt) {
  return readLineRaw(prompt, false);
}

// ---------------- crypto ----------------

function deriveKey(password, salt) {
  return crypto.scryptSync(password, salt, KDF.keylen, {
    N: KDF.N, r: KDF.r, p: KDF.p, maxmem: 128 * 1024 * 1024,
  });
}

function encryptKeys(keys, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const aes = deriveKey(password, salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', aes, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(keys), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1, kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p,
    salt: salt.toString('hex'), iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'), ct: ct.toString('hex'),
  });
}

function decryptKeys(password) {
  const raw = JSON.parse(fs.readFileSync(VAULT, 'utf8'));
  const aes = deriveKey(password, Buffer.from(raw.salt, 'hex'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', aes, Buffer.from(raw.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(raw.tag, 'hex'));
  const pt = Buffer.concat([decipher.update(Buffer.from(raw.ct, 'hex')), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

// ---------------- provider probe & patch rendering ----------------

// GET {baseURL}/models —— 兼验 key 和拿模型列表
async function probeModels(baseURL, key) {
  const url = baseURL.replace(/\/+$/, '') + '/models';
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, status: res.status, models: [], error: `HTTP ${res.status}` };
    const j = await res.json();
    const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
    const models = arr.map((m) => (typeof m === 'string' ? m : m?.id)).filter(Boolean);
    return { ok: true, models };
  } catch (e) {
    return { ok: false, models: [], error: e.name === 'AbortError' ? '超时（20s）' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

// 渲染 cordis.patch.yml（整体生成，包含默认路由 + 供应商声明）
function renderPatch(sel) {
  const tpl = fs.readFileSync(PATCH_TPL, 'utf8');
  let out = tpl;

  if (sel.official) {
    out = out
      .replace('{{DEFAULT_PROVIDER}}', 'deepseek-official')
      .replace('{{DEFAULT_MODEL}}', sel.model || 'deepseek-flash')
      .replace('{{DEEPSEEK_BASEURL}}', sel.baseURL ? `    baseURL: ${sel.baseURL}` : '')
      .replace('{{PIAI_PROVIDERS}}', '      {}');
  } else {
    const modelsYaml = (sel.models || [])
      .map(
        (m) =>
          `          - id: ${m.id}\n            name: ${m.name || m.id}\n            contextWindow: ${m.contextWindow || 131072}`
      )
      .join('\n');
    const block = [
      `      ${sel.id}:`,
      `        displayName: ${sel.displayName || sel.label?.split('（')[0] || sel.id}`,
      `        apiKeyEnv: ${sel.env}`,
      '        api: openai-completions',
      `        baseURL: ${sel.baseURL}`,
      '        models:',
      modelsYaml,
    ].join('\n');
    out = out
      .replace('{{DEFAULT_PROVIDER}}', sel.id)
      .replace('{{DEFAULT_MODEL}}', sel.model)
      .replace('{{DEEPSEEK_BASEURL}}', '')
      .replace('{{PIAI_PROVIDERS}}', block);
  }
  return out;
}

function writePatch(sel) {
  fs.mkdirSync(path.dirname(PATCH_OUT), { recursive: true });
  fs.writeFileSync(PATCH_OUT, renderPatch(sel), 'utf8');
  say(`[DONE] 模型路由已写入 ${path.relative(path.join(__dirname, '..'), PATCH_OUT)}`);
}

// ---------------- commands ----------------

async function cmdInit() {
  say('=====================================================');
  say('  NOVA Agent · 首次配置');
  say('  选一个模型供应商，填入 API Key 就能开工。');
  say('=====================================================');
  if (fs.existsSync(LOCK) || fs.existsSync(VAULT)) {
    say('[SKIP] 已配置过。要重配请运行：首次配置.bat（或 node app\\vault.mjs reset）');
    process.exit(1);
  }

  const existing = loadPlaintextKeys();
  if (Object.keys(existing).length) {
    for (const [k, v] of Object.entries(existing)) say(`  发现已有配置：${k} = ${mask(v)}`);
  }

  // --- 选供应商 ---
  say('\n选择模型供应商（回车 = 1）：');
  for (const p of PROVIDERS) say(`  ${p.n}. ${p.label}`);
  const pSel = await ask('供应商 [1-8]: ');
  const provider = PROVIDERS.find((p) => String(p.n) === pSel) || PROVIDERS[0];

  // --- 自定义网关要自填地址 ---
  let baseURL = provider.baseURL || '';
  if (provider.id === 'custom') {
    while (!baseURL) {
      const u = (await ask('网关 baseURL（OpenAI 兼容，一般以 /v1 结尾）: ')).replace(/\/+$/, '');
      if (/^https?:\/\//.test(u)) baseURL = u;
      else say('  要以 http:// 或 https:// 开头。');
    }
  }

  // --- 填 Key ---
  let key = '';
  const defKey = existing[provider.env];
  while (!key) {
    const input = await askHidden(`API Key${defKey ? '（回车 = 沿用 ' + mask(defKey) + '）' : ''}: `);
    if (!input && defKey) { key = defKey; break; }
    if (input) key = input;
    else say('  第一次配置必须填一个 Key。');
  }

  // --- 验证 + 拿模型列表 ---
  const probeURL = provider.official ? provider.verifyURL : baseURL;
  say(`\n正在验证 Key（${probeURL}/models）...`);
  const probe = await probeModels(probeURL, key);
  let models = [];

  if (provider.official) {
    // DeepSeek 官方：模型由内核内置（flash / pro），验证失败不拦路
    if (probe.ok) say('  ✓ Key 有效。');
    else say(`  ⚠ 没验证通过（${probe.error || probe.status}）。先保存，之后跑不起来再检查。`);
    say('\n选默认模型（回车 = 1）：');
    say('  1. deepseek-flash    快，日常够用');
    say('  2. deepseek-v4-pro   推理更强，慢一点');
    const mSel = await ask('模型 [1-2]: ');
    const model = mSel === '2' ? 'deepseek-v4-pro' : 'deepseek-flash';
    await finishInit({ official: true, env: provider.env, key, model });
    return;
  }

  if (probe.ok && probe.models.length) {
    say(`  ✓ Key 有效，拿到 ${probe.models.length} 个模型。`);
    models = probe.models.slice(0, 15).map((id) => ({ id, contextWindow: 131072 }));
    say('\n选默认模型（回车 = 1，之后可用 /model 随时切换）：');
    models.forEach((m, i) => say(`  ${i + 1}. ${m.id}`));
    if (probe.models.length > 15) say(`  ...（共 ${probe.models.length} 个，只列出前 15）`);
    const mSel = await ask(`模型 [1-${models.length}] 或直接输入模型名: `);
    let chosen = models[0];
    const idx = parseInt(mSel, 10);
    if (mSel && Number.isNaN(idx)) {
      chosen = { id: mSel.trim(), contextWindow: 131072 };
      models.unshift(chosen); // 手填的也声明进路由，/model 能看到
    } else if (idx >= 1 && idx <= models.length) {
      chosen = models[idx - 1];
    }
    await finishInit({ ...provider, official: false, baseURL, key, models, model: chosen.id });
    return;
  }

  // 验证失败：给原因，允许手动继续
  say(`  ✗ 验证失败（${probe.error || probe.status || '未知错误'}）。常见原因：`);
  say('    · Key 抄错 / 多了空格');
  say('    · 该供应商需要代理（OpenRouter / OpenAI 必须挂代理）');
  say('    · 网关地址不对（一般要以 /v1 结尾）');
  const goOn = await ask('仍要保存这个 Key 吗？保存则需手动输入模型名 [y/N]: ');
  if (!/^y/i.test(goOn)) {
    say('[ABORT] 未保存。重新运行向导再试。');
    process.exit(1);
  }
  let manual = '';
  while (!manual) manual = (await ask('手动输入默认模型名（如 deepseek-chat）: ')).trim();
  models = [{ id: manual, contextWindow: 131072 }];
  await finishInit({ ...provider, official: false, baseURL, key, models, model: manual });
}

// 写凭据（明文 / 加密）+ 渲染路由补丁 + 收尾打印
async function finishInit(sel) {
  const keys = { [sel.env]: sel.key };

  say('\n要不要给 U 盘加启动密码？（丢了 U 盘别人也拿不到你的 Key）');
  let password = null;
  while (true) {
    const p1 = await askHidden('设置启动密码（回车 = 不设，明文存 key.txt）: ');
    if (!p1) { say('  -> 不设密码。Key 明文存在 key.txt。'); break; }
    if (p1.length < 4) { say('  太短（至少 4 位）。'); continue; }
    const p2 = await askHidden('再输一遍确认: ');
    if (p1 !== p2) { say('  两次不一致，重来。'); continue; }
    password = p1;
    break;
  }

  fs.mkdirSync(HOME, { recursive: true });

  if (password) {
    const hint = await ask('密码提示（可选，回车 = 不设）: ');
    fs.writeFileSync(VAULT, encryptKeys(keys, password));
    fs.writeFileSync(LOCK, JSON.stringify({ v: 1, mode: 'password', hint: hint || '' }, null, 2));
    try { fs.unlinkSync(KEYFILE); } catch {}
    say(`\n[DONE] API Key 已加密 → data/vault.enc（${sel.env} = ${mask(sel.key)}）`);
    say('       明文 key.txt 已删除；之后每次启动要输密码（3 次机会）。');
  } else {
    const lines = [
      '# NOVA Agent - API keys（明文）。格式：KEY=VALUE。',
      '# 由首次配置向导生成。删掉本文件再启动 = 重新进配置向导。',
      '',
      ...Object.entries(keys).map(([k, v]) => `${k}=${v}`), '',
    ];
    fs.writeFileSync(KEYFILE, lines.join('\n'));
    fs.writeFileSync(LOCK, JSON.stringify({ v: 1, mode: 'none', hint: '' }, null, 2));
    say(`\n[DONE] Key 已保存到 key.txt（${sel.env} = ${mask(sel.key)}）。`);
  }

  writePatch(sel);
  say('配置完成！重新运行 NOVA-AGENT.bat 即可开聊。');
  printEnv(keys);
}

// env lines for the launcher to capture (stdout); diagnostics stay on stderr
// NOVA_API_READY 是给启动脚本的「凭据就绪」标记，跟具体供应商解耦
function printEnv(keys) {
  for (const [k, v] of Object.entries(keys)) process.stdout.write(`${k}=${v}\n`);
  process.stdout.write('NOVA_API_READY=1\n');
}

async function tryUnlock(password) {
  try {
    const keys = decryptKeys(password);
    return keys;
  } catch {
    return null;
  }
}

async function cmdUnlock() {
  // plaintext mode
  if (!fs.existsSync(VAULT)) {
    const keys = loadPlaintextKeys();
    if (!Object.keys(keys).length) {
      say('[ERR] 没有配置 Key。运行：NOVA-AGENT.bat（自动进配置向导）');
      process.exit(1);
    }
    for (const [k, v] of Object.entries(keys)) process.stdout.write(`${k}=${v}\n`);
    process.stdout.write('NOVA_API_READY=1\n');
    return;
  }
  // password mode - 3 attempts
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  for (let i = 1; i <= 3; i++) {
    const left = 4 - i;
    const pw = await askHidden(`启动密码${lock.hint ? `（提示：${lock.hint}）` : ''} [第 ${i}/3 次]: `);
    const keys = await tryUnlock(pw);
    if (keys) {
      for (const [k, v] of Object.entries(keys)) process.stdout.write(`${k}=${v}\n`);
      process.stdout.write('NOVA_API_READY=1\n');
      return;
    }
    say(left > 1 ? `  密码不对，还剩 ${left} 次机会。` : '  密码不对。');
  }
  say('[LOCKED] 3 次都没输对。拔插一次 U 盘再试，或运行：node app\\vault.mjs changepw');
  process.exit(1);
}

function cmdStatus() {
  const hasVault = fs.existsSync(VAULT);
  const hasLock = fs.existsSync(LOCK);
  let mode = hasVault ? 'password' : (fs.existsSync(KEYFILE) ? 'none (plaintext key.txt)' : 'not configured');
  if (hasLock) {
    try { mode = JSON.parse(fs.readFileSync(LOCK, 'utf8')).mode; } catch {}
  }
  process.stdout.write(`vault.enc : ${hasVault ? 'present' : 'absent'}\n`);
  process.stdout.write(`lock.json : ${hasLock ? 'present' : 'absent'}\n`);
  process.stdout.write(`key.txt   : ${fs.existsSync(KEYFILE) ? 'present' : 'absent'}\n`);
  process.stdout.write(`mode      : ${mode}\n`);
  if (hasLock) {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
      if (lock.hint) process.stdout.write(`hint      : ${lock.hint}\n`);
    } catch {}
  }
}

async function verifyOldPassword() {
  for (let i = 1; i <= 3; i++) {
    const pw = await askHidden('Current password: ');
    if (await tryUnlock(pw)) return pw;
    say(i < 3 ? '  wrong password, try again.' : '  wrong password.');
  }
  say('[LOCKED] too many failed attempts.');
  process.exit(1);
}

async function readKeysInteractive(existing) {
  say('\nWhich key to set? (Enter = 1)');
  for (const p of PROVIDERS) {
    const cur = existing[p.env];
    say(`  ${p.n}. ${p.label}${cur ? `  [current: ${mask(cur)}]` : ''}`);
  }
  const sel = await ask('Provider [1-4]: ');
  const provider = PROVIDERS.find((p) => String(p.n) === sel) || PROVIDERS[0];
  let key = '';
  while (!key) {
    const input = await ask(`API Key for ${provider.env} (Enter = keep current): `);
    key = input || existing[provider.env] || '';
    if (!key) say('  a key is required.');
  }
  return { ...existing, [provider.env]: key };
}

async function cmdSetKey() {
  if (!fs.existsSync(VAULT)) {
    say('[ERR] Vault not found (no-password mode: edit key.txt directly).');
    process.exit(1);
  }
  const old = await verifyOldPassword();
  const current = decryptKeys(old);
  const keys = await readKeysInteractive(current);
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  // keep old password, re-encrypt with fresh salt
  fs.writeFileSync(VAULT, encryptKeys(keys, old));
  say(`\n[DONE] Keys updated: ${Object.entries(keys).map(([k, v]) => `${k}=${mask(v)}`).join(', ')}`);
}

async function cmdChangePw() {
  if (!fs.existsSync(VAULT)) {
    say('[ERR] Vault not found (no-password mode: run "init" to set a password).');
    process.exit(1);
  }
  const old = await verifyOldPassword();
  const keys = decryptKeys(old);
  let np = null;
  while (true) {
    const p1 = await askHidden('New password (Enter = remove password, store plaintext): ');
    if (!p1) {
      // downgrade to plaintext
      const lines = [
        '# USB Portable Agent - API keys (plaintext)', '',
        ...Object.entries(keys).map(([k, v]) => `${k}=${v}`), '',
      ];
      fs.writeFileSync(KEYFILE, lines.join('\n'));
      fs.unlinkSync(VAULT);
      fs.writeFileSync(LOCK, JSON.stringify({ v: 1, mode: 'none', hint: '' }, null, 2));
      say('\n[DONE] Password removed. Keys moved back to plaintext key.txt.');
      return;
    }
    if (p1.length < 4) { say('  too short (min 4 chars).'); continue; }
    const p2 = await askHidden('Confirm new password: ');
    if (p1 !== p2) { say('  mismatch, try again.'); continue; }
    np = p1;
    break;
  }
  const hint = await ask('Password hint (optional, Enter = none): ');
  fs.writeFileSync(VAULT, encryptKeys(keys, np));
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  lock.mode = 'password'; lock.hint = hint || '';
  fs.writeFileSync(LOCK, JSON.stringify(lock, null, 2));
  try { fs.unlinkSync(KEYFILE); } catch {}
  say('\n[DONE] Password changed and vault re-encrypted.');
}

async function cmdRemove() {
  if (!fs.existsSync(VAULT)) {
    say('[ERR] Vault not found. Nothing to remove.');
    process.exit(1);
  }
  const pw = await verifyOldPassword();
  const keys = decryptKeys(pw);
  const lines = [
    '# USB Portable Agent - API keys (plaintext)', '',
    ...Object.entries(keys).map(([k, v]) => `${k}=${v}`), '',
  ];
  fs.writeFileSync(KEYFILE, lines.join('\n'));
  fs.unlinkSync(VAULT);
  fs.writeFileSync(LOCK, JSON.stringify({ v: 1, mode: 'none', hint: '' }, null, 2));
  say('[DONE] Vault removed. Keys are back in plaintext key.txt.');
}

// 清掉凭据重新走一遍向导（「首次配置.bat」的入口）
async function cmdReset() {
  say('这会删除已保存的 API Key（key.txt / vault.enc）并重新配置。');
  const ok = await ask('确定吗？[y/N]: ');
  if (!/^y/i.test(ok)) { say('已取消。'); return; }
  for (const f of [VAULT, LOCK, KEYFILE]) { try { fs.unlinkSync(f); } catch {} }
  say('');
  await cmdInit();
}

// ---------------- main ----------------

const cmd = process.argv[2] || 'status';
const handlers = { init: cmdInit, unlock: cmdUnlock, status: cmdStatus, setkey: cmdSetKey, changepw: cmdChangePw, remove: cmdRemove, reset: cmdReset };
if (!handlers[cmd]) {
  say(`Unknown command: ${cmd}. Valid: ${Object.keys(handlers).join(' / ')}`);
  process.exit(2);
}
await handlers[cmd]();
