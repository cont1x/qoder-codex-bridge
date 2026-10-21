import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Bridge } from './bridge.mjs';

const bridge = new Bridge();
const server = new McpServer({ name: 'qoder-codex', version: '1.0.0' });
const respond = fn => async args => {
  try { return { content: [{ type: 'text', text: JSON.stringify(await fn(args), null, 2) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
};
server.registerTool('qoder_health', { description: '检查本地 Qoder Desktop 执行入口与日志位置，不启动模型。', inputSchema: {} }, respond(() => bridge.health()));
server.registerTool('qoder_start', {
  description: '把 GPT 整理好的代码任务提示词交给本机 Qoder 执行。会修改指定工作目录中的文件。立即返回任务 ID，使用 qoder_result 查询。',
  inputSchema: {
    workspace: z.string().describe('要修改的项目绝对目录'),
    prompt: z.string().min(1).max(200000).describe('GPT 编写的任务：目标、上下文、范围、约束和实现指引'),
    acceptance: z.array(z.string()).max(50).optional().describe('可检查的验收标准'),
    timeoutSeconds: z.number().int().min(10).max(7200).optional(),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, respond(args => bridge.start(args)));
server.registerTool('qoder_result', { description: '读取 Qoder 任务状态与输出日志。completed 仅表示 Qoder 正常退出，仍需检查代码与验收结果。', inputSchema: { id: z.string() }, annotations: { readOnlyHint: true } }, respond(({ id }) => bridge.get(id)));
server.registerTool('qoder_list', { description: '列出最近三十次 Qoder 任务。', inputSchema: {}, annotations: { readOnlyHint: true } }, respond(() => bridge.list()));
server.registerTool('qoder_cancel', { description: '终止当前 Qoder 任务进程，保留已写入文件及执行日志。', inputSchema: { id: z.string() } }, respond(({ id }) => bridge.cancel(id)));
server.server.onclose = () => bridge.shutdown();
process.on('SIGTERM', () => { bridge.shutdown(); process.exit(0); });
process.on('SIGINT', () => { bridge.shutdown(); process.exit(0); });
await server.connect(new StdioServerTransport());
