# NOVA-AGENT 🧧

<p align="center"><img src="assets/icon.svg" width="128" alt="NOVA Agent 年兽图标"/></p>

**一个装进 U 盘就能带走的终端 AI Agent。** 插到任何 x64 Windows 电脑上，双击即用——不需要装 Node.js，不需要装 Python，不需要装任何东西。

> 界面为全手绘终端 UI（无 ink/无浏览器内核），默认「年兽红」crimson 主题，32×32 像素年兽图标。

---

## ✨ 特性

- **真正的便携**：自带 Node 运行时（`runtime/node`），所有状态（会话、记忆、配置）都存在 U 盘上，换电脑零重配
- **开箱即用的 TUI**：备用屏幕自绘界面、滚轮翻历史、Minecraft 式指令补全、`/model` `/skill` `/persona` 等指令
- **多供应商**：DeepSeek 官方 / SiliconFlow / Kimi / 智谱 / 阿里云百炼 / OpenRouter / OpenAI / 任意 OpenAI 兼容网关，首次配置时选一个、填 Key、在线验证、直接选模型
- **API Key 保护**：可选启动密码（AES-256-GCM + scrypt 加密进 `data/vault.enc`），U 盘丢了别人也拿不到 Key
- **技能系统**：`data/skills/` 平铺技能目录，带 SKILL.md 即被识别；技能跟着 U 盘走
- **预热池**：空闲时预起内核，发消息起步 ~20ms 而不是 ~2.2s
- **exFAT 兼容**：针对 U 盘文件系统做过专门修复（新建文件不再失败）

## 🚀 快速开始

### 方式一：便携包（推荐）

1. 从 [Releases](../../releases) 下载 `NOVA-Agent-vX.X.X-portable.zip`
2. 解压到 U 盘根目录（或任意目录，盘符自适应）
3. 双击 **`NOVA-AGENT.bat`**
4. 首次会进入配置向导：**选供应商 → 填 API Key → 选模型**，之后直接开聊

### 方式二：装到 U 盘（带图标快捷方式）

解压后在文件夹里双击 **`INSTALL-USB.bat`**：输入目标盘符，自动复制全部文件并在桌面创建带年兽图标的快捷方式。

### 方式三：从源码运行

```bash
git clone https://github.com/Loya-art/NOVA-AGENT.git
cd NOVA-AGENT/app
npm install        # 或 pnpm install
node ui/build.mjs  # 打包 TUI
cd ..

# 生成图标（仓库里只存 SVG 与像素栅格脚本，ico/png 本地生成）
node tools/make-nian.mjs 32 assets/icon        # 32×32 像素年兽 → svg + 512png + 多档 ico

runtime\node\bin\node.exe app\ui\bundle.mjs   # 需要 key.txt 或环境变量里的 API Key
```

## ⚙️ 首次配置（Hermes 式向导）

```
=====================================================
  NOVA Agent · 首次配置
  选一个模型供应商，填入 API Key 就能开工。
=====================================================

选择模型供应商（回车 = 1）：
  1. DeepSeek 官方（国内直连 · 推荐）
  2. 硅基流动 SiliconFlow（国内直连 · 聚合多模型）
  3. 月之暗面 Kimi（国内直连）
  4. 智谱 GLM 开放平台（国内直连）
  5. 阿里云百炼 · 通义千问（国内直连）
  6. OpenRouter（全球聚合 · 需代理）
  7. OpenAI 官方（需代理）
  8. 自定义 OpenAI 兼容网关（自填地址）
```

- 填完 Key 会**当场联网验证**，并列出该账号可用的模型让你选默认
- 验证失败也会告诉你常见原因（Key 抄错 / 需要代理 / 地址不对）
- 之后随时可以用 `SETUP.bat` 重配，或在界面里用 `/model` 切换

## 📁 目录结构

```
NOVA-Agent/
├─ NOVA-AGENT.bat      ← 双击启动
├─ SETUP.bat           ← 重新配置供应商 / Key / 模型
├─ INSTALL-USB.bat     ← 安装到 U 盘 + 建桌面快捷方式
├─ CHECK.bat           ← 换机自检（只读，不联网）
├─ assets/             ← 年兽图标（ico/svg/像素图源）
├─ runtime/node/       ← 自带 Node 运行时
├─ app/                ← 应用源码与依赖
│  ├─ ui/src/          ← 全手绘 TUI 源码
│  ├─ vault.mjs        ← 凭据保险库 + 配置向导
│  └─ templates/       ← profile 补丁模板
├─ data/               ← 运行数据（首次启动自动生成）
└─ workspace/          ← Agent 的工作目录
```

## 🔒 安全说明

- API Key 只存在**你的 U 盘上**（明文 `key.txt` 或加密 `data/vault.enc`），不会上传到任何地方
- 设置启动密码后，Key 用 AES-256-GCM 加密、scrypt 派生密钥
- 默认权限模式为 `danger-full-access`（Agent 执行命令不再逐步询问）——便携场景图省事；想更安全，删除 `NOVA-AGENT.bat` 里那一行即可回到「工作区写入 + 逐步确认」

## ❓ FAQ

**换一台电脑要重新配置吗？** 不用。所有配置都在 U 盘上，插上双击就行。

**没有网行不行？** 不行，调用模型 API 需要联网；除此之外一切本地。

**为什么界面反应很快？** 空闲时预热了内核进程，发消息起步 ≈ 20ms。

**U 盘是 exFAT 会出问题吗？** 已专门修复（禁用 hard-link 发布 + 关闭技能监听）。

**支持 Mac / Linux 吗？** 目前仅 x64 Windows（自带的 Node 与启动脚本都是 Windows 侧）。

## 📄 许可

[MIT](LICENSE) · 图标为像素画（源文件在 `assets/`，可自行改色）
内核依赖 `@deepseek-ai/dsh` 等来自 npm 的开源包，版权归各自作者。
