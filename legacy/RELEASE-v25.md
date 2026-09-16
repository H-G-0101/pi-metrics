# Version 25

- Lifetime and Recent Activity are separate, with navigation links.
- Partial and retained historical totals are explained explicitly.
- Expandable explanations for averages, medians and lifetime counts.
- Compact card numbers with full displayed values in title and accessible label.
- Mobile wallet details expand individually and keep their open state on refresh.
- /methodology documents classification, periods, exclusions and limitations.
- Data health distinguishes last report receipt, index status, recent scan and crawler-reported D1 persistence.

No crawler, checkpoint or database migration is required. Publish worker.js with
the existing wrangler.toml. The optional receivedAt field is assigned when a new
report arrives. Existing reports fall back to generatedAt.

An exact historical percentage and a last successful Action timestamp are not
claimed: existing reports do not provide evidence for these measurements.

Checks: Worker and crawler syntax; inline dashboard and preview script parsing.
Browser rendering could not be verified because the browser download failed.
