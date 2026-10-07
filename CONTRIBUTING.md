# Contributing

Thanks for helping! SpoStorage is a TypeScript monorepo (Node 22): a Fastify server with an engine, a React UI and
shared types, deployed to Azure App Service.

1. Read [docs/development.md](docs/development.md) (local setup, SQL Server container for tests, code map) and
   [AGENTS.md](AGENTS.md) (conventions — they apply to humans too).
2. Open an issue first for anything larger than a small fix, so we can agree on the approach.
3. Keep pull requests focused. Every PR must pass `npm run typecheck`, `npm run test:ci` and `npm run build` in `app/`.
4. Add or update tests: server tests run against a real SQL Server and never call SharePoint (inject a fake `fetch`).
5. Anything that deletes or moves content must keep the invariants in
   [docs/archive-and-access.md](docs/archive-and-access.md) and collect evidence for the Lab.
6. English only, no secrets, no tenant data (use `contoso` / `example.com` in tests and docs).

Commit messages: imperative, English, with a short prefix when useful (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`).
