import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Bridge } from './bridge.mjs';

const bridge = new Bridge();
const server = new McpServer({ name: 'qoder-codex', version: '1.2.0' });
const respond = fn => async args => {
  try { return { content: [{ type: 'text', text: JSON.stringify(await fn(args), null, 2) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
};
server.registerTool('qoder_health', { description: '检查本地 Qoder Desktop 执行入口与日志位置，不启动模型。', inputSchema: {} }, respond(() => bridge.health()));
server.registerTool('qoder_start', {
  description: '把任务交给 Qoder 实现并自检，会修改项目。默认等待最多45秒并返回简短结果；未结束用 qoder_result 等待。',
  inputSchema: {
    workspace: z.string().describe('要修改的项目绝对目录'),
    prompt: z.string().min(1).max(200000).describe('GPT 编写的任务：目标、上下文、范围、约束和实现指引'),
    acceptance: z.array(z.string()).max(50).optional().describe('可检查的验收标准'),
    timeoutSeconds: z.number().int().min(10).max(7200).optional(),
    waitSeconds: z.number().int().min(0).max(45).optional().describe('服务端等待秒数，默认45，减少轮询'),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, respond(async args => {
  const job = await bridge.start(args);
  return bridge.compactResult(job.id, { waitSeconds: args.waitSeconds });
}));
server.registerTool('qoder_result', {
  description: '等待并返回简短任务摘要，默认不回传原始日志。completed仍需验收；排障可选full。',
  inputSchema: { id: z.string(), waitSeconds: z.number().int().min(0).max(45).optional(), detail: z.enum(['summary', 'full']).optional(), afterRevision: z.string().optional().describe('上次返回的revision，未变化时不重复报告'), offset: z.number().int().min(0).optional(), maxChars: z.number().int().min(100).max(4000).optional() },
  annotations: { readOnlyHint: true },
}, respond(({ id, ...options }) => bridge.compactResult(id, options)));
server.registerTool('qoder_list', { description: '列出最近十次任务的简短状态，不返回报告或日志。', inputSchema: {}, annotations: { readOnlyHint: true } }, respond(() => bridge.compactList()));
server.registerTool('qoder_cancel', { description: '终止当前 Qoder 任务进程，保留已写入文件及执行日志。', inputSchema: { id: z.string() } }, respond(({ id }) => bridge.cancel(id)));
server.server.onclose = () => bridge.shutdown();
process.on('SIGTERM', () => { bridge.shutdown(); process.exit(0); });
process.on('SIGINT', () => { bridge.shutdown(); process.exit(0); });
await server.connect(new StdioServerTransport());
