# Sub-processors

Hoursmith uses a small number of third-party sub-processors to deliver the hosted service. This page lists every sub-processor that may process personal data on our behalf, along with the purpose of the processing, the region where the data is handled, and a link to each provider's Data Processing Agreement (DPA).

This list is kept current as our stack evolves. When the active customer base warrants it, material changes to this list — for example, a new sub-processor, a new processing region, or an expansion of processing scope — will be communicated by email to active subscribers in advance of the change taking effect.

Last updated: 2026-06-07.

## Active sub-processors

| Sub-processor | Purpose | Region | DPA |
| --- | --- | --- | --- |
| Vercel | Application hosting and serverless functions. All compute is pinned to the `fra1` region. | EU (Frankfurt, Germany) | [vercel.com/legal/dpa](https://vercel.com/legal/dpa) |
| Supabase | Authentication (email/password and GitHub OAuth) and Postgres database storing only the `profiles` and `subscriptions` tables. | EU (Frankfurt, Germany) | [supabase.com/legal/dpa](https://supabase.com/legal/dpa) |
| Polar | Merchant of Record for Premium subscriptions: checkout, payment processing, invoicing, and EU VAT calculation, collection, and remittance. | United States (Polar Software Inc.), transferred under Standard Contractual Clauses | [polar.sh/legal/data-processing-addendum](https://polar.sh/legal/data-processing-addendum) |
| PostHog | Cookieless product analytics: page views and a small set of product events. No autocapture, no session recording, and no persistent identifiers — so no consent banner is required. | EU (Germany), via PostHog EU Cloud | [posthog.com/dpa](https://posthog.com/dpa) |

### Not yet active

- **Resend** — transactional email delivery. Not currently in use. This entry will be moved to the active table when the integration ships, and active subscribers will be notified by email before it begins processing data.

## What we don't process

Hoursmith is designed so that the data you care most about never leaves your browser and is never sent to our servers. The hosted service exists to handle authentication, billing, and a stateless CORS proxy for Jira requests — nothing else.

**Jira API tokens.** Your Jira API token is stored in your browser's local storage and is attached to Jira requests client-side. The hosted CORS proxy forwards the request to your Jira instance and returns the response without inspecting, logging, or persisting the token or the response body.

**Jira workspace data.** Issues, worklogs, comments, attachments, sprints, and any other content fetched from your Jira instance are processed entirely in the browser. No Jira payload is written to any Hoursmith database, log, or cache.

**User settings, templates, and favorites.** Report configurations, saved filters, favorite issues, calendar mappings, and team setups live in your browser's local storage. There is no cloud sync; nothing is uploaded.

**Calendar feeds.** ICS feeds for absences, holidays, and shared availability are fetched and parsed in the browser. The hosted proxy may relay the fetch when CORS requires it but does not retain feed contents.

The only personal data we store server-side is the minimum required to operate auth and billing: your email address and authentication identifiers in Supabase, and the Polar customer and subscription identifiers needed to manage your plan.

## Changes to this list

Any addition or removal of a sub-processor will appear on this page with the "Last updated" date below adjusted to match. Material changes — a new sub-processor, a new processing region, or an expansion of the categories of data processed — will additionally be communicated by email to active subscribers in advance of taking effect.

Historical changes can be reviewed in the git history of this page.

---

Last updated: 2026-06-07. Contact: see the [Privacy Policy](/privacy).
