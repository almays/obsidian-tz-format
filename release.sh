#!/bin/sh
# Bump the version, commit, tag and push; GitHub Actions then publishes the release
# that BRAT installs in every vault.
# Usage: ./release.sh [patch|minor|major|X.Y.Z]   (default: patch)
set -e
cd "$(dirname "$0")"

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree is not clean; commit or stash first." >&2
  exit 1
fi
if [ "$(git branch --show-current)" != "main" ]; then
  echo "Release from the main branch." >&2
  exit 1
fi

VERSION=$(node -e '
  const fs = require("fs");
  const bump = process.argv[1] || "patch";
  const m = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
  let v;
  if (/^\d+\.\d+\.\d+$/.test(bump)) v = bump;
  else {
    const [a, b, c] = m.version.split(".").map(Number);
    v = { major: `${a + 1}.0.0`, minor: `${a}.${b + 1}.0`, patch: `${a}.${b}.${c + 1}` }[bump];
    if (!v) { console.error(`Unknown bump: ${bump}`); process.exit(1); }
  }
  m.version = v;
  fs.writeFileSync("manifest.json", JSON.stringify(m, null, 2) + "\n");
  const vs = JSON.parse(fs.readFileSync("versions.json", "utf8"));
  vs[v] = m.minAppVersion;
  fs.writeFileSync("versions.json", JSON.stringify(vs, null, 2) + "\n");
  console.log(v);
' "$1")

git add manifest.json versions.json
git commit -q -m "Release $VERSION"
git tag "$VERSION"
git push origin main "$VERSION"
echo "Pushed $VERSION; the release appears on GitHub in a minute, BRAT picks it up on the next Obsidian start."
