import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { Reconciler } from "../src/reconciler.js"
import type { FizzyClient } from "../src/fizzy.js"
import type { Router } from "../src/router.js"
import type { Supervisor } from "../src/supervisor.js"
import { makeCard, makeGoldenTicketCard, makeColumn, makeConfig, makeGoldenTicket } from "./fixtures.js"

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

function makeMockClient(cards: ReturnType<typeof makeCard>[] = []): FizzyClient {
  return {
    listBoards: vi.fn(),
    getBoard: vi.fn(),
    listCards: vi.fn().mockResolvedValue(cards),
    listColumns: vi.fn(),
    getCard: vi.fn(),
    listComments: vi.fn(),
    closeCard: vi.fn(),
    triageCard: vi.fn(),
    postComment: vi.fn(),
    toggleTag: vi.fn(),
    getIdentity: vi.fn(),
  } as unknown as FizzyClient
}

function makeMockRouter(): Router {
  return {
    loadBoardConfigs: vi.fn().mockResolvedValue(undefined),
    findGoldenTicket: vi.fn().mockReturnValue(null),
    routeCardsForReconciliation: vi.fn().mockReturnValue([]),
    getBoardConfigs: vi.fn().mockReturnValue(new Map()),
    routeEvent: vi.fn(),
    loadBoardConfig: vi.fn(),
  } as unknown as Router
}

function makeMockSupervisor(): Supervisor {
  return {
    activeCardIds: vi.fn().mockReturnValue(new Set()),
    spawn: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    cancelOrphans: vi.fn(),
    isRunning: vi.fn().mockReturnValue(false),
    activeCount: vi.fn().mockReturnValue(0),
    atCapacity: vi.fn().mockReturnValue(false),
    getActiveRuns: vi.fn().mockReturnValue([]),
    getRecentRuns: vi.fn().mockReturnValue([]),
  } as unknown as Supervisor
}

describe("Reconciler", () => {
  let reconciler: Reconciler
  let client: FizzyClient
  let router: ReturnType<typeof makeMockRouter>
  let supervisor: ReturnType<typeof makeMockSupervisor>

  beforeEach(() => {
    vi.useFakeTimers()
    client = makeMockClient()
    router = makeMockRouter()
    supervisor = makeMockSupervisor()
  })

  afterEach(() => {
    reconciler?.stop()
    vi.useRealTimers()
  })

  it("runs a tick immediately on start", async () => {
    reconciler = new Reconciler(makeConfig(), client, router as Router, supervisor as Supervisor, ["board-1"])

    reconciler.start()

    // loadBoardConfigs called immediately
    expect(router.loadBoardConfigs).toHaveBeenCalledWith(["board-1"])
  })

  it("passes undefined when boardIds is empty", async () => {
    reconciler = new Reconciler(makeConfig(), client, router as Router, supervisor as Supervisor, [])

    reconciler.start()

    expect(router.loadBoardConfigs).toHaveBeenCalledWith(undefined)
  })

  it("runs ticks on interval", async () => {
    const config = makeConfig({ polling: { interval: 5000 } })
    reconciler = new Reconciler(config, client, router as Router, supervisor as Supervisor, ["board-1"])

    reconciler.start()
    expect(router.loadBoardConfigs).toHaveBeenCalledTimes(1)

    // Wait for next tick + flush promises
    await vi.advanceTimersByTimeAsync(5000)
    expect(router.loadBoardConfigs).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(5000)
    expect(router.loadBoardConfigs).toHaveBeenCalledTimes(3)
  })

  it("stops the interval", async () => {
    reconciler = new Reconciler(makeConfig({ polling: { interval: 1000 } }), client, router as Router, supervisor as Supervisor, [])

    reconciler.start()
    expect(router.loadBoardConfigs).toHaveBeenCalledTimes(1)

    reconciler.stop()

    await vi.advanceTimersByTimeAsync(5000)
    // Should not have been called again after stop
    expect(router.loadBoardConfigs).toHaveBeenCalledTimes(1)
  })

  it("cancels orphaned agents", async () => {
    const goldenCard = makeGoldenTicketCard()
    const workCard = makeCard({ id: "work-1", column: makeColumn({ id: "col-1" }) })
    client = makeMockClient([goldenCard, workCard])

    // Setup router to return golden ticket for col-1
    ;(router.findGoldenTicket as ReturnType<typeof vi.fn>).mockImplementation((card: any) => {
      if (card.column?.id === "col-1" && !card.tags?.includes("agent-instructions")) {
        return makeGoldenTicket()
      }
      return null
    })

    reconciler = new Reconciler(makeConfig(), client, router as Router, supervisor as Supervisor, ["board-1"])
    reconciler.start()

    // Allow async tick to complete
    await vi.advanceTimersByTimeAsync(0)

    expect(supervisor.cancelOrphans).toHaveBeenCalled()
  })

  it("spawns agents for unworked cards found during reconciliation", async () => {
    const goldenCard = makeGoldenTicketCard()
    const workCard = makeCard({ id: "work-1", column: makeColumn({ id: "col-1" }) })
    client = makeMockClient([goldenCard, workCard])

    const ticket = makeGoldenTicket()
    ;(router.routeCardsForReconciliation as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "spawn", card: workCard, goldenTicket: ticket },
    ])

    reconciler = new Reconciler(makeConfig(), client, router as Router, supervisor as Supervisor, ["board-1"])
    reconciler.start()

    await vi.advanceTimersByTimeAsync(0)

    expect(supervisor.spawn).toHaveBeenCalledWith(workCard, ticket)
  })

  it("does not spawn when at capacity", async () => {
    ;(supervisor.atCapacity as ReturnType<typeof vi.fn>).mockReturnValue(true)
    ;(router.routeCardsForReconciliation as ReturnType<typeof vi.fn>).mockReturnValue([
      { type: "spawn", card: makeCard(), goldenTicket: makeGoldenTicket() },
    ])

    reconciler = new Reconciler(makeConfig(), client, router as Router, supervisor as Supervisor, [])
    reconciler.start()

    await vi.advanceTimersByTimeAsync(0)

    expect(supervisor.spawn).not.toHaveBeenCalled()
  })

  it("guards against concurrent ticks", async () => {
    // Make loadBoardConfigs take a while
    let resolveLoad!: () => void
    ;(router.loadBoardConfigs as ReturnType<typeof vi.fn>).mockImplementation(() => {
      return new Promise<void>(r => { resolveLoad = r })
    })

    reconciler = new Reconciler(makeConfig({ polling: { interval: 1000 } }), client, router as Router, supervisor as Supervisor, [])
    reconciler.start()

    // First tick is in progress
    expect(router.loadBoardConfigs).toHaveBeenCalledTimes(1)

    // Trigger another tick while first is still running
    await vi.advanceTimersByTimeAsync(1000)

    // Second tick should be skipped because first is still running
    expect(router.loadBoardConfigs).toHaveBeenCalledTimes(1)

    // Let first tick complete
    resolveLoad()
    await vi.advanceTimersByTimeAsync(0)

    // Now a new tick should be able to run
    ;(router.loadBoardConfigs as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(1000)
    expect(router.loadBoardConfigs).toHaveBeenCalledTimes(2)
  })

  it("handles errors gracefully without crashing", async () => {
    ;(router.loadBoardConfigs as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("API down"))

    reconciler = new Reconciler(makeConfig({ polling: { interval: 1000 } }), client, router as Router, supervisor as Supervisor, [])
    reconciler.start()

    // Should not throw
    await vi.advanceTimersByTimeAsync(0)

    // And should keep running — next tick works
    ;(router.loadBoardConfigs as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(1000)

    expect(router.loadBoardConfigs).toHaveBeenCalledTimes(2)
  })

  it("passes board_ids to listCards", async () => {
    reconciler = new Reconciler(makeConfig(), client, router as Router, supervisor as Supervisor, ["b1", "b2"])
    reconciler.start()

    await vi.advanceTimersByTimeAsync(0)

    expect(client.listCards).toHaveBeenCalledWith({ board_ids: ["b1", "b2"] })
  })

  it("calls listCards without board_ids when empty", async () => {
    reconciler = new Reconciler(makeConfig(), client, router as Router, supervisor as Supervisor, [])
    reconciler.start()

    await vi.advanceTimersByTimeAsync(0)

    expect(client.listCards).toHaveBeenCalledWith(undefined)
  })
})
