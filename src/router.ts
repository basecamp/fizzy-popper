import type { Config } from "./config.js"
import type { FizzyCard, FizzyClient, FizzyWebhookEvent, GoldenTicket } from "./fizzy.js"
import { isGoldenTicket, parseGoldenTicket } from "./fizzy.js"

// ── Route decision ──

export type RouteAction =
  | { type: "spawn"; card: FizzyCard; goldenTicket: GoldenTicket }
  | { type: "cancel"; cardId: string; reason: string }
  | { type: "refresh_golden_tickets" }
  | { type: "ignore"; reason: string }

// ── Board configuration (golden tickets per column) ──

export interface BoardConfig {
  boardId: string
  boardName: string
  goldenTickets: Map<string, GoldenTicket> // column_id → golden ticket
}

// ── Router ──

export class Router {
  private boardConfigs: Map<string, BoardConfig> = new Map() // board_id → config
  private config: Config
  private client: FizzyClient

  constructor(config: Config, client: FizzyClient) {
    this.config = config
    this.client = client
  }

  getBoardConfigs(): Map<string, BoardConfig> {
    return this.boardConfigs
  }

  // ── Load golden tickets for all watched boards ──

  async loadBoardConfigs(boardIds?: string[]): Promise<void> {
    const boards = await this.client.listBoards()
    const watchedBoards = boardIds && boardIds.length > 0
      ? boards.filter(b => boardIds.includes(b.id))
      : boards

    for (const board of watchedBoards) {
      await this.loadBoardConfig(board.id, board.name)
    }
  }

  async loadBoardConfig(boardId: string, boardName?: string): Promise<BoardConfig> {
    const name = boardName ?? (await this.client.getBoard(boardId)).name
    const cards = await this.client.listCards({ board_ids: [boardId] })

    const goldenTickets = new Map<string, GoldenTicket>()
    for (const card of cards) {
      if (!isGoldenTicket(card)) continue
      if (!card.column) continue

      const ticket = parseGoldenTicket(card, this.config.agent.default_backend)
      if (ticket) {
        goldenTickets.set(card.column.id, ticket)
      }
    }

    const boardConfig: BoardConfig = { boardId, boardName: name, goldenTickets }
    this.boardConfigs.set(boardId, boardConfig)
    return boardConfig
  }

  // ── Find golden ticket for a card's column ──

  findGoldenTicket(card: FizzyCard): GoldenTicket | null {
    if (!card.column) return null

    const boardConfig = this.boardConfigs.get(card.board.id)
    if (!boardConfig) return null

    return boardConfig.goldenTickets.get(card.column.id) ?? null
  }

  // ── Route a webhook event ──

  routeEvent(event: FizzyWebhookEvent, activeCardIds: Set<string>): RouteAction {
    const { action, eventable, board } = event

    // If the event is for a golden ticket card itself, refresh
    if ("tags" in eventable && isGoldenTicket(eventable as FizzyCard)) {
      return { type: "refresh_golden_tickets" }
    }

    switch (action) {
      case "card_triaged":
      case "card_published": {
        const card = eventable as FizzyCard
        if (activeCardIds.has(card.id)) return { type: "ignore", reason: "already running" }

        const goldenTicket = this.findGoldenTicket(card)
        if (!goldenTicket) return { type: "ignore", reason: "column has no golden ticket" }

        return { type: "spawn", card, goldenTicket }
      }

      case "comment_created": {
        const comment = eventable as { card?: { id: string } }
        if (comment.card?.id && activeCardIds.has(comment.card.id)) {
          return { type: "ignore", reason: "agent already running for this card" }
        }
        return { type: "ignore", reason: "comment re-trigger handled by reconciler" }
      }

      case "card_closed":
      case "card_postponed":
      case "card_auto_postponed":
      case "card_sent_back_to_triage": {
        const card = eventable as FizzyCard
        if (activeCardIds.has(card.id)) {
          return { type: "cancel", cardId: card.id, reason: action }
        }
        return { type: "ignore", reason: "no active agent for card" }
      }

      case "card_reopened": {
        const card = eventable as FizzyCard
        if (activeCardIds.has(card.id)) return { type: "ignore", reason: "already running" }

        const goldenTicket = this.findGoldenTicket(card)
        if (!goldenTicket) return { type: "ignore", reason: "column has no golden ticket" }

        return { type: "spawn", card, goldenTicket }
      }

      case "card_board_changed": {
        const card = eventable as FizzyCard
        if (isGoldenTicket(card)) return { type: "refresh_golden_tickets" }

        // If card moved away from a watched board, cancel
        const boardConfig = this.boardConfigs.get(board.id)
        if (!boardConfig && activeCardIds.has(card.id)) {
          return { type: "cancel", cardId: card.id, reason: "card moved to unwatched board" }
        }

        // If card arrived in a watched board column with golden ticket, spawn
        if (boardConfig && card.column) {
          const goldenTicket = boardConfig.goldenTickets.get(card.column.id)
          if (goldenTicket && !activeCardIds.has(card.id)) {
            return { type: "spawn", card, goldenTicket }
          }
        }

        return { type: "ignore", reason: "board change not actionable" }
      }

      default:
        return { type: "ignore", reason: `unhandled action: ${action}` }
    }
  }

  // ── Route cards found during reconciliation ──

  routeCardsForReconciliation(
    cards: FizzyCard[],
    activeCardIds: Set<string>,
  ): RouteAction[] {
    const actions: RouteAction[] = []

    for (const card of cards) {
      if (isGoldenTicket(card)) continue
      if (card.closed) continue
      if (!card.column) continue
      if (activeCardIds.has(card.id)) continue

      const goldenTicket = this.findGoldenTicket(card)
      if (goldenTicket) {
        actions.push({ type: "spawn", card, goldenTicket })
      }
    }

    return actions
  }
}
