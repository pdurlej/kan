type QueryValue = string | number | boolean | null | undefined;

export type KanClientOptions = {
  baseUrl: string;
  agentToken: string;
};

type RequestOptions = {
  method?: "GET" | "POST";
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  idempotencyKey?: string | null;
};

export class KanIntegrationClient {
  private readonly apiBaseUrl: URL;
  private readonly agentToken: string;

  constructor(options: KanClientOptions) {
    this.apiBaseUrl = new URL("/api/v1/", options.baseUrl);
    this.agentToken = options.agentToken;
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const url = new URL(options.path.replace(/^\//, ""), this.apiBaseUrl);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.agentToken}`,
    };

    if (options.method === "POST") {
      headers["content-type"] = "application/json";
    }

    if (options.idempotencyKey) {
      headers["idempotency-key"] = options.idempotencyKey;
    }

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body:
        options.method === "POST" && options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Kan Integration API ${response.status} ${response.statusText}: ${text}`,
      );
    }

    return (await response.json()) as T;
  }

  listBoards(input: { workspacePublicId: string }) {
    return this.request<unknown>({
      path: `/agent/workspaces/${encodeURIComponent(input.workspacePublicId)}/boards`,
    });
  }

  listColumns(input: { boardPublicId: string }) {
    return this.request<unknown>({
      path: `/agent/boards/${encodeURIComponent(input.boardPublicId)}/columns`,
    });
  }

  listCards(input: { boardPublicId: string; listPublicId?: string }) {
    return this.request<unknown>({
      path: `/agent/boards/${encodeURIComponent(input.boardPublicId)}/cards`,
      query: { listPublicId: input.listPublicId },
    });
  }

  searchCards(input: {
    workspacePublicId: string;
    query: string;
    limit?: number;
  }) {
    return this.request<unknown>({
      path: `/agent/workspaces/${encodeURIComponent(input.workspacePublicId)}/cards/search`,
      query: { query: input.query, limit: input.limit },
    });
  }

  getCardContext(input: { cardPublicId: string }) {
    return this.request<unknown>({
      path: `/agent/cards/${encodeURIComponent(input.cardPublicId)}`,
    });
  }

  getRecentActivity(input: {
    workspacePublicId: string;
    boardPublicId?: string;
    since?: string;
    onlyMoves?: boolean;
    includeAgentAudit?: boolean;
    limit?: number;
  }) {
    return this.request<unknown>({
      path: `/agent/workspaces/${encodeURIComponent(input.workspacePublicId)}/activity`,
      query: {
        boardPublicId: input.boardPublicId,
        since: input.since,
        onlyMoves: input.onlyMoves,
        includeAgentAudit: input.includeAgentAudit,
        limit: input.limit,
      },
    });
  }

  createCard(input: {
    listPublicId: string;
    title: string;
    description?: string;
    dueDate?: string | null;
    metadata?: unknown;
    idempotencyKey?: string;
  }) {
    return this.request<unknown>({
      method: "POST",
      path: "/agent/cards",
      body: input,
      idempotencyKey: input.idempotencyKey,
    });
  }

  moveCard(input: {
    cardPublicId: string;
    toListPublicId: string;
    index?: number;
    idempotencyKey?: string;
  }) {
    return this.request<unknown>({
      method: "POST",
      path: `/agent/cards/${encodeURIComponent(input.cardPublicId)}/move`,
      body: input,
      idempotencyKey: input.idempotencyKey,
    });
  }

  commentCard(input: {
    cardPublicId: string;
    comment: string;
    idempotencyKey?: string;
  }) {
    return this.request<unknown>({
      method: "POST",
      path: `/agent/cards/${encodeURIComponent(input.cardPublicId)}/comments`,
      body: input,
      idempotencyKey: input.idempotencyKey,
    });
  }

  proposeBoardUpdate(input: {
    workspacePublicId: string;
    boardPublicId?: string;
    title: string;
    summary?: string;
    actions: unknown[];
  }) {
    return this.request<unknown>({
      method: "POST",
      path: "/agent/proposals",
      body: input,
    });
  }

  applyApprovedUpdate(input: {
    proposalPublicId: string;
    idempotencyKey?: string;
  }) {
    return this.request<unknown>({
      method: "POST",
      path: `/agent/proposals/${encodeURIComponent(input.proposalPublicId)}/apply`,
      body: input,
      idempotencyKey: input.idempotencyKey,
    });
  }

  ensureAiInbox(input: { workspacePublicId: string }) {
    return this.request<unknown>({
      method: "POST",
      path: `/agent/workspaces/${encodeURIComponent(input.workspacePublicId)}/ai-inbox`,
      body: input,
    });
  }
}
