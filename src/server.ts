import { Hono } from "hono"
import { serve } from "@hono/node-server"
import type { Config } from "./config.js"
import type { FizzyWebhookEvent } from "./fizzy.js"
import { verifyWebhookSignature, isWebhookFresh } from "./fizzy.js"
import type { Router } from "./router.js"
import type { Supervisor } from "./supervisor.js"
import * as log from "./log.js"

export class WebhookServer {
  private app: Hono
  private config: Config
  private router: Router
  private supervisor: Supervisor
  private recentEventIds: Set<string> = new Set()
  private server: ReturnType<typeof serve> | null = null

  constructor(config: Config, router: Router, supervisor: Supervisor) {
    this.config = config
    this.router = router
    this.supervisor = supervisor
    this.app = this.createApp()
  }

  private createApp(): Hono {
    const app = new Hono()

    // Webhook endpoint
    app.post("/webhook", async (c) => {
      const body = await c.req.text()

      // Verify signature if webhook secret is configured
      if (this.config.webhook.secret) {
        const signature = c.req.header("X-Webhook-Signature") ?? ""
        const timestamp = c.req.header("X-Webhook-Timestamp") ?? ""

        if (!verifyWebhookSignature(body, signature, this.config.webhook.secret)) {
          return c.json({ error: "invalid signature" }, 401)
        }

        if (!isWebhookFresh(timestamp)) {
          return c.json({ error: "stale event" }, 400)
        }
      }

      let event: FizzyWebhookEvent
      try {
        event = JSON.parse(body) as FizzyWebhookEvent
      } catch {
        return c.json({ error: "invalid JSON" }, 400)
      }

      // Deduplication
      if (this.recentEventIds.has(event.id)) {
        return c.json({ status: "duplicate" }, 200)
      }

      // Claim the event ID before dispatch to prevent concurrent duplicates
      this.recentEventIds.add(event.id)
      this.pruneRecentEvents()

      // Route event
      log.event(event.action, `card event from ${event.board.name}`)
      const action = this.router.routeEvent(event, this.supervisor.activeCardIds())

      const boardIds = this.config.boards !== "all" ? this.config.boards : undefined

      try {
        switch (action.type) {
          case "spawn":
            await this.supervisor.spawn(action.card, action.goldenTicket)
            break
          case "cancel":
            this.supervisor.cancel(action.cardId, action.reason)
            break
          case "refresh_golden_tickets":
            await this.router.loadBoardConfigs(boardIds)
            break
          case "ignore":
            break
        }
      } catch (err) {
        // Release the event ID so Fizzy can retry
        this.recentEventIds.delete(event.id)
        const message = err instanceof Error ? err.message : String(err)
        log.error(`Dispatch error: ${message}`)
        return c.json({ error: "dispatch failed" }, 500)
      }

      return c.json({ status: "ok" }, 200)
    })

    // Status endpoint
    app.get("/status", (c) => {
      const active = this.supervisor.getActiveRuns().map(run => ({
        card_number: run.card_number,
        card_title: run.card_title,
        column: run.column_name,
        backend: run.backend_name,
        started_at: run.started_at.toISOString(),
        running_sec: (Date.now() - run.started_at.getTime()) / 1000,
      }))

      const recent = this.supervisor.getRecentRuns().map(run => ({
        card_number: run.card_number,
        card_title: run.card_title,
        status: run.status,
        finished_at: run.finished_at.toISOString(),
      }))

      return c.json({ active, recent, active_count: active.length })
    })

    // Health check
    app.get("/health", (c) => c.json({ status: "ok" }))

    return app
  }

  start(): void {
    const port = this.config.webhook.port
    if (!this.config.webhook.secret) {
      log.warn("No webhook secret configured — webhook signature verification is disabled")
    }
    this.server = serve({ fetch: this.app.fetch, port })
    log.dim(`Webhook server listening on :${port}`)
  }

  stop(): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  private pruneRecentEvents(): void {
    // Keep only last 1000 event IDs
    if (this.recentEventIds.size > 1000) {
      const arr = Array.from(this.recentEventIds)
      this.recentEventIds = new Set(arr.slice(-500))
    }
  }
}
