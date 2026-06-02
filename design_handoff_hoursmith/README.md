# Handoff: Hoursmith — Brand + UX Redesign

## Overview
This package applies a complete brand and UX redesign to the Hoursmith app
(`jira-timesheet-report`). It covers four things: a new visual identity
(**Forge × Ledger**), an information-architecture fix (the Dashboard / Reports /
Timesheet / Team naming tangle), a from-scratch **Settings** restructure that keeps
100% of the existing fields, and a new logo (**Billet H**).

**Start here:** open `CLAUDE_CODE_PROMPT.md` and paste it into Claude Code from the
repo root. Work phase by phase. This README is the detailed spec behind that prompt.

## About the design files
The `*.html` files in this folder are **design references created in HTML** — they
show intended look and behavior. They are **not** production code to copy. Your job
is to recreate them in this repo's existing environment: **React 18 +
react-router-dom + CSS Modules**, themed through
`frontend/react/styles/tokens.css`. Keep the browser-only / PWA architecture and all
existing data flows intact.

Reference files (open them as you work):
- `index.html` — the diagnosis (the 7 problems being solved)
- `ia.html` — information architecture: the full naming reconciliation table
- `directions.html` — the three brand directions (we chose Forge × Ledger)
- `screens.html` — redesigned **My Week** + **Reports**
- `logo.html` — the six logo explorations; **Billet H** is the chosen mark
- `settings.html` — the Settings redesign **and the parity ledger** (your checklist)
- `tokens.forge.css` — Phase-1 token values mapped onto existing token names

## Fidelity
**High-fidelity.** Colors, type, spacing, and interactions are final. Recreate the
UI faithfully using this repo's CSS Modules patterns — don't introduce a CSS
framework or component library, and don't restyle from scratch where a token swap
will do the work.

---

## The system: Forge × Ledger
- **Identity = Forge.** Warm, crafted, name-true ("Hour**smith**"). Iron + ember.
- **Numerics = Ledger.** Every hour figure is mono, tabular, audit-aligned.
- **Voice = Daylight.** Human, plainspoken, reassuring (copy guidance only).

### Design tokens (Phase 1)
Paste `tokens.forge.css` over the matching names in `tokens.css`. Key values:

| Role | Token | Old | New |
|---|---|---|---|
| Brand accent | `--color-primary` | `#4f46e5` indigo | `#c8431a` ember |
| Spark / highlight | `--color-spark` | — | `#ee6b2d` |
| Page bg | `--color-bg` | slate-50 | `#f4efe7` paper |
| Card | `--color-surface` | white/slate | `#fbf8f2` |
| Dark ground | `--color-iron` | — | `#1c1714` |
| Text | `--color-text` | slate-900 | `#241d18` |
| Text 2 | `--color-text-secondary` | slate-500 | `#574d43` |
| Border | `--color-border` | slate-200 | `#e2d8c8` |
| Success (complete) | `--color-success` | green | `#4d7c3a` |
| Warning (incomplete) | `--color-warning` | amber | `#b07d18` |
| Danger (missing/weekend) | `--color-danger` | red | `#b23a2e` |
| Overtime | `--color-info` | **indigo (collided!)** | `#3f6b7d` teal-slate |

**Critical:** the brand accent must never appear on the green→amber→red status
ramp. The current "overtime" state is indigo — the same hue as the primary — so a
data state and a link read identically. Move overtime to `--color-info` (teal-slate)
and let ember be brand-only.

Type: display **Bricolage Grotesque** (700/800), body **Hanken Grotesk** (400–700),
numerals **JetBrains Mono** (tabular). All hour figures use the mono numeral face.

---

## Screens / Views

### 1. My Week (was "Dashboard")  — `screens.html`, Screen 02
- **Route:** `/my-week` (redirect `/dashboard` → `/my-week`). Nav label "My Week".
- **Purpose:** the signed-in user closes **their own** current week. (Chasing
  teammates moves to Reports — keep My Week strictly first-person.)
- **Layout:** app nav → a dark "close the week" lead panel → week-progress bar row →
  gap-first day cards → month heatmap.
- **Lead panel (`.close-panel`):** iron background, ember hot-edge on the left, one
  primary action ("Fill Thursday"), a big mono stat ("1 gap"). This replaces the
  flat six-button toolbar — one job leads, exports demote into a menu.
- **Day cards:** ordered gaps-first, not calendar order. The gap card is red-tinted
  with context ("last Thursday you logged HS-412, HS-419") and a one-click fix.
- **Numbers:** every `Xh` is mono, tabular, color-coded by status only.

### 2. Reports (absorbs Timesheet / Team)  — `screens.html`, Screen 03
- **Route:** `/reports` (redirect `/team`, `/timesheet` → `/reports`).
- **Purpose:** review **any period × any people**, export.
- **Toolbar = the filters:** a **Period** segmented control (Week / Month) and a
  **People** segmented control (Me / A person / Team). "Whose timesheet" is a filter,
  not a destination.
- **Body:** a team member table — per-day hours, total, gap column (red when > 0),
  and a "Remind" action on rows with gaps. Mono tabular figures throughout.

### 3. Settings  — `settings.html` (biggest change; see parity section)

### Logo — Billet H  — `logo.html`
Two iron posts joined by a glowing ember crossbar + two small spark dots. Open
monogram, no container needed; also works tiled on iron for the app icon. Replace
`frontend/public/pwa-icon.svg` and the favicon. The current icon is a generic
indigo rounded square — the new SVG is in `logo.html` (mark #2 / "Billet H", symbol
`#mk2-light` for light grounds, `#mk2-dark` for the iron tile). Produce a clean
512×512 production SVG with locked clear-space.

---

## Settings restructure — and the parity contract  (`settings.html`)

The current `SettingsPage` stacks a hero + `SetupWizard` + `DiagnosticsPanel` + a
six-fieldset `SettingsForm` on one endless page. The redesign reorganizes the
**presentation** only — **no field, store binding, test handler, or helper string
may be removed or renamed.**

### What changes (layout/IA)
1. **Merge `SetupWizard` + `DiagnosticsPanel`** into one readiness header:
   overall status + headline + detail, progress (X/4 steps + %), quick facts
   (team members, optional signals, suggestion feeds, time-off calendars), the four
   steps with states, the Jira access-path guidance, and Dashboard/Reports surface
   readiness. The five diagnostic checks become **status dots on the rail**, not a
   separate list. One "Run / Refresh checks" button. Keep `buildSettingsSetupModel`
   as the single source — it already produces all of this.
2. **Left-rail section nav** with live status dots; render only the active section.
   Sections: Connection · Reports Scope · Permissions · Services · Preferences ·
   Data & backup.
3. **Persistent sticky save bar** (was the inline form-status row): Backup, Share
   Pack, Import, Discard, Save + the unsaved-changes status.
4. **"Services"** gets a roomy panel of its own (it currently hides GitLab +
   RescueTime + 3 calendar-feed types + 2 sub-editors at the bottom of the scroll).

### What must NOT change (the parity ledger)
Every row below must still exist and behave identically. This maps 1:1 to the
existing components — reorganize them, don't rewrite their logic.

| Section | Controls & info that MUST survive | Owning component(s) today |
|---|---|---|
| Readiness header | headline+detail, progress, quick facts, 4 steps, access-path checklist, Dashboard+Reports readiness, last-refreshed meta, Run/Refresh | `SetupWizard.tsx`, `DiagnosticsPanel.tsx`, `settingsSetup.ts` |
| Connection | Test + result banner; Jira Host (+normalize hint); Email; API Token; CORS Proxy (optional; Self-hosted / Hosted-by-Premium badges; override link); proxy + SOCKS hints; Premium waitlist | `sections/ConnectionSection.tsx` |
| Reports Scope | JQL Filter (optional) + "applied to all queries"; Team Members chip editor (optional) + Enter/Tab/paste hint | `sections/ScopeSection.tsx`, `AllowedUsersInput.tsx` |
| Permissions | auto-detect hint; add / edit / delete worklogs; enable timesheet reminders | `sections/PermissionsSection.tsx` |
| Services | GitLab (host, token, scope hint, Test, status, troubleshooting); RescueTime (key, proxy hint, Test, status); Suggestion feeds (label, URL, add/remove); Calendar mappings editor (issue, patterns, search, composer, validation); Time-off calendars (label, URL, self/shared attribution, title filter); Public holidays (label, URL); Shared-calendar assignments editor (pattern, emails, select-all/clear, validation); Test calendars | `sections/IntegrationsSection.tsx`, `CalendarMappingsEditor.tsx`, `TeamAbsenceAssignmentsEditor.tsx` |
| Preferences | Theme (system/light/dark); Time Rounding (off/15m/30m); Include absence columns in CSV (+ IsAbsence/AbsenceKind/AbsenceDays note) | `sections/PreferencesSection.tsx` |
| Data & backup | Backup; Share Pack (no secrets); Import; Discard; Save; unsaved-changes status | `SettingsForm.tsx` (status row + buttons) |

---

## Interactions & behavior
- **Rail → panel:** clicking a rail item shows that section, hides others; the
  active item gets a filled state and the section's status dot reflects its
  readiness (from `settingsSetup.ts`).
- **Save bar:** disabled Save/Discard until `isDirty`; same `saveSettings()` /
  `resetForm()` handlers as today. Toasts unchanged.
- **Tests:** per-service Test buttons keep their existing handlers (`testJira`,
  `testGitlab`, `testCalendar`, `testRescueTime`) and result banners.
- **Readiness header** may collapse once `coreReady` is true (progressive
  disclosure) — optional, but it's the fix for "setup noise on day 400".
- **My Week / Reports** transitions: standard react state; no animation engine.

## State management
No new global state. Reuse the existing stores: `useConfigStore`,
`useSettingsFormStore`, `useUserDataStore`, `useUIStore`. The readiness header reads
`buildSettingsSetupModel(...)` exactly as the wizard/diagnostics do now. Rail active
section is local component state.

## Design tokens
See `tokens.forge.css` and the token table above. Spacing/radii: reuse the repo's
existing `--space-*` and `--radius-*` scales — only colors, fonts, and the status
mapping change.

## Assets
- **Logo / app icon:** production **Billet H** SVGs are included in `billet-h/`:
  - `pwa-icon.svg` — drop in at `frontend/public/pwa-icon.svg` (512×512, iron tile)
  - `pwa-icon-maskable.svg` — `frontend/public/pwa-icon-maskable.svg` (Android safe-zone)
  - `favicon.svg` — favicon (holds up to 16px)
  - `lockup-horizontal.svg` — mark + wordmark for nav/marketing (swap fills to
    `#f4efe7` on dark grounds; renders best once Bricolage Grotesque is loaded)
- **Fonts:** Bricolage Grotesque, Hanken Grotesk, JetBrains Mono (Google Fonts; or
  self-host under `frontend/public/fonts/` to keep the no-CDN posture).
- No raster images required.

## Files in this bundle
- `CLAUDE_CODE_PROMPT.md` — paste-in, phased prompt
- `tokens.forge.css` — Phase-1 token override
- `index.html`, `ia.html`, `directions.html`, `screens.html`, `logo.html`,
  `settings.html` — design references
- `assets/` — stylesheets for the reference HTML (not for production use)
