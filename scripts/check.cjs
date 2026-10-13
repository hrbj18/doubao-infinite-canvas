const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
let failed = false;
for (const directory of ['src', 'ui', 'scripts', 'test']) {
  for (const name of fs.readdirSync(path.join(__dirname, '..', directory))) {
    if (!/\.(cjs|mjs|js)$/.test(name)) continue;
    const file = path.join(__dirname, '..', directory, name), result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) { process.stderr.write(result.stderr); failed = true; }
  }
}
if (failed) process.exit(1); console.log('全部 JavaScript 文件语法检查通过');
