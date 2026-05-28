import { describe, it, expect, vi, beforeEach } from "vitest"
import { createHmac } from "node:crypto"
import type { Mock } from "vitest"
import {
  parseGoldenTicket,
  isGoldenTicket,
  verifyWebhookSignature,
  isWebhookFresh,
  FizzyClient,
} from "../src/fizzy.js"
import { makeCard, makeGoldenTicketCard, makeConfig } from "./fixtures.js"

const sdkMock = vi.hoisted(() => {
  const rootClient = {
    identity: {
      me: vi.fn(),
    },
  }
  const accountClient = {
    boards: {
      list: vi.fn(),
      get: vi.fn(),
    },
    columns: {
      list: vi.fn(),
    },
    cards: {
      list: vi.fn(),
      get: vi.fn(),
      close: vi.fn(),
      triage: vi.fn(),
      tag: vi.fn(),
    },
    comments: {
      list: vi.fn(),
      create: vi.fn(),
    },
  }
  const createFizzyClient = vi.fn(({ baseUrl }: { baseUrl: string }) =>
    baseUrl.endsWith("/123") || baseUrl.endsWith("/a") ? accountClient : rootClient,
  )

  return { rootClient, accountClient, createFizzyClient }
})

vi.mock("@37signals/fizzy", () => ({
  createFizzyClient: sdkMock.createFizzyClient,
}))

describe("parseGoldenTicket", () => {
  it("returns null for a card without agent-instructions tag", () => {
    const card = makeCard({ tags: ["bug"] })
    expect(parseGoldenTicket(card, "claude")).toBeNull()
  })

  it("returns null for a card without a column", () => {
    const card = makeGoldenTicketCard({ column: undefined })
    expect(parseGoldenTicket(card, "claude")).toBeNull()
  })

  it("parses a golden ticket with claude backend tag", () => {
    const card = makeGoldenTicketCard()
    const ticket = parseGoldenTicket(card, "openai")

    expect(ticket).not.toBeNull()
    expect(ticket!.backend).toBe("claude")
    expect(ticket!.column_id).toBe("col-1")
    expect(ticket!.column_name).toBe("Code Review")
    expect(ticket!.description).toBe("Review code for bugs and security issues")
    expect(ticket!.steps).toHaveLength(2)
    expect(ticket!.on_complete).toBe("comment")
    expect(ticket!.title).toBe("Code Review Agent")
  })

  it("uses default backend when no backend tag present", () => {
    const card = makeGoldenTicketCard({ tags: ["agent-instructions"] })
    const ticket = parseGoldenTicket(card, "openai")

    expect(ticket!.backend).toBe("openai")
  })

  it("detects codex backend tag", () => {
    const card = makeGoldenTicketCard({ tags: ["agent-instructions", "codex"] })
    const ticket = parseGoldenTicket(card, "claude")

    expect(ticket!.backend).toBe("codex")
  })

  it("detects opencode backend tag", () => {
    const card = makeGoldenTicketCard({ tags: ["agent-instructions", "opencode"] })
    const ticket = parseGoldenTicket(card, "claude")

    expect(ticket!.backend).toBe("opencode")
  })

  it("detects anthropic backend tag", () => {
    const card = makeGoldenTicketCard({ tags: ["agent-instructions", "anthropic"] })
    const ticket = parseGoldenTicket(card, "claude")

    expect(ticket!.backend).toBe("anthropic")
  })

  it("detects openai backend tag", () => {
    const card = makeGoldenTicketCard({ tags: ["agent-instructions", "openai"] })
    const ticket = parseGoldenTicket(card, "claude")

    expect(ticket!.backend).toBe("openai")
  })

  it("picks first backend tag when multiple are present", () => {
    const card = makeGoldenTicketCard({ tags: ["agent-instructions", "codex", "claude"] })
    const ticket = parseGoldenTicket(card, "openai")

    expect(ticket!.backend).toBe("codex")
  })

  it("detects close-on-complete", () => {
    const card = makeGoldenTicketCard({ tags: ["agent-instructions", "claude", "close-on-complete"] })
    const ticket = parseGoldenTicket(card, "claude")

    expect(ticket!.on_complete).toBe("close")
  })

  it("detects move-to-done via generic move-to pattern", () => {
    const card = makeGoldenTicketCard({ tags: ["agent-instructions", "move-to-done"] })
    const ticket = parseGoldenTicket(card, "claude")

    expect(ticket!.on_complete).toBe("move:done")
  })

  it("detects move-to-<column> with hyphen-to-space conversion", () => {
    const card = makeGoldenTicketCard({ tags: ["agent-instructions", "move-to-in-progress"] })
    const ticket = parseGoldenTicket(card, "claude")

    expect(ticket!.on_complete).toBe("move:in progress")
  })

  it("defaults on_complete to comment", () => {
    const card = makeGoldenTicketCard({ tags: ["agent-instructions"] })
    const ticket = parseGoldenTicket(card, "claude")

    expect(ticket!.on_complete).toBe("comment")
  })

  it("uses card steps from the golden ticket", () => {
    const card = makeGoldenTicketCard({
      steps: [
        { id: "s1", content: "Step one", completed: true },
        { id: "s2", content: "Step two", completed: false },
      ],
    })
    const ticket = parseGoldenTicket(card, "claude")

    expect(ticket!.steps).toEqual([
      { id: "s1", content: "Step one", completed: true },
      { id: "s2", content: "Step two", completed: false },
    ])
  })

  it("handles card with no steps", () => {
    const card = makeGoldenTicketCard({ steps: undefined })
    const ticket = parseGoldenTicket(card, "claude")

    expect(ticket!.steps).toEqual([])
  })
})

describe("isGoldenTicket", () => {
  it("returns true for a card with agent-instructions tag", () => {
    expect(isGoldenTicket(makeCard({ tags: ["agent-instructions"] }))).toBe(true)
  })

  it("returns true when agent-instructions is among other tags", () => {
    expect(isGoldenTicket(makeCard({ tags: ["bug", "agent-instructions", "claude"] }))).toBe(true)
  })

  it("returns false for a card without agent-instructions tag", () => {
    expect(isGoldenTicket(makeCard({ tags: ["bug", "feature"] }))).toBe(false)
  })

  it("returns false for a card with no tags", () => {
    expect(isGoldenTicket(makeCard({ tags: [] }))).toBe(false)
  })
})

describe("verifyWebhookSignature", () => {
  const secret = "test-signing-secret"
  const body = '{"id":"event-1","action":"card_triaged"}'

  it("accepts valid HMAC-SHA256 signature", () => {
    const signature = createHmac("sha256", secret).update(body).digest("hex")

    expect(verifyWebhookSignature(body, signature, secret)).toBe(true)
  })

  it("rejects invalid signature", () => {
    expect(verifyWebhookSignature(body, "bad-signature-hex-value-aaa", secret)).toBe(false)
  })

  it("rejects signature with wrong secret", () => {
    const signature = createHmac("sha256", "wrong-secret").update(body).digest("hex")

    expect(verifyWebhookSignature(body, signature, secret)).toBe(false)
  })

  it("rejects signature of different body", () => {
    const otherBody = '{"id":"event-2","action":"card_closed"}'
    const signature = createHmac("sha256", secret).update(otherBody).digest("hex")

    expect(verifyWebhookSignature(body, signature, secret)).toBe(false)
  })

  it("rejects signature with length mismatch", () => {
    expect(verifyWebhookSignature(body, "short", secret)).toBe(false)
  })
})

describe("isWebhookFresh", () => {
  it("accepts a timestamp from just now", () => {
    expect(isWebhookFresh(new Date().toISOString())).toBe(true)
  })

  it("accepts a timestamp from 2 minutes ago", () => {
    const twoMinAgo = new Date(Date.now() - 120_000).toISOString()
    expect(isWebhookFresh(twoMinAgo)).toBe(true)
  })

  it("rejects a timestamp from 10 minutes ago", () => {
    const tenMinAgo = new Date(Date.now() - 600_000).toISOString()
    expect(isWebhookFresh(tenMinAgo)).toBe(false)
  })

  it("accepts a timestamp from 4 minutes ago (within default 5m tolerance)", () => {
    const fourMinAgo = new Date(Date.now() - 240_000).toISOString()
    expect(isWebhookFresh(fourMinAgo)).toBe(true)
  })

  it("respects custom tolerance", () => {
    const twoMinAgo = new Date(Date.now() - 120_000).toISOString()
    expect(isWebhookFresh(twoMinAgo, 60)).toBe(false) // 60s tolerance
    expect(isWebhookFresh(twoMinAgo, 180)).toBe(true) // 180s tolerance
  })

  it("rejects timestamps in the far future", () => {
    const farFuture = new Date(Date.now() + 600_000).toISOString()
    expect(isWebhookFresh(farFuture)).toBe(false)
  })
})

describe("FizzyClient", () => {
  let client: FizzyClient

  beforeEach(() => {
    vi.clearAllMocks()
    resetSdkDefaults()
    client = new FizzyClient(makeConfig())
  })

  describe("client construction", () => {
    it("constructs root and account-scoped SDK clients", async () => {
      await client.listBoards()

      expect(sdkMock.createFizzyClient).toHaveBeenNthCalledWith(1, {
        accessToken: "fz_test_token",
        baseUrl: "https://app.fizzy.do",
      })
      expect(sdkMock.createFizzyClient).toHaveBeenNthCalledWith(2, {
        accessToken: "fz_test_token",
        baseUrl: "https://app.fizzy.do/123",
      })
    })

    it("strips trailing slash from api_url", async () => {
      const clientWithSlash = new FizzyClient(makeConfig({
        fizzy: { token: "t", account: "a", api_url: "https://app.fizzy.do/" },
      }))

      await clientWithSlash.listBoards()

      expect(sdkMock.createFizzyClient).toHaveBeenLastCalledWith({
        accessToken: "t",
        baseUrl: "https://app.fizzy.do/a",
      })
    })
  })

  describe("listCards", () => {
    it("maps board_ids to SDK boardIds", async () => {
      await client.listCards({ board_ids: ["b1", "b2"] })

      expect(sdkMock.accountClient.cards.list).toHaveBeenCalledWith({
        boardIds: ["b1", "b2"],
      })
    })
  })

  describe("paginated lists", () => {
    it("returns the SDK list result as a plain array", async () => {
      const page1 = [makeCard({ id: "card-1" })]
      const page2 = [makeCard({ id: "card-2" })]
      mocked(sdkMock.accountClient.cards.list).mockResolvedValue([...page1, ...page2])

      const results = await client.listCards()

      expect(results).toHaveLength(2)
      expect(results[0].id).toBe("card-1")
      expect(results[1].id).toBe("card-2")
    })
  })

  describe("error handling", () => {
    it("wraps SDK errors with a Fizzy API prefix", async () => {
      mocked(sdkMock.accountClient.cards.get).mockRejectedValue(new Error("Not found"))

      await expect(client.getCard(42)).rejects.toThrow("Fizzy API: Not found")
    })
  })

  describe("mutations", () => {
    it("closeCard delegates to the SDK close method", async () => {
      await client.closeCard(42)

      expect(sdkMock.accountClient.cards.close).toHaveBeenCalledWith(42)
    })

    it("triageCard maps column_id to SDK columnId", async () => {
      await client.triageCard(42, "col-done")

      expect(sdkMock.accountClient.cards.triage).toHaveBeenCalledWith(42, {
        columnId: "col-done",
      })
    })

    it("postComment sends comment body", async () => {
      await client.postComment(42, "<p>Agent result</p>")

      expect(sdkMock.accountClient.comments.create).toHaveBeenCalledWith(42, {
        body: "<p>Agent result</p>",
      })
    })

    it("toggleTag maps tag_title to SDK tagTitle", async () => {
      await client.toggleTag(42, "pi-error")

      expect(sdkMock.accountClient.cards.tag).toHaveBeenCalledWith(42, {
        tagTitle: "pi-error",
      })
    })
  })

  describe("getIdentity", () => {
    it("uses the accountless root SDK client", async () => {
      mocked(sdkMock.rootClient.identity.me).mockResolvedValue({ accounts: [] })

      await client.getIdentity()

      expect(sdkMock.rootClient.identity.me).toHaveBeenCalled()
      expect(sdkMock.accountClient.boards.list).not.toHaveBeenCalled()
    })
  })
})

function resetSdkDefaults(): void {
  mocked(sdkMock.accountClient.boards.list).mockResolvedValue([])
  mocked(sdkMock.accountClient.boards.get).mockResolvedValue({})
  mocked(sdkMock.accountClient.columns.list).mockResolvedValue([])
  mocked(sdkMock.accountClient.cards.list).mockResolvedValue([])
  mocked(sdkMock.accountClient.cards.get).mockResolvedValue(makeCard())
  mocked(sdkMock.accountClient.cards.close).mockResolvedValue(undefined)
  mocked(sdkMock.accountClient.cards.triage).mockResolvedValue(undefined)
  mocked(sdkMock.accountClient.cards.tag).mockResolvedValue(undefined)
  mocked(sdkMock.accountClient.comments.list).mockResolvedValue([])
  mocked(sdkMock.accountClient.comments.create).mockResolvedValue({})
  mocked(sdkMock.rootClient.identity.me).mockResolvedValue({ accounts: [] })
}

function mocked<T extends (...args: never[]) => unknown>(fn: T): Mock {
  return fn as Mock
}
