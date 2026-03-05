import { describe, it, expect, vi, beforeEach } from "vitest"
import { createHmac } from "node:crypto"
import {
  parseGoldenTicket,
  isGoldenTicket,
  verifyWebhookSignature,
  isWebhookFresh,
  FizzyClient,
} from "../src/fizzy.js"
import { makeCard, makeGoldenTicketCard, makeColumn, makeConfig } from "./fixtures.js"

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
    client = new FizzyClient(makeConfig())
  })

  describe("url construction", () => {
    it("constructs correct board list URL", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify([]), { status: 200 }),
      )

      await client.listBoards()

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://app.fizzy.do/123/boards",
        expect.objectContaining({
          headers: expect.objectContaining({
            "Authorization": "Bearer fz_test_token",
          }),
        }),
      )

      fetchSpy.mockRestore()
    })

    it("strips trailing slash from api_url", () => {
      const clientWithSlash = new FizzyClient(makeConfig({
        fizzy: { token: "t", account: "a", api_url: "https://app.fizzy.do/" },
      }))

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify([]), { status: 200 }),
      )

      clientWithSlash.listBoards()

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://app.fizzy.do/a/boards",
        expect.any(Object),
      )

      fetchSpy.mockRestore()
    })
  })

  describe("listCards", () => {
    it("adds board_ids query params", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {},
        }),
      )

      await client.listCards({ board_ids: ["b1", "b2"] })

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://app.fizzy.do/123/cards?board_ids[]=b1&board_ids[]=b2",
        expect.any(Object),
      )

      fetchSpy.mockRestore()
    })
  })

  describe("paginatedRequest", () => {
    it("follows Link header for pagination", async () => {
      const page1 = [makeCard({ id: "card-1" })]
      const page2 = [makeCard({ id: "card-2" })]

      const fetchSpy = vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(JSON.stringify(page1), {
            status: 200,
            headers: { "Link": '<https://app.fizzy.do/123/cards?page=2>; rel="next"' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify(page2), { status: 200 }),
        )

      const results = await client.listCards()

      expect(results).toHaveLength(2)
      expect(results[0].id).toBe("card-1")
      expect(results[1].id).toBe("card-2")
      expect(fetchSpy).toHaveBeenCalledTimes(2)

      fetchSpy.mockRestore()
    })
  })

  describe("error handling", () => {
    it("throws on non-ok response", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("Not found", { status: 404, statusText: "Not Found" }),
      )

      await expect(client.getCard(42)).rejects.toThrow("Fizzy API 404")

      vi.restoreAllMocks()
    })
  })

  describe("mutations", () => {
    it("closeCard sends POST to closure endpoint", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 204 }),
      )

      await client.closeCard(42)

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://app.fizzy.do/123/cards/42/closure",
        expect.objectContaining({ method: "POST" }),
      )

      fetchSpy.mockRestore()
    })

    it("triageCard sends column_id in body", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 204 }),
      )

      await client.triageCard(42, "col-done")

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://app.fizzy.do/123/cards/42/triage",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ column_id: "col-done" }),
        }),
      )

      fetchSpy.mockRestore()
    })

    it("postComment sends comment body", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 204 }),
      )

      await client.postComment(42, "<p>Agent result</p>")

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://app.fizzy.do/123/cards/42/comments",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ comment: { body: "<p>Agent result</p>" } }),
        }),
      )

      fetchSpy.mockRestore()
    })

    it("toggleTag sends tag_title", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(null, { status: 204 }),
      )

      await client.toggleTag(42, "pi-error")

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://app.fizzy.do/123/cards/42/taggings",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ tag_title: "pi-error" }),
        }),
      )

      fetchSpy.mockRestore()
    })
  })

  describe("getIdentity", () => {
    it("fetches /my/identity without account slug", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ accounts: [] }), { status: 200 }),
      )

      await client.getIdentity()

      expect(fetchSpy).toHaveBeenCalledWith(
        "https://app.fizzy.do/my/identity",
        expect.any(Object),
      )

      fetchSpy.mockRestore()
    })
  })
})
