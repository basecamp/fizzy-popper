import type { Config } from "./config.js"
import type { FizzyClient } from "./fizzy.js"
import { isGoldenTicket } from "./fizzy.js"
import type { Router } from "./router.js"
import type { Supervisor } from "./supervisor.js"
import * as log from "./log.js"

export class Reconciler {
  private config: Config
  private client: FizzyClient
  private router: Router
  private supervisor: Supervisor
  private timer: ReturnType<typeof setInterval> | null = null
  private ticking = false
  private boardIds: string[]

  constructor(
    config: Config,
    client: FizzyClient,
    router: Router,
    supervisor: Supervisor,
    boardIds: string[],
  ) {
    this.config = config
    this.client = client
    this.router = router
    this.supervisor = supervisor
    this.boardIds = boardIds
  }

  start(): void {
    // Run immediately, then on interval
    this.tick()
    this.timer = setInterval(() => this.tick(), this.config.polling.interval)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      // Refresh golden tickets
      await this.router.loadBoardConfigs(this.boardIds.length > 0 ? this.boardIds : undefined)

      // Fetch all cards on watched boards
      const cards = await this.client.listCards(
        this.boardIds.length > 0 ? { board_ids: this.boardIds } : undefined,
      )

      // Determine which card IDs should be in agent columns
      const validAgentCardIds = new Set<string>()
      for (const card of cards) {
        if (isGoldenTicket(card)) continue
        if (card.closed) continue
        if (!card.column) continue

        const goldenTicket = this.router.findGoldenTicket(card)
        if (goldenTicket) {
          validAgentCardIds.add(card.id)
        }
      }

      // Cancel agents for cards that are no longer in agent columns
      this.supervisor.cancelOrphans(validAgentCardIds)

      // Route new cards that aren't already running
      const actions = this.router.routeCardsForReconciliation(
        cards,
        this.supervisor.activeCardIds(),
      )

      for (const action of actions) {
        if (action.type === "spawn" && !this.supervisor.atCapacity()) {
          await this.supervisor.spawn(action.card, action.goldenTicket)
        }
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`Reconciliation error: ${message}`)
    } finally {
      this.ticking = false
    }
  }
}
