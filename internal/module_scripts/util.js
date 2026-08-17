const { spawnSync } = require('child_process');

// On Windows, executables like `tsc` and `jest` are `.cmd` batch files and cannot be
// spawned directly — they require shell: true to resolve. On Unix, shell: true is
// unnecessary.
function spawnSyncWithAutoShell(command, args, options) {
  const result = spawnSync(command, args, { ...options, shell: process.platform === 'win32' });
  if (result.error) {
    // A failed spawn (e.g. the tool is not installed) leaves status null, and callers
    // exit with `status ?? 0` — reporting success. Fail loudly instead.
    console.error(`${command}: ${result.error.message}`);
    process.exit(1);
  }
  return result;
}

module.exports = { spawnSyncWithAutoShell };
