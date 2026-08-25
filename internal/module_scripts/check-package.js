#!/usr/bin/env node
// What ends up in the npm tarball used to be decided by .npmignore — deny-by-default's
// opposite, so every new file shipped unless someone remembered to exclude it. The
// gitignored CLAUDE.md was never listed there and would have gone out with any manual
// `npm publish` from a working tree; CI escaped it only because a fresh checkout does
// not have the file. A published version cannot be unpublished after 72 hours.
//
// package.json#files is now the allowlist. This checks the two ways an allowlist goes
// wrong: it ships something it should not, and it quietly stops shipping something it
// should. Note that .npmignore cannot fix either — npm ignores it inside a directory
// named in `files`, which is why a naive `"src"` entry would pack src/__tests__.
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const pkg = require(path.join(root, 'package.json'));

// Sources that belong in the tarball, and the test trees inside them that do not.
const SOURCE_ROOTS = ['src', 'ios', 'android'];
const NOT_SOURCE = /(^|\/)(__tests__|__mocks__|test|androidTest|build)(\/|$)/;

const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 32 << 20 });

// npm 10 reports an array of packed packages, npm 12 an object keyed by package name;
// the per-file entries are identical. CI meets both — the release job installs
// npm@latest — so normalize the container, and fail loudly on a third shape instead of
// reading `undefined` off it.
function packedPaths(report) {
  const packages = Array.isArray(report) ? report : Object.values(report);
  const own = packages.find((entry) => entry && entry.name === pkg.name) ?? packages[0];
  if (!own || !Array.isArray(own.files)) {
    const version = run('npm', ['--version']).trim();
    throw new Error(`npm ${version} reported pack contents in an unrecognized shape`);
  }
  return new Set(own.files.map((file) => file.path));
}

// `npm pack` runs the `prepare` script no matter what — --ignore-scripts does not stop
// it — so this rebuilds build/ as a side effect and needs the dev dependencies installed.
let packed;
try {
  packed = packedPaths(JSON.parse(run('npm', ['pack', '--dry-run', '--json'])));
} catch (error) {
  console.error('Could not read what `npm pack --dry-run` would produce:');
  console.error(String(error.stderr || error.message).trim());
  console.error('Run `npm ci` first — packing rebuilds build/ through the prepare script.');
  process.exit(1);
}

let tracked = null;
try {
  // stderr is dropped: outside a checkout git's own "not a repository" is noise in
  // front of the explanation below.
  tracked = execFileSync('git', ['ls-files'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 << 20,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\n')
    .filter(Boolean);
} catch {
  console.warn('Not a git work tree — skipping the tracked-file checks.');
}

const problems = [];

// The compiled entry points: absent means the tarball is inert.
for (const entry of [pkg.main, pkg.types]) {
  if (!packed.has(entry)) {
    problems.push(`missing ${entry} — run \`npm run build\` before packing`);
  }
}

if (tracked) {
  // Nothing untracked may ship. This is the leak check: gitignored working files
  // (CLAUDE.md, .local/) and stray scratch files are untracked by definition, so it
  // needs no list of secrets to keep current. build/ is generated, hence exempt.
  const index = new Set(tracked);
  for (const file of packed) {
    if (file.startsWith('build/')) continue;
    if (!index.has(file)) problems.push(`not tracked by git, must not ship: ${file}`);
  }

  // …and no source may be left behind. Add ios/Whatever.swift and the podspec's
  // source_files glob will expect it on the consumer's disk; this fails until the
  // allowlist covers it.
  const sources = tracked.filter(
    (file) => SOURCE_ROOTS.some((dir) => file.startsWith(`${dir}/`)) && !NOT_SOURCE.test(file)
  );
  for (const file of sources) {
    if (!packed.has(file)) problems.push(`source is tracked but not packed: ${file}`);
  }
}

if (problems.length > 0) {
  console.error('Tarball contents are wrong:');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(
  `Tarball contents are correct: ${packed.size} files, allowlisted by package.json#files.`
);
