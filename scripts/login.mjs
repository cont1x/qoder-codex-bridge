import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { discover } from '../src/bridge.mjs';
const config = discover();
if (!existsSync(config.entry)) throw new Error('未找到 Qoder 后台入口，请设置 QODER_INSTALL_DIR 或 QODER_CLI。');
const child = spawn(config.command, [...config.prefixArgs, '--config-dir', config.home, 'login'], {
  stdio: 'inherit', windowsHide: true, shell: false,
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
