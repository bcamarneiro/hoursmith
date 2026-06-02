# Rollout Guide

This guide is for the person rolling Hoursmith out to a team, not the end user opening it for the first time.

The goal is simple:

- get the hosted app in front of people quickly
- make setup predictable
- keep trust high by validating data consistency early
- reduce support load once teammates start using it

## Recommended Rollout Shape

Use a phased rollout instead of dropping the app into a wide team channel without context.

## Hosting Target

Vercel is the preferred hosted path now.

Why:

- browser routing works cleanly with rewrites
- the app stays fully static and zero-backend
- previews are easier to share during pilot rollout
- the production build does not need the GitHub Pages hash-routing fallback

### Phase 1: Internal Maintainer Check

Before inviting teammates:

1. Confirm the hosted app or local build you plan to share is on the latest `main`
2. Run:

```bash
npm run lint
npm run test:run
npm run test:e2e:smoke
npm run build
npm run build:vercel
```

3. Open the app and verify:
   - `Settings` wizard completes cleanly
   - diagnostics show Jira as ready
   - `Dashboard` loads
   - `Reports` weekly and monthly views load
   - read-only snapshots export correctly from `Reports`
4. Run a real-data consistency check for a recent window with:

```bash
node scripts/validate-real-data-consistency.cjs ~/Downloads/hoursmith-settings.json
```

For SOCKS5 environments:

```bash
node scripts/validate-real-data-consistency.cjs \
  ~/Downloads/hoursmith-settings.json \
  socks5h://127.0.0.1:8080 \
  2
```

The rollout should not start until the current weekly and monthly reporting views agree for a representative recent period.

### Phase 2: Pilot With 1-3 Teammates

Choose a small pilot group first:

- one person who only needs the personal `Dashboard`
- one person who will use `Reports`
- one person likely to hit setup friction such as proxy or permissions

For the pilot:

1. Send the hosted URL
2. Send a teammate-safe `Share Pack` from `Settings`
3. Ask each person to complete onboarding using the guide in `docs/teammate-onboarding.md`
4. Collect feedback with `docs/pilot-feedback-template.md`
5. Ask for feedback on:
   - setup time
   - diagnostics clarity
   - whether `Dashboard` or `Reports` was easier to understand first
   - any mismatch between expected Jira data and what the app shows

### Phase 3: Wider Team Rollout

After the pilot is stable:

1. Share the hosted URL
2. Share the onboarding guide
3. Provide one default `Share Pack` per team/reporting scope if needed
4. Make clear which path people should take:
   - `Dashboard` for personal weekly close
   - `Reports` for team visibility and compliance
5. Keep one maintainer available for the first week of adoption

## Preflight Checklist

Use this checklist before each meaningful rollout wave:

- Hosted app loads without console-breaking errors
- `Settings` import/export still works
- PWA install prompt still appears on supported browsers
- `Reports` share links reopen the expected filtered state
- `Reports` HTML/Markdown snapshots export correctly
- `Reports` weekly consistency check succeeds for a known-good week
- `allowedUsers` reflects the intended reporting scope
- the local or hosted proxy instructions are still correct

## Recommended Assets To Prepare

Prepare these before sharing broadly:

- hosted app URL
- Vercel preview/production URL
- one `Share Pack` per team or reporting scope
- a short “what is this for?” intro message
- one screenshot of `Dashboard`
- one screenshot of `Reports`
- one known-good recent validation result

If screenshots are not ready yet, the app is still usable, but adoption will be slower.

## What To Share With Teammates

At minimum, share:

1. the hosted URL
2. the onboarding guide
3. a `Share Pack` if teammates should inherit the same Jira host, allowed users, JQL, or calendar mappings
4. proxy guidance only if direct browser access is expected to fail in your environment

Do not share:

- API tokens
- full backups unless the backup is strictly for your own restore path

## Support Model During Rollout

Ask teammates to report problems using these categories:

- `Setup`: host, token, proxy, diagnostics, permissions
- `Dashboard`: personal week data, missing worklogs, suggestion confusion
- `Reports`: filtering, weekly/monthly mismatch, snapshots, exports
- `Performance`: slow loads, large month fetches, UI stalls

This keeps triage fast and prevents generic “it does not work” reports.

## Common Rollout Failure Modes

### 1. CORS Or Proxy Problems

Symptoms:

- diagnostics fail early
- Jira calls fail in browser despite valid credentials

Actions:

- start by leaving the proxy field blank and testing direct browser access
- verify whether the environment actually needs the local CORS proxy before telling people to use it
- if it does, document the expected proxy URL clearly
- for SOCKS5 environments, use `npm run cors-proxy:socks` behind the same local proxy URL

### 2. Reporting Scope Confusion

Symptoms:

- `Dashboard` and `Reports` appear to disagree

Actions:

- check `allowedUsers`
- remember that `Dashboard` is personal and `Reports` can be scoped to a team
- use the in-app weekly consistency validation or the real-data validator before assuming a product bug

### 3. Permissions Issues

Symptoms:

- read works but CRUD actions fail
- diagnostics or API calls return `401`/`403`

Actions:

- re-run diagnostics
- verify Jira token and permission flags in `Settings`

## Rollout Exit Criteria

A rollout can be considered healthy when:

- a new teammate can complete setup without pairing
- the first weekly use succeeds
- the recent weekly/monthly reporting views validate cleanly
- teammates can export at least one useful artifact:
  - weekly summary
  - CSV
  - read-only report snapshot

## Suggested Announcement Template

Use or adapt this:

> We are starting to use Hoursmith as a lightweight Jira companion for weekly close and reporting.  
> Use `Dashboard` for your own weekly gap review and `Reports` for team/monthly reporting.  
> Start here: `<hosted-url>`  
> If you have a shared setup pack, import it from `Settings`.  
> If setup fails, run diagnostics in `Settings` first and report whether the issue is `Setup`, `Dashboard`, or `Reports`.
