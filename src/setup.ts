import * as p from "@clack/prompts"
import chalk from "chalk"
import { saveConfig } from "./config.js"
import { FizzyClient, type FizzyBoard } from "./fizzy.js"
import { detectBackends } from "./agent.js"

export async function runSetup(): Promise<void> {
  p.intro(chalk.bold("fizzy-popper") + " — AI agents for your Fizzy boards")

  // API token
  const token = await p.text({
    message: "Fizzy API token (profile → API → Personal access tokens)",
    placeholder: "fz_...",
    validate(value) {
      if (!value) return "Token is required"
    },
  })
  if (p.isCancel(token)) return cancel()

  // Validate token and get accounts
  const tempClient = new FizzyClient({
    fizzy: { token: token as string, account: "", api_url: "https://app.fizzy.do" },
  } as any)

  let identity: Awaited<ReturnType<typeof tempClient.getIdentity>>
  try {
    identity = await tempClient.getIdentity()
  } catch (err) {
    p.cancel("Failed to authenticate. Check your API token.")
    process.exit(1)
  }

  if (identity.accounts.length === 0) {
    p.cancel("No accounts found for this token.")
    process.exit(1)
  }

  // Account selection
  let accountSlug: string
  if (identity.accounts.length === 1) {
    accountSlug = identity.accounts[0].slug.replace(/^\//, "")
    p.log.info(`Account: ${identity.accounts[0].name} (${accountSlug})`)
  } else {
    const selected = await p.select({
      message: "Which account?",
      options: identity.accounts.map(a => ({
        value: a.slug.replace(/^\//, ""),
        label: a.name,
        hint: a.slug,
      })),
    })
    if (p.isCancel(selected)) return cancel()
    accountSlug = selected as string
  }

  // Fetch boards
  const client = new FizzyClient({
    fizzy: { token: token as string, account: accountSlug, api_url: "https://app.fizzy.do" },
  } as any)

  let boards: FizzyBoard[]
  try {
    boards = await client.listBoards()
  } catch (err) {
    p.cancel("Failed to fetch boards. Check your permissions.")
    process.exit(1)
  }

  if (boards.length === 0) {
    p.cancel("No boards found.")
    process.exit(1)
  }

  // Board selection
  const selectedBoards = await p.multiselect({
    message: "Which boards to watch?",
    options: boards.map(b => ({ value: b.id, label: b.name })),
    required: true,
  })
  if (p.isCancel(selectedBoards)) return cancel()

  // Backend detection and selection
  const s = p.spinner()
  s.start("Detecting installed agent backends...")
  const detected = await detectBackends()
  s.stop(
    detected.length > 0
      ? `Detected: ${detected.join(", ")}`
      : "No CLI backends detected (you can use API backends)",
  )

  const backendOptions: Array<{ value: string; label: string; hint?: string }> = []
  if (detected.includes("claude")) backendOptions.push({ value: "claude", label: "Claude Code CLI" })
  if (detected.includes("codex")) backendOptions.push({ value: "codex", label: "OpenAI Codex CLI" })
  if (detected.includes("opencode")) backendOptions.push({ value: "opencode", label: "OpenCode CLI" })
  backendOptions.push({ value: "anthropic", label: "Anthropic API (direct)", hint: "requires ANTHROPIC_API_KEY" })
  backendOptions.push({ value: "openai", label: "OpenAI API (direct)", hint: "requires OPENAI_API_KEY" })
  backendOptions.push({ value: "command", label: "Custom command" })

  const defaultBackend = await p.select({
    message: "Default agent backend",
    options: backendOptions,
  })
  if (p.isCancel(defaultBackend)) return cancel()

  // Build config
  const config: Record<string, unknown> = {
    fizzy: {
      token: token as string,
      account: accountSlug,
      api_url: "https://app.fizzy.do",
    },
    boards: selectedBoards as string[],
    agent: {
      max_concurrent: 5,
      timeout: 300000,
      default_backend: defaultBackend as string,
    },
    polling: {
      interval: 30000,
    },
    webhook: {
      port: 4567,
    },
  }

  // Save
  const path = saveConfig(config)
  p.log.success(`Config saved to ${chalk.dim(path)}`)

  p.note(
    [
      `1. Add a card tagged ${chalk.cyan("#agent-instructions")} to any column you want agents to work`,
      `2. Write instructions in the card description, add a checklist as steps`,
      `3. Tag it ${chalk.cyan("#claude")}, ${chalk.cyan("#codex")}, etc. to pick the backend (or use your default)`,
    ].join("\n"),
    "Next steps",
  )

  p.outro(`Run ${chalk.cyan("fizzy-popper start")} to begin watching.`)
}

function cancel(): void {
  p.cancel("Setup cancelled.")
  process.exit(0)
}
