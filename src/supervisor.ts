import type { Config } from "./config.js"
import type { FizzyCard, FizzyClient, GoldenTicket, AgentRun } from "./fizzy.js"
import { buildPrompt, createBackend, type AgentResult } from "./agent.js"
import * as log from "./log.js"

export class Supervisor {
  private active: Map<string, AgentRun> = new Map() // card_id → run
  private recent: Array<AgentRun & { result?: AgentResult; finished_at: Date }> = []
  private config: Config
  private client: FizzyClient

  constructor(config: Config, client: FizzyClient) {
    this.config = config
    this.client = client
  }

  // ── Queries ──

  isRunning(cardId: string): boolean {
    return this.active.has(cardId)
  }

  activeCount(): number {
    return this.active.size
  }

  activeCardIds(): Set<string> {
    return new Set(this.active.keys())
  }

  atCapacity(): boolean {
    return this.active.size >= this.config.agent.max_concurrent
  }

  getActiveRuns(): AgentRun[] {
    return Array.from(this.active.values())
  }

  getRecentRuns(): Array<AgentRun & { result?: AgentResult; finished_at: Date }> {
    return this.recent.slice(-20)
  }

  // ── Spawn an agent ──

  async spawn(card: FizzyCard, goldenTicket: GoldenTicket): Promise<void> {
    if (this.active.has(card.id)) {
      log.warn(`Agent already running for card #${card.number}`)
      return
    }

    if (this.atCapacity()) {
      log.warn(`At capacity (${this.config.agent.max_concurrent}), skipping card #${card.number}`)
      return
    }

    const abortController = new AbortController()
    const run: AgentRun = {
      card_id: card.id,
      card_number: card.number,
      card_title: card.title,
      column_name: goldenTicket.column_name,
      backend_name: goldenTicket.backend,
      started_at: new Date(),
      status: "running",
      abort_controller: abortController,
    }

    this.active.set(card.id, run)
    log.agentSpawn(card.number, card.title, goldenTicket.column_name)
    log.agentStep(`Spawning ${goldenTicket.backend}...`)

    // Run asynchronously — don't await here
    this.executeAgent(card, goldenTicket, run).catch(err => {
      log.error(`Unhandled error for card #${card.number}: ${err}`)
    })
  }

  // ── Cancel an agent ──

  cancel(cardId: string, reason: string): void {
    const run = this.active.get(cardId)
    if (!run) return

    run.abort_controller.abort()
    run.status = "cancelled"
    ;(run as any).cancelled = true
    this.active.delete(cardId)
    this.recent.push({ ...run, finished_at: new Date() })
    if (this.recent.length > 50) this.recent.splice(0, this.recent.length - 50)

    log.agentStep(`Cancelled card #${run.card_number}: ${reason}`)
  }

  // ── Cancel agents for cards no longer in agent columns ──

  cancelOrphans(validCardIds: Set<string>): void {
    for (const [cardId, run] of this.active) {
      if (!validCardIds.has(cardId)) {
        this.cancel(cardId, "card no longer in agent column")
      }
    }
  }

  // ── Internal execution ──

  private async executeAgent(card: FizzyCard, goldenTicket: GoldenTicket, run: AgentRun): Promise<void> {
    const cancelled = () => (run as any).cancelled === true

    try {
      // Fetch full card data + comments
      log.agentStep(`Fetching card #${card.number} data...`)
      const [fullCard, comments] = await Promise.all([
        this.client.getCard(card.number),
        this.client.listComments(card.number),
      ])

      if (cancelled()) return

      // Build prompt
      log.agentStep(`Building prompt (${comments.length} comments)...`)
      const prompt = buildPrompt(goldenTicket, fullCard, comments)

      // Create and execute backend
      const backend = createBackend(goldenTicket.backend, this.config)
      log.agentStep(`Running ${backend.name}...`)
      const result = await backend.execute(prompt, {
        timeout: this.config.agent.timeout,
        signal: run.abort_controller.signal,
      })

      if (cancelled()) return

      if (result.success) {
        run.status = "succeeded"
        const durationSec = (Date.now() - run.started_at.getTime()) / 1000

        // Post result as comment
        log.agentStep(`Posting result (${result.output.length} chars)...`)
        await this.client.postComment(card.number, result.output)

        if (cancelled()) return

        // Execute on_complete action
        log.agentStep(`Executing on_complete: ${goldenTicket.on_complete}`)
        const actionDesc = await this.executeOnComplete(card, goldenTicket)

        log.agentSuccess(durationSec, actionDesc)
      } else {
        run.status = "failed"

        // Post error as comment
        const errorHtml = `<p><strong>Agent error:</strong> ${escapeHtml(result.error ?? "Unknown error")}</p>`
        await this.client.postComment(card.number, errorHtml)

        // Tag card with pi-error
        try { await this.client.toggleTag(card.number, "pi-error") } catch { /* best effort */ }

        log.agentError(result.error ?? "Unknown error")
      }

      this.active.delete(card.id)
      this.recent.push({ ...run, result, finished_at: new Date() })
      if (this.recent.length > 50) this.recent.splice(0, this.recent.length - 50)
    } catch (err: unknown) {
      if (cancelled()) return

      const isTimeout = err != null && typeof err === "object" && "timedOut" in err && (err as any).timedOut === true
      run.status = isTimeout ? "timed_out" : "failed"
      this.active.delete(card.id)
      this.recent.push({ ...run, finished_at: new Date() })
      if (this.recent.length > 50) this.recent.splice(0, this.recent.length - 50)

      const message = err instanceof Error ? err.message : String(err)
      log.agentError(message)

      // Best-effort error comment
      try {
        const errorHtml = `<p><strong>Agent error:</strong> ${escapeHtml(message)}</p>`
        await this.client.postComment(card.number, errorHtml)
        await this.client.toggleTag(card.number, "pi-error")
      } catch { /* ignore */ }
    }
  }

  private async executeOnComplete(card: FizzyCard, goldenTicket: GoldenTicket): Promise<string> {
    const action = goldenTicket.on_complete

    if (action === "close") {
      await this.client.closeCard(card.number)
      return "comment posted, card closed"
    }

    if (action.startsWith("move:")) {
      const targetColumnName = action.slice(5)
      try {
        const columns = await this.client.listColumns(card.board.id)
        const target = columns.find(c => c.name.toLowerCase() === targetColumnName.toLowerCase())
        if (target) {
          await this.client.triageCard(card.number, target.id)
          return `comment posted, moved to ${target.name}`
        }
        return `comment posted (column "${targetColumnName}" not found)`
      } catch {
        return `comment posted (move failed)`
      }
    }

    // Default: just comment
    if (action !== "comment") {
      log.warn(`Unrecognized on_complete action: ${action}`)
    }
    return "comment posted"
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
