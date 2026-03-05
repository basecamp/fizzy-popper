import { createHmac, timingSafeEqual } from "node:crypto"
import type { Config } from "./config.js"

// ── Domain types ──

export interface FizzyUser {
  id: string
  name: string
  role: string
  active: boolean
  email_address: string | null
  created_at: string
  url: string
  avatar_url?: string
}

export interface FizzyBoard {
  id: string
  name: string
  all_access: boolean
  created_at: string
  url: string
  creator: FizzyUser
}

export interface FizzyColumn {
  id: string
  name: string
  color: string | { name: string; value: string }
  created_at: string
}

export interface FizzyStep {
  id: string
  content: string
  completed: boolean
}

export interface FizzyCard {
  id: string
  number: number
  title: string
  status: "drafted" | "published"
  description: string
  description_html: string
  image_url: string | null
  has_attachments?: boolean
  tags: string[]
  closed: boolean
  postponed?: boolean
  golden: boolean
  last_active_at: string
  created_at: string
  url: string
  board: FizzyBoard
  column?: FizzyColumn
  creator: FizzyUser
  assignees?: FizzyUser[]
  has_more_assignees?: boolean
  steps?: FizzyStep[]
  comments_url: string
  reactions_url?: string
}

export interface FizzyComment {
  id: string
  created_at: string
  updated_at: string
  body: { plain_text: string; html: string }
  creator: FizzyUser
  card: { id: string; url: string }
  reactions_url: string
  url: string
}

export interface FizzyWebhookEvent {
  id: string
  action: string
  created_at: string
  eventable: FizzyCard | FizzyComment
  board: FizzyBoard
  creator: FizzyUser
}

// ── Golden Ticket (parsed from a card tagged #agent-instructions) ──

export interface GoldenTicket {
  card_id: string
  column_id: string
  column_name: string
  description: string
  steps: FizzyStep[]
  backend: string
  on_complete: "comment" | "close" | string // "move:<column_name>"
  title: string
}

// ── Agent Run Attempt ──

export interface AgentRun {
  card_id: string
  card_number: number
  card_title: string
  column_name: string
  backend_name: string
  started_at: Date
  status: "running" | "succeeded" | "failed" | "timed_out" | "cancelled"
  abort_controller: AbortController
}

// ── Fizzy REST client ──

export class FizzyClient {
  private baseUrl: string
  private account: string
  private token: string

  constructor(config: Config) {
    this.baseUrl = config.fizzy.api_url.replace(/\/$/, "")
    this.account = config.fizzy.account
    this.token = config.fizzy.token
  }

  private url(path: string): string {
    return `${this.baseUrl}/${this.account}${path}`
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = this.url(path)
    const response = await fetch(url, {
      ...options,
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new Error(`Fizzy API ${response.status}: ${response.statusText} — ${text}`)
    }

    const text = await response.text()
    if (!text) return undefined as T

    return JSON.parse(text) as T
  }

  private async paginatedRequest<T>(path: string): Promise<T[]> {
    const results: T[] = []
    let url: string | null = this.url(path)

    while (url) {
      const response = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${this.token}`,
          "Accept": "application/json",
        },
      })

      if (!response.ok) {
        const text = await response.text().catch(() => "")
        throw new Error(`Fizzy API ${response.status}: ${response.statusText} — ${text}`)
      }

      const data = await response.json() as T[]
      results.push(...data)

      // Parse Link header for next page
      const link = response.headers.get("Link") || response.headers.get("link")
      url = parseLinkNext(link)
    }

    return results
  }

  // ── Board operations ──

  async listBoards(): Promise<FizzyBoard[]> {
    return this.request<FizzyBoard[]>("/boards")
  }

  async getBoard(boardId: string): Promise<FizzyBoard> {
    return this.request<FizzyBoard>(`/boards/${boardId}`)
  }

  async listColumns(boardId: string): Promise<FizzyColumn[]> {
    return this.request<FizzyColumn[]>(`/boards/${boardId}/columns`)
  }

  // ── Card operations ──

  async listCards(params?: { board_ids?: string[] }): Promise<FizzyCard[]> {
    let path = "/cards"
    if (params?.board_ids?.length) {
      const qs = params.board_ids.map(id => `board_ids[]=${encodeURIComponent(id)}`).join("&")
      path += `?${qs}`
    }
    return this.paginatedRequest<FizzyCard>(path)
  }

  async getCard(cardNumber: number): Promise<FizzyCard> {
    return this.request<FizzyCard>(`/cards/${cardNumber}`)
  }

  async listComments(cardNumber: number): Promise<FizzyComment[]> {
    return this.paginatedRequest<FizzyComment>(`/cards/${cardNumber}/comments`)
  }

  // ── Card mutations ──

  async closeCard(cardNumber: number): Promise<void> {
    await this.request<void>(`/cards/${cardNumber}/closure`, { method: "POST" })
  }

  async triageCard(cardNumber: number, columnId: string): Promise<void> {
    await this.request<void>(`/cards/${cardNumber}/triage`, {
      method: "POST",
      body: JSON.stringify({ column_id: columnId }),
    })
  }

  async postComment(cardNumber: number, body: string): Promise<void> {
    await this.request<void>(`/cards/${cardNumber}/comments`, {
      method: "POST",
      body: JSON.stringify({ comment: { body } }),
    })
  }

  async toggleTag(cardNumber: number, tagTitle: string): Promise<void> {
    await this.request<void>(`/cards/${cardNumber}/taggings`, {
      method: "POST",
      body: JSON.stringify({ tag_title: tagTitle }),
    })
  }

  // ── Identity ──

  async getIdentity(): Promise<{ accounts: Array<{ id: string; name: string; slug: string; user: FizzyUser }> }> {
    const url = `${this.baseUrl}/my/identity`
    const response = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${this.token}`,
        "Accept": "application/json",
      },
    })
    if (!response.ok) {
      throw new Error(`Fizzy API ${response.status}: ${response.statusText}`)
    }
    return response.json() as Promise<{ accounts: Array<{ id: string; name: string; slug: string; user: FizzyUser }> }>
  }
}

// ── Webhook verification ──

export function verifyWebhookSignature(
  body: string,
  signature: string,
  secret: string,
): boolean {
  // HMAC-SHA256 of the raw body using the signing secret
  const expected = createHmac("sha256", secret).update(body).digest("hex")

  if (expected.length !== signature.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
}

export function isWebhookFresh(timestamp: string, toleranceSec: number = 300): boolean {
  const eventTime = new Date(timestamp).getTime()
  const now = Date.now()
  return Math.abs(now - eventTime) < toleranceSec * 1000
}

// ── Helpers ──

function parseLinkNext(header: string | null): string | null {
  if (!header) return null
  const match = header.match(/<([^>]+)>;\s*rel="next"/)
  return match ? match[1] : null
}

// ── Golden ticket parsing ──

const BACKEND_TAGS = ["claude", "codex", "opencode", "anthropic", "openai"] as const
const COMPLETION_TAG_PREFIX = "move-to-"

export function parseGoldenTicket(card: FizzyCard, defaultBackend: string): GoldenTicket | null {
  if (!card.tags.includes("agent-instructions")) return null
  if (!card.column) return null

  let backend = defaultBackend
  for (const tag of card.tags) {
    if ((BACKEND_TAGS as readonly string[]).includes(tag)) {
      backend = tag
      break
    }
  }

  let onComplete: string = "comment"
  for (const tag of card.tags) {
    if (tag === "close-on-complete") {
      onComplete = "close"
      break
    }
    if (tag.startsWith(COMPLETION_TAG_PREFIX)) {
      const columnName = tag.slice(COMPLETION_TAG_PREFIX.length).replace(/-/g, " ")
      onComplete = `move:${columnName}`
      break
    }
  }

  return {
    card_id: card.id,
    column_id: card.column.id,
    column_name: card.column.name,
    description: card.description,
    steps: card.steps ?? [],
    backend,
    on_complete: onComplete,
    title: card.title,
  }
}

export function isGoldenTicket(card: FizzyCard): boolean {
  return card.tags.includes("agent-instructions")
}
