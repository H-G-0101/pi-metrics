# v26 — audit corrections

This release supersedes earlier claims that lifetime counters never decrease.
Correct totals may decrease when an incorrect earlier classification is removed.

## Changes

- Recent transactions not present in the historical index stay pending unless
  the same recipient has a create_account operation in the same transaction.
  A missing interval in history no longer implies a second migration.
- Worker accepts corrected totals rather than retaining earlier maxima. Old
  crawler schemas and reports older than the currently stored report are rejected.
- D1 metadata is checked even when a local checkpoint exists. A newer D1 index
  is restored into an isolated map and validated before becoming the active index.
- Each historical page (up to 200 wallets) and its cursor are one D1 batch.
- An initial/recovery copy freezes the historical cursor, marks metadata as
  rebuilding and only marks D1 ready after copying every wallet. No database
  table is deleted. If interrupted, an available checkpoint is needed to finish
  that copy. Errors stop the run rather than silently abandoning persistence.
- Checkpoint shards are written in a new generation before the manifest switches.
  Obsolete local shard generations are removed only after a successful switch.
- Recent scans repeat after 15 minutes between historical pages. This is a target,
  not a guarantee during database copying or API failures. Collection start and
  completion times are distinct from report publication time.
- Recent first-migration signals contribute to the lifetime first count.
- D1 errors and recent-window freshness are exposed in Data health.
- Workflow concurrency queues another execution instead of cancelling a running one.

## Deployment

1. Keep the current checkpoint and D1 database. Do not delete either.
2. Publish the new Worker with the existing DB and STATS bindings.
3. Update the crawler and workflow in the repository. Let an old Action finish;
   the new Worker will reject its old-schema reports until the new crawler runs.
4. Run the updated Action or wait for its scheduled execution. No new D1 tables
   are required. A frozen initial copy can take time for millions of wallets.
5. Check Data health and the Action log. Persistent errors require investigation
   of the reported Cloudflare response; configuration alone cannot fix quotas
   or service availability.

Validation: run `node audit-tests.cjs`. Tests cover grouping, classification gaps,
checkpoint generations, a newer D1 despite a local cache, atomic page requests,
frozen initial copy, restore isolation, valid downward corrections and report gates.
Tests use mocked services. They do not certify deployed D1 records or blockchain
history. Verify a successful deployed run before treating the migration as complete.
