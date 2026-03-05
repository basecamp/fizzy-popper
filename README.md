# Agents, it's Fizzy. Get popping.

fizzy-popper is an implementation of [OpenAI's Symphony spec](https://github.com/openai/symphony/blob/main/SPEC.md) for [Fizzy](https://fizzy.do) boards. Symphony's idea is great: a kanban board becomes an agent dispatch surface. Move a card into a column, an agent works it, posts its results, moves the card along. Humans manage work; agents do work.

The [Symphony spec](https://github.com/openai/symphony) is language-agnostic and invites anyone to build their own version. So we did — for Fizzy. You should build one too.

This is experimental. We built it to play with the idea, see what sticks, and figure out what agent-driven kanban actually feels like in practice. It's a demo. An invitation. A starting point. Play with it.

## The spec

The real star here is [SPEC.md](SPEC.md) — a complete, language-agnostic service specification. We wrote it before writing any code, then handed it to a coding agent and said "build this." The spec covers every routing rule, lifecycle transition, prompt assembly step, and API interaction. You could implement fizzy-popper in Rust, Go, Elixir, Python, whatever — from the spec alone.

This is the same approach OpenAI took with Symphony: spec first, implementation second. We think it's the right way to build agent-driven systems. The spec is the contract; the code is just one realization of it.

## How it works

```
[Backlog]   [Triage]              [Code Review]         [Done]
             ┌──────────────┐      ┌──────────────┐
             │ 🎫 Triage    │      │ 🎫 Review    │
             │ Agent        │      │ Agent        │
             │ #agent-      │      │ #agent-      │
             │  instructions│      │  instructions│
             │ #claude      │      │ #anthropic   │
             │ #move-to-    │      │ #close-on-   │
             │  code-review │      │  complete    │
             └──────────────┘      └──────────────┘
             Card #42              Card #58
             "Fix login bug"       "Add dark mode"
```

1. **Golden tickets** — Drop a card tagged `#agent-instructions` into any column. Its description becomes the agent prompt, its checklist becomes the steps the agent follows.
2. **fizzy-popper watches** — Via webhooks or polling, the service detects when work cards land in agent-enabled columns.
3. **Agents run** — The configured backend (Claude Code, Codex, Anthropic API, etc.) gets the prompt + full card context. The result is posted as a comment.
4. **Cards move** — On completion, the card can be closed, moved to another column, or just commented on — all configured via tags on the golden ticket.

That's it. No YAML pipelines, no DAGs, no orchestration frameworks. Just cards, columns, and tags. The board is the interface.

## Quick start

```bash
npm install
npx tsx src/cli.ts setup    # Interactive setup wizard
npx tsx src/cli.ts start    # Watch boards
```

The setup wizard asks for your Fizzy API token, picks your boards, detects installed backends, and writes `.fizzy-popper/config.yml`.

## Setting up a board for agents

You need three things: a board, a golden ticket card, and a work card to test with.

**Using the [Fizzy CLI](https://github.com/robzolkos/fizzy-cli):**

```bash
# Create a board with columns
fizzy board create --title "Agent Playground"
fizzy column create --board BOARD_ID --title "Triage"
fizzy column create --board BOARD_ID --title "Done"

# Create a golden ticket in the Triage column
fizzy card create --board BOARD_ID --title "Triage Agent" \
  --description "Summarize the card and propose a plan of action as a bulleted list."
fizzy card tag CARD_NUMBER --tag agent-instructions
fizzy card tag CARD_NUMBER --tag claude
fizzy card tag CARD_NUMBER --tag move-to-done
fizzy card column CARD_NUMBER --column TRIAGE_COLUMN_ID

# Add steps for the agent to follow
fizzy step create CARD_NUMBER --content "Acknowledge the request"
fizzy step create CARD_NUMBER --content "Identify key requirements"
fizzy step create CARD_NUMBER --content "Propose next steps"

# Create a work card and triage it
fizzy card create --board BOARD_ID --title "Add user authentication" \
  --description "We need OAuth2 login with Google and GitHub providers."
fizzy card column CARD_NUMBER --column TRIAGE_COLUMN_ID
```

**Or in the Fizzy UI:** Create a card, tag it `#agent-instructions` and `#claude`, write your prompt in the description, add checklist items as steps, and drag it into the column you want to automate. Then drag a work card into that column and watch the agent go.

**With Claude Code:** Run `/setup-test-board` — there's a built-in skill that walks you through the whole thing using the Fizzy CLI.

## Golden tickets

A golden ticket is a card tagged `#agent-instructions` that lives in the column it configures. No column naming conventions required — the golden ticket's presence is the signal.

| Card field | Purpose |
|-----------|---------|
| **Title** | Human label (e.g. "Triage Agent", "Code Review Agent") |
| **Description** | The agent's prompt — natural language instructions |
| **Steps** | Ordered tasks the agent should complete |
| **Tags** | Backend + completion behavior (see below) |

### Backend tags

The first matching tag picks the backend. Falls back to `default_backend` in config.

| Tag | Backend |
|-----|---------|
| `#claude` | Claude Code CLI |
| `#codex` | OpenAI Codex CLI |
| `#opencode` | OpenCode CLI |
| `#anthropic` | Anthropic Messages API |
| `#openai` | OpenAI Chat Completions API |

### Completion tags

| Tag | What happens after the agent posts its comment |
|-----|-----------------------------------------------|
| *(none)* | Just the comment. Card stays put. |
| `#close-on-complete` | Card gets closed |
| `#move-to-done` | Card moves to the "done" column |
| `#move-to-<column-name>` | Card moves to the named column (hyphens become spaces) |

## Agent backends

| Backend | How it runs | Install |
|---------|------------|---------|
| `claude` | Claude Code CLI (`claude --print`) | `npm i -g @anthropic-ai/claude-code` |
| `codex` | OpenAI Codex CLI | `npm i -g @openai/codex` |
| `opencode` | OpenCode CLI | `brew install opencode-ai/tap/opencode` |
| `anthropic` | Anthropic Messages API (built-in) | Set `ANTHROPIC_API_KEY` |
| `openai` | OpenAI Chat API (built-in) | Set `OPENAI_API_KEY` |
| `command` | Any executable | Set `backends.command.run` in config |

## Configuration

Config lives at `.fizzy-popper/config.yml`:

```yaml
fizzy:
  token: $FIZZY_API_TOKEN
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
  secret: $FIZZY_WEBHOOK_SECRET

backends:
  claude:
    model: sonnet
  anthropic:
    api_key: $ANTHROPIC_API_KEY
    model: claude-sonnet-4-20250514
  openai:
    api_key: $OPENAI_API_KEY
    model: gpt-4o
  command:
    run: "my-script {prompt_file}"
```

Values starting with `$` are resolved from environment variables.

## Commands

```
fizzy-popper            # Setup wizard (first run) or start watching
fizzy-popper start      # Watch boards (polling + webhooks)
fizzy-popper setup      # Re-run setup wizard
fizzy-popper status     # Show boards and agent columns
fizzy-popper boards     # List all boards and columns
```

## Webhooks

For real-time response, point a Fizzy webhook at your server:

```
POST https://your-server:4567/webhook
```

Signatures are verified via `X-Webhook-Signature` (HMAC-SHA256). Without webhooks, the polling reconciler picks up changes on the configured interval (default 30s).

## Status & health

```
GET http://localhost:4567/status    # Active agents + recent completions (JSON)
GET http://localhost:4567/health    # { "status": "ok" }
```

## Requirements

- Node.js 22+
- At least one agent backend installed or configured
- A [Fizzy](https://fizzy.do) account and API token

## Acknowledgments

This project is directly inspired by [OpenAI's Symphony](https://github.com/openai/symphony). Symphony introduced the pattern of kanban-as-agent-dispatch and published a language-agnostic spec inviting others to build their own. We took them up on it.

## License

MIT — see [MIT-LICENSE](MIT-LICENSE).
