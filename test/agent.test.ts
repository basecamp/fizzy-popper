import { describe, it, expect, vi } from "vitest"
import { buildPrompt, createBackend } from "../src/agent.js"
import { makeCard, makeComment, makeGoldenTicket, makeConfig } from "./fixtures.js"

describe("buildPrompt", () => {
  it("includes system context", () => {
    const prompt = buildPrompt(makeGoldenTicket(), makeCard(), [])
    expect(prompt).toContain("You are an AI agent working a card on a Fizzy board")
    expect(prompt).toContain("HTML")
  })

  it("includes golden ticket instructions", () => {
    const ticket = makeGoldenTicket({ description: "Analyze this code carefully" })
    const prompt = buildPrompt(ticket, makeCard(), [])
    expect(prompt).toContain("## Instructions")
    expect(prompt).toContain("Analyze this code carefully")
  })

  it("includes golden ticket checklist", () => {
    const ticket = makeGoldenTicket({
      steps: [
        { id: "s1", content: "Check security", completed: false },
        { id: "s2", content: "Review tests", completed: true },
      ],
    })
    const prompt = buildPrompt(ticket, makeCard(), [])
    expect(prompt).toContain("## Steps to Follow")
    expect(prompt).toContain("Complete each of these steps in order")
    expect(prompt).toContain("- [ ] Check security")
    expect(prompt).toContain("- [x] Review tests")
  })

  it("omits checklist section when no steps", () => {
    const ticket = makeGoldenTicket({ steps: [] })
    const prompt = buildPrompt(ticket, makeCard(), [])
    expect(prompt).not.toContain("## Steps to Follow")
  })

  it("includes card title and number", () => {
    const card = makeCard({ number: 42, title: "Fix login bug" })
    const prompt = buildPrompt(makeGoldenTicket(), card, [])
    expect(prompt).toContain("## Card #42: Fix login bug")
  })

  it("includes card description", () => {
    const card = makeCard({ description: "The login button does not work" })
    const prompt = buildPrompt(makeGoldenTicket(), card, [])
    expect(prompt).toContain("The login button does not work")
  })

  it("includes card tags", () => {
    const card = makeCard({ tags: ["bug", "urgent"] })
    const prompt = buildPrompt(makeGoldenTicket(), card, [])
    expect(prompt).toContain("**Tags:** #bug, #urgent")
  })

  it("omits tags section when card has no tags", () => {
    const card = makeCard({ tags: [] })
    const prompt = buildPrompt(makeGoldenTicket(), card, [])
    expect(prompt).not.toContain("**Tags:**")
  })

  it("includes assignees", () => {
    const card = makeCard({
      assignees: [
        { id: "u1", name: "Alice", role: "member", active: true, email_address: null, created_at: "", url: "" },
        { id: "u2", name: "Bob", role: "member", active: true, email_address: null, created_at: "", url: "" },
      ],
    })
    const prompt = buildPrompt(makeGoldenTicket(), card, [])
    expect(prompt).toContain("**Assigned to:** Alice, Bob")
  })

  it("includes card steps/checklist", () => {
    const card = makeCard({
      steps: [
        { id: "cs1", content: "Step A", completed: false },
        { id: "cs2", content: "Step B", completed: true },
      ],
    })
    const prompt = buildPrompt(makeGoldenTicket(), card, [])
    expect(prompt).toContain("### Card Checklist")
    expect(prompt).toContain("- [ ] Step A")
    expect(prompt).toContain("- [x] Step B")
  })

  it("includes comment thread", () => {
    const comments = [
      makeComment({ creator: { id: "u1", name: "Alice", role: "member", active: true, email_address: null, created_at: "", url: "" }, body: { plain_text: "I tried this approach", html: "" } }),
      makeComment({ creator: { id: "u2", name: "Bob", role: "member", active: true, email_address: null, created_at: "", url: "" }, body: { plain_text: "Looks good to me", html: "" } }),
    ]
    const prompt = buildPrompt(makeGoldenTicket(), makeCard(), comments)
    expect(prompt).toContain("## Discussion Thread")
    expect(prompt).toContain("**Alice**")
    expect(prompt).toContain("I tried this approach")
    expect(prompt).toContain("**Bob**")
    expect(prompt).toContain("Looks good to me")
  })

  it("omits discussion section when no comments", () => {
    const prompt = buildPrompt(makeGoldenTicket(), makeCard(), [])
    expect(prompt).not.toContain("## Discussion Thread")
  })

  it("omits empty description", () => {
    const card = makeCard({ description: "" })
    const prompt = buildPrompt(makeGoldenTicket(), card, [])
    // Should not have double blank lines from empty description
    expect(prompt).not.toMatch(/## Card #42: Fix login bug\n\n\n/)
  })
})

describe("createBackend", () => {
  it("creates claude backend", () => {
    const backend = createBackend("claude", makeConfig())
    expect(backend.name).toBe("claude")
  })

  it("creates codex backend", () => {
    const backend = createBackend("codex", makeConfig())
    expect(backend.name).toBe("codex")
  })

  it("creates opencode backend", () => {
    const backend = createBackend("opencode", makeConfig())
    expect(backend.name).toBe("opencode")
  })

  it("creates anthropic backend with env key", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test"
    const backend = createBackend("anthropic", makeConfig())
    expect(backend.name).toBe("anthropic")
    delete process.env.ANTHROPIC_API_KEY
  })

  it("creates openai backend with env key", () => {
    process.env.OPENAI_API_KEY = "sk-test"
    const backend = createBackend("openai", makeConfig())
    expect(backend.name).toBe("openai")
    delete process.env.OPENAI_API_KEY
  })

  it("creates command backend", () => {
    const config = makeConfig({ backends: { command: { run: "echo hello" } } })
    const backend = createBackend("command", config)
    expect(backend.name).toBe("command")
  })

  it("throws for unknown backend", () => {
    expect(() => createBackend("unknown-thing", makeConfig())).toThrow("Unknown backend: unknown-thing")
  })

  it("throws for anthropic backend without API key", () => {
    delete process.env.ANTHROPIC_API_KEY
    expect(() => createBackend("anthropic", makeConfig())).toThrow("Anthropic API key required")
  })

  it("throws for openai backend without API key", () => {
    delete process.env.OPENAI_API_KEY
    expect(() => createBackend("openai", makeConfig())).toThrow("OpenAI API key required")
  })

  it("throws for command backend without run config", () => {
    expect(() => createBackend("command", makeConfig())).toThrow("Command backend requires")
  })
})
