# Claude Code — paste this prompt

> Copy everything in the **PROMPT** block below into Claude Code from the root of
> `jira-timesheet-report`. The `design_handoff_hoursmith/` folder (this folder)
> should be committed or present in the repo so Claude Code can open the reference
> files. Work through it **one phase at a time** — review each PR before moving on.

---

## PROMPT

You are applying a brand + UX redesign to this repo. The full spec and visual
references live in `design_handoff_hoursmith/` — read `README.md` there first,
then open the referenced `*.html` files to see the intended look and behavior.

**These HTML files are design references, not code to copy.** Recreate them using
this repo's existing stack: React + react-router + CSS Modules + the design tokens
in `frontend/react/styles/tokens.css`. Keep all existing functionality and data.

Do the work in four phases, each as its own commit/PR. Stop after each phase so I
can review.

### Phase 1 — Design tokens (the brand)
- Replace the palette in `frontend/react/styles/tokens.css` with the Forge × Ledger
  values from `design_handoff_hoursmith/tokens.forge.css`. Map onto the EXISTING
  token names (`--color-primary`, `--color-surface`, etc.) so every component
  inherits the change — do not rename tokens.
- Swap the type system: display = Bricolage Grotesque, body = Hanken Grotesk,
  numerals/mono = JetBrains Mono. Add the `@import` (or self-host) and update the
  font-family tokens.
- Critical rule: the brand accent (ember `#c8431a`) must NOT sit on the semantic
  status ramp. Keep green/amber/red for worklog states; ember is brand-only.
- Make all hour/number figures use the mono numeral font, tabular-aligned.
- Verify dark mode still works (the repo already themes via tokens).

### Phase 2 — Information architecture (the rename)
- Rename the "Dashboard" surface to **"My Week"** everywhere user-facing:
  `Navigation.tsx`, page titles, route `/dashboard` → `/my-week` (keep a redirect
  from `/dashboard`).
- Keep **Reports** as the review surface. In Reports, expose **People** (Me /
  a person / Team) and **Period** (Week / Month) as filters — fold the old
  `/team` and `/timesheet` routes into `/reports` as redirects (they already
  redirect; just make sure the nav no longer advertises them).
- Rename the `TimesheetPage` component → `ReportsPage` and delete the orphan
  `TeamPage.tsx` stub.
- See `design_handoff_hoursmith/ia.html` for the full naming table.

### Phase 3 — Settings restructure (keep 100% parity)
- Rebuild `SettingsPage` per `design_handoff_hoursmith/settings.html`:
  - Merge `SetupWizard` + `DiagnosticsPanel` into ONE readiness header
    (progress, quick facts, 4 steps, access path, Dashboard/Reports readiness).
  - Add a left-rail section nav with live status dots; render only the active
    section. Sections: Connection, Reports Scope, Permissions, Services,
    Preferences, Data & backup.
  - Make the form-status bar a persistent sticky save bar (Backup, Share Pack,
    Import, Discard, Save).
- DO NOT remove or rename any field, store binding, test handler, or helper text.
  The parity ledger at the bottom of `settings.html` is the checklist — every row
  must still exist and behave identically. This is a reorganization of
  `SettingsForm` + its `sections/*` and the two editors, not a rewrite of logic.

### Phase 4 — Screens polish
- Apply the system to `My Week` and `Reports` per `screens.html`: lead My Week with
  a single "close the week" panel (one primary action, exports demoted), gap-first
  day ordering, mono tabular hours.
- Replace the app icon / logo with the **Billet H** mark. The production SVGs are
  already in `design_handoff_hoursmith/billet-h/` — drop `pwa-icon.svg` and
  `pwa-icon-maskable.svg` into `frontend/public/`, wire `favicon.svg`, and use
  `lockup-horizontal.svg` in the nav. No need to redraw from `logo.html`.

Constraints: don't introduce a CSS framework or component library; match the
existing CSS Modules patterns. Keep PWA + browser-only architecture intact.
Run the test suite after each phase and fix any fallout.

## END PROMPT
