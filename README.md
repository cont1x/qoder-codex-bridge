# Qoder × Codex Bridge

**GPT 整理需求并生成提示词 → Qoder 写代码 → Codex 检查与验收。**

这是安装在 Codex 中的本地 MCP 插件。支持通过 Qoder Launcher 的安装记录定位 Qoder 自带的后台 worker，也支持单独安装的 `qodercli`。后台执行任务，不向桌面聊天输入框模拟键盘输入。

## 1.1 节省 Codex 上下文

默认启用：提交任务和查询结果在服务端最多等待25秒，减少短间隔轮询；完成后只返回最多1600字符的报告摘要，不重复回传JSON原文和日志；历史列表仅包含最近10次任务的关键状态。完整报告和日志仍在本机保留，排障时调用 `qoder_result(detail="full")` 获取。`waitSeconds=0` 可立即返回。

调用规则让 Qoder 自行探索实现细节并自检，Codex 聚焦需求与关键验收。不会自动更改 Codex 模型、思考强度或账号限额。减少上下文和交互预计能降低部分 Codex 消耗，但实际幅度依任务与平台计量而变；Qoder 仍按自身规则消耗额度。

## 安装

当前在 Windows x64 + Node.js 24 + Qoder 0.4.8 环境验证。需要 Node.js 20+、Git 和 Codex CLI。

```powershell
git clone https://github.com/cont1x/qoder-codex-bridge.git
cd qoder-codex-bridge
npm ci
codex plugin marketplace add .
codex plugin add qoder-codex@qoder-bridge
```

重启 Codex 或新建聊天，然后输入：

> 用 qoder-code 开发这个项目，你负责出提示词，让 Qoder 实现并检查结果。

也可以指定项目绝对路径。DSH 插件与本插件各自独立；同时安装时，明确指定使用 Qoder 或 DSH。

## Qoder 登录

桌面登录不一定等于后台 CLI 已登录。首次使用可在本项目目录运行：

```powershell
npm run login
```

在 Qoder 官方浏览器页面完成登录即可。插件使用 Qoder 自身的凭据存储，不读取或复制登录令牌。自动化环境也可使用 Qoder 官方支持的 `QODER_PERSONAL_ACCESS_TOKEN` 环境变量，请勿把其值写入仓库。

## 工具与行为

| 工具 | 用途 |
| --- | --- |
| `qoder_health` | 检查 Launcher、后台入口和日志路径；不验证账号登录 |
| `qoder_start` | 提交任务，最多等待25秒，返回任务 ID 和精简状态/报告 |
| `qoder_result` | 最多等待25秒后返回摘要，排障时可选 full |
| `qoder_list` | 查看最近 10 次任务的关键状态 |
| `qoder_cancel` | 终止任务进程，保留已经写入的文件 |

提示词通过 stdin 传递，不拼接为 shell 命令。相同项目目录有文件锁，防止本插件并发写同一目录。默认超时 20 分钟，最大 2 小时。正常退出仍需由 Codex 读取代码差异并验收。

默认使用 Qoder 的 `accept_edits` 权限模式：允许项目文件编辑，其他需要确认的操作可能被 Qoder 拒绝；插件不使用 `--yolo`。运行测试等受限操作可由 Codex 在验收阶段执行。Qoder 会话不加载外部 MCP 服务，避免模型通过其他桥接服务递归转交任务。

任务记录位于 `%USERPROFILE%/.codex/qoder-bridge/runs/<任务ID>/`，含 `prompt.md`、`status.json`、`stdout.log` 和 `stderr.log`。每路日志最多 8MB；full 查询返回每路最后 24000 字符。日志可能含项目代码，请自行按需清理，不要提交到公开仓库。

## 配置

| 环境变量 | 用途 |
| --- | --- |
| `QODER_LAUNCHER` | Launcher.exe 的绝对路径；默认当前用户 LocalAppData 下的 Qoder Launcher |
| `QODER_INSTALL_DIR` | Qoder 实际安装根目录；默认从 Launcher 的 state.ini / install.ini 发现 |
| `QODER_CLI` | 覆盖执行入口：真实 qodercli.exe 或 JS/MJS 文件，不支持 CMD/PS1 包装脚本 |
| `QODER_NODE` | 执行 JS worker 的 Node 路径；默认当前 Node |
| `QODER_CONFIG_DIR` | Qoder CLI 配置目录；默认 `~/.qoder` |
| `QODER_MODEL` | 指定 Qoder 模型；不设置时沿用账号默认值 |
| `QODER_BRIDGE_DATA` | 覆盖本地任务日志目录 |

如果 Qoder 更新后内部 worker 路径变化，可改用官方安装的 `qodercli.exe` 并设置 `QODER_CLI`。安装本插件不会安装或分发 Qoder 本体。

## 验证与卸载

```powershell
npm test
npm run smoke
# 以下命令会真实调用 Qoder，在指定的独立测试目录写文件
npm run smoke -- C:\path\to\empty-test-folder
codex plugin remove qoder-codex@qoder-bridge
```

先执行 `npm ci` 再安装插件。源码包不包含依赖、Qoder 程序、登录数据或执行日志。保留克隆目录便于后续更新。

参考：[Qoder 脚本运行](https://docs.qoder.com/cli/run-in-scripts)、[Qoder 登录](https://docs.qoder.com/cli/authentication)、[OpenAI 插件打包](https://developers.openai.com/plugins/build/plugins)。
