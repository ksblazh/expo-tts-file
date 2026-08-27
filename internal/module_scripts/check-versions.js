#!/usr/bin/env node
// The package version is declared in five places: package.json, the podspec, the Gradle
// module, and twice in package-lock.json. They drifted once already — 0.2.0 was published
// to npm while both native manifests still said 0.1.0, which every native build log
// announced as "Installing ExpoTtsFile (0.1.0)" and nobody noticed. A line in a release
// checklist did not hold; this does.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const expected = JSON.parse(read('package.json')).version;

const declarations = [
  ['ios/ExpoTtsFile.podspec', /s\.version\s*=\s*'([^']+)'/],
  ['android/build.gradle', /^version\s*=\s*'([^']+)'/m],
  ['android/build.gradle', /versionName\s+"([^"]+)"/],
];

const problems = [];

for (const [file, pattern] of declarations) {
  const found = read(file).match(pattern);
  if (!found) {
    problems.push(`${file}: no version matched ${pattern}`);
  } else if (found[1] !== expected) {
    problems.push(`${file}: ${found[1]}`);
  }
}

// package-lock.json carries the version twice. npm rewrites both from package.json, but
// only when something makes npm run — a hand-edited bump leaves them behind, nothing in
// the build reads them, and so the drift stays silent until someone diffs a release
// commit. Fix a mismatch with `npm install --package-lock-only`, not by hand: the two
// fields sit next to a dependency that may legitimately carry the same version string,
// and a blind search-and-replace has already nearly rewritten the wrong one.
const lock = JSON.parse(read('package-lock.json'));
for (const [label, found] of [
  ['package-lock.json .version', lock.version],
  ['package-lock.json .packages[""].version', lock.packages?.['']?.version],
]) {
  if (found === undefined) {
    problems.push(`${label}: absent`);
  } else if (found !== expected) {
    problems.push(`${label}: ${found}`);
  }
}

if (problems.length > 0) {
  console.error(`Version mismatch — package.json declares ${expected}:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`Versions agree across package.json, the lockfile, the podspec and Gradle: ${expected}`);
