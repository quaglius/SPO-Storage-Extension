# Development

## Requirements

- **Node.js 22** (the CI and App Service run 22; use the same locally).
- Docker, for a local SQL Server used by the tests.
- Azure CLI, only to operate a deployed instance.

## Build and test

```bash
cd app
npm install
npm run typecheck
npm run build
```

Tests run against a real SQL Server (T-SQL, `OPENJSON`, `MERGE`, filtered indexes — an in-memory fake would hide
bugs). Start one locally:

```bash
docker run -d --name spostorage-sql-test -e ACCEPT_EULA=Y -e 'MSSQL_SA_PASSWORD=Local_Passw0rd!2026' -p 14330:1433 mcr.microsoft.com/mssql/server:2022-latest
```

Create the test database once (from `app/server`):

```bash
CI_SQL_MASTER='Server=localhost,14330;Database=master;User Id=sa;Password=Local_Passw0rd!2026;Encrypt=false;TrustServerCertificate=true' node scripts/ci-create-test-db.mjs
```

Run the suite:

```bash
cd app && AZURE_SQL_TEST_CONNECTION_STRING='Server=localhost,14330;Database=spostorage-test;User Id=sa;Password=Local_Passw0rd!2026;Encrypt=false;TrustServerCertificate=true' npm run test:ci
```

SharePoint and Graph are never called by tests: they use a fake `fetch` injected into `SpoClient`.

## Code map

```
app/                      npm workspaces
  server/                 Fastify 5 + mssql + zod + vitest
    src/index.ts          start-up: migrations, API, static UI in production, engine when SPOSTORAGE_ENGINE_V2=1
    src/app.ts            plugins (engine lockdown, admin allowlist) and routes
    src/db/               SQL pool, migration runner, migrations-sql/*.sql
    src/v2/
      env.ts              deployment configuration from environment variables
      db.ts               T-SQL helpers with named parameters (db(), tx(), execJson for OPENJSON)
      settings.ts         runtime settings (spo.settings)
      spo/client.ts       SharePoint/Graph client: rate limit, retries, error classification
      engine/             queue, runner, events, task types
      crawl/              inventory, versions, audit, rollups, planner
      policies/           definitions, simulation/plan, run execution
      actions/            executors (versions, archive, restore), permissions, blob, QuickXor, access decisions
      api/                /api/v2/* routes
      start.ts            task registry and engine start-up
  web/                    Vite + React 18 + TanStack Query + Tailwind
  shared/                 API types and utilities shared by server and web
infra/                    Bicep template
scripts/ci/               packaging for App Service
scripts/ops/              read-only diagnostics in a deployed engine
scripts/setup/            Entra app registrations and certificate
```

## Conventions

See [AGENTS.md](../AGENTS.md). In short: English everywhere; explicit T-SQL with named parameters; never scan
`spo.files` without an index or `TOP`; the UI reads rollups; API errors are `{ error: { code, message } }`; bytes are
numbers and dates ISO-8601 UTC; no secrets or tenant data in git.

## Extending

- **New engine task**: a handler `(ctx) => Promise<{ outcome: 'done' } | { outcome: 'again', afterMs, payload? }>` in
  `v2/crawl/` (or `v2/actions/`), registered in `v2/start.ts`, enqueued by the planner or an API route. Keep each
  execution short (one page, one batch), store cursors in the payload, call `ctx.progress(n)` for the watchdog and
  `ctx.status('…')` for the UI. Rethrow transient SharePoint errors (the runner backs off); record other failures and
  move on.
- **New policy**: schema in `policies/definitions.ts`; SQL in `build()` of `policies/plan.ts` (filters, estimated bytes,
  preview columns); an executor with evidence in `actions/`; a case in `policies/run.ts`.
- **New screen**: route in `v2/api/*.ts` (zod validation, `requireAdmin`), types in `shared/src/v2-api.ts`, a hook in
  `web/src/api/v2.ts`, a page in `web/src/pages/`.
- **Schema change**: a new numbered file in `migrations-sql/`; separate DDL batches with `GO`; think about the time it
  takes on a table with a million rows (migrations run at start-up).
