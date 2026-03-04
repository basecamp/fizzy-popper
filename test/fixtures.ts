import type { Config } from "../src/config.js"
import type { FizzyBoard, FizzyCard, FizzyColumn, FizzyComment, FizzyUser, FizzyWebhookEvent, GoldenTicket } from "../src/fizzy.js"

export function makeUser(overrides: Partial<FizzyUser> = {}): FizzyUser {
  return {
    id: "user-1",
    name: "Test User",
    role: "member",
    active: true,
    email_address: "test@example.com",
    created_at: "2025-01-01T00:00:00Z",
    url: "https://app.fizzy.do/123/users/user-1",
    ...overrides,
  }
}

export function makeBoard(overrides: Partial<FizzyBoard> = {}): FizzyBoard {
  return {
    id: "board-1",
    name: "Test Board",
    all_access: true,
    created_at: "2025-01-01T00:00:00Z",
    url: "https://app.fizzy.do/123/boards/board-1",
    creator: makeUser(),
    ...overrides,
  }
}

export function makeColumn(overrides: Partial<FizzyColumn> = {}): FizzyColumn {
  return {
    id: "col-1",
    name: "Code Review",
    color: "var(--color-card-default)",
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  }
}

export function makeCard(overrides: Partial<FizzyCard> = {}): FizzyCard {
  return {
    id: "card-1",
    number: 42,
    title: "Fix login bug",
    status: "published",
    description: "The login button is broken",
    description_html: "<p>The login button is broken</p>",
    image_url: null,
    tags: [],
    closed: false,
    golden: false,
    last_active_at: "2025-01-01T12:00:00Z",
    created_at: "2025-01-01T00:00:00Z",
    url: "https://app.fizzy.do/123/cards/42",
    board: makeBoard(),
    column: makeColumn(),
    creator: makeUser(),
    assignees: [],
    steps: [],
    comments_url: "https://app.fizzy.do/123/cards/42/comments",
    ...overrides,
  }
}

export function makeGoldenTicketCard(overrides: Partial<FizzyCard> = {}): FizzyCard {
  return makeCard({
    id: "golden-1",
    number: 1,
    title: "Code Review Agent",
    description: "Review code for bugs and security issues",
    description_html: "<p>Review code for bugs and security issues</p>",
    tags: ["agent-instructions", "claude"],
    golden: false,
    steps: [
      { id: "step-1", content: "Check for security issues", completed: false },
      { id: "step-2", content: "Review error handling", completed: false },
    ],
    ...overrides,
  })
}

export function makeComment(overrides: Partial<FizzyComment> = {}): FizzyComment {
  return {
    id: "comment-1",
    created_at: "2025-01-01T12:00:00Z",
    updated_at: "2025-01-01T12:00:00Z",
    body: { plain_text: "This looks good", html: "<p>This looks good</p>" },
    creator: makeUser(),
    card: { id: "card-1", url: "https://app.fizzy.do/123/cards/42" },
    reactions_url: "https://app.fizzy.do/123/cards/42/comments/comment-1/reactions",
    url: "https://app.fizzy.do/123/cards/42/comments/comment-1",
    ...overrides,
  }
}

export function makeGoldenTicket(overrides: Partial<GoldenTicket> = {}): GoldenTicket {
  return {
    card_id: "golden-1",
    column_id: "col-1",
    column_name: "Code Review",
    description: "Review code for bugs and security issues",
    steps: [
      { id: "step-1", content: "Check for security issues", completed: false },
      { id: "step-2", content: "Review error handling", completed: false },
    ],
    backend: "claude",
    on_complete: "comment",
    title: "Code Review Agent",
    ...overrides,
  }
}

export function makeWebhookEvent(overrides: Partial<FizzyWebhookEvent> = {}): FizzyWebhookEvent {
  return {
    id: "event-1",
    action: "card_triaged",
    created_at: new Date().toISOString(),
    eventable: makeCard(),
    board: makeBoard(),
    creator: makeUser(),
    ...overrides,
  }
}

export function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    fizzy: {
      token: "fz_test_token",
      account: "123",
      api_url: "https://app.fizzy.do",
    },
    boards: ["board-1"],
    webhook: {
      port: 4567,
      secret: undefined,
    },
    agent: {
      max_concurrent: 5,
      timeout: 300_000,
      default_backend: "claude",
    },
    backends: {},
    polling: {
      interval: 30_000,
    },
    ...overrides,
  }
}
