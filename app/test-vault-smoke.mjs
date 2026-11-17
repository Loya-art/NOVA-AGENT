// 冒烟测试：模拟向导输入（管道），验证凭据写入 + patch 渲染 + YAML 合法
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";

const ROOT = "F:/AgentPortable";
const TMP = path.join(ROOT, ".tmp-vault-test");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });

const env = { ...process.env, AGENT_HOME: path.join(TMP, "data") };
const run = (args, input) =>
  spawnSync(path.join(ROOT, "runtime/node/bin/node.exe"), ["vault.mjs", ...args], {
    cwd: ROOT + "/app", env, input, encoding: "utf8", timeout: 60000,
  });

let fail = 0;
const ok = (cond, msg) => { console.log((cond ? "  ✓ " : "  ✗ ") + msg); if (!cond) fail++; };

// --- 场景 1：DeepSeek 官方（验证大概率失败也能走完，检查 patch 渲染） ---
let r = run(["init"], "1\nfake-key-for-smoke-test-12345678\n2\n\n");
console.log("--- init deepseek stdout/stderr ---");
console.log((r.stdout || "") + (r.stderr || ""));
ok(r.status === 0, "init 退出码 0");
ok(fs.existsSync(path.join(TMP, "key.txt")), "key.txt 已生成");
const patch1 = fs.readFileSync(path.join(TMP, "data/profiles/headless/cordis.patch.yml"), "utf8");
ok(patch1.includes("provider: deepseek-official"), "默认路由 = deepseek-official");
ok(patch1.includes("model: deepseek-v4-pro"), "模型 = deepseek-v4-pro（选了 2）");
ok(!patch1.includes("{{"), "无残留占位符");
const S = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type("tag:yaml.org,2002:js", { kind: "scalar", construct: (d) => String(d) }),
  new yaml.Type("tag:yaml.org,2002:js", { kind: "sequence", construct: (d) => d }),
  new yaml.Type("tag:yaml.org,2002:js", { kind: "mapping", construct: (d) => d }),
]);
let doc1 = null;
try { doc1 = yaml.load(patch1, { schema: S }); } catch (e) { console.log("  YAML 解析错误:", e.message); }
ok(Array.isArray(doc1) && doc1.some((x) => x.id === "agent-default-model"), "patch 是合法 YAML 数组");
ok((r.stdout + r.stderr).includes("NOVA_API_READY=1"), "输出 NOVA_API_READY=1");

// --- 场景 2：自定义网关（手填地址+模型，跳过验证失败） ---
fs.rmSync(path.join(TMP, "key.txt"), { force: true });
fs.rmSync(path.join(TMP, "data"), { recursive: true, force: true });
fs.mkdirSync(path.join(TMP, "data"), { recursive: true });
r = run(["init"], "8\nhttps://gw.example.com/v1\nsk-custom-12345678\ny\nmy-model-x\n\n");
const patch2 = fs.readFileSync(path.join(TMP, "data/profiles/headless/cordis.patch.yml"), "utf8");
ok(patch2.includes("provider: custom"), "默认路由 = custom");
ok(patch2.includes("baseURL: https://gw.example.com/v1"), "自定义 baseURL 已写入");
ok(patch2.includes("- id: my-model-x"), "手填模型已声明");
ok(patch2.includes("CUSTOM_API_KEY"), "env 名正确");
let doc2 = null;
try { doc2 = yaml.load(patch2, { schema: S }); } catch (e) { console.log("  YAML 解析错误:", e.message); }
const piai = doc2?.find?.((x) => x.id === "llm-pi-ai");
ok(piai?.config?.providers?.custom?.models?.[0]?.id === "my-model-x", "pi-ai 路由结构正确");

// --- 场景 3：status / 已配置拦截 ---
r = run(["status"], "");
ok((r.stdout || "").includes("mode"), "status 可用");
r = run(["init"], "");
ok(r.status === 1, "重复 init 被拦截（退出码 1）");

fs.rmSync(TMP, { recursive: true, force: true });
console.log(fail ? `\n${fail} 项失败` : "\n全部通过");
process.exit(fail ? 1 : 0);
