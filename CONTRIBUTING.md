# Contributing to Nest

Thanks for wanting to help. Bug reports, fixes, docs and new provider adapters are all welcome.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Found a security problem? Don't open an issue, see [SECURITY.md](SECURITY.md).

## Before you start

- **Small fixes** (typos, obvious bugs, a missing test): just open a pull request.
- **Anything bigger** (a new feature, a new provider, a change to how runs, sessions or permissions work): open an issue first so we can agree on the shape before you spend time on it.
- Check [open issues](https://github.com/UseNestBot/Nest-Bot/issues) to see if someone is already on it.

## Set up

Needs Node.js 24+ and git. A signed in Claude Code or Codex CLI is handy for trying things out but not needed to run the tests.

```bash
git clone https://github.com/UseNestBot/Nest-Bot.git
cd Nest-Bot
npm install
npm run dev
```

`npm run dev` starts Nest with hot reload. Point it at a throwaway profile so you don't touch your real agents and chats:

```bash
NEST_USER_DATA=./profile-dev npm run dev
```

(`/profile*/` is already in `.gitignore`.)

## Where things are

| Path | What's in it |
| --- | --- |
| `src/main` | Electron main process: database, runs, scheduler, updater, IPC |
| `src/main/providers` | One adapter per provider (Claude Code, Codex, ACP CLIs, API keys) |
| `src/main/mcp` | The bundled MCP server agents use to remember, delegate and so on |
| `src/main/remote` | Remote access from your phone over Tailscale |
| `src/preload` | The bridge between main and renderer |
| `src/renderer` | The React UI |
| `src/shared` | Types and helpers used by both sides |
| `tests` | Vitest suite, with fake CLIs in `tests/fixtures` |

## Checks

Run all of these before you open a pull request. CI runs the same ones.

```bash
npm run typecheck
npm run build
npm test
```

Build before testing: part of `tests/agents.test.ts` only runs when `out/main/nest-mcp.mjs` exists.

The offline suite drives the real adapters against fake CLIs, so it never spends anything. If your change touches a provider adapter, also run the live tests for that provider on your own subscription:

```bash
NEST_LIVE=codex,claude npx vitest run tests/live.test.ts
NEST_LIVE=cursor,gemini,grok npx vitest run tests/live-acp.test.ts
```

Say in your pull request which live tests you ran, if any.

## Making changes

- **Match the code around you.** Same naming, same comment style, same level of detail.
- **Add a test** for bug fixes and new behaviour. For provider changes, extend the fake CLI in `tests/fixtures` rather than mocking the adapter.
- **Keep pull requests focused.** One fix or feature each. Unrelated cleanups go in their own PR.
- **Test on the platforms you touch.** Nest ships for Windows and Linux. If you change paths, process handling or packaging, say which you tested on.
- **Update the README** if you change something a user would notice: a setting, a file location, a new provider.

## Things we won't merge

Nest's promise is that it runs the official CLIs on the user's own subscription and asks before acting. So we won't take changes that:

- Read, copy, store or forward a provider CLI's credentials or session tokens.
- Scrape chat websites, call undocumented endpoints, or proxy someone else's access.
- Turn on permission bypass or full access modes by default, or skip approval cards.
- Stop stripping `*_API_KEY` / `*_BASE_URL` variables from provider processes, or otherwise make it easy to get billed by accident.
- Send user data (chats, memory, audio, files) anywhere other than the provider the user picked.

## Commits and pull requests

- Write commit messages in the imperative: "Fix cancel on Windows", not "Fixed" or "Fixes".
- Fill in the pull request template. Link the issue it closes with `Closes #123`.
- Screenshots or a short clip help a lot for UI changes, in both light and dark mode.
- A maintainer will review it. Expect questions; they're not a no.

## License

By contributing you agree that your contributions are licensed under the same license as the project, see [LICENSE](LICENSE).
