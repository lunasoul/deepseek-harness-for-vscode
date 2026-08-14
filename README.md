# DeepSeek Harness for VS Code

在 VS Code 中原生运行 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 AI 编码助手扩展，无需你在本机克隆仓库、安装 Node/npm 或手动部署 Harness —— 安装匹配平台的 VSIX 即可开箱即用。

> 当前为社区开发版本 `0.3.0`。DeepSeek Harness 仍处于 Developer Preview，本扩展固定使用官方 npm 包 `@deepseek-ai/dsh@0.1.0-rc.6`。

## ✨ 特性

- **原生 VS Code 会话工作台** — 直接在侧边栏完成全部交互
- **完整会话管理** — 持久化历史、新建 / 切换 / 重命名 / 分支会话
- **多轮对话** — 流式回复、运行中排队、停止生成、历史分页
- **Markdown 渲染** — 代码块（带一键复制）、标题、列表、引用与行内格式
- **编辑器选区上下文** — 发送时自动附加当前选中代码（可设置关闭），也可用“⬒ 选区”按钮手动插入
- **快捷键** — `Ctrl+Alt+H`（macOS `Cmd+Alt+H`）打开工作台
- **斜杠命令** — 输入 `/` 弹出官方命令菜单（`/permission`、`/plan`、`/goal`、`/compact`、`/feedback`），支持过滤与键盘导航；`/model`、`/reasoning`、`/preset` 可直接切换会话设置
- **透明推理过程** — 折叠推理步骤、工具调用与结果时间线
- **Harness 原生能力** — 审批请求、结构化用户问题、Todo 计划、Skills 快捷调用、后台任务状态
- **模型选择** — DeepSeek V4 Flash / Pro，会话级即时切换
- **推理等级** — `off` / `high` / `max`
- **Agent Preset** — `standard`、`code`（PTC）、`minimal`、`cordis` 四种官方预设
- **免部署运行时** — 官方 `dsh` 与独立 Node 22.22.3 随 VSIX 分发，生命周期自动管理
- **安全连接** — 本地随机回环端口启动 Harness Gateway

## 📦 安装

1. 从 [Releases](https://github.com/skymecode/deepseek-harness-for-vscode/releases) 下载与你的系统匹配的 VSIX 文件。
2. 在 VS Code 中打开扩展面板（`Cmd/Ctrl + Shift + X`），点击右上角 `...` → **从 VSIX 安装...**。
3. 选择下载的 VSIX 文件，重启或按提示重新加载窗口。

不同系统请选择对应平台包，例如 macOS Apple Silicon 使用 `darwin-arm64` 包。

## 🚀 快速开始

1. 打开你要开发的代码项目。
2. 在 VS Code 用户 `settings.json` 中加入你的 DeepSeek API Key：

   ```json
   {
     "deepseekHarness.apiKey": "sk-你的DeepSeek_API_Key"
   }
   ```

   > 也可以点击侧边栏的“配置”按钮，扩展会帮你把密钥写入同一个用户设置，无需手改。

3. 点击 Activity Bar（活动栏）中的 **DeepSeek Harness** 图标，打开对话工作台。
4. 在输入框描述你的任务，回车即可开始。

无需执行任何 Harness 安装命令。

## ⚙️ 配置

| 设置 | 默认值 | 说明 |
|---|---|---|
| `deepseekHarness.apiKey` | 空 | DeepSeek API Key，以 `machine` 作用域明文存于用户 `settings.json` |
| `deepseekHarness.model` | `deepseek-v4-flash` | 新会话默认模型：Flash / Pro |
| `deepseekHarness.reasoningEffort` | `high` | 推理等级：`off` / `high` / `max` |
| `deepseekHarness.agentPreset` | `standard` | 新会话默认 Agent Preset |
| `deepseekHarness.provider` | `deepseek-official` | Harness 模型提供方路由 |
| `deepseekHarness.baseUrl` | 空 | 可选 DeepSeek API Base URL，留空使用官方默认地址 |
| `deepseekHarness.permissionMode` | `workspace-write` | 文件与 Shell 权限默认策略：`read-only` / `workspace-write` / `danger-full-access` |
| `deepseekHarness.autoAttachSelection` | `true` | 发送消息时自动附加当前编辑器选中的代码作为上下文；关闭后仅通过“⬒ 选区”按钮手动附加 |

- 模型与推理等级会在会话中通过 Gateway 即时更新；Agent Preset 可更新空白会话，并作为后续新会话的默认值。
- API Key 使用 `machine` 作用域，**不会**写入项目 `.vscode/settings.json`。它是明文存储，请勿提交或同步包含密钥的设置文件。
- 自动附加选区：发送时读取当前编辑器选区（最长 16 KB，超长自动截断）并作为消息的第一段上下文发送；若消息里已手动嵌入同一文件的选区（“⬒ 选区”或 `[选区: ` 标记）则不会重复附加。

### 命令

| 命令 | 说明 |
|---|---|
| `DeepSeek Harness: 打开工作台` | 打开对话工作台 |
| `DeepSeek Harness: 重新加载工作台` | 重新加载运行时与工作台 |
| `DeepSeek Harness: 设置 API Key` | 写入 DeepSeek API Key |
| `DeepSeek Harness: 清除 API Key` | 清除已保存的 API Key |
| `DeepSeek Harness: 显示日志` | 查看扩展与运行时日志 |

## 🔒 安全与隐私

- 扩展只在**本机随机回环端口**启动 Harness Gateway。
- 工作台使用严格的 Webview CSP。
- 文件访问受 `permissionMode` 沙箱约束，默认仅允许写入当前工作区。
- API Key 按需求明文存储于用户级 `settings.json`（`machine` 作用域），不会进入工作区配置。

## 🖥️ 平台支持

扩展 UI 是跨平台 TypeScript，但内置的 Node、PTY 与 sandbox 为原生二进制，因此按以下平台分别发布 VSIX：

- macOS：`darwin-arm64`、`darwin-x64`
- Linux：`linux-arm64`、`linux-x64`
- Windows：`win32-arm64`、`win32-x64`

发布到 Marketplace 后 VS Code 会自动为各平台安装正确包；站外发布时建议在同一个 GitHub Release 中附上全部平台的 VSIX 文件。

## 🛠️ 开发与打包

```sh
npm install
npm run check-types   # 类型检查
npm run lint          # 代码规范
npm test              # 单元测试
npm run compile       # 编译
npm run package       # 打包 VSIX
```

- `npm run package` 在 Windows / macOS / Linux 均可直接运行（`scripts/package-vsix.mjs` 通过当前 Node 直接调用 vsce，不再依赖平台 shim）。
- npm ≥ 11 会拦截依赖安装脚本：仓库 `package.json` 已带 `allowScripts` 白名单（node、node-pty、koffi、esbuild 等），`npm ci` 会自动放行。
- 多平台构建与发布已配置 GitHub Actions（`.github/workflows/release.yml`）：推送 `v*` 标签或手动触发，产出 darwin / linux / win32 各架构 VSIX 并附加到 Release（win32-arm64 需自托管 runner）。

分层架构与分发取舍详见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 📄 License

扩展代码采用 [MIT License](LICENSE)。随包分发的 DeepSeek Harness、Node.js 与其他依赖的许可信息见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) 及各 npm 包附带的许可文件。
