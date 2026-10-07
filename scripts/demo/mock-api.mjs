// Fake-data mock of the SpoStorage API for README screenshots and UI demos.
// Dependency-free: `node scripts/demo/mock-api.mjs [port]` (default 4180, what the Vite dev proxy expects).
// Everything here is fictional: tenant "contoso", people "Ana Lopez" and "Ben Carter".

import http from 'node:http';
import { pathToFileURL } from 'node:url';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const TB = 1024 ** 4;
const DAY = 86_400_000;
const TENANT_URL = 'https://contoso.sharepoint.com';
const PEOPLE = [
  { name: 'Ana Lopez', email: 'ana.lopez@contoso.com' },
  { name: 'Ben Carter', email: 'ben.carter@contoso.com' },
];

// Deterministic pseudo-random numbers so every run produces the same screenshots.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const ago = (ms) => new Date(Date.now() - ms).toISOString();
const daysAgo = (d) => ago(d * DAY);
const minutesAgo = (m) => ago(m * 60_000);
const round = (n) => Math.round(n);

const SITES = [
  { id: 1, title: 'Marketing', slug: 'marketing', usedTb: 7.6, versionsShare: 0.58, libs: ['Documents', 'Brand Assets', 'Campaigns', 'Event Photos', 'Site Assets'] },
  { id: 2, title: 'Design Studio', slug: 'design-studio', usedTb: 6.9, versionsShare: 0.66, libs: ['Documents', 'Working Files', 'Renders', 'Fonts and Templates'] },
  { id: 3, title: 'Video Production', slug: 'video-production', usedTb: 11.2, versionsShare: 0.52, libs: ['Documents', 'Raw Footage', 'Edits', 'Final Masters'] },
  { id: 4, title: 'Projects 2024', slug: 'projects-2024', usedTb: 4.3, versionsShare: 0.61, libs: ['Documents', 'Deliverables', 'Drawings'] },
  { id: 5, title: 'Finance', slug: 'finance', usedTb: 2.1, versionsShare: 0.71, libs: ['Documents', 'Reports', 'Budgets'] },
  { id: 6, title: 'HR', slug: 'hr', usedTb: 0.85, versionsShare: 0.44, libs: ['Documents', 'Policies', 'Onboarding'] },
  { id: 7, title: 'Sales', slug: 'sales', usedTb: 1.6, versionsShare: 0.55, libs: ['Documents', 'Proposals', 'Price Lists'] },
  { id: 8, title: 'Legal', slug: 'legal', usedTb: 0.95, versionsShare: 0.38, libs: ['Documents', 'Contracts'] },
  { id: 9, title: 'Engineering', slug: 'engineering', usedTb: 1.4, versionsShare: 0.63, libs: ['Documents', 'Specifications', 'CAD'] },
  { id: 10, title: 'Training', slug: 'training', usedTb: 0.62, versionsShare: 0.35, libs: ['Documents', 'Recordings'] },
  { id: 11, title: 'IT Operations', slug: 'it-operations', usedTb: 0.31, versionsShare: 0.29, libs: ['Documents', 'Runbooks'] },
  { id: 12, title: 'Executive Board', slug: 'executive-board', usedTb: 0.12, versionsShare: 0, libs: [], denied: true },
  { id: 13, title: 'Events', slug: 'events', usedTb: 0.04, versionsShare: 0.21, libs: ['Documents'] },
];

const FILE_NAMES = {
  1: ['Brand_Campaign_2024_master.psd', 'Product_Launch_Keynote.pptx', 'Spring_Catalog_print.indd', 'Trade_Show_Booth_3D.blend', 'Social_Video_Cutdowns.mp4', 'Newsletter_Archive_2021.zip'],
  2: ['Packaging_Redesign_v14.psd', 'Store_Window_Render.tif', 'Logo_Explorations.ai', 'Lookbook_Layout.indd', 'Showroom_Model.skp', 'Illustration_Pack.psb'],
  3: ['Interview_A-cam_4K.mov', 'Documentary_Rough_Cut.prproj', 'Event_Recap_2022.mp4', 'Drone_Footage_Coast.mov', 'Color_Grade_Master.mov', 'Audio_Stems.wav'],
  4: ['Site_Plan_Rev_F.dwg', 'Project_Schedule.mpp', 'Client_Presentation.pptx', 'Survey_Pointcloud.e57', 'Bid_Package.pdf', 'Progress_Photos.zip'],
  5: ['Budget_Model_FY24.xlsx', 'Monthly_Close_Workbook.xlsx', 'Audit_Evidence.zip', 'Forecast_Scenarios.xlsx', 'Board_Pack_Q3.pdf', 'Ledger_Export.csv'],
  6: ['Employee_Handbook.docx', 'Onboarding_Video.mp4', 'Benefits_Guide.pdf', 'Training_Matrix.xlsx'],
  7: ['Price_List_Master.xlsx', 'Sales_Kickoff_Deck.pptx', 'Demo_Recording.mp4', 'Proposal_Template.docx'],
  8: ['Contract_Repository_Index.xlsx', 'Due_Diligence_Pack.zip', 'Template_Library.docx'],
  9: ['Gearbox_Assembly.step', 'Test_Bench_Logs.csv', 'Firmware_Builds.zip', 'Spec_Sheet_Series_X.pdf'],
  10: ['Leadership_Course_Session1.mp4', 'Safety_Training.pptx', 'Course_Catalog.pdf'],
  11: ['VM_Backups_Index.xlsx', 'Network_Diagram.vsdx', 'Runbook_Patching.docx'],
  13: ['Gala_Photos.zip', 'Venue_Floorplan.pdf'],
};

const siteUrl = (s) => `${TENANT_URL}/sites/${s.slug}`;
const ext = (name) => (name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : null);

function siteMetrics(s) {
  const r = rng(s.id * 97);
  const usedBytes = round(s.usedTb * TB);
  // Sites with a library still crawling (Video Production) or failed (HR) explain less of their usage.
  const percent = s.denied ? null : s.id === 3 ? 0.874 : s.id === 6 ? 0.931 : 0.965 + r() * 0.06;
  const explainedBytes = s.denied ? 0 : round(usedBytes * percent);
  const versionsBytes = round(explainedBytes * s.versionsShare);
  return {
    usedBytes,
    percent,
    explainedBytes,
    versionsBytes,
    heavyVersionsBytes: round(versionsBytes * (0.72 + r() * 0.15)),
    olderThan365Bytes: round((explainedBytes - versionsBytes) * (0.35 + r() * 0.25)),
    fileCountDeclared: round(usedBytes / (2.2 * MB)),
    lastActivityAt: s.denied ? daysAgo(41) : minutesAgo(5 + s.id * 37),
  };
}

function libraries(s) {
  const m = siteMetrics(s);
  const r = rng(s.id * 131);
  const weights = s.libs.map((_, i) => (i === s.libs.length - 1 && s.libs.length > 2 ? 0.04 : 0.2 + r()));
  const total = weights.reduce((a, b) => a + b, 0);
  return s.libs.map((title, i) => {
    const totalBytes = round((m.explainedBytes * 0.97 * weights[i]) / total);
    const versionsBytes = round(totalBytes * s.versionsShare * (0.85 + r() * 0.3));
    const currentBytes = totalBytes - versionsBytes;
    const fileCount = round(currentBytes / (1.6 * MB));
    const failed = s.id === 6 && title === 'Onboarding';
    return {
      id: s.id * 100 + i + 1,
      title,
      hidden: false,
      metricsTotalBytes: totalBytes,
      metricsStreamBytes: currentBytes,
      metricsFileCount: fileCount,
      metricsCapturedAt: daysAgo(1),
      baselineState: failed ? 'failed' : s.id === 3 && i === 1 ? 'running' : 'done',
      baselineDoneAt: failed ? null : daysAgo(3 + i),
      deltaAt: minutesAgo(30 + i * 11),
      lastError: failed ? 'The request was throttled (429) five times in a row.' : null,
      rollup: {
        fileCount,
        currentBytes,
        totalBytes,
        versionsBytes,
        heavyVersionsBytes: round(versionsBytes * 0.8),
        olderThan365Bytes: round(currentBytes * 0.45),
      },
    };
  });
}

function siteListItem(s) {
  const m = siteMetrics(s);
  const libs = libraries(s);
  return {
    id: s.id,
    url: siteUrl(s),
    title: s.title,
    template: s.id === 13 ? 'SITEPAGEPUBLISHING#0' : 'GROUP#0',
    usedBytes: m.usedBytes,
    fileCountDeclared: m.fileCountDeclared,
    lastActivityAt: m.lastActivityAt,
    accessState: s.denied ? 'denied' : 'ok',
    excluded: false,
    explainedBytes: m.explainedBytes,
    percent: m.percent,
    versionsBytes: m.versionsBytes,
    heavyVersionsBytes: m.heavyVersionsBytes,
    olderThan365Bytes: m.olderThan365Bytes,
    libraries: {
      total: libs.length,
      done: libs.filter((l) => l.baselineState === 'done').length,
      failed: libs.filter((l) => l.baselineState === 'failed').length,
    },
  };
}

let nextFileId = 1;
const FILES = [];
for (const s of SITES) {
  const names = FILE_NAMES[s.id] ?? [];
  const r = rng(s.id * 7919);
  const libs = libraries(s);
  names.forEach((name, i) => {
    const lib = libs[(i % Math.max(1, libs.length - 1)) + (libs.length > 1 ? 1 : 0)] ?? libs[0];
    const sizeBytes = round((s.usedTb > 4 ? 2.5 : 0.6) * GB * (0.2 + r()));
    const versionCount = 12 + round(r() * 180);
    const versionsBytes = round(sizeBytes * versionCount * (0.4 + r() * 0.4));
    const modifiedDays = round(20 + r() * 1100);
    const author = PEOPLE[(s.id + i) % 2].name;
    FILES.push({
      id: nextFileId++,
      siteId: s.id,
      siteTitle: s.title,
      libraryId: lib?.id ?? null,
      libraryTitle: lib?.title ?? 'Documents',
      url: `${siteUrl(s)}/${encodeURIComponent(lib?.title ?? 'Documents')}/${name}`,
      name,
      extension: ext(name),
      sizeBytes,
      totalBytes: sizeBytes + versionsBytes,
      versionsBytes,
      versionCount,
      versionLabel: `${versionCount}.0`,
      modifiedAt: daysAgo(modifiedDays),
      editor: author,
      createdAt: daysAgo(modifiedDays + 200),
      author,
      lastAccessAt: modifiedDays > 400 ? null : daysAgo(round(modifiedDays / 2)),
      hasUniquePerms: i % 3 === 0,
    });
  });
}

function topFile(f) {
  return {
    id: f.id,
    name: f.name,
    url: f.url,
    sizeBytes: f.sizeBytes,
    versionsBytes: f.versionsBytes,
    totalBytes: f.totalBytes,
    modifiedAt: f.modifiedAt,
    libraryTitle: f.libraryTitle,
  };
}

function siteDetail(s) {
  const m = siteMetrics(s);
  const files = FILES.filter((f) => f.siteId === s.id);
  return {
    ...siteListItem(s),
    accessError: s.denied ? 'Access denied (403). The engine app is not a site collection admin.' : null,
    recycleBin: s.denied
      ? null
      : {
          firstStageBytes: round(m.usedBytes * 0.012),
          firstStageItems: round(m.fileCountDeclared * 0.01),
          secondStageBytes: round(m.usedBytes * 0.006),
          secondStageItems: round(m.fileCountDeclared * 0.004),
          oldestDeletedAt: daysAgo(92),
          capturedAt: minutesAgo(48),
        },
    libraries: libraries(s),
    topFilesByVersions: [...files].sort((a, b) => b.versionsBytes - a.versionsBytes).map(topFile),
    topFilesBySize: [...files].sort((a, b) => b.sizeBytes - a.sizeBytes).map(topFile),
  };
}

// ---------- Status, engine, events ----------

const EVENT_TEMPLATES = [
  ['info', 'library-baseline-done', (s) => `Baseline finished for Documents (${s.title}).`],
  ['info', 'versions-scanned', (s) => `Historic versions measured for 1,240 files in ${s.title}.`],
  ['warn', 'throttled', () => 'SharePoint asked to slow down (429); backing off for 30 s.'],
  ['info', 'tenant-usage', () => 'Tenant quota measured from the SharePoint admin API.'],
  ['info', 'files-removed', (s) => `12 files deleted in SharePoint were removed from the inventory (${s.title}).`],
  ['info', 'archive-verified', (s) => `Archived copy verified in Blob Cold (SHA-256 match) for a file in ${s.title}.`],
  ['warn', 'page-shrunk', () => 'Large page failed in Raw Footage; retrying with 2500 rows.'],
  ['info', 'run-progress', () => 'Run #14: 1,000 more historic versions deleted.'],
  ['error', 'task-failed', (s) => `Cannot read Onboarding (${s.title}): the request was throttled five times.`],
  ['info', 'audit-ingest', () => 'Audit log ingested up to yesterday (48,210 records).'],
];

const EVENTS = [];
{
  const r = rng(4242);
  const active = SITES.filter((s) => !s.denied);
  for (let i = 0; i < 60; i++) {
    const [level, kind, msg] = EVENT_TEMPLATES[i % EVENT_TEMPLATES.length];
    const site = kind === 'task-failed' ? SITES[5] : active[round(r() * (active.length - 1))];
    const global = ['throttled', 'tenant-usage', 'run-progress', 'audit-ingest', 'page-shrunk'].includes(kind);
    EVENTS.push({
      id: 5000 - i,
      at: minutesAgo(1 + i * 7 + round(r() * 5)),
      level,
      kind,
      message: msg(site),
      siteId: global ? null : site.id,
      siteTitle: global ? null : site.title,
      libraryId: null,
    });
  }
  EVENTS.unshift({
    id: 5001,
    at: minutesAgo(0.5),
    level: 'warn',
    kind: 'site-denied',
    message: 'Access denied to Executive Board; the engine cannot inventory it.',
    siteId: 12,
    siteTitle: 'Executive Board',
    libraryId: null,
  });
}

function status() {
  const items = SITES.map(siteListItem);
  const usedBytes = items.reduce((a, s) => a + (s.usedBytes ?? 0), 0);
  const explainedBytes = items.reduce((a, s) => a + s.explainedBytes, 0);
  const versionsBytes = items.reduce((a, s) => a + s.versionsBytes, 0);
  const quotaBytes = round(2.4 * TB);
  const excessBytes = Math.max(0, usedBytes - quotaBytes);
  const r = rng(77);
  const perMinute = Array.from({ length: 60 }, (_, i) => ({
    minute: minutesAgo(60 - i),
    items: round(900 + 350 * Math.sin(i / 6) + r() * 250),
    throttled: i % 17 === 0 ? 3 : 0,
    errors: i === 41 ? 1 : 0,
  }));
  return {
    tenant: {
      capturedAt: minutesAgo(18),
      source: 'SharePoint admin API',
      quotaBytes,
      usedBytes,
      versionsBytes,
      excessBytes,
      estimatedMonthlyCostUsd: Math.round((excessBytes / GB) * 0.2 * 100) / 100,
    },
    sites: { total: SITES.length, excluded: 0, denied: 1, usedBytes },
    reconciliation: {
      explainedBytes,
      percent: explainedBytes / usedBytes,
      libraries: { total: 412, done: 405, running: 3, pending: 2, failed: 2 },
      filesKnown: 18_412_903,
      filesDeclared: 18_655_120,
      sitesChecked: 12,
      sitesMatching: 9,
      sitesOver: 2,
      sitesUnder: 1,
    },
    savings: {
      heavyVersionsBytes: items.reduce((a, s) => a + s.heavyVersionsBytes, 0),
      heavyVersionsFiles: 48_213,
      olderThan365Bytes: items.reduce((a, s) => a + s.olderThan365Bytes, 0),
      olderThan730Bytes: round(items.reduce((a, s) => a + s.olderThan365Bytes, 0) * 0.58),
    },
    engine: {
      state: 'working',
      heartbeatAt: minutesAgo(0.2),
      lastProgressAt: minutesAgo(0.3),
      startedAt: daysAgo(2),
      commit: '3f9c2e1a7b',
      pauseReason: null,
      slots: [
        { kind: 'versions', target: 'Video Production › Raw Footage', since: minutesAgo(6), status: 'Measuring historic versions · Video Production › Raw Footage (12,480 of 31,200 files)' },
        { kind: 'library-delta', target: 'Marketing › Campaigns', since: minutesAgo(2), status: null },
        { kind: 'run', target: 'Run #14', since: minutesAgo(44), status: 'Run #14 · deleting historic versions (18,211 of 18,240)' },
        { kind: null, target: null, since: null, status: null },
      ],
      lastHour: {
        items: perMinute.reduce((a, m) => a + m.items, 0),
        requests: 9_874,
        throttled: perMinute.reduce((a, m) => a + m.throttled, 0),
        errors: 1,
        perMinute,
      },
      queue: { ready: 128, due: 4, leased: 3, failed: 2 },
    },
    recentEvents: EVENTS.slice(0, 8).map(({ libraryId: _l, ...e }) => e),
  };
}

const NOTICES = {
  notices: [
    {
      id: 'site-denied',
      level: 'warn',
      title: '1 site blocks the engine',
      body: 'The engine app cannot read this site, so its files are not inventoried and reconciliation is incomplete. Add the engine app as a site collection admin or review the site sharing settings.',
      links: [{ label: 'Site permissions in SharePoint', href: 'https://learn.microsoft.com/sharepoint/site-permissions' }],
      sites: [{ siteId: 12, title: 'Executive Board', url: `${TENANT_URL}/sites/executive-board`, detail: 'Access denied (403)' }],
    },
    {
      id: 'retention',
      level: 'info',
      title: 'A retention policy keeps historic versions on 2 sites',
      body: 'Deleting versions on these sites moves them to the Preservation Hold library instead of freeing quota. Exclude them from version policies or adjust the retention policy in Microsoft Purview.',
      links: [{ label: 'Retention policies in Purview', href: 'https://learn.microsoft.com/purview/retention' }],
      sites: [
        { siteId: 5, title: 'Finance', url: `${TENANT_URL}/sites/finance`, detail: 'Preservation Hold: 182 GB' },
        { siteId: 8, title: 'Legal', url: `${TENANT_URL}/sites/legal`, detail: 'Preservation Hold: 64 GB' },
      ],
    },
  ],
};

// ---------- Policies, runs, lab ----------

const KIND_LABELS = {
  delete_versions: 'Delete heavy historic versions',
  archive_files: 'Archive inactive files to Blob Cold',
  purge_recycle: 'Empty recycle bins',
  version_limit: 'Limit versions per library',
};

let nextPolicyId = 5;
const POLICIES = [
  { id: 1, name: 'Trim heavy versions (keep latest 5)', definition: { kind: 'delete_versions', scope: {}, minVersionsBytes: 1, minFileSizeBytes: 100 * MB, keepLatest: 5, olderThanDays: null }, createdBy: PEOPLE[0].email, createdAt: daysAgo(60), updatedAt: daysAgo(12) },
  { id: 2, name: 'Archive media untouched for 2 years', definition: { kind: 'archive_files', scope: { extensions: ['.mp4', '.mov', '.psd'] }, minSizeBytes: 50 * MB, notModifiedDays: 730, notAccessedDays: null }, createdBy: PEOPLE[1].email, createdAt: daysAgo(45), updatedAt: daysAgo(9) },
  { id: 3, name: 'Empty recycle bins after 30 days', definition: { kind: 'purge_recycle', scope: {}, olderThanDays: 30, stage: 'both' }, createdBy: PEOPLE[0].email, createdAt: daysAgo(30), updatedAt: daysAgo(30) },
  { id: 4, name: 'Limit versions to 50 on media sites', definition: { kind: 'version_limit', scope: { siteIds: [1, 2, 3] }, majorVersionLimit: 50 }, createdBy: PEOPLE[1].email, createdAt: daysAgo(21), updatedAt: daysAgo(3) },
];

const policyItem = (p) => ({ ...p, kind: p.definition.kind, kindLabel: KIND_LABELS[p.definition.kind], enabled: true });

const approvals = (at) => [
  { step: 1, by: PEOPLE[0].email, at: ago(at + 3 * 3_600_000) },
  { step: 2, by: PEOPLE[1].email, at: ago(at + 2 * 3_600_000) },
  { step: 3, by: PEOPLE[0].email, at: ago(at + 3_600_000) },
];

let nextRunId = 17;
const RUNS = [
  { id: 16, policyId: 2, policyName: POLICIES[1].name, scope: 'tenant', mode: 'execute', status: 'awaiting_approval', definition: POLICIES[1].definition, selection: null, requestedBy: PEOPLE[1].email, approvals: [{ step: 1, by: PEOPLE[1].email, at: minutesAgo(90) }], plannedCount: 22_871, plannedBytes: round(4.6 * TB), doneCount: 0, freedBytes: 0, createdAt: minutesAgo(95), startedAt: null, finishedAt: null, error: null, actionTotals: { planned: 22_871 } },
  { id: 15, policyId: null, policyName: null, scope: 'lab', mode: 'lab', status: 'done', definition: POLICIES[1].definition, selection: { fileIds: [13, 14, 15, 16, 17] }, requestedBy: PEOPLE[0].email, approvals: approvals(DAY * 4), plannedCount: 5, plannedBytes: round(41 * GB), doneCount: 5, freedBytes: round(41 * GB), createdAt: daysAgo(4.2), startedAt: daysAgo(4.1), finishedAt: daysAgo(4.05), error: null, actionTotals: { done: 5 } },
  { id: 14, policyId: 1, policyName: POLICIES[0].name, scope: 'tenant', mode: 'execute', status: 'done', definition: POLICIES[0].definition, selection: null, requestedBy: PEOPLE[0].email, approvals: approvals(DAY * 2), plannedCount: 18_240, plannedBytes: round(9.2 * TB), doneCount: 18_211, freedBytes: round(9.13 * TB), createdAt: daysAgo(2.3), startedAt: daysAgo(2), finishedAt: minutesAgo(40), error: null, actionTotals: { done: 18_211, skipped: 21, failed: 8 } },
  { id: 13, policyId: 3, policyName: POLICIES[2].name, scope: 'tenant', mode: 'execute', status: 'done', definition: POLICIES[2].definition, selection: null, requestedBy: PEOPLE[1].email, approvals: approvals(DAY * 9), plannedCount: 12, plannedBytes: round(612 * GB), doneCount: 12, freedBytes: round(598 * GB), createdAt: daysAgo(9.5), startedAt: daysAgo(9), finishedAt: daysAgo(8.9), error: null, actionTotals: { done: 12 } },
  { id: 12, policyId: 1, policyName: POLICIES[0].name, scope: 'tenant', mode: 'execute', status: 'cancelled', definition: POLICIES[0].definition, selection: null, requestedBy: PEOPLE[0].email, approvals: [], plannedCount: 17_902, plannedBytes: round(8.9 * TB), doneCount: 0, freedBytes: 0, createdAt: daysAgo(14), startedAt: null, finishedAt: daysAgo(13.9), error: null, actionTotals: { cancelled: 17_902 } },
];

function runActions(run) {
  const files = FILES.slice(0, 25);
  const action = run.definition?.kind === 'archive_files' ? 'archive' : run.definition?.kind === 'purge_recycle' ? 'purge_recycle' : 'delete_versions';
  return files.map((f, i) => ({
    id: run.id * 1000 + i,
    siteId: f.siteId,
    libraryId: f.libraryId,
    fileId: f.id,
    targetUrl: f.url,
    action,
    bytes: round(f.versionsBytes * 0.8),
    status: run.status === 'done' ? (i === 7 ? 'skipped' : 'done') : 'planned',
    detail: i === 7 ? 'File changed after planning; skipped.' : run.status === 'done' ? `Deleted ${round(f.versionCount * 0.9)} historic versions` : null,
    evidence: run.status === 'done' ? { quotaBefore: 'n/a in demo', versionsBefore: f.versionCount, versionsAfter: 5 } : null,
    executedAt: run.finishedAt,
  }));
}

function simulate(definition) {
  const kind = definition?.kind ?? 'delete_versions';
  const pool = [...FILES].sort((a, b) => b.versionsBytes - a.versionsBytes);
  if (kind === 'purge_recycle') {
    const preview = SITES.filter((s) => !s.denied).map((s) => {
      const m = siteMetrics(s);
      return { siteId: s.id, siteTitle: s.title, libraryId: null, libraryTitle: null, fileId: null, fileName: null, extension: null, targetUrl: siteUrl(s), bytes: round(m.usedBytes * 0.015), sizeBytes: null, versionsBytes: null, versionLabel: null, versionsToDelete: null, modifiedAt: null, lastAccessAt: null };
    });
    return finishSimulation(preview, preview.length);
  }
  if (kind === 'version_limit') {
    const preview = SITES.filter((s) => !s.denied).flatMap((s) =>
      libraries(s).map((l) => ({ siteId: s.id, siteTitle: s.title, libraryId: l.id, libraryTitle: l.title, fileId: null, fileName: null, extension: null, targetUrl: `${siteUrl(s)}/${l.title}`, bytes: 0, sizeBytes: null, versionsBytes: l.rollup.versionsBytes, versionLabel: '500', versionsToDelete: null, modifiedAt: null, lastAccessAt: null })),
    );
    return finishSimulation(preview, preview.length);
  }
  const archive = kind === 'archive_files';
  const candidates = (archive ? [...FILES].sort((a, b) => b.sizeBytes - a.sizeBytes) : pool).slice(0, 12);
  const preview = candidates.map((f) => ({
    siteId: f.siteId,
    siteTitle: f.siteTitle,
    libraryId: f.libraryId,
    libraryTitle: f.libraryTitle,
    fileId: f.id,
    fileName: f.name,
    extension: f.extension,
    targetUrl: f.url,
    bytes: archive ? f.totalBytes : round(f.versionsBytes * 0.85),
    sizeBytes: f.sizeBytes,
    versionsBytes: f.versionsBytes,
    versionLabel: f.versionLabel,
    versionsToDelete: Math.max(0, f.versionCount - Number(definition?.keepLatest ?? 5)),
    modifiedAt: f.modifiedAt,
    lastAccessAt: f.lastAccessAt,
  }));
  return finishSimulation(preview, archive ? 22_871 : 48_213, archive ? 4.6 * TB : 11.8 * TB);
}

function finishSimulation(preview, count, totalBytes) {
  const bySiteMap = new Map();
  for (const p of preview) {
    const cur = bySiteMap.get(p.siteId) ?? { siteId: p.siteId, title: p.siteTitle, count: 0, bytes: 0 };
    cur.count += 1;
    cur.bytes += p.bytes;
    bySiteMap.set(p.siteId, cur);
  }
  const previewBytes = preview.reduce((a, p) => a + p.bytes, 0);
  const scale = totalBytes ? totalBytes / Math.max(1, previewBytes) : 1;
  const scaleCount = count / Math.max(1, preview.length);
  const bySite = [...bySiteMap.values()]
    .map((s) => ({ ...s, count: round(s.count * scaleCount), bytes: round(s.bytes * scale) }))
    .sort((a, b) => b.bytes - a.bytes);
  return { count, bytes: totalBytes ? round(totalBytes) : previewBytes, bySite, preview };
}

// ---------- Explorer and archive ----------

const ARCHIVE_SITES = [
  { siteId: 3, share: 0.56 },
  { siteId: 2, share: 0.23 },
  { siteId: 1, share: 0.13 },
  { siteId: 4, share: 0.05 },
  { siteId: 9, share: 0.03 },
];
const ARCHIVE_TOTAL_BYTES = round(6.8 * TB);
const ARCHIVE_TOTAL_FILES = 41_382;

const ARCHIVE_FOLDERS = {
  '': [
    { name: 'Raw Footage', share: 0.62 },
    { name: 'Edits', share: 0.25 },
    { name: 'Documents', share: 0.13 },
  ],
  '/Raw Footage': [
    { name: '2019', share: 0.21 },
    { name: '2020', share: 0.34 },
    { name: '2021', share: 0.45 },
  ],
};

const ARCHIVED_FILES = [
  'Harbor_Timelapse_A-cam.mov',
  'Interview_CEO_Townhall_4K.mov',
  'Product_Shoot_Studio_B.mov',
  'Drone_Coastline_Pass2.mov',
  'Behind_the_Scenes_Day3.mp4',
  'Festival_Booth_Wide.mov',
  'Customer_Story_Rough.mp4',
  'Warehouse_Tour_Gimbal.mov',
].map((name, i) => ({
  archivedId: 900 + i,
  name,
  extension: ext(name),
  sizeBytes: round((3.1 + i * 1.7) * GB),
  archivedAt: daysAgo(4 + i * 3),
  archivedBy: PEOPLE[Math.floor(i / 3) % 2].email,
  originalModifiedAt: daysAgo(900 + i * 40),
  originalModifiedBy: PEOPLE[i % 2].name,
  blobTier: 'Cold',
  state: 'original_deleted',
}));

function archiveTree(siteId, path) {
  const sites = ARCHIVE_SITES.map((a, i) => {
    const s = SITES.find((x) => x.id === a.siteId);
    return {
      siteId: s.id,
      title: s.title,
      url: siteUrl(s),
      fileCount: round(ARCHIVE_TOTAL_FILES * a.share),
      bytes: round(ARCHIVE_TOTAL_BYTES * a.share),
      lastArchivedAt: daysAgo(1 + i * 2),
    };
  });
  const base = { summary: { fileCount: ARCHIVE_TOTAL_FILES, bytes: ARCHIVE_TOTAL_BYTES }, sites, siteId: null, siteTitle: null, siteUrl: null, path: path ?? '', folders: [], files: [] };
  if (!siteId) return base;
  const site = sites.find((s) => s.siteId === siteId);
  if (!site) return base;
  const normalized = path ? `/${path.split('/').filter(Boolean).join('/')}` : '';
  const parentBytes = normalized === '/Raw Footage' ? site.bytes * 0.62 : site.bytes;
  const parentFiles = normalized === '/Raw Footage' ? site.fileCount * 0.62 : site.fileCount;
  const folders = (ARCHIVE_FOLDERS[normalized] ?? []).map((f) => ({
    name: f.name,
    path: `${normalized}/${f.name}`,
    fileCount: round(parentFiles * f.share),
    bytes: round(parentBytes * f.share),
  }));
  const files = normalized === '/Raw Footage/2021' || normalized === '/Raw Footage' ? ARCHIVED_FILES : [];
  return { ...base, siteId, siteTitle: site.title, siteUrl: site.url, path: normalized, folders, files };
}

function accessFor(siteTitle) {
  return {
    people: [
      { email: PEOPLE[0].email, name: PEOPLE[0].name, roles: ['Full Control'], via: [`${siteTitle} Owners`] },
      { email: PEOPLE[1].email, name: PEOPLE[1].name, roles: ['Edit'], via: [`${siteTitle} Members`] },
    ],
    principals: [
      { kind: 'group', name: `${siteTitle} Owners`, email: null, roles: ['Full Control'], members: [{ email: PEOPLE[0].email, name: PEOPLE[0].name }], membersNote: null },
      { kind: 'group', name: `${siteTitle} Members`, email: null, roles: ['Edit'], members: [{ email: PEOPLE[1].email, name: PEOPLE[1].name }], membersNote: null },
    ],
    everyone: false,
    unique: false,
  };
}

function archivedRecord(id) {
  const f = ARCHIVED_FILES.find((x) => x.archivedId === id) ?? ARCHIVED_FILES[0];
  const site = SITES[2];
  const originalUrl = `/sites/${site.slug}/Raw Footage/2021/${f.name}`;
  return {
    id: f.archivedId,
    name: f.name,
    extension: f.extension,
    sizeBytes: f.sizeBytes,
    sha256: 'c0ffee00' + String(f.archivedId).padStart(56, '0'),
    contentType: f.extension === '.mp4' ? 'video/mp4' : 'video/quicktime',
    blobPath: `contoso/${site.slug}/Raw Footage/2021/${f.name}`,
    blobTier: f.blobTier,
    state: f.state,
    originalUrl,
    linkUrl: `${originalUrl}.url`,
    webUrl: siteUrl(site),
    siteId: site.id,
    siteTitle: site.title,
    archivedAt: f.archivedAt,
    archivedBy: f.archivedBy,
    originalModifiedAt: f.originalModifiedAt,
    originalModifiedBy: f.originalModifiedBy,
    acl: [
      { principal: `${site.title} Owners`, role: 'Full Control' },
      { principal: `${site.title} Members`, role: 'Edit' },
    ],
    accessLog: [
      { id: 1, at: daysAgo(1), userUpn: PEOPLE[1].email, granted: true, reason: 'Member of Video Production Members' },
      { id: 2, at: daysAgo(6), userUpn: PEOPLE[0].email, granted: true, reason: 'Member of Video Production Owners' },
    ],
  };
}

function explorerFolder(siteId, libraryId, path) {
  const s = SITES.find((x) => x.id === siteId) ?? SITES[0];
  const libs = libraries(s);
  const explorerLibs = libs.map((l) => ({
    id: l.id,
    title: l.title,
    rootUrl: `/sites/${s.slug}/${l.title}`,
    fileCount: l.rollup.fileCount,
    currentBytes: l.rollup.currentBytes,
    totalBytes: l.rollup.totalBytes,
    versionsBytes: l.rollup.versionsBytes,
  }));
  const base = { siteId: s.id, siteTitle: s.title, libraryId: null, libraryTitle: null, rootUrl: null, path: path ?? '', libraries: explorerLibs, folders: [], files: [], hasMore: false };
  if (!libraryId) return base;
  const lib = explorerLibs.find((l) => l.id === libraryId) ?? explorerLibs[0];
  const names = ['2021', '2022', '2023', '2024', 'Shared with agencies'];
  const folders = path
    ? []
    : names.map((name, i) => ({ name, path: `/${name}`, fileCount: round(lib.fileCount * (0.1 + i * 0.05)), totalBytes: round(lib.totalBytes * (0.08 + i * 0.06)), archivedCount: i === 0 ? 214 : 0 }));
  const files = FILES.filter((f) => f.siteId === s.id).map((f) => ({
    id: f.id,
    name: f.name,
    serverRelativeUrl: `/sites/${s.slug}/${lib.title}${path || ''}/${f.name}`,
    sizeBytes: f.sizeBytes,
    versionsBytes: f.versionsBytes,
    totalBytes: f.totalBytes,
    modifiedAt: f.modifiedAt,
    lastAccessAt: f.lastAccessAt,
    archived: false,
    archivedId: null,
    archivedAt: null,
    blobTier: null,
  }));
  return { ...base, libraryId: lib.id, libraryTitle: lib.title, rootUrl: lib.rootUrl, folders, files };
}

function explorerFile(id) {
  const f = FILES.find((x) => x.id === id) ?? FILES[0];
  const s = SITES.find((x) => x.id === f.siteId);
  return {
    id: f.id,
    name: f.name,
    extension: f.extension,
    serverRelativeUrl: new URL(f.url).pathname,
    webUrl: siteUrl(s),
    siteId: s.id,
    siteTitle: s.title,
    libraryId: f.libraryId,
    libraryTitle: f.libraryTitle,
    sizeBytes: f.sizeBytes,
    versionsBytes: f.versionsBytes,
    totalBytes: f.totalBytes,
    versionLabel: f.versionLabel,
    versionCount: f.versionCount,
    createdAt: f.createdAt,
    modifiedAt: f.modifiedAt,
    author: f.author,
    editor: f.editor,
    lastAccessAt: f.lastAccessAt,
    versions: Array.from({ length: 8 }, (_, i) => ({
      label: `${f.versionCount - i - 1}.0`,
      sizeBytes: round(f.sizeBytes * (0.92 + i * 0.01)),
      createdAt: daysAgo(30 + i * 12),
      createdBy: PEOPLE[i % 2].name,
    })),
    lastAccess: f.lastAccessAt ? { at: f.lastAccessAt, user: PEOPLE[1].email, operation: 'FileAccessed' } : null,
    access: accessFor(s.title),
  };
}

// ---------- Files list ----------

function filesList(q) {
  let items = [...FILES];
  if (q.siteId) items = items.filter((f) => f.siteId === Number(q.siteId));
  if (q.search) items = items.filter((f) => f.name.toLowerCase().includes(String(q.search).toLowerCase()));
  if (q.minVersionsBytes) items = items.filter((f) => f.versionsBytes >= Number(q.minVersionsBytes));
  if (q.modifiedBefore) items = items.filter((f) => f.modifiedAt < q.modifiedBefore);
  const sort = q.sort ?? 'size';
  const key = sort === 'versions' ? 'versionsBytes' : sort === 'modified' ? 'modifiedAt' : sort === 'name' ? 'name' : 'sizeBytes';
  items.sort((a, b) => (a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : 0));
  if (q.dir === 'asc') items.reverse();
  return paginate(
    items.map(({ libraryId: _l, versionCount: _v, ...f }) => f),
    q,
    { totalBytes: items.reduce((a, f) => a + f.totalBytes, 0) },
  );
}

function paginate(all, q, extra = {}) {
  const page = Math.max(1, Number(q.page ?? 1));
  const pageSize = Math.min(500, Math.max(1, Number(q.pageSize ?? 50)));
  return { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize, ...extra };
}

// ---------- Settings ----------

const SETTINGS = {
  engine: { tenant: 'contoso', concurrency: 4, requestsPerMinute: 600, heavyVersionsThresholdBytes: 20 * MB, tenantUsageIntervalMinutes: 60, siteStructureIntervalHours: 24, libraryScanIntervalHours: 6, versionsRescanDays: 7, maxSubwebDepth: 3, retryFailedAfterHours: 6 },
  archive: { account: 'contosoarchive', container: 'spo-archive', tier: 'Cold', portalBaseUrl: 'https://spostorage-demo.example/archive', maxFileBytes: 50 * GB, subscriptionId: '00000000-0000-0000-0000-000000000000', resourceGroup: 'rg-spostorage-demo' },
  'pricing.extraStorageUsdPerGbMonth': 0.2,
};

// ---------- Router ----------

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(json);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}/?$`);
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/health', () => ({
  status: 'ok',
  version: '2.4.0',
  build: { version: '2.4.0', commit: '3f9c2e1a7b4d', builtAt: daysAgo(2) },
  role: 'hub',
  engine: false,
}));
route('GET', '/api/v2/status', () => status());
route('GET', '/api/v2/notices', () => NOTICES);
route('GET', '/api/v2/sites', (_p, q) => {
  let items = SITES.map(siteListItem);
  if (q.search) items = items.filter((s) => s.title.toLowerCase().includes(String(q.search).toLowerCase()));
  const sort = q.sort ?? 'used';
  const val = (s) => (sort === 'name' ? s.title : sort === 'explained' ? (s.percent ?? 0) : sort === 'versions' ? s.versionsBytes : (s.usedBytes ?? 0));
  items.sort((a, b) => (val(a) < val(b) ? 1 : val(a) > val(b) ? -1 : 0));
  if ((q.dir ?? (sort === 'name' ? 'asc' : 'desc')) === 'asc') items.reverse();
  return paginate(items, q);
});
route('GET', '/api/v2/sites/:id', (p) => {
  const s = SITES.find((x) => x.id === Number(p.id));
  return s ? siteDetail(s) : [404, { error: { code: 'NOT_FOUND', message: 'Site not found' } }];
});
route('GET', '/api/v2/files', (_p, q) => filesList(q));
route('GET', '/api/v2/events', (_p, q) => {
  let items = EVENTS;
  if (q.level) items = items.filter((e) => e.level === q.level);
  if (q.siteId) items = items.filter((e) => e.siteId === Number(q.siteId));
  return paginate(items, q);
});
route('GET', '/api/v2/tasks', (_p, q) =>
  paginate(
    [
      { id: 71, kind: 'library-baseline', targetKey: 'library:603', siteTitle: 'HR', libraryTitle: 'Onboarding', attempts: 5, lastError: 'The request was throttled (429) five times in a row.', updatedAt: minutesAgo(26), state: 'failed' },
      { id: 88, kind: 'site-structure', targetKey: 'site:12', siteTitle: 'Executive Board', libraryTitle: null, attempts: 5, lastError: 'Access denied (403).', updatedAt: minutesAgo(51), state: 'failed' },
    ].filter((t) => !q.state || t.state === q.state),
    q,
  ),
);
route('POST', '/api/v2/tasks/retry-failed', () => ({ retried: 2 }));
route('POST', '/api/v2/engine/pause', () => ({ ok: true }));
route('POST', '/api/v2/engine/resume', () => ({ ok: true }));

route('GET', '/api/v2/policies', () => ({ items: POLICIES.map(policyItem) }));
route('POST', '/api/v2/policies/simulate', (_p, _q, body) => simulate(body.definition));
route('POST', '/api/v2/policies', (_p, _q, body) => {
  const p = { id: nextPolicyId++, name: body.name ?? 'New policy', definition: body.definition ?? {}, createdBy: PEOPLE[0].email, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  POLICIES.push(p);
  return policyItem(p);
});
route('PUT', '/api/v2/policies/:id', (p, _q, body) => {
  const policy = POLICIES.find((x) => x.id === Number(p.id));
  if (!policy) return [404, { error: { code: 'NOT_FOUND', message: 'Policy not found' } }];
  Object.assign(policy, { name: body.name ?? policy.name, definition: body.definition ?? policy.definition, updatedAt: new Date().toISOString() });
  return policyItem(policy);
});
route('DELETE', '/api/v2/policies/:id', (p) => {
  const i = POLICIES.findIndex((x) => x.id === Number(p.id));
  if (i >= 0) POLICIES.splice(i, 1);
  return [204, undefined];
});
const newRun = (fields) => {
  const run = { id: nextRunId++, scope: 'tenant', mode: 'execute', status: 'planned', selection: null, requestedBy: PEOPLE[0].email, approvals: [], doneCount: 0, freedBytes: 0, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, error: null, ...fields };
  RUNS.unshift(run);
  return run;
};
route('POST', '/api/v2/policies/:id/runs', (p) => {
  const policy = POLICIES.find((x) => x.id === Number(p.id)) ?? POLICIES[0];
  const sim = simulate(policy.definition);
  return newRun({ policyId: policy.id, policyName: policy.name, definition: policy.definition, plannedCount: sim.count, plannedBytes: sim.bytes });
});
route('POST', '/api/v2/lab/runs', (_p, _q, body) =>
  newRun({ policyId: null, policyName: null, scope: 'lab', mode: 'lab', definition: body.definition, selection: { fileIds: body.fileIds, siteIds: body.siteIds }, plannedCount: (body.fileIds ?? body.siteIds ?? []).length, plannedBytes: round(12 * GB) }),
);
route('POST', '/api/v2/lab/access-check', (_p, _q, body) => ({
  archivedId: body.archivedId ?? 0,
  results: (body.upns ?? []).map((upn) => ({ upn, granted: upn.endsWith('@contoso.com'), reason: upn.endsWith('@contoso.com') ? 'Member of the site Members group' : 'No permission on the original file' })),
}));
route('GET', '/api/v2/runs', (_p, q) => paginate(RUNS.filter((r) => (!q.scope || r.scope === q.scope) && (!q.status || r.status === q.status)), q));
route('GET', '/api/v2/runs/:id', (p) => RUNS.find((r) => r.id === Number(p.id)) ?? [404, { error: { code: 'NOT_FOUND', message: 'Run not found' } }]);
route('GET', '/api/v2/runs/:id/actions', (p, q) => {
  const run = RUNS.find((r) => r.id === Number(p.id));
  return paginate(run ? runActions(run).filter((a) => !q.status || a.status === q.status) : [], q);
});
route('POST', '/api/v2/runs/:id/approve', (p, _q, body) => {
  const run = RUNS.find((r) => r.id === Number(p.id));
  if (!run) return [404, { error: { code: 'NOT_FOUND', message: 'Run not found' } }];
  run.approvals = [...run.approvals, { step: body.step ?? 1, by: PEOPLE[0].email, at: new Date().toISOString() }];
  run.status = run.approvals.length >= 3 ? 'running' : 'awaiting_approval';
  return run;
});
route('POST', '/api/v2/runs/:id/cancel', (p) => {
  const run = RUNS.find((r) => r.id === Number(p.id));
  if (run) run.status = 'cancelled';
  return { ok: true };
});

route('GET', '/api/v2/archived', (_p, q) => {
  const items = ARCHIVED_FILES.map((f) => {
    const r = archivedRecord(f.archivedId);
    return { id: r.id, name: r.name, sizeBytes: r.sizeBytes, state: r.state, archivedAt: r.archivedAt, siteId: r.siteId, siteTitle: r.siteTitle, originalUrl: r.originalUrl };
  }).filter((f) => !q.search || f.name.toLowerCase().includes(String(q.search).toLowerCase()));
  return paginate(items, q);
});
route('GET', '/api/v2/archived/:id', (p) => archivedRecord(Number(p.id)));
route('GET', '/api/v2/portal/:id', (p) => {
  const r = archivedRecord(Number(p.id));
  return { name: r.name, sizeBytes: r.sizeBytes, archivedAt: r.archivedAt, originalUrl: r.originalUrl, siteTitle: r.siteTitle, granted: true, reason: 'Member of Video Production Members' };
});
route('GET', '/api/v2/audit', () => ({ consented: true, coverageFrom: daysAgo(182), coverageTo: daysAgo(1), records: 4_812_330 }));
route('GET', '/api/v2/explorer/folder', (_p, q) => explorerFolder(Number(q.siteId), q.libraryId ? Number(q.libraryId) : null, q.path ?? ''));
route('GET', '/api/v2/explorer/file/:id', (p) => explorerFile(Number(p.id)));
route('GET', '/api/v2/explorer/archived/:id', (p) => {
  const r = archivedRecord(Number(p.id));
  return { ...r, access: accessFor(r.siteTitle) };
});
route('GET', '/api/v2/archive/tree', (_p, q) => archiveTree(q.siteId ? Number(q.siteId) : null, q.path ?? ''));
route('GET', '/api/v2/archive/item/:id', (p) => {
  const r = archivedRecord(Number(p.id));
  return {
    ...r,
    blobUrlInPortal: null,
    containerUrlInPortal: null,
    sharePointFolderUrl: `${r.webUrl}/Raw Footage/2021`,
    sharePointLinkUrl: `${TENANT_URL}${r.linkUrl}`,
    portalUrl: `/archive/${r.id}`,
    access: accessFor(r.siteTitle),
    integrity: { sha256: r.sha256, detail: 'SHA-256 of the Blob copy matches the original download.', evidence: null },
    restore: { state: null, requestedBy: null, requestedAt: null, restoredAt: null, error: null },
  };
});
route('GET', '/api/v2/archive/links', () => ({ originalsPending: 0, originalsPendingBytes: 0, linksPending: 0, running: false, errors: [] }));
route('POST', '/api/v2/archive/links/complete', () => ({ started: true }));
route('POST', '/api/v2/archive/item/:id/restore', (p) => ({ archivedId: Number(p.id), restoreState: 'requested' }));
route('GET', '/api/v2/settings/:key', (p) => {
  const key = decodeURIComponent(p.key);
  return { key, value: SETTINGS[key] ?? null };
});
route('PUT', '/api/v2/settings/:key', (p, _q, body) => {
  const key = decodeURIComponent(p.key);
  SETTINGS[key] = body.value;
  return { key, value: body.value };
});

async function handle(req, res, log) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const query = Object.fromEntries(url.searchParams);
  const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readBody(req);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const result = await r.handler(params, query, body);
    if (Array.isArray(result) && typeof result[0] === 'number') send(res, result[0], result[1]);
    else send(res, 200, result);
    return;
  }
  log(`[mock-api] unknown route ${req.method} ${url.pathname}, returning an empty shape`);
  if (req.method === 'GET') send(res, 200, { items: [], total: 0, page: 1, pageSize: 50 });
  else if (req.method === 'DELETE') send(res, 204);
  else send(res, 200, { ok: true });
}

function listen(port, host, log) {
  const server = http.createServer((req, res) => {
    handle(req, res, log).catch((err) => {
      log(`[mock-api] ${req.method} ${req.url} failed: ${err.stack ?? err}`);
      send(res, 500, { error: { code: 'MOCK_ERROR', message: String(err.message ?? err) } });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

/**
 * Listens on 127.0.0.1 and, when available, ::1: the Vite proxy targets `localhost`, which Node may resolve to
 * either. Loopback only, so no firewall prompt. Resolves to an object whose `close()` stops both listeners.
 */
export async function startMockApi({ port = 4180, log = console.log } = {}) {
  const servers = [await listen(port, '127.0.0.1', log)];
  try {
    servers.push(await listen(port, '::1', log));
  } catch (err) {
    if (err.code !== 'EADDRNOTAVAIL' && err.code !== 'EAFNOSUPPORT') {
      await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
      throw err;
    }
  }
  return {
    close: () =>
      Promise.all(
        servers.map((s) => {
          s.closeAllConnections?.();
          return new Promise((r) => s.close(r));
        }),
      ),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4180);
  const server = await startMockApi({ port });
  console.log(`[mock-api] fake SpoStorage API on http://localhost:${port} (Ctrl+C to stop)`);
  const stop = () => server.close().then(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
