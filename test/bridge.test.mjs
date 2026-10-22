import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, discover } from '../src/bridge.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function finished(bridge, id) {
  for (let i = 0; i < 150; i++) { const job = bridge.get(id); if (!['running', 'cancelling'].includes(job.state)) return job; await pause(40); }
  throw new Error('test timeout');
}
function setup(source) {
  const root = mkdtempSync(join(tmpdir(), 'qoder-bridge-'));
  const entry = join(root, 'fake.mjs');
  const workspace = join(root, 'project with spaces'); mkdirSync(workspace);
  writeFileSync(entry, source);
  return { workspace, bridge: new Bridge({ command: process.execPath, entry, home: root, data: join(root, 'runs') }) };
}
test('中文和 shell 字符经 stdin 原样传输，工作目录正确，输出可恢复', async () => {
  const { bridge, workspace } = setup(`import {writeFileSync} from 'node:fs'; let text='';for await(const chunk of process.stdin)text+=chunk;writeFileSync('received.txt',text);console.log(process.cwd());`);
  const prompt = '中文 "quotes" $() & | `backticks`\n第二行';
  const { id } = await bridge.start({ workspace, prompt });
  const result = await finished(bridge, id);
  assert.equal(result.state, 'completed');
  assert.ok(result.stdout.includes(workspace));
  assert.ok(readFileSync(join(workspace, 'received.txt'), 'utf8').includes(prompt));
  assert.equal(new Bridge(bridge.config).get(id).state, 'completed');
});
test('同目录并发被阻止，取消终止进程', async () => {
  const { bridge, workspace } = setup('process.stdin.resume();setInterval(()=>{},1000);');
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  await assert.rejects(bridge.start({ workspace, prompt: 'duplicate' }), /已有 Qoder 任务/);
  bridge.cancel(id);
  assert.equal((await finished(bridge, id)).state, 'cancelled');
});
test('非零退出报告失败，目录和 ID 校验', async () => {
  const { bridge, workspace } = setup('console.error("provider unavailable");process.exit(7);');
  await assert.rejects(bridge.start({ workspace: '.', prompt: 'task' }), /绝对路径/);
  assert.throws(() => bridge.get('../outside'), /无效任务/);
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const job = await finished(bridge, id);
  assert.equal(job.state, 'failed'); assert.equal(job.exitCode, 7); assert.match(job.stderr, /provider unavailable/);
});
test('Launcher 安装记录定位 worker，显式入口优先', () => {
  const root = mkdtempSync(join(tmpdir(), 'qoder-discovery-'));
  const install = join(root, 'actual installation');
  const worker = join(install, 'resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs');
  mkdirSync(join(worker, '..'), { recursive: true }); writeFileSync(worker, '');
  writeFileSync(join(root, 'state.ini'), `[launcher]\r\ninstallDir=${install}\r\n`);
  const config = discover({ QODER_LAUNCHER: join(root, 'Qoder Launcher.exe'), PATH: '' });
  assert.equal(config.entry, worker); assert.deepEqual(config.prefixArgs, [worker]);
  const native = discover({ QODER_CLI: join(root, 'qodercli.exe'), PATH: '' });
  assert.deepEqual(native.prefixArgs, []); assert.equal(native.command, native.entry);
});
test('JSON 任务错误即使退出零也报告失败', async () => {
  const { bridge, workspace } = setup('console.log(JSON.stringify({type:"result",subtype:"error_during_execution",is_error:true,result:"Login expired"}));');
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const job = await finished(bridge, id);
  assert.equal(job.state, 'failed'); assert.equal(job.exitCode, 0); assert.equal(job.error, 'Login expired');
});
test('Qoder 参数保留权限、MCP 隔离和 stdin，不使用 shell 绕过', async () => {
  const { bridge, workspace } = setup('console.log(JSON.stringify(process.argv.slice(2)));');
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const job = await finished(bridge, id);
  const args = JSON.parse(job.stdout);
  assert.ok(args.includes('--print')); assert.equal(args[args.indexOf('--permission-mode') + 1], 'accept_edits');
  assert.ok(args.includes('--strict-mcp-config')); assert.ok(!args.includes('--yolo'));
});
test('默认等待短任务完成，精简摘要去掉重复日志并保留完整排障入口', async () => {
  const report = '完成报告'.repeat(1500);
  const { bridge, workspace } = setup(`console.error('diagnostic'.repeat(3000));console.log(JSON.stringify({subtype:'success',result:${JSON.stringify(report)}}));`);
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const summary = await bridge.compactResult(id, { waitSeconds: 2 });
  assert.equal(summary.state, 'completed'); assert.equal(summary.summary.length, 1600);
  assert.equal(summary.truncated, true); assert.equal(summary.stdout, undefined); assert.equal(summary.stderr, undefined);
  const full = await bridge.compactResult(id, { waitSeconds: 0, detail: 'full' });
  assert.ok(full.stdout.includes(report)); assert.ok(full.stderr.includes('diagnostic'));
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 5);
  assert.equal(bridge.compactList()[0].result, undefined);
});
test('等待超时返回运行状态，失败摘要保留诊断', async () => {
  const { bridge, workspace } = setup('process.stdin.resume();setInterval(()=>{},1000);');
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const summary = await bridge.compactResult(id, { waitSeconds: 0 });
  assert.equal(summary.state, 'running'); assert.equal(summary.summary, undefined);
  bridge.cancel(id); await finished(bridge, id);
  const failed = setup('console.error("missing credentials");process.exit(1);');
  const job = await failed.bridge.start({ workspace: failed.workspace, prompt: 'task' });
  const result = await failed.bridge.compactResult(job.id, { waitSeconds: 2 });
  assert.equal(result.state, 'failed'); assert.match(result.diagnostic, /missing credentials/);
});
test('相同结果只返回未变化状态，翻页不会被旧revision跳过', async () => {
  const report = 'A'.repeat(1600) + '验收失败：检查未执行。' + 'B'.repeat(2000);
  const { bridge, workspace } = setup(`console.log(JSON.stringify({subtype:'success',result:${JSON.stringify(report)}}));`);
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const first = await bridge.compactResult(id, { waitSeconds: 2 });
  const same = await bridge.compactResult(id, { waitSeconds: 0, afterRevision: first.revision });
  assert.equal(same.unchanged, true); assert.equal(same.summary, undefined);
  assert.ok(JSON.stringify(same).length < JSON.stringify(first).length / 5);
  const second = await bridge.compactResult(id, { waitSeconds: 0, offset: first.nextOffset, afterRevision: first.revision });
  assert.match(second.summary, /验收失败/); assert.notEqual(second.revision, first.revision);
  assert.equal(second.unchanged, undefined);
  const third = await bridge.compactResult(id, { waitSeconds: 0, offset: second.nextOffset });
  assert.equal(first.summary + second.summary + third.summary, report);
  assert.equal(third.truncated, false);
});
test('状态改变时旧revision仍返回最新结果', async () => {
  const { bridge, workspace } = setup('setTimeout(()=>console.log(JSON.stringify({result:"done"})),300);');
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const initial = await bridge.compactResult(id, { waitSeconds: 0 });
  assert.equal(initial.state, 'running');
  const result = await bridge.compactResult(id, { waitSeconds: 2, afterRevision: initial.revision });
  assert.equal(result.state, 'completed'); assert.equal(result.summary, 'done');
  assert.notEqual(result.revision, initial.revision);
});
test('成功退出仍提示独立验收、未读报告、诊断和权限拒绝', async () => {
  const { bridge, workspace } = setup('console.error("test skipped");console.log(JSON.stringify({result:"A".repeat(1800),permission_denials:[{tool:"Bash"}]}));');
  const { id } = await bridge.start({ workspace, prompt: 'task' });
  const first = await bridge.compactResult(id, { waitSeconds: 2 });
  assert.equal(first.state, 'completed'); assert.equal(first.reviewRequired, true);
  assert.equal(first.reportChars, 1800); assert.equal(first.unreadChars, 200);
  assert.equal(first.diagnosticAvailable, true); assert.equal(first.permissionDenialCount, 1);
  const last = await bridge.compactResult(id, { waitSeconds: 0, offset: first.nextOffset });
  assert.equal(last.unreadChars, 0); assert.equal(last.reviewRequired, true);
  const full = await bridge.compactResult(id, { waitSeconds: 0, detail: 'full' });
  assert.match(full.stderr, /test skipped/); assert.equal(JSON.parse(full.stdout).permission_denials.length, 1);
});
