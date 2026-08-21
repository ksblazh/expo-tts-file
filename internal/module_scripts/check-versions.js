#!/usr/bin/env node
// The package version is declared in three places: package.json, the podspec and the
// Gradle module. They drifted once already — 0.2.0 was published to npm while both
// native manifests still said 0.1.0, which every native build log announced as
// "Installing ExpoTtsFile (0.1.0)" and nobody noticed. A line in a release checklist
// did not hold; this does.
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

if (problems.length > 0) {
  console.error(`Version mismatch — package.json declares ${expected}:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`Versions agree across package.json, the podspec and Gradle: ${expected}`);
