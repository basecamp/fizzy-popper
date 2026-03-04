# fizzy-popper

AI agents for your [Fizzy](https://fizzy.do) boards. A long-running service that watches Fizzy kanban boards and dispatches AI agents when cards land in agent-designated columns.

Humans manage the board, fizzy-popper does the rest.

## How it works

1. **Golden tickets** — Drop a card tagged `#agent-instructions` into any column. Its description becomes the agent prompt, its checklist becomes the work items.
2. **fizzy-popper watches** — Via webhooks or polling, the service detects when cards land in agent-enabled columns.
3. **Agents run** — The service spawns the configured backend (Claude, Codex, OpenAI, etc.), feeds it the prompt + card context, and posts the result as a comment.

```
[Maybe?]   [Code Review]         [Research]           [Done]
            ┌──────────────┐     ┌──────────────┐
            │ 🎫 Code      │     │ 🎫 Research  │
            │ Review Agent │     │ Agent        │
            │ #agent-      │     │ #agent-      │
            │  instructions│     │  instructions│
            │ #claude      │     │ #codex       │
            └──────────────┘     └──────────────┘
            Card #42             Card #58
            "Fix login bug"      "SSO options"
```

When card #42 lands in "Code Review", fizzy-popper finds the golden ticket, reads its instructions, spawns a Claude agent, and posts the result.

## Quick start

```bash
npx fizzy-popper
```

First run launches an interactive setup wizard. After that, it watches your boards.

## Commands

```
fizzy-popper            # Setup wizard (first run) or start watching
fizzy-popper start      # Watch boards (polling + webhooks)
fizzy-popper setup      # Re-run setup wizard
fizzy-popper status     # Show boards and agent columns
fizzy-popper boards     # List all boards and columns
```

## Configuration

Config lives at `.fizzy-popper/config.yml`:

```yaml
fizzy:
  token: fz_your_token
  account: "897362094"
  api_url: https://app.fizzy.do

boards:
  - board_id_1
  - board_id_2

agent:
  max_concurrent: 5
  timeout: 300000
  default_backend: claude

polling:
  interval: 30000

webhook:
  port: 4567
  secret: your_webhook_signing_secret

backends:
  claude:
    model: sonnet
  codex:
    model: codex-mini
  anthropic:
    api_key: $ANTHROPIC_API_KEY
    model: claude-sonnet-4-20250514
  openai:
    api_key: $OPENAI_API_KEY
    model: gpt-4o
  command:
    run: "my-script {prompt_file}"
```

Environment variables can be referenced with `$VAR_NAME` syntax.

## Golden tickets

A golden ticket is a card tagged `#agent-instructions` that lives in the column it configures.

| Card field | Purpose |
|-----------|---------|
| **Description** | The agent's instructions (natural language) |
| **Steps** | Work checklist the agent should follow |
| **Tags** | Behavior: backend (`#claude`, `#codex`, `#opencode`, `#openai`, `#anthropic`) and completion (`#close-on-complete`, `#move-to-done`, `#move-to-<column>`) |
| **Title** | Human label for the column's agent (e.g. "Code Review Agent") |

Columns without a golden ticket are ignored. No naming conventions required.

## Agent backends

| Backend | How it runs | Install |
|---------|------------|---------|
| `claude` | Claude Code CLI (`claude --print`) | `npm i -g @anthropic-ai/claude-code` |
| `codex` | OpenAI Codex CLI | `npm i -g @openai/codex` |
| `opencode` | OpenCode CLI | `brew install opencode-ai/tap/opencode` |
| `anthropic` | Anthropic Messages API (built-in) | Set `ANTHROPIC_API_KEY` |
| `openai` | OpenAI Chat API (built-in) | Set `OPENAI_API_KEY` |
| `command` | Any executable | Set `backends.command.run` in config |

Override per column with tags on the golden ticket (`#claude`, `#codex`, etc.).

## Webhooks

For real-time response, create a webhook in Fizzy pointing to your server:

```
POST https://your-server:4567/webhook
```

fizzy-popper verifies signatures using `X-Webhook-Signature` (HMAC-SHA256) and checks `X-Webhook-Timestamp` for freshness.

Without webhooks, the polling reconciler picks up changes on the configured interval (default 30s).

## Status endpoint

```
GET http://localhost:4567/status
```

Returns JSON with active agents and recent completions.

## Specification

See [SPEC.md](SPEC.md) for the complete language-agnostic service specification. Anyone can implement fizzy-popper in any language from the spec alone.

## Requirements

- Node.js 22+
- At least one agent backend installed or configured
- Fizzy API token with Read + Write permission

## License

MIT — see [MIT-LICENSE](MIT-LICENSE).
