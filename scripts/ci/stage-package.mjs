// Builds the App Service deployment folder from an already-built app/ tree.
// Layout (matches the startup command `node server/dist/index.js`):
//   package.json (server + shared runtime deps, no workspaces)
//   server/{package.json,dist}  shared/{package.json,dist}  web/dist  build-info.json
// Workspace symlinks do not survive on App Service /home, so @spostorage/shared is later copied
// into node_modules as a real folder (see the workflow).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , outDirArg] = process.argv;
if (!outDirArg) {
  console.error('usage: node scripts/ci/stage-package.mjs <outDir>');
  process.exit(1);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appDir = path.join(root, 'app');
const outDir = path.resolve(outDirArg);

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

for (const must of ['server/dist/index.js', 'web/dist/index.html', 'shared/dist/index.js']) {
  if (!fs.existsSync(path.join(appDir, must))) {
    console.error(`missing build output: app/${must}`);
    process.exit(1);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

function runtimePackageJson(pkg) {
  const out = { name: pkg.name, version: pkg.version, private: true, type: pkg.type };
  for (const key of ['main', 'types', 'exports', 'dependencies']) {
    if (pkg[key]) out[key] = pkg[key];
  }
  return out;
}

for (const ws of ['server', 'shared']) {
  const pkg = readJson(path.join(appDir, ws, 'package.json'));
  fs.mkdirSync(path.join(outDir, ws), { recursive: true });
  fs.writeFileSync(path.join(outDir, ws, 'package.json'), `${JSON.stringify(runtimePackageJson(pkg), null, 2)}\n`);
  fs.cpSync(path.join(appDir, ws, 'dist'), path.join(outDir, ws, 'dist'), { recursive: true });
}
fs.cpSync(path.join(appDir, 'web', 'dist'), path.join(outDir, 'web', 'dist'), { recursive: true });

const serverPkg = readJson(path.join(appDir, 'server', 'package.json'));
const sharedPkg = readJson(path.join(appDir, 'shared', 'package.json'));
const deps = {};
for (const pkg of [sharedPkg, serverPkg]) {
  for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
    if (name === '@spostorage/shared' || name === 'better-sqlite3') continue;
    deps[name] = version;
  }
}
fs.writeFileSync(
  path.join(outDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'spostorage',
      version: serverPkg.version,
      private: true,
      type: 'module',
      dependencies: deps,
      scripts: { start: 'node server/dist/index.js' },
    },
    null,
    2,
  )}\n`,
);

const buildInfo = {
  version: serverPkg.version,
  commit: process.env.GITHUB_SHA ?? null,
  ref: process.env.GITHUB_REF_NAME ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(outDir, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
console.log(`staged ${outDir}`, buildInfo);
