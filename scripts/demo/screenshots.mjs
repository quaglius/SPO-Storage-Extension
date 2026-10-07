// Generates the README screenshots in docs/images/ from the fake-data mock API. No SQL Server, no Azure.
//
//   cd scripts/demo
//   npm install --no-save playwright-core
//   node screenshots.mjs
//
// Needs Node 22, Google Chrome (CHROME_PATH overrides the default path) and free ports 4180 and 5173.
// If app/node_modules is missing it runs `npm ci --ignore-scripts` in app/ (the lockfile is not modified) and removes
// app/node_modules again at the end; set KEEP_APP_DEPS=1 to keep it.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockApi } from './mock-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const appDir = path.join(repo, 'app');
const webDir = path.join(appDir, 'web');
const outDir = path.join(repo, 'docs', 'images');
const viteBin = path.join(appDir, 'node_modules', 'vite', 'bin', 'vite.js');
const chromePath = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const API_PORT = 4180;
const WEB_PORT = 5173;
const BASE = `http://localhost:${WEB_PORT}`;

const SHOTS = [
  {
    file: 'status.png',
    url: '/',
    fullPage: true,
    ready: async (page) => {
      await page.getByRole('heading', { name: 'Tenant quota', exact: true }).waitFor();
      await page.locator('.recharts-line-curve').first().waitFor();
      await page.getByRole('heading', { name: 'Recent events', exact: true }).waitFor();
    },
  },
  {
    file: 'sites.png',
    url: '/sites',
    ready: async (page) => {
      await page.getByRole('link', { name: 'Video Production' }).waitFor();
    },
  },
  {
    file: 'site-detail.png',
    url: '/sites/1',
    ready: async (page) => {
      await page.getByRole('heading', { name: 'Marketing', exact: true }).waitFor();
      await page.getByRole('cell', { name: 'Brand Assets' }).first().waitFor();
    },
  },
  {
    file: 'policies.png',
    url: '/policies',
    ready: async (page) => {
      await page.getByText('Trim heavy versions (keep latest 5)').waitFor();
    },
  },
  {
    file: 'lab.png',
    url: '/lab',
    fullPage: true,
    ready: async (page) => {
      await page.getByText('would be freed').waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Select first 5' }).click();
      await page.getByRole('button', { name: 'Create test with 5 selected' }).waitFor();
    },
  },
  {
    file: 'archived.png',
    url: '/archived',
    ready: async (page) => {
      await page.getByRole('cell', { name: 'Video Production', exact: true }).click();
      await page.getByRole('cell', { name: 'Raw Footage', exact: true }).click();
      await page.getByText('Harbor_Timelapse_A-cam.mov').waitFor();
    },
  },
  {
    file: 'activity.png',
    url: '/activity',
    ready: async (page) => {
      await page.getByRole('cell', { name: 'site-denied', exact: true }).first().waitFor();
    },
  },
];

const log = (msg) => console.log(`[screenshots] ${msg}`);

function portFree(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => resolve(err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT'));
    srv.listen(port, host, () => srv.close(() => resolve(true)));
  });
}

async function assertPortsFree() {
  for (const port of [API_PORT, WEB_PORT]) {
    if (!(await portFree(port, '127.0.0.1')) || !(await portFree(port, '::1'))) {
      throw new Error(`Port ${port} is in use. Stop the dev server (npm run dev) first.`);
    }
  }
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.pid == null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

async function waitForHttp(url, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Vite exited early with code ${child.exitCode}`);
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function ensureAppDeps() {
  if (existsSync(viteBin)) return false;
  log('app/node_modules is missing: running npm ci --ignore-scripts in app/ (lockfile untouched)');
  const res = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: appDir,
    stdio: 'inherit',
    shell: true,
  });
  if (res.status !== 0 || !existsSync(viteBin)) throw new Error('npm ci in app/ failed');
  return true;
}

async function loadPlaywright() {
  try {
    return await import('playwright-core');
  } catch {
    throw new Error('playwright-core is not installed. Run: cd scripts/demo && npm install --no-save playwright-core');
  }
}

/** Rejects screenshots that are blank or nearly uniform by counting distinct colours on a pixel sample grid. */
async function assertNotBlank(page, file) {
  const { size } = statSync(file);
  if (size < 20_000) throw new Error(`${path.basename(file)} is suspiciously small (${size} bytes)`);
  const b64 = readFileSync(file).toString('base64');
  const colours = await page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const seen = new Set();
    for (let y = 0; y < canvas.height; y += Math.max(1, Math.floor(canvas.height / 80))) {
      for (let x = 0; x < canvas.width; x += Math.max(1, Math.floor(canvas.width / 80))) {
        const [r, g, b] = ctx.getImageData(x, y, 1, 1).data;
        seen.add((r << 16) | (g << 8) | b);
      }
    }
    return seen.size;
  }, b64);
  if (colours < 8) throw new Error(`${path.basename(file)} looks blank (${colours} distinct colours)`);
  return colours;
}

async function main() {
  await assertPortsFree();
  if (!existsSync(chromePath)) throw new Error(`Chrome not found at ${chromePath} (set CHROME_PATH)`);
  const { chromium } = await loadPlaywright();

  let installedDeps = false;
  let mock;
  let vite;
  let browser;
  const problems = [];

  const cleanup = async () => {
    await browser?.close().catch(() => {});
    killTree(vite);
    await mock?.close().catch(() => {});
    if (installedDeps && process.env.KEEP_APP_DEPS !== '1') {
      log('removing app/node_modules installed by this script');
      rmSync(path.join(appDir, 'node_modules'), { recursive: true, force: true });
    }
  };
  const onSignal = () => {
    void cleanup().then(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    installedDeps = ensureAppDeps();

    mock = await startMockApi({ port: API_PORT, log });
    log(`mock API on :${API_PORT}`);

    vite = spawn(process.execPath, [viteBin, '--port', String(WEB_PORT), '--strictPort'], {
      cwd: webDir,
      env: { ...process.env, PORT: String(WEB_PORT), BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    vite.stdout.on('data', (d) => process.env.DEBUG_VITE && process.stdout.write(d));
    vite.stderr.on('data', (d) => process.stderr.write(d));
    await waitForHttp(`${BASE}/`, 60_000, vite);
    log(`vite on :${WEB_PORT}`);

    mkdirSync(outDir, { recursive: true });
    browser = await chromium.launch({ executablePath: chromePath, headless: true });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: 'light',
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    await context.addInitScript(() => localStorage.setItem('spostorage-theme', 'light'));

    for (const shot of SHOTS) {
      const page = await context.newPage();
      const pageProblems = [];
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const where = msg.location()?.url ?? '';
        if (/\/favicon\.ico$/.test(where)) return;
        pageProblems.push(`console error: ${msg.text()}${where ? ` (${where})` : ''}`);
      });
      page.on('pageerror', (err) => pageProblems.push(`page error: ${err.message}`));
      page.on('requestfailed', (req) => {
        if (req.url().includes('/api/')) pageProblems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`);
      });
      page.on('response', (res) => {
        if (res.url().includes('/api/') && res.status() >= 400) pageProblems.push(`HTTP ${res.status()}: ${res.url()}`);
      });

      await page.goto(`${BASE}${shot.url}`, { waitUntil: 'networkidle' });
      await shot.ready(page);
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);

      const hosts = await page.evaluate(() =>
        [...document.body.innerText.matchAll(/([a-z0-9-]+)\.sharepoint\.com/gi)].map((m) => m[1].toLowerCase()),
      );
      const foreign = [...new Set(hosts)].filter((h) => h !== 'contoso');
      if (foreign.length) pageProblems.push(`non-demo tenant host on page: ${foreign.join(', ')}`);

      const file = path.join(outDir, shot.file);
      await page.screenshot({ path: file, fullPage: Boolean(shot.fullPage) });
      await assertNotBlank(page, file);
      log(`saved docs/images/${shot.file}${pageProblems.length ? ` with ${pageProblems.length} problem(s)` : ''}`);
      problems.push(...pageProblems.map((p) => `${shot.file}: ${p}`));
      await page.close();
    }
  } finally {
    await cleanup();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }

  for (const port of [API_PORT, WEB_PORT]) {
    if (!(await portFree(port, '127.0.0.1')) || !(await portFree(port, '::1'))) {
      problems.push(`port ${port} is still in use after cleanup`);
    }
  }
  if (problems.length) {
    for (const p of problems) console.error(`[screenshots] ${p}`);
    process.exitCode = 1;
    return;
  }
  log(`done: ${SHOTS.length} screenshots in docs/images/, ports ${API_PORT} and ${WEB_PORT} are free`);
}

main().catch((err) => {
  console.error(`[screenshots] ${err.stack ?? err}`);
  process.exitCode = 1;
});
