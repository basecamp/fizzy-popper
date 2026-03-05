import { describe, it, expect, vi, beforeEach } from "vitest"
import { Router, type RouteAction } from "../src/router.js"
import type { FizzyClient } from "../src/fizzy.js"
import { makeCard, makeGoldenTicketCard, makeBoard, makeColumn, makeConfig, makeWebhookEvent, makeGoldenTicket } from "./fixtures.js"

function makeMockClient(cards: ReturnType<typeof makeCard>[] = []): FizzyClient {
  return {
    listBoards: vi.fn().mockResolvedValue([makeBoard()]),
    getBoard: vi.fn().mockResolvedValue(makeBoard()),
    listCards: vi.fn().mockResolvedValue(cards),
    listColumns: vi.fn().mockResolvedValue([makeColumn()]),
    getCard: vi.fn(),
    listComments: vi.fn(),
    closeCard: vi.fn(),
    triageCard: vi.fn(),
    postComment: vi.fn(),
    toggleTag: vi.fn(),
    getIdentity: vi.fn(),
  } as unknown as FizzyClient
}

describe("Router", () => {
  describe("loadBoardConfigs", () => {
    it("loads golden tickets from watched boards", async () => {
      const goldenCard = makeGoldenTicketCard()
      const client = makeMockClient([goldenCard])
      const router = new Router(makeConfig(), client)

      await router.loadBoardConfigs(["board-1"])

      const configs = router.getBoardConfigs()
      expect(configs.size).toBe(1)

      const boardConfig = configs.get("board-1")!
      expect(boardConfig.goldenTickets.size).toBe(1)
      expect(boardConfig.goldenTickets.get("col-1")!.backend).toBe("claude")
    })

    it("ignores golden tickets without columns", async () => {
      const goldenCard = makeGoldenTicketCard({ column: undefined })
      const client = makeMockClient([goldenCard])
      const router = new Router(makeConfig(), client)

      await router.loadBoardConfigs(["board-1"])

      const configs = router.getBoardConfigs()
      expect(configs.get("board-1")!.goldenTickets.size).toBe(0)
    })

    it("ignores non-golden-ticket cards", async () => {
      const regularCard = makeCard({ tags: ["bug"] })
      const client = makeMockClient([regularCard])
      const router = new Router(makeConfig(), client)

      await router.loadBoardConfigs(["board-1"])

      const configs = router.getBoardConfigs()
      expect(configs.get("board-1")!.goldenTickets.size).toBe(0)
    })
  })

  describe("findGoldenTicket", () => {
    it("finds golden ticket for a card in an agent column", async () => {
      const goldenCard = makeGoldenTicketCard()
      const client = makeMockClient([goldenCard])
      const router = new Router(makeConfig(), client)

      await router.loadBoardConfigs(["board-1"])

      const card = makeCard({ column: makeColumn({ id: "col-1" }) })
      const ticket = router.findGoldenTicket(card)
      expect(ticket).not.toBeNull()
      expect(ticket!.backend).toBe("claude")
    })

    it("returns null for a card in a column without golden ticket", async () => {
      const goldenCard = makeGoldenTicketCard()
      const client = makeMockClient([goldenCard])
      const router = new Router(makeConfig(), client)

      await router.loadBoardConfigs(["board-1"])

      const card = makeCard({ column: makeColumn({ id: "col-other" }) })
      expect(router.findGoldenTicket(card)).toBeNull()
    })

    it("returns null for a card without a column", async () => {
      const goldenCard = makeGoldenTicketCard()
      const client = makeMockClient([goldenCard])
      const router = new Router(makeConfig(), client)

      await router.loadBoardConfigs(["board-1"])

      const card = makeCard({ column: undefined })
      expect(router.findGoldenTicket(card)).toBeNull()
    })

    it("returns null for unknown board", async () => {
      const client = makeMockClient([])
      const router = new Router(makeConfig(), client)

      const card = makeCard({ board: makeBoard({ id: "unknown-board" }) })
      expect(router.findGoldenTicket(card)).toBeNull()
    })
  })

  describe("routeEvent", () => {
    let router: Router

    beforeEach(async () => {
      const goldenCard = makeGoldenTicketCard()
      const client = makeMockClient([goldenCard])
      router = new Router(makeConfig(), client)
      await router.loadBoardConfigs(["board-1"])
    })

    describe("card_triaged", () => {
      it("spawns agent for a card in a column with golden ticket", () => {
        const event = makeWebhookEvent({
          action: "card_triaged",
          eventable: makeCard({ column: makeColumn({ id: "col-1" }) }),
        })
        const action = router.routeEvent(event, new Set())
        expect(action.type).toBe("spawn")
      })

      it("ignores golden ticket cards", () => {
        const event = makeWebhookEvent({
          action: "card_triaged",
          eventable: makeGoldenTicketCard(),
        })
        // Golden ticket cards trigger refresh since they have agent-instructions tag
        const action = router.routeEvent(event, new Set())
        expect(action.type).toBe("refresh_golden_tickets")
      })

      it("ignores cards already running", () => {
        const card = makeCard({ column: makeColumn({ id: "col-1" }) })
        const event = makeWebhookEvent({ action: "card_triaged", eventable: card })
        const action = router.routeEvent(event, new Set(["card-1"]))
        expect(action.type).toBe("ignore")
        expect((action as { reason: string }).reason).toBe("already running")
      })

      it("ignores cards in columns without golden tickets", () => {
        const card = makeCard({ column: makeColumn({ id: "col-no-golden" }) })
        const event = makeWebhookEvent({ action: "card_triaged", eventable: card })
        const action = router.routeEvent(event, new Set())
        expect(action.type).toBe("ignore")
        expect((action as { reason: string }).reason).toContain("no golden ticket")
      })
    })

    describe("card_published", () => {
      it("spawns agent for published card in agent column", () => {
        const card = makeCard({ column: makeColumn({ id: "col-1" }) })
        const event = makeWebhookEvent({ action: "card_published", eventable: card })
        const action = router.routeEvent(event, new Set())
        expect(action.type).toBe("spawn")
      })
    })

    describe("card_closed", () => {
      it("cancels running agent", () => {
        const card = makeCard()
        const event = makeWebhookEvent({ action: "card_closed", eventable: card })
        const action = router.routeEvent(event, new Set(["card-1"]))
        expect(action.type).toBe("cancel")
        expect((action as { cardId: string }).cardId).toBe("card-1")
      })

      it("ignores when no agent running", () => {
        const card = makeCard()
        const event = makeWebhookEvent({ action: "card_closed", eventable: card })
        const action = router.routeEvent(event, new Set())
        expect(action.type).toBe("ignore")
      })
    })

    describe("card_postponed", () => {
      it("cancels running agent", () => {
        const card = makeCard()
        const event = makeWebhookEvent({ action: "card_postponed", eventable: card })
        const action = router.routeEvent(event, new Set(["card-1"]))
        expect(action.type).toBe("cancel")
      })
    })

    describe("card_sent_back_to_triage", () => {
      it("cancels running agent", () => {
        const card = makeCard()
        const event = makeWebhookEvent({ action: "card_sent_back_to_triage", eventable: card })
        const action = router.routeEvent(event, new Set(["card-1"]))
        expect(action.type).toBe("cancel")
      })
    })

    describe("card_auto_postponed", () => {
      it("cancels running agent", () => {
        const card = makeCard()
        const event = makeWebhookEvent({ action: "card_auto_postponed" as any, eventable: card })
        const action = router.routeEvent(event, new Set(["card-1"]))
        expect(action.type).toBe("cancel")
      })

      it("ignores when no agent running", () => {
        const card = makeCard()
        const event = makeWebhookEvent({ action: "card_auto_postponed" as any, eventable: card })
        const action = router.routeEvent(event, new Set())
        expect(action.type).toBe("ignore")
      })
    })

    describe("card_reopened", () => {
      it("spawns agent for reopened card in agent column", () => {
        const card = makeCard({ column: makeColumn({ id: "col-1" }) })
        const event = makeWebhookEvent({ action: "card_reopened", eventable: card })
        const action = router.routeEvent(event, new Set())
        expect(action.type).toBe("spawn")
      })

      it("ignores golden ticket cards", () => {
        const event = makeWebhookEvent({
          action: "card_reopened",
          eventable: makeGoldenTicketCard(),
        })
        const action = router.routeEvent(event, new Set())
        expect(action.type).toBe("refresh_golden_tickets")
      })

      it("ignores already running cards", () => {
        const card = makeCard({ column: makeColumn({ id: "col-1" }) })
        const event = makeWebhookEvent({ action: "card_reopened", eventable: card })
        const action = router.routeEvent(event, new Set(["card-1"]))
        expect(action.type).toBe("ignore")
      })
    })

    describe("card_board_changed", () => {
      it("spawns when card arrives in watched board with agent column", () => {
        const card = makeCard({ column: makeColumn({ id: "col-1" }) })
        const event = makeWebhookEvent({ action: "card_board_changed", eventable: card })
        const action = router.routeEvent(event, new Set())
        expect(action.type).toBe("spawn")
      })

      it("refreshes when golden ticket changes boards", () => {
        const event = makeWebhookEvent({
          action: "card_board_changed",
          eventable: makeGoldenTicketCard(),
        })
        const action = router.routeEvent(event, new Set())
        expect(action.type).toBe("refresh_golden_tickets")
      })
    })

    describe("comment_created", () => {
      it("ignores when agent is running for card", () => {
        const comment = { card: { id: "card-1" } } as any
        const event = makeWebhookEvent({ action: "comment_created", eventable: comment })
        const action = router.routeEvent(event, new Set(["card-1"]))
        expect(action.type).toBe("ignore")
      })
    })

    describe("unknown action", () => {
      it("ignores unhandled actions", () => {
        const event = makeWebhookEvent({ action: "card_assigned" as any })
        const action = router.routeEvent(event, new Set())
        expect(action.type).toBe("ignore")
        expect((action as { reason: string }).reason).toContain("unhandled")
      })
    })
  })

  describe("routeCardsForReconciliation", () => {
    it("returns spawn actions for unworked cards in agent columns", async () => {
      const goldenCard = makeGoldenTicketCard()
      const workCard = makeCard({ id: "work-1", column: makeColumn({ id: "col-1" }) })
      const client = makeMockClient([goldenCard])
      const router = new Router(makeConfig(), client)
      await router.loadBoardConfigs(["board-1"])

      const actions = router.routeCardsForReconciliation([workCard], new Set())
      expect(actions).toHaveLength(1)
      expect(actions[0].type).toBe("spawn")
    })

    it("skips golden ticket cards", async () => {
      const goldenCard = makeGoldenTicketCard()
      const client = makeMockClient([goldenCard])
      const router = new Router(makeConfig(), client)
      await router.loadBoardConfigs(["board-1"])

      const actions = router.routeCardsForReconciliation([goldenCard], new Set())
      expect(actions).toHaveLength(0)
    })

    it("skips closed cards", async () => {
      const goldenCard = makeGoldenTicketCard()
      const closedCard = makeCard({ closed: true, column: makeColumn({ id: "col-1" }) })
      const client = makeMockClient([goldenCard])
      const router = new Router(makeConfig(), client)
      await router.loadBoardConfigs(["board-1"])

      const actions = router.routeCardsForReconciliation([closedCard], new Set())
      expect(actions).toHaveLength(0)
    })

    it("skips cards without columns", async () => {
      const goldenCard = makeGoldenTicketCard()
      const untriagedCard = makeCard({ column: undefined })
      const client = makeMockClient([goldenCard])
      const router = new Router(makeConfig(), client)
      await router.loadBoardConfigs(["board-1"])

      const actions = router.routeCardsForReconciliation([untriagedCard], new Set())
      expect(actions).toHaveLength(0)
    })

    it("skips already-running cards", async () => {
      const goldenCard = makeGoldenTicketCard()
      const workCard = makeCard({ id: "work-1", column: makeColumn({ id: "col-1" }) })
      const client = makeMockClient([goldenCard])
      const router = new Router(makeConfig(), client)
      await router.loadBoardConfigs(["board-1"])

      const actions = router.routeCardsForReconciliation([workCard], new Set(["work-1"]))
      expect(actions).toHaveLength(0)
    })

    it("skips cards in columns without golden tickets", async () => {
      const goldenCard = makeGoldenTicketCard()
      const workCard = makeCard({ column: makeColumn({ id: "col-no-golden" }) })
      const client = makeMockClient([goldenCard])
      const router = new Router(makeConfig(), client)
      await router.loadBoardConfigs(["board-1"])

      const actions = router.routeCardsForReconciliation([workCard], new Set())
      expect(actions).toHaveLength(0)
    })
  })
})
