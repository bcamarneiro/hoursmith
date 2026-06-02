# Contributing

Thanks for your interest in contributing to Hoursmith! This guide will get you up and running.

## Quick Start

```bash
git clone https://github.com/bcamarneiro/hoursmith.git
cd hoursmith
npm install
npm run dev:offline   # runs with mock data, no Jira needed
```

The app opens at **http://localhost:5174** with sample data.

## Development Workflow

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature
   ```

2. **Make your changes** — the dev server hot-reloads automatically.

3. **Run checks** before committing:
   ```bash
   npm run test:run    # unit tests
   npm run lint        # linter
   npm run format      # auto-format
   ```

4. **Commit** with a clear message:
   ```
   fix: correct worklog date format for Jira Server
   feat: add keyboard shortcut for month navigation
   refactor: simplify day calculation hook
   ```

5. **Push and open a PR** against `main`.

## Commit Conventions

We use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | When to use |
|--------|-------------|
| `feat:` | New feature or capability |
| `fix:` | Bug fix |
| `refactor:` | Code change that neither fixes a bug nor adds a feature |
| `test:` | Adding or updating tests |
| `docs:` | Documentation only |
| `chore:` | Build, tooling, or dependency changes |

Keep the subject line under 72 characters. Use the body for context if needed.

## Git Hooks

Husky runs automatically after `npm install`:

- **Pre-commit** — formats your code with Biome
- **Pre-push** — runs tests and build; blocks push if either fails

If you need to bypass (e.g., WIP push to a draft branch):
```bash
git push --no-verify
```

## Project Structure

```
frontend/
  react/
    components/    # UI components
    hooks/         # Custom React hooks
    pages/         # Route-level page components
    utils/         # Pure utility functions
    constants/     # Shared constants
    styles/        # Global styles and design tokens
  stores/          # Zustand state management
  mocks/           # MSW mock handlers for offline mode
types/             # Shared TypeScript interfaces
e2e/               # Playwright E2E tests
```

## Code Style

- **Biome** handles all formatting and linting. Run `npm run format` and it takes care of everything.
- **CSS Modules** with design tokens from `frontend/react/styles/tokens.css`. Use existing tokens instead of hardcoded values.
- **Zustand** for state. Components read from stores via selectors; avoid prop drilling for shared state.
- Keep components focused. If a component grows beyond ~150 lines, consider splitting it.

## Testing

```bash
npm run test          # watch mode (during development)
npm run test:run      # single run (CI / pre-push)
npm run test:coverage # with coverage report
npm run test:e2e      # Playwright E2E (start dev:offline first)
```

- Unit tests live next to the code: `__tests__/fileName.test.ts`
- E2E tests live in `e2e/`
- Use the existing mock worklog helpers in tests — check existing test files for patterns
- E2E tests require `npm run dev:offline` running in another terminal

## Environment Variables

See `.env.example` for all available variables. None are required for development — `npm run dev:offline` works out of the box.

## CORS Proxy

If you're testing against a real Jira instance:

```bash
# Terminal 1
npm run cors-proxy

# Terminal 2
npm run dev
```

Then set the CORS Proxy field in the app's Settings to `http://localhost:8081`.

For corporate networks with a SOCKS5 proxy:
```bash
npm run cors-proxy:socks
```

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Include a short description of what and why
- If it changes UI, mention how to verify visually
- Tests should pass (`npm run test:run && npm run build`)
- The CI pipeline runs automatically on PRs to `main` and `develop`

## Need Help?

- Check existing [issues](https://github.com/bcamarneiro/hoursmith/issues) for context
- See [ROADMAP.md](ROADMAP.md) for planned features
- Open an issue if you're unsure about an approach before investing time
