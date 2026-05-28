import { createHmac, timingSafeEqual } from "node:crypto"
import {
  createFizzyClient as createOfficialFizzyClient,
  type FizzyClient as OfficialFizzyClient,
} from "@37signals/fizzy"
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

// ── Fizzy SDK-backed client ──

export class FizzyClient {
  private baseUrl: string
  private account: string
  private token: string
  private rootClient: OfficialFizzyClient
  private scopedClient: OfficialFizzyClient | null = null

  constructor(config: Config) {
    this.baseUrl = config.fizzy.api_url.replace(/\/$/, "")
    this.account = config.fizzy.account
    this.token = config.fizzy.token

    this.rootClient = createOfficialFizzyClient({
      accessToken: this.token,
      baseUrl: this.baseUrl,
    })
  }

  private accountClient(): OfficialFizzyClient {
    if (!this.account) {
      throw new Error("Fizzy account is required for account-scoped API calls")
    }

    this.scopedClient ??= createOfficialFizzyClient({
      accessToken: this.token,
      baseUrl: `${this.baseUrl}/${encodeURIComponent(this.account)}`,
    })

    return this.scopedClient
  }

  private async sdkRequest<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Fizzy API: ${error.message}`)
      }
      throw error
    }
  }

  private async sdkList<T>(operation: () => Promise<Iterable<T>>): Promise<T[]> {
    const result = await this.sdkRequest(operation)
    return [...result]
  }

  private async sdkMutation(operation: () => Promise<unknown>): Promise<void> {
    await this.sdkRequest(operation)
  }

  private cardListOptions(params?: { board_ids?: string[] }): { boardIds?: string[] } | undefined {
    if (!params?.board_ids?.length) return undefined
    return { boardIds: params.board_ids }
  }

  private async accountRequest<T>(operation: (client: OfficialFizzyClient) => Promise<T>): Promise<T> {
    return this.sdkRequest(() => operation(this.accountClient()))
  }

  private async list(operation: (client: OfficialFizzyClient) => Promise<Iterable<unknown>>): Promise<unknown[]> {
    return this.sdkList(() => operation(this.accountClient()))
  }

  private async mutate(operation: (client: OfficialFizzyClient) => Promise<unknown>): Promise<void> {
    return this.sdkMutation(() => operation(this.accountClient()))
  }

  private async root<T>(operation: (client: OfficialFizzyClient) => Promise<T>): Promise<T> {
    return this.sdkRequest(() => operation(this.rootClient))
  }

  // ── Board operations ──

  async listBoards(): Promise<FizzyBoard[]> {
    return await this.list(client => client.boards.list()) as FizzyBoard[]
  }

  async getBoard(boardId: string): Promise<FizzyBoard> {
    return await this.accountRequest(client => client.boards.get(boardId)) as FizzyBoard
  }

  async listColumns(boardId: string): Promise<FizzyColumn[]> {
    return await this.list(client => client.columns.list(boardId)) as FizzyColumn[]
  }

  // ── Card operations ──

  async listCards(params?: { board_ids?: string[] }): Promise<FizzyCard[]> {
    return await this.list(client => client.cards.list(this.cardListOptions(params))) as FizzyCard[]
  }

  async getCard(cardNumber: number): Promise<FizzyCard> {
    return await this.accountRequest(client => client.cards.get(cardNumber)) as FizzyCard
  }

  async listComments(cardNumber: number): Promise<FizzyComment[]> {
    return await this.list(client => client.comments.list(cardNumber)) as FizzyComment[]
  }

  // ── Card mutations ──

  async closeCard(cardNumber: number): Promise<void> {
    await this.mutate(client => client.cards.close(cardNumber))
  }

  async triageCard(cardNumber: number, columnId: string): Promise<void> {
    await this.mutate(client => client.cards.triage(cardNumber, { columnId }))
  }

  async postComment(cardNumber: number, body: string): Promise<void> {
    await this.mutate(client => client.comments.create(cardNumber, { body }))
  }

  async toggleTag(cardNumber: number, tagTitle: string): Promise<void> {
    await this.mutate(client => client.cards.tag(cardNumber, { tagTitle }))
  }

  // ── Identity ──

  async getIdentity(): Promise<{ accounts: Array<{ id: string; name: string; slug: string; user: FizzyUser }> }> {
    return this.root(client => client.identity.me()) as Promise<{ accounts: Array<{ id: string; name: string; slug: string; user: FizzyUser }> }>
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
