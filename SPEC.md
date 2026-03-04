# fizzy-popper Service Specification

**Status:** Draft v1 (language-agnostic)

**Purpose:** Define a long-running service that watches Fizzy boards, interprets card events, and spawns AI agent sessions per card.

---

## 1. Problem Statement

fizzy-popper is a daemon that bridges Fizzy kanban boards and AI agent execution. It solves four problems:

1. **Repeatable board-driven AI execution.** Turns "move a card into a column and an agent works it" into a persistent, supervised process rather than a manual invocation.
2. **Column-aware routing.** Different columns dispatch to different agent backends, models, and instructions. A "Triage with AI" column can use Claude while a "Generate Tests" column uses Codex — same board, same daemon.
3. **Board-native configuration.** Workflow policy lives on the board itself via *golden ticket* cards — per-column instruction cards tagged `#agent-instructions`. No external config file is needed to define what agents do; the board is the source of truth.
4. **Observability over concurrent agent runs.** A single status surface shows which agents are running, what they produced, and what failed — across all watched boards.

**Boundary:** fizzy-popper is a scheduler/router and board reader. It reads cards, dispatches agents, and posts results. Card mutations (comments, moves, closures) are performed by agents themselves via the Fizzy API, or by the service on behalf of completed agents. fizzy-popper does not implement agent logic — it invokes backends that do.

---

## 2. Goals and Non-Goals

### Goals

- **Dual-mode event ingestion.** Webhooks for real-time response; polling for reconciliation and environments where webhooks are impractical.
- **Bounded concurrency.** A configurable cap on simultaneous agent runs, with one agent per card at a time.
- **Pluggable agent backends.** CLI tools (Claude Code, Codex, OpenCode), HTTP APIs (Anthropic, OpenAI), and arbitrary executables — selectable per column.
- **Board-native configuration.** Golden ticket cards define agent behavior. No column-naming conventions required.
- **Restart recovery without persistent DB.** On startup, reconciliation polls the board and spawns agents for any unworked cards in agent-enabled columns. No database, no WAL, no recovery log.
- **Structured logging.** Every event, dispatch decision, and agent lifecycle transition logged as structured output.

### Non-Goals

- **Rich web UI.** The status endpoint is JSON. Terminal output is a human-readable activity feed. No dashboard.
- **General-purpose workflow engine.** fizzy-popper handles one pattern: card appears in column, agent runs, result posted. It does not model arbitrary state machines.
- **Prescribing AI models or providers.** The service is backend-agnostic. It does not bundle, recommend, or constrain model choice.
- **Mandating sandbox controls.** Agent isolation is the responsibility of the backend or the operator. fizzy-popper passes prompts and collects output.

---

## 3. System Overview — Main Components

| # | Component | Responsibility |
|---|-----------|---------------|
| 1 | **Golden Ticket Loader** | Discovers `#agent-instructions` cards per column across all watched boards. Builds the column-to-instruction mapping. |
| 2 | **Config Layer** | Typed getters for service config. YAML file with `$ENV_VAR` interpolation, validated by schema. |
| 3 | **Fizzy Client** | REST API client for boards, columns, cards, comments, closures, triaging, and tagging. Handles pagination via `Link` headers. Webhook signature verification. |
| 4 | **Event Ingester** | Dual-mode: webhook HTTP receiver (primary) + reconciliation poller (fallback and consistency). |
| 5 | **Router** | Maps Fizzy events and reconciliation findings to dispatch decisions: spawn, cancel, refresh golden tickets, or ignore. |
| 6 | **Supervisor** | In-memory registry of running agent attempts. Enforces concurrency cap, dedup by card ID, cancellation via abort signal. Tracks recent completions. |
| 7 | **Agent Runner** | Builds the prompt from golden ticket + card + comments. Resolves backend. Executes with timeout and abort. Posts result or error. Executes on_complete action. |
| 8 | **Status Surface** | HTTP endpoint (`GET /status`) returning JSON: active agents, recent completions, active count. Health check at `GET /health`. |
| 9 | **Logging** | Structured console output: timestamps, card numbers, column names, backend names, durations, errors. |

---

## 4. Core Domain Model

### Card (from Fizzy API)

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Unique identifier |
| `number` | integer | Human-readable card number |
| `title` | string | |
| `description` | string | Plain text |
| `description_html` | string | Rich text HTML |
| `status` | enum | `drafted` or `published` |
| `closed` | boolean | |
| `postponed` | boolean | |
| `golden` | boolean | Whether the card is a golden ticket (Fizzy API field) |
| `column` | object or null | `{ id, name, color }` — null if untriaged |
| `board` | object | `{ id, name }` |
| `tags` | list of strings | |
| `assignees` | list of users | `{ id, name, role, email_address }` |
| `steps` | list | `{ id, content, completed }` |
| `image_url` | string or null | |
| `has_attachments` | boolean | |
| `created_at` | datetime | |
| `last_active_at` | datetime | |
| `comments_url` | string | URL to fetch comments |
| `creator` | user object | |

### Comment (from Fizzy API)

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | |
| `body` | object | `{ plain_text, html }` |
| `creator` | user object | |
| `card` | object | `{ id, url }` |
| `created_at` | datetime | |
| `updated_at` | datetime | |

### Golden Ticket (derived from a card tagged `#agent-instructions`)

| Field | Source | Notes |
|-------|--------|-------|
| `card_id` | card.id | Identity of the instruction card |
| `column_id` | card.column.id | The column this ticket configures |
| `column_name` | card.column.name | For display |
| `title` | card.title | For display |
| `description` | card.description | The agent prompt |
| `steps` | card.steps | Checklist items passed to the agent |
| `backend` | card.tags | First matching backend tag, or default_backend from config |
| `on_complete` | card.tags | Completion action derived from tags (see section 5) |

### Webhook Event (from Fizzy)

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Unique event ID, used for deduplication |
| `action` | string | One of 11 actions (see below) |
| `created_at` | datetime | |
| `eventable` | Card or Comment | The object the event pertains to |
| `board` | Board object | |
| `creator` | User object | Who triggered the event |

**Webhook actions:** `card_assigned`, `card_closed`, `card_postponed`, `card_auto_postponed`, `card_board_changed`, `card_published`, `card_reopened`, `card_sent_back_to_triage`, `card_triaged`, `card_unassigned`, `comment_created`

**Webhook headers:**
- `X-Webhook-Signature` — HMAC-SHA256 of the raw request body, keyed on the webhook signing secret, hex-encoded.
- `X-Webhook-Timestamp` — ISO 8601 timestamp of event creation. Used for freshness validation.

### Agent Run Attempt

| Field | Type | Notes |
|-------|------|-------|
| `card_id` | string | Dedup key |
| `card_number` | integer | For display |
| `card_title` | string | For display |
| `column_name` | string | Column at time of dispatch |
| `backend_name` | string | Resolved backend |
| `started_at` | datetime | |
| `status` | enum | `running`, `succeeded`, `failed`, `timed_out`, `cancelled` |
| `abort_controller` | AbortController | Signal for cancellation |

### Service Config

Loaded from `.fizzy-popper/config.yml` in the working directory. String values starting with `$` are resolved as environment variables.

```yaml
fizzy:
  token: $FIZZY_API_TOKEN          # required
  account: your_account_slug       # required
  api_url: https://app.fizzy.do    # default

boards: all                        # list of board IDs, or "all"

webhook:
  port: 4567                       # default
  secret: $FIZZY_WEBHOOK_SECRET    # optional — disables signature verification if absent

agent:
  max_concurrent: 5                # default
  timeout: 300000                  # ms, default 5 minutes
  default_backend: claude          # default

backends:
  claude:
    model: sonnet                  # default
  codex:
    model: codex-mini              # default
  opencode: {}
  anthropic:
    api_key: $ANTHROPIC_API_KEY    # optional, falls back to env var
    model: claude-sonnet-4-20250514
  openai:
    api_key: $OPENAI_API_KEY       # optional, falls back to env var
    model: gpt-4o
  command:
    run: "my-script {prompt_file}" # template with {prompt_file} substitution

polling:
  interval: 30000                  # ms, default 30 seconds
```

---

## 5. Golden Ticket Pattern

A **golden ticket** is any card tagged `#agent-instructions`. It lives in the column it configures.

### Discovery Rules

1. A column is **agent-enabled** if and only if it contains a card tagged `#agent-instructions`.
2. No column naming convention is required. The presence of the golden ticket is the sole signal.
3. One golden ticket per column. If multiple exist, the first one found wins.
4. Golden ticket cards are never processed as work items.

### Content Mapping

| Card field | Golden ticket field | Purpose |
|------------|-------------------|---------|
| `description` | Agent prompt | System instructions for the agent |
| `steps` | Checklist | Work items passed to the agent in the prompt |
| `tags` | Behavior config | Backend selection, completion action |

### Backend Tags

The first matching tag determines the backend. If none match, `agent.default_backend` from config is used.

| Tag | Backend |
|-----|---------|
| `#claude` | Claude Code CLI |
| `#codex` | OpenAI Codex CLI |
| `#opencode` | OpenCode CLI |
| `#anthropic` | Anthropic Messages API |
| `#openai` | OpenAI Chat Completions API |

### Completion Tags

The first matching tag determines the on_complete action. Default is `comment` (post result, take no further action).

| Tag | Action |
|-----|--------|
| `#close-on-complete` | Post result as comment, then close the card |
| `#move-to-done` | Post result as comment, then triage card to column named "Done" |
| `#move-to-<column>` | Post result as comment, then triage card to the named column. Hyphens in the tag are converted to spaces in the column name. |

### Cache Lifecycle

- Golden tickets are fetched per board on startup.
- Refreshed on each reconciliation interval.
- Webhook events targeting a golden ticket card (any action on a card tagged `#agent-instructions`) trigger an immediate refresh of that board's golden ticket cache.

---

## 6. Event Ingestion

### Webhook Mode

1. Receive HTTP POST on `/webhook`.
2. If `webhook.secret` is configured: verify `X-Webhook-Signature` header. HMAC-SHA256 of the raw request body using the signing secret, compared in constant time. Reject with 401 on mismatch.
3. Verify `X-Webhook-Timestamp` freshness. Reject events older than 300 seconds with 400.
4. Parse JSON body as `FizzyWebhookEvent`.
5. Deduplicate by `event.id`. If seen before, return 200 with `{ status: "duplicate" }`.
6. Route event through Router.
7. Return 200 with `{ status: "ok" }`.

### Polling Mode (Reconciliation)

1. Runs on a fixed interval (`polling.interval`).
2. Refresh golden tickets for all watched boards.
3. Fetch all cards on watched boards (paginated).
4. Identify which cards are in agent-enabled columns and not closed.
5. Cancel agents for cards that are no longer in agent-enabled columns (orphan detection).
6. Emit synthetic spawn actions for unworked cards (cards in agent columns with no active agent).
7. Respect concurrency cap when spawning.

### Deduplication

- Webhook events are deduplicated by `event.id`. A bounded set of recent event IDs is maintained (last 1000, pruned to 500 on overflow).
- Reconciliation deduplicates against the supervisor's active set — a card with a running agent is never re-spawned.

---

## 7. Routing Rules

The Router receives either a webhook event or a list of cards from reconciliation and produces a dispatch decision.

### Webhook Event Routing

| Event | Condition | Action |
|-------|-----------|--------|
| `card_triaged` | Card is not a golden ticket AND not already running AND column has golden ticket | **Spawn** agent |
| `card_published` | Card is not a golden ticket AND not already running AND column has golden ticket | **Spawn** agent |
| `comment_created` | Card is in an agent column AND no active agent | **Re-trigger** agent (via reconciler) |
| `card_closed` | Agent running for this card | **Cancel** agent |
| `card_postponed` | Agent running for this card | **Cancel** agent |
| `card_auto_postponed` | Agent running for this card | **Cancel** agent |
| `card_sent_back_to_triage` | Agent running for this card | **Cancel** agent |
| `card_reopened` | Card is not a golden ticket AND not already running AND column has golden ticket | **Spawn** agent |
| `card_board_changed` | Card moved away from watched board AND agent running | **Cancel** agent |
| `card_board_changed` | Card arrived on watched board AND column has golden ticket AND not running | **Spawn** agent |
| Any event on a golden ticket card | — | **Refresh** golden ticket cache |

All other combinations produce **Ignore**.

### Reconciliation Routing

For each card on watched boards:
1. Skip golden ticket cards.
2. Skip closed cards.
3. Skip cards without a column (untriaged, unless triage itself has a golden ticket — but the card needs a column to match).
4. Skip cards already in the supervisor's active set.
5. If the card's column has a golden ticket: **Spawn**.

---

## 8. Agent Execution

### Lifecycle

```
Supervisor checks capacity
  → Fetch full card (GET /cards/:number) + comments (GET /cards/:number/comments) in parallel
  → Find golden ticket for card's column
  → Build prompt (see Prompt Assembly)
  → Resolve backend from golden ticket
  → Execute backend with timeout + abort signal
  → On success:
      Post output as comment on card
      Execute on_complete action (comment / close / move)
      Log success with duration
  → On failure:
      Post error comment on card (HTML-formatted)
      Toggle #pi-error tag on card (best effort)
      Log failure with error message
  → Remove card from active set
  → Record in recent completions
```

### Prompt Assembly

The prompt is a single text document assembled from four sources in order:

1. **System context.** Fixed preamble identifying the agent's role and output format requirements (HTML suitable for a Fizzy comment).
2. **Golden ticket instructions.** The golden ticket's `description` field. This is the operator's prompt.
3. **Golden ticket checklist.** The golden ticket's `steps`, rendered as a markdown checklist.
4. **Card content.** Card number, title, description, tags, assignees, card steps (if any).
5. **Discussion thread.** All comments on the card, in chronological order, with author names and timestamps.

### on_complete Actions

| Action | Behavior |
|--------|----------|
| `comment` (default) | Post agent output as comment. No further mutation. |
| `close` | Post agent output as comment, then close the card via `POST /cards/:number/closure`. |
| `move:<column_name>` | Post agent output as comment, then triage card to the named column via `POST /cards/:number/triage` with the column's ID. Column lookup is case-insensitive against columns on the card's board. If the column is not found, log a warning and skip the move. |

### Error Handling

On agent failure (backend returns `success: false`, execution throws, or timeout):
1. Post an error comment: `<p><strong>Agent error:</strong> {escaped error message}</p>`
2. Toggle the `#pi-error` tag on the card (best effort — failure to tag does not propagate).
3. Set run status to `failed` or `timed_out`.
4. No retry in v1.

---

## 9. Agent Backend Interface

### Contract

Every backend implements:

```
execute(prompt: string, options: BackendOptions) → AgentResult
```

**BackendOptions:**
| Field | Type | Notes |
|-------|------|-------|
| `model` | string (optional) | Override backend's configured model |
| `timeout` | integer (ms) | Maximum execution time |
| `signal` | AbortSignal | Cancellation signal |

**AgentResult:**
| Field | Type | Notes |
|-------|------|-------|
| `output` | string | Agent's response text |
| `success` | boolean | Whether execution completed without error |
| `error` | string (optional) | Error message on failure |
| `metadata.tokens` | integer (optional) | Total tokens consumed |
| `metadata.duration_ms` | integer (optional) | Wall-clock execution time |

### Backend Implementations

| Backend | Mechanism | Invocation |
|---------|-----------|------------|
| `claude` | Claude Code CLI | `claude --print --model <model>` with prompt on stdin |
| `codex` | OpenAI Codex CLI | `codex exec --json --ephemeral "<prompt>"` |
| `opencode` | OpenCode CLI | `opencode -p "<prompt>" -f json -q` |
| `anthropic` | Anthropic Messages API | HTTP POST to Messages endpoint. Single user message. `max_tokens: 4096`. |
| `openai` | OpenAI Chat Completions API | HTTP POST to Chat Completions endpoint. Single user message. `max_tokens: 4096`. |
| `command` | Arbitrary executable | Write prompt to a temp file. Execute the configured command with `{prompt_file}` replaced by the temp file path. Collect stdout. Clean up temp file. |

### Backend Auto-Detection

On first run (setup wizard), probe which CLI backends are installed:

| Backend | Probe command |
|---------|--------------|
| `claude` | `claude --version` |
| `codex` | `codex --version` |
| `opencode` | `opencode --version` |
| `anthropic` | Check for `ANTHROPIC_API_KEY` environment variable |
| `openai` | Check for `OPENAI_API_KEY` environment variable |

CLI probes use a 5-second timeout. Failure means the backend is not available.

---

## 10. Concurrency and Lifecycle

- **Global concurrency cap.** `agent.max_concurrent` from config. Default 5. When at capacity, new spawn requests are logged and skipped — the next reconciliation tick will pick them up if capacity frees.
- **One agent per card.** Card ID is the dedup key. A spawn request for a card with a running agent is ignored.
- **Cancellation.** Agents are cancellable via an abort signal. Cancel triggers include: card closed, card postponed, card sent back to triage, card moved to unwatched board, card moved out of agent column (orphan detection), and service shutdown.
- **No retry or backoff in v1.** Failed agents post an error and stop. The card remains in the column; a human or the reconciler can re-trigger.
- **Graceful shutdown.** On `SIGINT` or `SIGTERM`: stop the reconciler timer, stop the webhook server, cancel all active agents, exit.

---

## 11. Observability

### Structured Logging

Every significant event produces a log line:

| Event | Logged fields |
|-------|--------------|
| Board loaded | Board name, golden ticket count per column |
| Golden ticket found | Column name, backend, on_complete action |
| Webhook received | Action, board name |
| Route decision | Action type, card number, reason |
| Agent spawned | Card number, card title, column name, backend |
| Agent succeeded | Card number, duration (seconds), on_complete action taken |
| Agent failed | Card number, error message |
| Agent cancelled | Card number, reason |
| Reconciliation tick | Implicit (golden ticket refresh, spawn/cancel actions logged individually) |

### Status Endpoint

`GET /status` returns:

```json
{
  "active": [
    {
      "card_number": 42,
      "card_title": "Fix login page",
      "column": "AI Review",
      "backend": "claude",
      "started_at": "2026-03-04T10:00:00Z",
      "running_sec": 45.2
    }
  ],
  "recent": [
    {
      "card_number": 41,
      "card_title": "Update docs",
      "status": "succeeded",
      "finished_at": "2026-03-04T09:58:00Z"
    }
  ],
  "active_count": 1
}
```

### Health Check

`GET /health` returns `{ "status": "ok" }` with 200. No authentication required.

### Terminal Output

Human-readable activity feed with:
- Timestamps on event receipt
- Card numbers and titles on agent spawn/complete/fail
- Duration on completion
- Backend name and column name on spawn
- Colored output (success green, failure red, metadata dim)

---

## 12. Fizzy API Reference

Subset of endpoints used by fizzy-popper. All requests require `Authorization: Bearer <token>` and `Accept: application/json`.

### Read Operations

| Method | Path | Returns | Notes |
|--------|------|---------|-------|
| `GET` | `/:account/boards` | `Board[]` | List all boards for the account |
| `GET` | `/:account/boards/:id/columns` | `Column[]` | List columns on a board |
| `GET` | `/:account/cards?board_ids[]=:id` | `Card[]` | List cards, filtered by board. Paginated via `Link` header. |
| `GET` | `/:account/cards/:number` | `Card` | Single card with full detail (includes steps) |
| `GET` | `/:account/cards/:number/comments` | `Comment[]` | Paginated via `Link` header |
| `GET` | `/my/identity` | Identity | Returns accounts list with user info |

### Write Operations

| Method | Path | Body | Effect |
|--------|------|------|--------|
| `POST` | `/:account/cards/:number/comments` | `{ comment: { body } }` | Post a comment (HTML body) |
| `POST` | `/:account/cards/:number/closure` | — | Close the card |
| `POST` | `/:account/cards/:number/triage` | `{ column_id }` | Move card to a column |
| `POST` | `/:account/cards/:number/taggings` | `{ tag_title }` | Toggle a tag on/off |

### Pagination

Paginated endpoints return a `Link` header with `rel="next"` pointing to the next page URL. The client follows `Link: <url>; rel="next"` until absent.

### Webhook Verification

- **Signature:** HMAC-SHA256 of the raw request body using the webhook `signing_secret`. Hex-encoded. Sent as `X-Webhook-Signature` header.
- **Timestamp:** ISO 8601 datetime sent as `X-Webhook-Timestamp` header. Reject events with absolute drift > 300 seconds.
- **Verification:** Constant-time comparison of computed vs. received signature.

---

## 13. Reference Algorithms

### Startup

```
load config from .fizzy-popper/config.yml
create Fizzy client from config
create Router, Supervisor

resolve board IDs:
  if config.boards == "all": fetch all boards, collect IDs
  else: use config.boards as ID list

load golden tickets for each board:
  for each board:
    fetch all cards on board (paginated)
    for each card tagged #agent-instructions with a column:
      parse golden ticket → store in column_id → ticket map

display board summary (board names, agent-enabled columns, backends)

start Reconciler on polling.interval
start Webhook server on webhook.port

register SIGINT/SIGTERM → graceful shutdown
```

### Poll Tick (Reconciliation)

```
refresh golden tickets for all watched boards
  (re-fetch cards, re-parse golden tickets, replace cache)

fetch all cards on watched boards (paginated)

build valid_agent_card_ids:
  for each card that is not golden ticket, not closed, has a column, and column has golden ticket:
    add card.id to valid set

cancel orphans:
  for each active agent whose card_id is not in valid set:
    cancel agent ("card no longer in agent column")

spawn new agents:
  for each card in valid set not in active set:
    if supervisor is not at capacity:
      spawn agent for card
```

### Webhook Dispatch

```
receive POST /webhook

if webhook.secret configured:
  verify X-Webhook-Signature (HMAC-SHA256, constant-time compare)
  verify X-Webhook-Timestamp freshness (< 300s drift)
  reject on failure

parse event JSON

if event.id already seen: return 200 duplicate
add event.id to seen set (prune if > 1000)

route event:
  if eventable is a golden ticket card: refresh golden tickets
  else: match on event.action (see routing table §7)

execute action:
  spawn → supervisor.spawn(card, goldenTicket)
  cancel → supervisor.cancel(cardId, reason)
  refresh → router.loadBoardConfigs()
  ignore → no-op

return 200 ok
```

### Agent Dispatch

```
if supervisor.isRunning(card.id): return (already running)
if supervisor.atCapacity(): return (at capacity)

create AbortController
register AgentRun in active map

async:
  [fullCard, comments] = fetch card + comments in parallel
  goldenTicket = find golden ticket for card's column
  prompt = buildPrompt(goldenTicket, fullCard, comments)
  backend = createBackend(goldenTicket.backend, config)

  result = backend.execute(prompt, { timeout, signal })

  if aborted: set status=cancelled, remove from active, return

  if result.success:
    post result.output as comment on card
    execute on_complete action:
      "comment" → done
      "close" → POST /cards/:number/closure
      "move:<col>" → lookup column by name, POST /cards/:number/triage
    set status=succeeded

  else:
    post error comment on card
    toggle #pi-error tag (best effort)
    set status=failed

  remove from active map
  record in recent completions
```

---

## 14. Implementation Checklist

### Phase 1: Core Infrastructure
- [ ] Config layer: YAML loading, env var interpolation, schema validation
- [ ] Fizzy client: all read endpoints (boards, columns, cards, comments, identity)
- [ ] Fizzy client: all write endpoints (post comment, close card, triage card, toggle tag)
- [ ] Fizzy client: pagination via Link header
- [ ] Webhook signature verification + timestamp freshness check
- [ ] Golden ticket parser: tag-based backend selection, completion action derivation

### Phase 2: Event Processing
- [ ] Router: webhook event routing for all 11 actions
- [ ] Router: reconciliation card routing
- [ ] Webhook server: HTTP POST handler with signature verification, dedup, dispatch
- [ ] Reconciler: periodic tick — refresh golden tickets, spawn new, cancel orphans
- [ ] Event deduplication (bounded set of recent event IDs)

### Phase 3: Agent Execution
- [ ] Prompt builder: system context + golden ticket + card + comments
- [ ] Supervisor: active set, capacity check, spawn, cancel, orphan detection, recent tracking
- [ ] Agent lifecycle: fetch card, build prompt, execute, post result, on_complete action, error handling
- [ ] Backend: Claude Code CLI
- [ ] Backend: Codex CLI
- [ ] Backend: OpenCode CLI
- [ ] Backend: Anthropic Messages API
- [ ] Backend: OpenAI Chat Completions API
- [ ] Backend: Command (arbitrary executable)
- [ ] Backend auto-detection (CLI probe + env var check)

### Phase 4: Operability
- [ ] Status endpoint (GET /status): active agents, recent completions
- [ ] Health endpoint (GET /health)
- [ ] Structured logging: events, routing decisions, agent lifecycle
- [ ] Graceful shutdown (SIGINT/SIGTERM): stop reconciler, stop server, cancel all agents
- [ ] CLI: setup wizard (interactive config generation)
- [ ] CLI: start command
- [ ] CLI: status command (board summary, golden tickets, active agents)
- [ ] CLI: boards command (list boards and columns)
