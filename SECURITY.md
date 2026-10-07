# Security policy

SpoStorage runs with high privileges in a Microsoft 365 tenant (`Sites.FullControl.All`) and can permanently delete
content, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's **private vulnerability reporting** ("Security" tab → "Report a
vulnerability") with a description, steps to reproduce and the impact. You will get an acknowledgement within a few
days.

## Scope

In scope: authentication/authorization bypasses (admin screens, download portal, engine app), access-decision flaws in
archived-file downloads, injection, leaks of tenant data or secrets, integrity issues that could delete a file without a
verified copy.

## Hardening checklist for deployments

- Keep App Service Authentication **required** on the web app; never expose the engine app's API (it is locked down to
  `/api/health` by `SPOSTORAGE_ENGINE_V2=1`).
- Keep `SPOSTORAGE_ADMINS` short; it has no defaults.
- Store the engine certificate only in App Service settings (or Key Vault references); rotate it periodically.
- Keep soft delete, versioning and the delete lock on the archive storage account.
- Review [docs/archive-and-access.md](docs/archive-and-access.md) before changing anything in the archive or download
  path.
