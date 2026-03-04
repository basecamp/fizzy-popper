# fizzy-popper Development Guide

## Architecture

fizzy-popper is a long-running Node.js service that watches Fizzy kanban boards and dispatches AI agents when cards land in agent-designated columns. Configuration lives on the board itself via "golden ticket" cards tagged `#agent-instructions`.

See [SPEC.md](SPEC.md) for the complete behavioral contract.

## Project Structure

```
src/
  cli.ts           # Entry point — commander CLI with start/setup/status/boards
  setup.ts         # @clack/prompts interactive setup wizard
  config.ts        # .fizzy-popper/config.yml loader, zod validation, $ENV resolution
  fizzy.ts         # Fizzy REST client, domain types, webhook HMAC verification, golden ticket parsing
  log.ts           # Chalk-based terminal output
  agent.ts         # Backend interface, prompt builder, 6 backend implementations
  router.ts        # Event-to-action routing, board config / golden ticket discovery
  supervisor.ts    # Agent lifecycle: spawn, cancel, execute, on_complete actions
  reconciler.ts    # Polling loop for board reconciliation
  server.ts        # Hono webhook HTTP server + /status + /health endpoints
test/
  fixtures.ts      # Shared factory functions for test data
  *.test.ts        # Per-module test files (vitest)
```

## Key Concepts

- **Golden ticket**: A card tagged `#agent-instructions` in any column. Its description is the agent prompt, its steps are the checklist, its tags select the backend and completion action.
- **Router**: Maps Fizzy webhook events and reconciliation discoveries to actions (spawn, cancel, refresh, ignore).
- **Supervisor**: Owns the in-memory set of running agents. One agent per card, global concurrency cap.
- **Backend**: Anything that takes a prompt and returns a result. CLI backends (claude, codex, opencode) spawn subprocesses. API backends (anthropic, openai) make HTTP calls. Command backend runs arbitrary executables.

## Running

```bash
npm install
npx tsx src/cli.ts --help       # Run CLI via tsx
npx tsx src/cli.ts setup        # Interactive setup
npx tsx src/cli.ts start        # Watch boards
npm test                        # Run test suite
npm run typecheck               # TypeScript strict check
```

## Testing

Tests use vitest with mocked fetch/subprocess calls. No network or Fizzy account needed.

```bash
npm test                        # Run once
npx vitest                      # Watch mode
```

## Conventions

- TypeScript strict mode, ESM (`"type": "module"`)
- Zod for config validation
- Hono for the webhook HTTP server
- Execa for subprocess management (CLI backends)
- All Fizzy API interactions go through `FizzyClient` in `fizzy.ts`
- Domain types (FizzyCard, GoldenTicket, AgentRun, etc.) live in `fizzy.ts`
- Log output via `log.ts` — never raw `console.log` in other modules
