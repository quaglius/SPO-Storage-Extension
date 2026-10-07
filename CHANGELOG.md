# Changelog

## Unreleased

- Archive: when a site has no space for the `.url` link (over quota, read-only), the verified original is deleted and
  the link is left pending instead of failing the file. New **Complete archive links** pass (Archived page) creates the
  pending links, re-verifying blob and original first; it can be launched any number of times.

## 2.0.0 — first public release

- Durable engine on Azure SQL: tenant, sites, libraries, files (size including versions), version detail for heavy
  files, last access from the Microsoft 365 audit log; ~1 M files scanned in well under an hour.
- Layered reconciliation against the storage Microsoft counts for the quota.
- Policies (delete versions, archive to Blob Cold, empty recycle bins, limit versions) with live simulation, three-step
  approval, durable execution and per-action evidence; the Lab for small verified trials.
- Archive with a SharePoint `.url` link that keeps the original permissions, a download portal that asks SharePoint on
  every request, and restore to SharePoint.
- Folder explorer with "who can open this file" (people and e-mails); archive explorer with Azure portal links.
- Bicep template, Entra setup script and GitHub Actions deployment with OIDC.
