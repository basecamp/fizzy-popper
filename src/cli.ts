#!/usr/bin/env node

import { Command } from "commander"
import { loadConfig, configExists } from "./config.js"
import { FizzyClient } from "./fizzy.js"
import { Router } from "./router.js"
import { Supervisor } from "./supervisor.js"
import { Reconciler } from "./reconciler.js"
import { WebhookServer } from "./server.js"
import { runSetup } from "./setup.js"
import * as log from "./log.js"

const program = new Command()

program
  .name("fizzy-popper")
  .description("AI agents for your Fizzy boards")
  .version("0.1.0")

// Default action: setup if no config, else start
program
  .action(async () => {
    if (!configExists()) {
      await runSetup()
    } else {
      await start()
    }
  })

program
  .command("start")
  .description("Watch boards and dispatch agents")
  .action(start)

program
  .command("setup")
  .description("Interactive setup wizard")
  .action(runSetup)

program
  .command("status")
  .description("Show active agents")
  .action(async () => {
    const config = loadConfig()
    const client = new FizzyClient(config)
    const router = new Router(config, client)
    const supervisor = new Supervisor(config, client)

    const boardIds = config.boards === "all" ? [] : config.boards

    await router.loadBoardConfigs(boardIds.length > 0 ? boardIds : undefined)

    const boardConfigs = router.getBoardConfigs()
    if (boardConfigs.size === 0) {
      log.info("No boards configured.")
      return
    }

    for (const [, bc] of boardConfigs) {
      log.board(bc.boardName, `${bc.goldenTickets.size} agent column(s)`)
      for (const [, ticket] of bc.goldenTickets) {
        log.column(ticket.column_name, ticket.backend)
      }
    }

    const active = supervisor.getActiveRuns()
    if (active.length === 0) {
      log.info("No agents currently running.")
    } else {
      log.header("Active Agents")
      for (const run of active) {
        log.agentSpawn(run.card_number, run.card_title, run.column_name)
        log.agentStep(`${run.backend_name} — running for ${((Date.now() - run.started_at.getTime()) / 1000).toFixed(0)}s`)
      }
    }
  })

program
  .command("boards")
  .description("List boards and columns")
  .action(async () => {
    const config = loadConfig()
    const client = new FizzyClient(config)

    const boards = await client.listBoards()
    for (const board of boards) {
      log.board(board.name, board.url)
      const columns = await client.listColumns(board.id)
      for (const col of columns) {
        log.dim(`  ${col.name}`)
      }
    }
  })

// ── Start command implementation ──

async function start(): Promise<void> {
  const config = loadConfig()
  const client = new FizzyClient(config)
  const router = new Router(config, client)
  const supervisor = new Supervisor(config, client)

  const boardIds = config.boards === "all" ? [] : config.boards

  // Load initial board configs
  log.header(`fizzy-popper watching boards (polling ${config.polling.interval / 1000}s, webhooks :${config.webhook.port})`)

  await router.loadBoardConfigs(boardIds.length > 0 ? boardIds : undefined)

  // Display board summary
  const boardConfigs = router.getBoardConfigs()
  for (const [, bc] of boardConfigs) {
    log.board(bc.boardName, bc.goldenTickets.size === 0 ? "no golden tickets found" : "")
    for (const [, ticket] of bc.goldenTickets) {
      log.column(ticket.column_name, ticket.backend)
    }
  }

  // Start reconciler (polling)
  const reconciler = new Reconciler(config, client, router, supervisor, boardIds)
  reconciler.start()

  // Start webhook server
  const server = new WebhookServer(config, router, supervisor)
  server.start()

  // Graceful shutdown
  const shutdown = () => {
    log.info("Shutting down...")
    reconciler.stop()
    server.stop()

    // Cancel all active agents
    for (const cardId of supervisor.activeCardIds()) {
      supervisor.cancel(cardId, "service shutdown")
    }

    process.exit(0)
  }

  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

program.parse()
