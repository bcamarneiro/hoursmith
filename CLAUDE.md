# Hoursmith — active work: Forge × Ledger redesign

A full brand + UX redesign is being applied to this app. The complete spec,
visual references, and production assets live in **`design_handoff_hoursmith/`**.

## Start here
Read `design_handoff_hoursmith/CLAUDE_CODE_PROMPT.md` (the phased plan) and
`design_handoff_hoursmith/README.md` (the detailed spec) before making changes.
The `*.html` files in that folder are **design references**, not code to copy —
recreate them in this repo's stack (React 18 + react-router-dom + CSS Modules,
themed via `frontend/react/styles/tokens.css`). Keep the browser-only / PWA
architecture and all existing data flows intact.

## Work order — ONE phase per PR, stop for review between each
1. **Tokens** — apply `design_handoff_hoursmith/tokens.forge.css` over the existing
   token names in `tokens.css`. Low-risk, re-skins everything.
2. **IA rename** — Dashboard → **My Week** (`/dashboard` → `/my-week` redirect);
   keep **Reports** and fold `/team` + `/timesheet` into it as filters; rename
   `TimesheetPage` → `ReportsPage`; delete the `TeamPage.tsx` stub.
3. **Settings** — merge `SetupWizard` + `DiagnosticsPanel` into one readiness header,
   add a left-rail section nav, persistent sticky save bar. **Reorganization only.**
4. **Screens + logo** — My Week + Reports per `screens.html`; drop in the Billet H
   SVGs from `design_handoff_hoursmith/billet-h/`.

## Hard rules (do not violate)
- **Settings keeps 100% field parity.** Every row of the parity ledger in
  `design_handoff_hoursmith/README.md` (and `settings.html`) must still exist and
  behave identically. No field, store binding, test handler, or helper string may
  be removed or renamed — this is a layout/IA change, not a logic rewrite.
- **Brand accent (ember `#c8431a`) is brand-only.** Never put it on the
  green / amber / red worklog status ramp. Move the old indigo "overtime" state to
  `--color-info` (teal-slate `#3f6b7d`).
- **All hour/number figures** use the mono numeral font (JetBrains Mono), tabular.
- Don't introduce a CSS framework or component library; match existing CSS Modules.
- Run the test suite after each phase and fix any fallout before opening the PR.
