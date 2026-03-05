import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { z } from "zod"

const CONFIG_DIR = ".fizzy-popper"
const CONFIG_FILE = "config.yml"

const BackendConfigSchema = z.object({
  claude: z.object({
    model: z.string().default("sonnet"),
  }).optional(),
  codex: z.object({
    model: z.string().default("codex-mini"),
  }).optional(),
  opencode: z.object({}).optional(),
  anthropic: z.object({
    api_key: z.string().optional(),
    model: z.string().default("claude-sonnet-4-20250514"),
  }).optional(),
  openai: z.object({
    api_key: z.string().optional(),
    model: z.string().default("gpt-4o"),
  }).optional(),
  command: z.object({
    run: z.string(),
  }).optional(),
}).default({})

const ConfigSchema = z.object({
  fizzy: z.object({
    token: z.string(),
    account: z.string(),
    api_url: z.string().default("https://app.fizzy.do"),
  }),
  boards: z.union([z.array(z.string()), z.literal("all")]).default("all"),
  webhook: z.object({
    port: z.number().default(4567),
    secret: z.string().optional(),
  }).default({}),
  agent: z.object({
    max_concurrent: z.number().default(5),
    timeout: z.number().default(300_000),
    default_backend: z.string().default("claude"),
  }).default({}),
  backends: BackendConfigSchema,
  polling: z.object({
    interval: z.number().default(30_000),
  }).default({}),
})

export type Config = z.infer<typeof ConfigSchema>

export function configDir(cwd: string = process.cwd()): string {
  return join(cwd, CONFIG_DIR)
}

export function configPath(cwd: string = process.cwd()): string {
  return join(configDir(cwd), CONFIG_FILE)
}

export function configExists(cwd: string = process.cwd()): boolean {
  return existsSync(configPath(cwd))
}

export function loadConfig(cwd: string = process.cwd()): Config {
  const path = configPath(cwd)

  if (!existsSync(path)) {
    throw new Error(`Config not found at ${path}. Run \`fizzy-popper setup\` to create one.`)
  }

  const raw = readFileSync(path, "utf-8")
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Failed to parse ${path}: ${message}`)
  }

  // Resolve env vars
  const resolved = resolveEnvVars(parsed)

  return ConfigSchema.parse(resolved)
}

export function saveConfig(config: Record<string, unknown>, cwd: string = process.cwd()): string {
  const dir = configDir(cwd)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const path = configPath(cwd)
  writeFileSync(path, stringifyYaml(config), "utf-8")
  return path
}

function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string" && obj.startsWith("$")) {
    const envKey = obj.slice(1)
    return process.env[envKey] ?? obj
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars)
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = resolveEnvVars(value)
    }
    return result
  }
  return obj
}
