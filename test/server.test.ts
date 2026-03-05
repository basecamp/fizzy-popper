import { describe, it, expect, vi, beforeEach } from "vitest"
import { createHmac } from "node:crypto"
import { Hono } from "hono"
import { WebhookServer } from "../src/server.js"
import type { Router } from "../src/router.js"
import type { Supervisor } from "../src/supervisor.js"
import { makeConfig, makeWebhookEvent, makeCard, makeColumn, makeGoldenTicket } from "./fixtures.js"

// Suppress log output
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

function makeMockRouter(): Router {
  return {
    routeEvent: vi.fn().mockReturnValue({ type: "ignore", reason: "test" }),
    loadBoardConfigs: vi.fn().mockResolvedValue(undefined),
    getBoardConfigs: vi.fn().mockReturnValue(new Map()),
    findGoldenTicket: vi.fn(),
    loadBoardConfig: vi.fn(),
    routeCardsForReconciliation: vi.fn(),
  } as unknown as Router
}

function makeMockSupervisor(): Supervisor {
  return {
    activeCardIds: vi.fn().mockReturnValue(new Set()),
    spawn: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    getActiveRuns: vi.fn().mockReturnValue([]),
    getRecentRuns: vi.fn().mockReturnValue([]),
    isRunning: vi.fn().mockReturnValue(false),
    activeCount: vi.fn().mockReturnValue(0),
    atCapacity: vi.fn().mockReturnValue(false),
    cancelOrphans: vi.fn(),
  } as unknown as Supervisor
}

// We test the Hono app via its fetch method directly, without starting a server
function getApp(config = makeConfig(), router = makeMockRouter(), supervisor = makeMockSupervisor()): { server: WebhookServer; router: ReturnType<typeof makeMockRouter>; supervisor: ReturnType<typeof makeMockSupervisor> } {
  const server = new WebhookServer(config, router, supervisor)
  return { server, router: router as ReturnType<typeof makeMockRouter>, supervisor: supervisor as ReturnType<typeof makeMockSupervisor> }
}

// Helper to call the internal Hono app through WebhookServer
async function webhookRequest(server: WebhookServer, body: string, headers: Record<string, string> = {}): Promise<Response> {
  // Access the Hono app via a quick cast
  const app = (server as any).app as Hono
  const request = new Request("http://localhost/webhook", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/json", ...headers },
  })
  return app.fetch(request)
}

async function statusRequest(server: WebhookServer): Promise<Response> {
  const app = (server as any).app as Hono
  return app.fetch(new Request("http://localhost/status"))
}

async function healthRequest(server: WebhookServer): Promise<Response> {
  const app = (server as any).app as Hono
  return app.fetch(new Request("http://localhost/health"))
}

describe("WebhookServer", () => {
  describe("POST /webhook", () => {
    it("accepts valid webhook events", async () => {
      const { server, router } = getApp()
      const event = makeWebhookEvent()
      const body = JSON.stringify(event)

      const response = await webhookRequest(server, body)
      const json = await response.json()

      expect(response.status).toBe(200)
      expect(json.status).toBe("ok")
      expect(router.routeEvent).toHaveBeenCalled()
    })

    it("rejects invalid JSON", async () => {
      const { server } = getApp()

      const response = await webhookRequest(server, "not json {{{")
      expect(response.status).toBe(400)
    })

    it("deduplicates events by id", async () => {
      const { server, router } = getApp()
      const event = makeWebhookEvent({ id: "dup-event-1" })
      const body = JSON.stringify(event)

      await webhookRequest(server, body)
      const response2 = await webhookRequest(server, body)
      const json2 = await response2.json()

      expect(json2.status).toBe("duplicate")
      // Router should only be called once
      expect(router.routeEvent).toHaveBeenCalledTimes(1)
    })

    it("processes different event ids independently", async () => {
      const { server, router } = getApp()

      await webhookRequest(server, JSON.stringify(makeWebhookEvent({ id: "evt-1" })))
      await webhookRequest(server, JSON.stringify(makeWebhookEvent({ id: "evt-2" })))

      expect(router.routeEvent).toHaveBeenCalledTimes(2)
    })

    describe("with webhook secret", () => {
      const secret = "test-secret-key"
      const configWithSecret = makeConfig({ webhook: { port: 4567, secret } })

      it("accepts valid signature", async () => {
        const { server } = getApp(configWithSecret)
        const event = makeWebhookEvent()
        const body = JSON.stringify(event)
        const signature = createHmac("sha256", secret).update(body).digest("hex")
        const timestamp = new Date().toISOString()

        const response = await webhookRequest(server, body, {
          "X-Webhook-Signature": signature,
          "X-Webhook-Timestamp": timestamp,
        })

        expect(response.status).toBe(200)
      })

      it("rejects invalid signature", async () => {
        const { server } = getApp(configWithSecret)
        const body = JSON.stringify(makeWebhookEvent())

        const response = await webhookRequest(server, body, {
          "X-Webhook-Signature": "invalid-hex-sig-goes-here-aabbcc",
          "X-Webhook-Timestamp": new Date().toISOString(),
        })

        expect(response.status).toBe(401)
      })

      it("rejects stale timestamps", async () => {
        const { server } = getApp(configWithSecret)
        const body = JSON.stringify(makeWebhookEvent())
        const signature = createHmac("sha256", secret).update(body).digest("hex")
        const staleTimestamp = new Date(Date.now() - 600_000).toISOString()

        const response = await webhookRequest(server, body, {
          "X-Webhook-Signature": signature,
          "X-Webhook-Timestamp": staleTimestamp,
        })

        expect(response.status).toBe(400)
      })
    })

    describe("dedup after dispatch", () => {
      it("does not dedup if dispatch throws", async () => {
        const router = makeMockRouter()
        const supervisor = makeMockSupervisor()
        ;(router.routeEvent as ReturnType<typeof vi.fn>).mockReturnValue({
          type: "spawn",
          card: makeCard(),
          goldenTicket: makeGoldenTicket(),
        })
        ;(supervisor.spawn as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"))

        const { server } = getApp(makeConfig(), router, supervisor)
        const event = makeWebhookEvent({ id: "retry-event" })
        const body = JSON.stringify(event)

        const response1 = await webhookRequest(server, body)
        expect(response1.status).toBe(500)

        // Same event should be retryable (not deduped)
        ;(supervisor.spawn as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined)
        const response2 = await webhookRequest(server, body)
        expect(response2.status).toBe(200)
        expect((await response2.json()).status).toBe("ok")
      })
    })

    describe("route action dispatch", () => {
      it("calls supervisor.spawn for spawn actions", async () => {
        const router = makeMockRouter()
        const supervisor = makeMockSupervisor()
        const card = makeCard()
        const ticket = makeGoldenTicket()

        ;(router.routeEvent as ReturnType<typeof vi.fn>).mockReturnValue({
          type: "spawn",
          card,
          goldenTicket: ticket,
        })

        const { server } = getApp(makeConfig(), router, supervisor)
        await webhookRequest(server, JSON.stringify(makeWebhookEvent()))

        expect(supervisor.spawn).toHaveBeenCalledWith(card, ticket)
      })

      it("calls supervisor.cancel for cancel actions", async () => {
        const router = makeMockRouter()
        const supervisor = makeMockSupervisor()

        ;(router.routeEvent as ReturnType<typeof vi.fn>).mockReturnValue({
          type: "cancel",
          cardId: "card-1",
          reason: "card_closed",
        })

        const { server } = getApp(makeConfig(), router, supervisor)
        await webhookRequest(server, JSON.stringify(makeWebhookEvent()))

        expect(supervisor.cancel).toHaveBeenCalledWith("card-1", "card_closed")
      })

      it("calls router.loadBoardConfigs for refresh actions", async () => {
        const router = makeMockRouter()
        ;(router.routeEvent as ReturnType<typeof vi.fn>).mockReturnValue({
          type: "refresh_golden_tickets",
        })

        const { server } = getApp(makeConfig(), router)
        await webhookRequest(server, JSON.stringify(makeWebhookEvent()))

        expect(router.loadBoardConfigs).toHaveBeenCalledWith(["board-1"])
      })
    })
  })

  describe("GET /status", () => {
    it("returns empty status when nothing is running", async () => {
      const { server } = getApp()

      const response = await statusRequest(server)
      const json = await response.json()

      expect(response.status).toBe(200)
      expect(json.active).toEqual([])
      expect(json.recent).toEqual([])
      expect(json.active_count).toBe(0)
    })

    it("returns active agents from supervisor", async () => {
      const supervisor = makeMockSupervisor()
      ;(supervisor.getActiveRuns as ReturnType<typeof vi.fn>).mockReturnValue([
        {
          card_number: 42,
          card_title: "Fix bug",
          column_name: "Code Review",
          backend_name: "claude",
          started_at: new Date("2025-01-01T00:00:00Z"),
          status: "running",
        },
      ])

      const { server } = getApp(makeConfig(), makeMockRouter(), supervisor)
      const response = await statusRequest(server)
      const json = await response.json()

      expect(json.active).toHaveLength(1)
      expect(json.active[0].card_number).toBe(42)
      expect(json.active[0].backend).toBe("claude")
      expect(json.active_count).toBe(1)
    })
  })

  describe("GET /health", () => {
    it("returns ok", async () => {
      const { server } = getApp()

      const response = await healthRequest(server)
      const json = await response.json()

      expect(response.status).toBe(200)
      expect(json.status).toBe("ok")
    })
  })
})
