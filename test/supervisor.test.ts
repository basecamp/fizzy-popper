import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Supervisor } from "../src/supervisor.js"
import type { FizzyClient } from "../src/fizzy.js"
import { makeCard, makeGoldenTicket, makeComment, makeConfig, makeColumn } from "./fixtures.js"

function makeMockClient(): FizzyClient {
  return {
    listBoards: vi.fn(),
    getBoard: vi.fn(),
    listCards: vi.fn(),
    listColumns: vi.fn().mockResolvedValue([makeColumn({ id: "col-done", name: "Done" })]),
    getCard: vi.fn().mockResolvedValue(makeCard()),
    listComments: vi.fn().mockResolvedValue([]),
    closeCard: vi.fn().mockResolvedValue(undefined),
    triageCard: vi.fn().mockResolvedValue(undefined),
    postComment: vi.fn().mockResolvedValue(undefined),
    toggleTag: vi.fn().mockResolvedValue(undefined),
    getIdentity: vi.fn(),
  } as unknown as FizzyClient
}

// Minimal mock backend via agent module — we mock createBackend at module level
vi.mock("../src/agent.js", async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    createBackend: vi.fn().mockReturnValue({
      name: "mock",
      execute: vi.fn().mockResolvedValue({
        output: "<p>Agent result</p>",
        success: true,
        metadata: { duration_ms: 1000 },
      }),
    }),
  }
})

// Suppress log output during tests
vi.mock("../src/log.js", () => ({
  header: vi.fn(),
  board: vi.fn(),
  column: vi.fn(),
  agentSpawn: vi.fn(),
  agentStep: vi.fn(),
  agentSuccess: vi.fn(),
  agentError: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  event: vi.fn(),
  dim: vi.fn(),
}))

describe("Supervisor", () => {
  let supervisor: Supervisor
  let client: FizzyClient

  beforeEach(() => {
    client = makeMockClient()
    supervisor = new Supervisor(makeConfig(), client)
  })

  describe("initial state", () => {
    it("has no active runs", () => {
      expect(supervisor.activeCount()).toBe(0)
      expect(supervisor.activeCardIds().size).toBe(0)
      expect(supervisor.getActiveRuns()).toEqual([])
      expect(supervisor.getRecentRuns()).toEqual([])
    })

    it("is not at capacity", () => {
      expect(supervisor.atCapacity()).toBe(false)
    })

    it("reports no card as running", () => {
      expect(supervisor.isRunning("card-1")).toBe(false)
    })
  })

  describe("spawn", () => {
    it("registers the card as active", async () => {
      const card = makeCard()
      const ticket = makeGoldenTicket()

      await supervisor.spawn(card, ticket)

      expect(supervisor.isRunning("card-1")).toBe(true)
      expect(supervisor.activeCount()).toBe(1)
      expect(supervisor.activeCardIds().has("card-1")).toBe(true)
    })

    it("does not spawn duplicate for same card", async () => {
      const card = makeCard()
      const ticket = makeGoldenTicket()

      await supervisor.spawn(card, ticket)
      await supervisor.spawn(card, ticket)

      expect(supervisor.activeCount()).toBe(1)
    })

    it("respects concurrency cap", async () => {
      const config = makeConfig({ agent: { max_concurrent: 2, timeout: 300000, default_backend: "claude" } })
      const limitedSupervisor = new Supervisor(config, client)

      await limitedSupervisor.spawn(makeCard({ id: "c1", number: 1 }), makeGoldenTicket())
      await limitedSupervisor.spawn(makeCard({ id: "c2", number: 2 }), makeGoldenTicket())
      await limitedSupervisor.spawn(makeCard({ id: "c3", number: 3 }), makeGoldenTicket())

      expect(limitedSupervisor.activeCount()).toBe(2)
      expect(limitedSupervisor.isRunning("c1")).toBe(true)
      expect(limitedSupervisor.isRunning("c2")).toBe(true)
      expect(limitedSupervisor.isRunning("c3")).toBe(false)
    })

    it("fetches full card data and comments", async () => {
      const card = makeCard({ number: 42 })
      await supervisor.spawn(card, makeGoldenTicket())

      // Wait a tick for async execution to start
      await new Promise(r => setTimeout(r, 50))

      expect(client.getCard).toHaveBeenCalledWith(42)
      expect(client.listComments).toHaveBeenCalledWith(42)
    })

    it("posts result as comment on success", async () => {
      const card = makeCard({ number: 42 })
      await supervisor.spawn(card, makeGoldenTicket())

      // Wait for async execution
      await new Promise(r => setTimeout(r, 100))

      expect(client.postComment).toHaveBeenCalledWith(42, "<p>Agent result</p>")
    })

    it("moves run to recent after completion", async () => {
      const card = makeCard()
      await supervisor.spawn(card, makeGoldenTicket())

      await new Promise(r => setTimeout(r, 100))

      expect(supervisor.isRunning("card-1")).toBe(false)
      expect(supervisor.getRecentRuns()).toHaveLength(1)
      expect(supervisor.getRecentRuns()[0].status).toBe("succeeded")
    })
  })

  describe("cancel", () => {
    it("removes the card from active set", async () => {
      const card = makeCard()
      await supervisor.spawn(card, makeGoldenTicket())

      expect(supervisor.isRunning("card-1")).toBe(true)

      supervisor.cancel("card-1", "test cancellation")

      expect(supervisor.isRunning("card-1")).toBe(false)
      expect(supervisor.activeCount()).toBe(0)
    })

    it("adds to recent with cancelled status", async () => {
      const card = makeCard()
      await supervisor.spawn(card, makeGoldenTicket())

      supervisor.cancel("card-1", "test cancellation")

      const recent = supervisor.getRecentRuns()
      expect(recent).toHaveLength(1)
      expect(recent[0].status).toBe("cancelled")
    })

    it("is a no-op for unknown card ids", () => {
      supervisor.cancel("nonexistent", "should not crash")
      expect(supervisor.activeCount()).toBe(0)
    })
  })

  describe("cancelOrphans", () => {
    it("cancels agents not in the valid set", async () => {
      await supervisor.spawn(makeCard({ id: "c1", number: 1 }), makeGoldenTicket())
      await supervisor.spawn(makeCard({ id: "c2", number: 2 }), makeGoldenTicket())

      supervisor.cancelOrphans(new Set(["c1"]))

      expect(supervisor.isRunning("c1")).toBe(true)
      expect(supervisor.isRunning("c2")).toBe(false)
    })

    it("cancels all when valid set is empty", async () => {
      await supervisor.spawn(makeCard({ id: "c1", number: 1 }), makeGoldenTicket())
      await supervisor.spawn(makeCard({ id: "c2", number: 2 }), makeGoldenTicket())

      supervisor.cancelOrphans(new Set())

      expect(supervisor.activeCount()).toBe(0)
    })

    it("is a no-op when no active agents", () => {
      supervisor.cancelOrphans(new Set(["c1"]))
      expect(supervisor.activeCount()).toBe(0)
    })
  })

  describe("on_complete actions", () => {
    it("closes card when on_complete is close", async () => {
      const card = makeCard({ number: 42 })
      const ticket = makeGoldenTicket({ on_complete: "close" })

      await supervisor.spawn(card, ticket)
      await new Promise(r => setTimeout(r, 100))

      expect(client.closeCard).toHaveBeenCalledWith(42)
    })

    it("triages card to column when on_complete is move", async () => {
      const card = makeCard({ number: 42 })
      const ticket = makeGoldenTicket({ on_complete: "move:Done" })

      await supervisor.spawn(card, ticket)
      await new Promise(r => setTimeout(r, 100))

      expect(client.listColumns).toHaveBeenCalledWith("board-1")
      expect(client.triageCard).toHaveBeenCalledWith(42, "col-done")
    })
  })

  describe("error handling", () => {
    it("posts error comment and tags card on backend failure", async () => {
      const { createBackend } = await import("../src/agent.js")
      ;(createBackend as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        name: "mock",
        execute: vi.fn().mockResolvedValue({
          output: "",
          success: false,
          error: "Model refused",
        }),
      })

      const card = makeCard({ number: 42 })
      await supervisor.spawn(card, makeGoldenTicket())
      await new Promise(r => setTimeout(r, 100))

      expect(client.postComment).toHaveBeenCalledWith(
        42,
        expect.stringContaining("Agent error"),
      )
      expect(client.toggleTag).toHaveBeenCalledWith(42, "pi-error")
    })
  })

  describe("getRecentRuns", () => {
    it("limits to last 20 entries", async () => {
      for (let i = 0; i < 25; i++) {
        const card = makeCard({ id: `c-${i}`, number: i })
        await supervisor.spawn(card, makeGoldenTicket())
      }

      // Wait for all to complete
      await new Promise(r => setTimeout(r, 200))

      expect(supervisor.getRecentRuns().length).toBeLessThanOrEqual(20)
    })
  })
})
