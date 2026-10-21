import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync, realpathSync, statSync, readdirSync, renameSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { delimiter, extname } from 'node:path';

export function discover(env = process.env) {
  const launcherDir = join(env.LOCALAPPDATA || join(homedir(), 'AppData/Local'), 'Qoder/Qoder Launcher');
  const launcher = env.QODER_LAUNCHER || join(launcherDir, 'Qoder Launcher.exe');
  const stateDir = resolve(launcher, '..');
  const installDirs = [env.QODER_INSTALL_DIR];
  for (const name of ['state.ini', 'install.ini']) {
    const ini = join(stateDir, name);
    if (existsSync(ini)) installDirs.push(readFileSync(ini, 'utf8').match(/^installDir=(.+)$/m)?.[1]?.trim());
  }
  const workers = installDirs.filter(Boolean).map(dir => join(dir, 'resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs'));
  const native = [join(homedir(), '.qoder/bin/qodercli/qodercli.exe'), ...(env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, process.platform === 'win32' ? 'qodercli.exe' : 'qodercli'))];
  const entry = env.QODER_CLI || workers.find(existsSync) || native.find(existsSync) || '';
  const javascript = ['.js', '.mjs', '.cjs'].includes(extname(entry).toLowerCase());
  return {
    launcher,
    command: javascript ? (env.QODER_NODE || process.execPath) : entry,
    entry, prefixArgs: javascript ? [entry] : [],
    home: env.QODER_CONFIG_DIR || join(homedir(), '.qoder'),
    data: env.QODER_BRIDGE_DATA || join(homedir(), '.codex/qoder-bridge/runs'),
  };
}

export function makePrompt({ prompt, acceptance = [] }) {
  return `你是本次任务的代码执行者。上游 GPT/Codex 已整理以下任务，请直接在当前工作目录实现。\n遵守项目 AGENTS.md 和现有代码规范，保留无关改动。遇到缺失凭据或必须人工确认的操作，明确报告阻塞，不要假称完成。不要把实现任务再转交给 Codex。\n\n任务提示词：\n${prompt}\n\n验收标准：\n${acceptance.length ? acceptance.map((s, i) => `${i + 1}. ${s}`).join('\n') : '完成任务，并运行与改动相关的检查。'}\n\n最后用中文报告：实际修改的文件、实现要点、执行过的检查及结果、尚未完成的事项。`;
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; }
}
function tail(path, limit = 24000) {
  // Logs are capped by the runner; return only a context-sized tail to GPT.
  return existsSync(path) ? readFileSync(path, 'utf8').slice(-limit) : '';
}

export class Bridge {
  constructor(config = discover()) {
    this.config = config;
    this.running = new Map();
    mkdirSync(config.data, { recursive: true });
  }
  health() {
    return { ...this.config, entryExists: existsSync(this.config.entry), commandExists: existsSync(this.config.command), launcherExists: existsSync(this.config.launcher || ''), transport: 'stdio', execution: 'Qoder bundled worker / qodercli --print', permissionMode: 'accept_edits', authentication: 'Qoder CLI login or QODER_PERSONAL_ACCESS_TOKEN; health does not verify login' };
  }
  paths(id) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('无效任务 ID');
    const dir = join(this.config.data, id);
    return { dir, status: join(dir, 'status.json'), stdout: join(dir, 'stdout.log'), stderr: join(dir, 'stderr.log') };
  }
  save(job) {
    const target = this.paths(job.id).status;
    const temp = `${target}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(job, null, 2));
    renameSync(temp, target);
  }
  get(id) {
    const paths = this.paths(id);
    if (!existsSync(paths.status)) throw new Error('找不到该任务');
    const job = JSON.parse(readFileSync(paths.status, 'utf8'));
    if (['running', 'cancelling'].includes(job.state) && !this.running.has(id) && !(job.ownerPid && alive(job.ownerPid))) {
      job.state = 'interrupted';
      job.error = '所属桥接服务已断开；执行进程可能仍在运行，请检查日志和工作区后再提交。';
    }
    return { ...job, stdout: tail(paths.stdout), stderr: tail(paths.stderr), logDirectory: paths.dir };
  }
  list() {
    return readdirSync(this.config.data).filter(id => /^[0-9a-f-]{36}$/.test(id))
      .map(id => { const { stdout, stderr, ...job } = this.get(id); return job; })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 30);
  }
  async start({ workspace, prompt, acceptance = [], timeoutSeconds = 1200 }) {
    if (!isAbsolute(workspace)) throw new Error('工作目录必须是绝对路径');
    const cwd = realpathSync(resolve(workspace));
    if (!statSync(cwd).isDirectory()) throw new Error('工作目录不是文件夹');
    if (!prompt?.trim()) throw new Error('提示词不能为空');
    if (!existsSync(this.config.entry)) throw new Error('未找到 Qoder 后台入口。请设置 QODER_INSTALL_DIR 或 QODER_CLI 指向实际 qodercli.exe / JS 入口。');
    if (/\.(cmd|bat|ps1)$/i.test(this.config.entry)) throw new Error('QODER_CLI 需指向实际可执行文件或 JS 入口，不支持 shell 包装脚本。');
    const lockKey = createHash('sha256').update(process.platform === 'win32' ? cwd.toLowerCase() : cwd).digest('hex');
    const lock = join(this.config.data, `${lockKey}.lock`);
    if (existsSync(lock)) {
      const owner = JSON.parse(readFileSync(lock, 'utf8'));
      if (alive(owner.pid) || (owner.childPid && alive(owner.childPid))) throw new Error(`该目录已有 Qoder 任务：${owner.id}`);
      unlinkSync(lock);
    }
    const id = randomUUID();
    const fd = openSync(lock, 'wx');
    writeFileSync(fd, JSON.stringify({ pid: process.pid, id }));
    closeSync(fd);
    const paths = this.paths(id);
    let child;
    try {
      mkdirSync(paths.dir);
      const task = makePrompt({ prompt, acceptance });
      writeFileSync(join(paths.dir, 'prompt.md'), task);
      const args = [...(this.config.prefixArgs ?? [this.config.entry]), '--print', '--output-format', 'json', '--permission-mode', 'accept_edits', '--config-dir', this.config.home, '--session-id', id, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'];
      if (process.env.QODER_MODEL) args.push('--model', process.env.QODER_MODEL);
      child = spawn(this.config.command, args, {
        cwd, env: { ...process.env, QODER_CONFIG_DIR: this.config.home },
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      });
      const job = { id, sessionId: id, ownerPid: process.pid, workspace: cwd, state: 'running', startedAt: new Date().toISOString(), pid: child.pid ?? null, exitCode: null };
      writeFileSync(lock, JSON.stringify({ pid: process.pid, childPid: child.pid, id }));
      this.save(job);
      let finished = false;
      const fds = { stdout: openSync(paths.stdout, 'w'), stderr: openSync(paths.stderr, 'w') };
      const sizes = { stdout: 0, stderr: 0 };
      for (const key of ['stdout', 'stderr']) child[key].on('data', chunk => {
        const remaining = 8 * 1024 * 1024 - sizes[key];
        if (remaining > 0) { const part = chunk.subarray(0, remaining); writeFileSync(fds[key], part); sizes[key] += part.length; }
      });
      const finish = (code, signal, error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        closeSync(fds.stdout); closeSync(fds.stderr);
        job.exitCode = code;
        job.signal = signal;
        job.state = job.state === 'cancelling' ? 'cancelled' : job.state === 'running' ? (code === 0 && !error ? 'completed' : 'failed') : job.state;
        // Some CLI versions communicate a task failure in JSON despite exit 0.
        if (job.state === 'completed') {
          try {
            const result = JSON.parse(readFileSync(paths.stdout, 'utf8'));
            job.result = { subtype: result.subtype, is_error: result.is_error, result: result.result };
            if (result.is_error === true || (typeof result.subtype === 'string' && result.subtype.startsWith('error'))) {
              job.state = 'failed';
              job.error = result.result || result.subtype;
            }
          } catch { /* Non-JSON output remains available in the raw log. */ }
        }
        if (error) job.error = error.message;
        job.finishedAt = new Date().toISOString();
        this.save(job);
        this.running.delete(id);
        if (existsSync(lock)) unlinkSync(lock);
      };
      const timer = setTimeout(() => { job.state = 'timed_out'; this.save(job); this.kill(child); }, timeoutSeconds * 1000);
      this.running.set(id, { child, job });
      child.once('error', error => finish(null, null, error));
      child.once('close', (code, signal) => finish(code, signal));
      child.stdin.on('error', error => { job.inputError = error.message; });
      child.stdin.end(task, 'utf8');
      return { ...job, logDirectory: paths.dir, next: '调用 qoder_result 查询结果；完成后检查文件差异并验证验收标准。' };
    } catch (error) {
      if (child) this.kill(child);
      if (existsSync(lock)) unlinkSync(lock);
      throw error;
    }
  }
  kill(child) {
    if (!child.pid) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => child.kill());
    } else child.kill('SIGTERM');
  }
  cancel(id) {
    const active = this.running.get(id);
    if (!active) throw new Error('任务未在当前服务运行；请先查询结果');
    active.job.state = 'cancelling';
    this.save(active.job);
    this.kill(active.child);
    return { id, state: 'cancelling', note: '取消不会撤回已经写入的文件。' };
  }
  shutdown() {
    for (const { child, job } of this.running.values()) {
      job.state = 'interrupted'; this.save(job); this.kill(child);
    }
  }
}
