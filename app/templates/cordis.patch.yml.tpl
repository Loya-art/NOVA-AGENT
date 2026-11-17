# ============================================================
#  NOVA Agent — profile 补丁层（headless）
#  本文件由首次配置向导生成/更新（app/vault.mjs）。
#  手改也行，但再跑一次向导会被覆盖。
#
#  补丁条目「整体替换」目标条目的配置，所以要保留的字段必须重写一遍。
# ============================================================

# ---------- 1. 默认模型路由 ----------
# provider 填下面 llm-pi-ai: providers 里声明的路由名；
# DeepSeek 官方填 deepseek-official（走第 2 节的 Anthropic 协议直连）。
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: {{DEFAULT_PROVIDER}}
    model: {{DEFAULT_MODEL}}

# ---------- 2. DeepSeek 官方直连 ----------
# apiKeyEnv 只是「凭据引用名」，不是密钥本身。密钥放这三处之一（优先级从高到低）：
#   ① 启动时的环境变量       set DEEPSEEK_API_KEY=sk-xxx
#   ② 凭据文件                key.txt / data/vault.enc（向导管理）
#   ③ .env 文件               %ROOT%\data\.env
- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek-api-key'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    reasoningEffort: high
    maxTokens: 256000
    # baseURL 留空 = 用官方地址 https://api.deepseek.com/anthropic
    # 要接 DeepSeek 中转站时，向导里选「自定义网关」或手动填：
    # baseURL: https://your-gateway.example.com/anthropic
{{DEEPSEEK_BASEURL}}

# ---------- 3. 多供应商 / OpenAI 兼容网关 ----------
# 「不绑死 DeepSeek」的关键。providers 里每个键就是一条可选模型路由，
# /model 界面会自动列出这里的所有模型。首次配置向导会按你选的供应商写这一节。
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
{{PIAI_PROVIDERS}}

# ---------- 4. exFAT 兼容：禁用 fs 观察策略 ----------
# U 盘是 exFAT 格式时不支持硬链接。内核「新建文件」默认走 hard-link 原子发布，
# 在 exFAT 上必然报 EISDIR（现象：能改文件、新建必失败）。禁用后回退到
# rename 原子覆盖，exFAT 可用。代价是失去并发写入的 no-clobber 保护（单用户无影响）。
# 固定硬盘（NTFS）想启用并发保护，可删掉下面这个条目。
- id: fs-observation-policy
  name: '@deepseek-ai/dsh-fs-observation-policy'
  disabled: true

# ---------- 5. 技能目录不做文件监听（U 盘友好） ----------
# 技能库在 data/skills/。默认会为每个技能根挂文件监听；在 U 盘上这既慢又没意义
# ——技能是「启动时载入」的程序性记忆，改完重启界面即生效。
- id: skill-filesystem
  name: '@deepseek-ai/dsh-skill-filesystem'
  config:
    watch: false

# ---------- 6. MCP 服务器（可选，按需解开注释） ----------
# 示例：ComfyUI 生图/视频 MCP（stdio 服务器）。本机没装对应程序时
# 启动会记一条错误但 Agent 照常能跑（failOnStartupError 默认 false）。
# - id: mcp-comfy
#   name: '@deepseek-ai/dsh-mcp-client'
#   config:
#     serverName: comfy
#     transport: stdio
#     command: 'C:\path\to\comfy-mcp.exe'
#     args: []
#     env:
#       COMFY_BIN: 'E:\path\to\comfy.exe'
#     toolCallTimeoutMs: 900000
