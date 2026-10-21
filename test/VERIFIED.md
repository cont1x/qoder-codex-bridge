2026-10-22 本机验收记录：

- Windows x64，Node.js 24，Qoder Desktop 0.4.8 自带 worker 1.1.69。
- 使用 Launcher 安装记录自动找到真实后台入口，通过 Qoder 官方浏览器登录。
- MCP SDK 客户端完成 stdio 握手并发现五个桥接工具。
- 真实模型在独立测试目录通过 Write 工具创建 bridge-smoke.txt，并使用 Read 回读；exitCode 0，result.subtype 为 success。
- 客户端独立读取真实文件，严格等于 QODER_CODEX_BRIDGE_OK，21 字节。
- 自动化测试覆盖中文和特殊字符传递、结果持久化、同目录互斥、取消进程、非零退出、Launcher 发现、JSON 任务错误及权限参数。

登录与任务日志保留在本机，未包含在公开源码中。此记录不表示其他版本的 Qoder 内部 worker 路径保持不变。
