// 独立 Node.js 脚本：执行 nexa cookies ls 并打印 stdout/stderr
import { execFile } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const nexaBin = resolve(root, 'dist/cli/index.js');

execFile('node', [nexaBin, 'cookies', 'ls'], { timeout: 30000 }, (err, stdout, stderr) => {
  console.log('=== stdout ===');
  process.stdout.write(stdout);
  console.log('=== stderr ===');
  process.stdout.write(stderr);
  if (err) {
    console.error('Process exited with error:', err);
    process.exit(err.code || 1);
  }
});
