import { writeFileSync, rmSync, mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { execa } from "execa"
import Anthropic from "@anthropic-ai/sdk"
import OpenAI from "openai"
import type { Config } from "./config.js"
import type { FizzyCard, FizzyComment, FizzyStep, GoldenTicket } from "./fizzy.js"

// ── Backend interface ──

export interface AgentResult {
  output: string
  success: boolean
  error?: string
  metadata?: {
    tokens?: number
    duration_ms?: number
  }
}

export interface BackendOptions {
  model?: string
  timeout: number
  signal: AbortSignal
}

export interface AgentBackend {
  name: string
  execute(prompt: string, options: BackendOptions): Promise<AgentResult>
}

// ── Prompt builder ──

export function buildPrompt(
  goldenTicket: GoldenTicket,
  card: FizzyCard,
  comments: FizzyComment[],
): string {
  const parts: string[] = []

  // System context
  parts.push(`You are an AI agent working a card on a Fizzy board.`)
  parts.push(`Your output will be posted as a comment on the card. Format your response as HTML suitable for a Fizzy comment (use <p>, <strong>, <em>, <ul>/<li>, <ol>/<li>, <h3>, <pre><code>, <blockquote> tags).`)
  parts.push("")

  // Golden ticket instructions
  parts.push(`## Instructions`)
  parts.push("")
  parts.push(goldenTicket.description)
  parts.push("")

  // Golden ticket checklist — presented as tasks to follow
  if (goldenTicket.steps.length > 0) {
    parts.push(`## Steps to Follow`)
    parts.push("")
    parts.push(`Complete each of these steps in order. Address every unchecked item in your response:`)
    parts.push("")
    for (const step of goldenTicket.steps) {
      const check = step.completed ? "[x]" : "[ ]"
      parts.push(`- ${check} ${step.content}`)
    }
    parts.push("")
  }

  // Card content
  parts.push(`## Card #${card.number}: ${card.title}`)
  parts.push("")
  if (card.description) {
    parts.push(card.description)
    parts.push("")
  }

  if (card.tags.length > 0) {
    parts.push(`**Tags:** ${card.tags.map(t => `#${t}`).join(", ")}`)
    parts.push("")
  }

  if (card.assignees && card.assignees.length > 0) {
    parts.push(`**Assigned to:** ${card.assignees.map(u => u.name).join(", ")}`)
    parts.push("")
  }

  // Card steps
  if (card.steps && card.steps.length > 0) {
    parts.push(`### Card Checklist`)
    parts.push("")
    for (const step of card.steps) {
      const check = step.completed ? "[x]" : "[ ]"
      parts.push(`- ${check} ${step.content}`)
    }
    parts.push("")
  }

  // Comment thread
  if (comments.length > 0) {
    parts.push(`## Discussion Thread`)
    parts.push("")
    for (const comment of comments) {
      parts.push(`**${comment.creator.name}** (${new Date(comment.created_at).toLocaleString()}):`)
      parts.push(comment.body.plain_text)
      parts.push("")
    }
  }

  return parts.join("\n")
}

// ── Backend implementations ──

// Claude Code CLI
class ClaudeBackend implements AgentBackend {
  name = "claude"
  private model: string

  constructor(config: Config) {
    this.model = config.backends?.claude?.model ?? "sonnet"
  }

  async execute(prompt: string, options: BackendOptions): Promise<AgentResult> {
    const start = Date.now()
    const model = options.model ?? this.model
    try {
      const result = await execa("claude", ["--print", "--model", model], {
        input: prompt,
        timeout: options.timeout,
        cancelSignal: options.signal,
      })
      return {
        output: result.stdout,
        success: true,
        metadata: { duration_ms: Date.now() - start },
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: "", success: false, error: message }
    }
  }
}

// OpenAI Codex CLI
class CodexBackend implements AgentBackend {
  name = "codex"
  private model: string

  constructor(config: Config) {
    this.model = config.backends?.codex?.model ?? "codex-mini"
  }

  async execute(prompt: string, options: BackendOptions): Promise<AgentResult> {
    const start = Date.now()
    const model = options.model ?? this.model
    try {
      const result = await execa(
        "codex",
        ["exec", "--model", model, "--json", "--ephemeral", prompt],
        { timeout: options.timeout, cancelSignal: options.signal },
      )
      let output = result.stdout
      try {
        const parsed = JSON.parse(output)
        output = parsed.output ?? parsed.result ?? output
      } catch { /* not JSON, use raw stdout */ }
      return {
        output,
        success: true,
        metadata: { duration_ms: Date.now() - start },
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: "", success: false, error: message }
    }
  }
}

// OpenCode CLI
class OpenCodeBackend implements AgentBackend {
  name = "opencode"

  async execute(prompt: string, options: BackendOptions): Promise<AgentResult> {
    const start = Date.now()
    try {
      // OpenCode CLI does not support a --model flag
      const result = await execa(
        "opencode",
        ["-p", prompt, "-f", "json", "-q"],
        { timeout: options.timeout, cancelSignal: options.signal },
      )
      let output = result.stdout
      try {
        const parsed = JSON.parse(output)
        output = parsed.output ?? parsed.result ?? output
      } catch { /* not JSON, use raw stdout */ }
      return {
        output,
        success: true,
        metadata: { duration_ms: Date.now() - start },
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: "", success: false, error: message }
    }
  }
}

// Anthropic API (direct)
class AnthropicBackend implements AgentBackend {
  name = "anthropic"
  private client: Anthropic
  private model: string

  constructor(config: Config) {
    const apiKey = config.backends?.anthropic?.api_key ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) throw new Error("Anthropic API key required (set ANTHROPIC_API_KEY or backends.anthropic.api_key)")
    this.client = new Anthropic({ apiKey })
    this.model = config.backends?.anthropic?.model ?? "claude-sonnet-4-20250514"
  }

  async execute(prompt: string, options: BackendOptions): Promise<AgentResult> {
    const start = Date.now()
    const model = options.model ?? this.model
    try {
      const message = await this.client.messages.create({
        model,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }, { signal: options.signal })
      const output = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map(block => block.text)
        .join("\n")
      return {
        output,
        success: true,
        metadata: {
          tokens: (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0),
          duration_ms: Date.now() - start,
        },
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: "", success: false, error: message }
    }
  }
}

// OpenAI API (direct)
class OpenAIBackend implements AgentBackend {
  name = "openai"
  private client: OpenAI
  private model: string

  constructor(config: Config) {
    const apiKey = config.backends?.openai?.api_key ?? process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("OpenAI API key required (set OPENAI_API_KEY or backends.openai.api_key)")
    this.client = new OpenAI({ apiKey })
    this.model = config.backends?.openai?.model ?? "gpt-4o"
  }

  async execute(prompt: string, options: BackendOptions): Promise<AgentResult> {
    const start = Date.now()
    const model = options.model ?? this.model
    try {
      const completion = await this.client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 4096,
      }, { signal: options.signal })
      const output = completion.choices[0]?.message?.content ?? ""
      return {
        output,
        success: true,
        metadata: {
          tokens: (completion.usage?.prompt_tokens ?? 0) + (completion.usage?.completion_tokens ?? 0),
          duration_ms: Date.now() - start,
        },
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: "", success: false, error: message }
    }
  }
}

// Custom command backend
class CommandBackend implements AgentBackend {
  name = "command"
  private command: string

  constructor(config: Config) {
    const run = config.backends?.command?.run
    if (!run) throw new Error("Command backend requires backends.command.run in config")
    this.command = run
  }

  async execute(prompt: string, options: BackendOptions): Promise<AgentResult> {
    const start = Date.now()
    const tempDir = mkdtempSync(join(tmpdir(), "fizzy-popper-"))
    const promptFile = join(tempDir, "prompt.md")
    writeFileSync(promptFile, prompt, "utf-8")

    const escaped = promptFile.replace(/'/g, "'\\''")
    const cmd = this.command.replace(/\{prompt_file\}/g, `'${escaped}'`)

    try {
      const result = await execa("bash", ["-c", cmd], {
        timeout: options.timeout,
        cancelSignal: options.signal,
      })
      return {
        output: result.stdout,
        success: true,
        metadata: { duration_ms: Date.now() - start },
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { output: "", success: false, error: message }
    } finally {
      try { rmSync(tempDir, { recursive: true }) } catch { /* ignore */ }
    }
  }
}

// ── Backend factory ──

export function createBackend(name: string, config: Config): AgentBackend {
  switch (name) {
    case "claude": return new ClaudeBackend(config)
    case "codex": return new CodexBackend(config)
    case "opencode": return new OpenCodeBackend()
    case "anthropic": return new AnthropicBackend(config)
    case "openai": return new OpenAIBackend(config)
    case "command": return new CommandBackend(config)
    default: throw new Error(`Unknown backend: ${name}`)
  }
}

// ── Backend auto-detection ──

export async function detectBackends(): Promise<string[]> {
  const detected: string[] = []
  const checks: Array<{ name: string; cmd: string; args: string[] }> = [
    { name: "claude", cmd: "claude", args: ["--version"] },
    { name: "codex", cmd: "codex", args: ["--version"] },
    { name: "opencode", cmd: "opencode", args: ["--version"] },
  ]

  for (const check of checks) {
    try {
      await execa(check.cmd, check.args, { timeout: 5000 })
      detected.push(check.name)
    } catch { /* not installed */ }
  }

  if (process.env.ANTHROPIC_API_KEY) detected.push("anthropic")
  if (process.env.OPENAI_API_KEY) detected.push("openai")

  return detected
}
