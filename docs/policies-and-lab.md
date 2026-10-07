# Policies, simulation, approval and the Lab

## Policy types

Defined in [`app/server/src/v2/policies/definitions.ts`](../app/server/src/v2/policies/definitions.ts). Every policy
has a **scope**: the whole tenant or selected sites, optionally file extensions (and, in the Lab, exact files).

| Kind | Criteria | Action (permanent) |
|---|---|---|
| `delete_versions` | files larger than X MB; keep the latest N historic versions; optionally only versions older than D days | `DeleteByLabel` on each version — versions do **not** go to the recycle bin. The current version is never touched. |
| `archive_files` | files larger than X MB, not modified for N days, optionally not opened for N days (needs audit coverage) | copy to Blob (Cold) → `.url` link with the same permissions → delete the original. See [archive-and-access.md](archive-and-access.md). |
| `purge_recycle` | items deleted more than N days ago | empties both recycle bin stages (both count against quota). |
| `version_limit` | maximum N major versions | sets the library limit; SharePoint trims extra versions **the next time each file is edited**. |

Hidden libraries (Preservation Hold Library, galleries) and the platform's own `.url` links are never targeted.

## Simulation

[`policies/plan.ts`](../app/server/src/v2/policies/plan.ts) turns a definition into SQL over the inventory — **no
SharePoint calls**. It returns totals, totals per site and the top candidates (file, library, size, versions to
delete, bytes freed, last modified, last access). Bytes freed for version deletion are exact when version detail is
known and estimated from the major version number otherwise. The UI re-simulates automatically as criteria change.

"Not opened for N days" treats files with no audit record as not opened — but the simulation is rejected
(`POLICY_NOT_READY`) until the audit log covers those N days, so nothing is archived just because its history was not
loaded yet.

## Runs and the three-step approval

1. **Create a plan** — the targets are materialized in `spo.policy_actions` (status `planned`) with the estimate.
2. **Approve** — an administrator completes three steps in order: reviewed the simulation; understands it is
   irreversible; types the confirmation text shown (e.g. `DELETE 42`, the planned count).
3. **Execute** — the engine task `policy-run` processes actions in batches (archive: 6 in parallel), marking each one
   `running` → `done` / `failed` / `skipped` with bytes freed, a human-readable detail and evidence. Transient
   SharePoint errors put the action back to `planned` and back off; interrupted actions are resumed.

Runs can be cancelled; the engine stops taking new actions from a cancelled run.

## The Lab

Same flow, limited to **20 items you pick**, and with **full evidence** per action:

| Action | Evidence collected |
|---|---|
| Delete versions | versions before and after, `SMTotalSize` before and after, recycle bin entries (must be none), Preservation Hold Library item count before and after (growth means a retention policy kept the content) |
| Archive | bytes read vs SharePoint vs blob, QuickXor computed vs SharePoint's, SHA-256, blob tier, link URL, permissions copied, original gone, not in the recycle bin, Preservation Hold Library growth |
| Recycle bin | items removed and remaining |
| Version limit | limit before and after |

After an archive run, the **access test** lets you enter e-mails and see who would be allowed or denied by the portal —
without their sessions — using the same decision the portal uses.

Recommended path: run each policy type in the Lab on a non-critical site, check the evidence (especially retention
holds), open the link in SharePoint as two different users, then plan the tenant-wide run.
