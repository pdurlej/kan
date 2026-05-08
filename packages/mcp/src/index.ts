import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

import { KanIntegrationClient } from "./client";

const env = {
  host: process.env.KAN_MCP_HOST ?? "0.0.0.0",
  port: Number(process.env.KAN_MCP_PORT ?? "8086"),
  kanBaseUrl: process.env.KAN_BASE_URL,
  kanAgentToken: process.env.KAN_AGENT_TOKEN,
  actionsEnabled: process.env.KAN_MCP_ACTIONS_ENABLED !== "false",
  mcpBearerToken: process.env.KAN_MCP_BEARER_TOKEN,
};

if (!env.kanBaseUrl) {
  throw new Error("KAN_BASE_URL is required");
}

if (!env.kanAgentToken) {
  throw new Error("KAN_AGENT_TOKEN is required");
}

const client = new KanIntegrationClient({
  baseUrl: env.kanBaseUrl,
  agentToken: env.kanAgentToken,
});

const jsonText = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: JSON.stringify(value, null, 2),
    },
  ],
});

const requireActionsEnabled = () => {
  if (!env.actionsEnabled) {
    throw new Error(
      "Kan MCP action tools are disabled. Use propose_board_update or set KAN_MCP_ACTIONS_ENABLED=true.",
    );
  }
};

const metadataSchema = {
  source: z
    .enum([
      "signal",
      "fastmail",
      "meeting",
      "forgejo",
      "manual",
      "obsidian",
      "iskra",
      "n8n",
    ])
    .optional(),
  sourceRef: z.string().max(2048).optional(),
  createdByKind: z.enum(["human", "iskra", "n8n", "import"]).optional(),
  sensitivity: z.enum(["normal", "private", "sensitive"]).optional(),
  relationshipRef: z.string().max(2048).optional(),
  projectRef: z.string().max(2048).optional(),
  lastAiSummary: z.string().max(5000).optional(),
};

const isoDateTimeSchema = z.string().datetime({ offset: true });

const createProposedActionSchema = () =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("create_card"),
      listPublicId: z.string().min(12),
      title: z.string().min(1).max(2000),
      description: z.string().max(10000).optional(),
      dueDate: isoDateTimeSchema.nullable().optional(),
      metadata: z.object(metadataSchema).optional(),
    }),
    z.object({
      type: z.literal("move_card"),
      cardPublicId: z.string().min(12),
      toListPublicId: z.string().min(12),
      index: z.number().int().min(0).optional(),
    }),
    z.object({
      type: z.literal("comment_card"),
      cardPublicId: z.string().min(12),
      comment: z.string().min(1).max(10000),
    }),
  ]);

const aiInboxColumnNames = [
  "Captured",
  "Clarify",
  "Ready",
  "Doing",
  "Waiting",
  "Done / Archived",
] as const;

type AiInboxResult = {
  boardPublicId: string;
  lists: Array<{ publicId: string; name: string; index: number }>;
};

type SearchCardResult = {
  publicId: string;
  title: string;
  boardPublicId: string;
  listName: string;
};

const getAiInboxColumn = (inbox: unknown, columnName: string) => {
  const result = inbox as AiInboxResult;
  const column = result.lists.find(
    (list) => list.name.toLowerCase() === columnName.toLowerCase(),
  );

  if (!column) {
    throw new Error(`AI Inbox column not found: ${columnName}`);
  }

  return { inbox: result, column };
};

const createServer = () => {
  const server = new McpServer({
    name: "kan",
    version: "0.1.0",
  });

  server.registerTool(
    "get_default_context",
    {
      title: "Get default context",
      description:
        "Return the workspace, optional board scope, existing AI Inbox, and scopes for this Kan integration token.",
      inputSchema: {},
    },
    async () => jsonText(await client.getDefaultContext()),
  );

  server.registerTool(
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "List the workspace visible to this Kan integration token. Tokens are intentionally scoped to one workspace.",
      inputSchema: {},
    },
    async () => jsonText(await client.listWorkspaces()),
  );

  server.registerTool(
    "list_boards",
    {
      title: "List boards",
      description:
        "List Kan boards visible to this integration token. If workspacePublicId is omitted, the token's default workspace is used.",
      inputSchema: {
        workspacePublicId: z.string().min(12).optional(),
      },
    },
    async (input) => jsonText(await client.listBoards(input)),
  );

  server.registerTool(
    "list_columns",
    {
      title: "List columns",
      description: "List columns for a Kan board.",
      inputSchema: {
        boardPublicId: z.string().min(12),
      },
    },
    async (input) => jsonText(await client.listColumns(input)),
  );

  server.registerTool(
    "list_cards",
    {
      title: "List cards",
      description: "List cards on a board, optionally limited to one column.",
      inputSchema: {
        boardPublicId: z.string().min(12),
        listPublicId: z.string().min(12).optional(),
      },
    },
    async (input) => jsonText(await client.listCards(input)),
  );

  server.registerTool(
    "search_cards",
    {
      title: "Search cards",
      description:
        "Search Kan cards in a workspace. If workspacePublicId is omitted, the token's default workspace is used.",
      inputSchema: {
        workspacePublicId: z.string().min(12).optional(),
        query: z.string().min(1).max(100),
        limit: z.number().int().min(1).max(50).optional(),
      },
    },
    async (input) => jsonText(await client.searchCards(input)),
  );

  server.registerTool(
    "get_card_context",
    {
      title: "Get card context",
      description: "Get a card with board, column, due date, and labels.",
      inputSchema: {
        cardPublicId: z.string().min(12),
      },
    },
    async (input) => jsonText(await client.getCardContext(input)),
  );

  server.registerTool(
    "get_recent_activity",
    {
      title: "Get recent activity",
      description:
        "Get recent human card activity and agent audit events. If workspacePublicId is omitted, the token's default workspace is used. Datetimes accept offsets and are normalized to UTC; use today=true for the current Europe/Warsaw day.",
      inputSchema: {
        workspacePublicId: z.string().min(12).optional(),
        boardPublicId: z.string().min(12).optional(),
        since: isoDateTimeSchema.optional(),
        today: z.boolean().optional(),
        onlyMoves: z.boolean().optional(),
        includeAgentAudit: z.boolean().optional(),
        actor: z.string().min(1).max(255).optional(),
        action: z.string().min(1).max(100).optional(),
        source: z
          .enum([
            "signal",
            "fastmail",
            "meeting",
            "forgejo",
            "manual",
            "obsidian",
            "iskra",
            "n8n",
          ])
          .optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async (input) => jsonText(await client.getRecentActivity(input)),
  );

  server.registerTool(
    "create_card",
    {
      title: "Create card",
      description:
        "Create a Kan card after an explicit human instruction. Writes are audited.",
      inputSchema: {
        listPublicId: z.string().min(12),
        title: z.string().min(1).max(2000),
        description: z.string().max(10000).optional(),
        dueDate: isoDateTimeSchema.nullable().optional(),
        metadata: z.object(metadataSchema).optional(),
        idempotencyKey: z.string().max(255).optional(),
      },
    },
    async (input) => {
      requireActionsEnabled();
      return jsonText(
        await client.createCard({
          ...input,
          idempotencyKey: input.idempotencyKey ?? `mcp:create:${randomUUID()}`,
        }),
      );
    },
  );

  server.registerTool(
    "create_ai_inbox_card",
    {
      title: "Create AI Inbox card",
      description:
        "Create a card in AI Inbox after an explicit human instruction. Defaults to the token workspace and Captured column.",
      inputSchema: {
        workspacePublicId: z.string().min(12).optional(),
        columnName: z.enum(aiInboxColumnNames).optional(),
        title: z.string().min(1).max(2000),
        description: z.string().max(10000).optional(),
        dueDate: isoDateTimeSchema.nullable().optional(),
        metadata: z.object(metadataSchema).optional(),
        idempotencyKey: z.string().max(255).optional(),
      },
    },
    async (input) => {
      requireActionsEnabled();
      const { column } = getAiInboxColumn(
        await client.ensureAiInbox({
          workspacePublicId: input.workspacePublicId,
        }),
        input.columnName ?? "Captured",
      );

      return jsonText(
        await client.createCard({
          listPublicId: column.publicId,
          title: input.title,
          description: input.description,
          dueDate: input.dueDate,
          metadata: input.metadata,
          idempotencyKey:
            input.idempotencyKey ?? `mcp:ai-inbox:create:${randomUUID()}`,
        }),
      );
    },
  );

  server.registerTool(
    "move_card",
    {
      title: "Move card",
      description:
        "Move a Kan card after an explicit human instruction. Writes are audited.",
      inputSchema: {
        cardPublicId: z.string().min(12),
        toListPublicId: z.string().min(12),
        index: z.number().int().min(0).optional(),
        idempotencyKey: z.string().max(255).optional(),
      },
    },
    async (input) => {
      requireActionsEnabled();
      return jsonText(
        await client.moveCard({
          ...input,
          idempotencyKey: input.idempotencyKey ?? `mcp:move:${randomUUID()}`,
        }),
      );
    },
  );

  server.registerTool(
    "move_ai_inbox_card",
    {
      title: "Move AI Inbox card",
      description:
        "Move one AI Inbox card after an explicit human instruction. Provide cardPublicId when known; otherwise provide query/title. Ambiguous title matches are returned without mutation.",
      inputSchema: {
        workspacePublicId: z.string().min(12).optional(),
        cardPublicId: z.string().min(12).optional(),
        query: z.string().min(1).max(100).optional(),
        toColumnName: z.enum(aiInboxColumnNames),
        index: z.number().int().min(0).optional(),
        idempotencyKey: z.string().max(255).optional(),
      },
    },
    async (input) => {
      requireActionsEnabled();
      const { inbox, column } = getAiInboxColumn(
        await client.ensureAiInbox({
          workspacePublicId: input.workspacePublicId,
        }),
        input.toColumnName,
      );

      let cardPublicId = input.cardPublicId;
      if (!cardPublicId) {
        if (!input.query) {
          return jsonText({
            ok: false,
            reason: "cardPublicId_or_query_required",
          });
        }

        const results = (await client.searchCards({
          workspacePublicId: input.workspacePublicId,
          query: input.query,
          limit: 10,
        })) as SearchCardResult[];
        const candidates = results.filter(
          (card) => card.boardPublicId === inbox.boardPublicId,
        );
        const exactMatches = candidates.filter(
          (card) => card.title.toLowerCase() === input.query!.toLowerCase(),
        );
        const matches = exactMatches.length > 0 ? exactMatches : candidates;

        if (matches.length !== 1) {
          return jsonText({
            ok: false,
            reason: matches.length === 0 ? "card_not_found" : "ambiguous_card",
            candidates: matches.map((card) => ({
              publicId: card.publicId,
              title: card.title,
              listName: card.listName,
            })),
          });
        }

        cardPublicId = matches[0]!.publicId;
      }

      return jsonText(
        await client.moveCard({
          cardPublicId,
          toListPublicId: column.publicId,
          index: input.index,
          idempotencyKey:
            input.idempotencyKey ?? `mcp:ai-inbox:move:${randomUUID()}`,
        }),
      );
    },
  );

  server.registerTool(
    "comment_card",
    {
      title: "Comment card",
      description:
        "Add a Kan card comment after an explicit human instruction. Writes are audited.",
      inputSchema: {
        cardPublicId: z.string().min(12),
        comment: z.string().min(1).max(10000),
        idempotencyKey: z.string().max(255).optional(),
      },
    },
    async (input) => {
      requireActionsEnabled();
      return jsonText(
        await client.commentCard({
          ...input,
          idempotencyKey: input.idempotencyKey ?? `mcp:comment:${randomUUID()}`,
        }),
      );
    },
  );

  server.registerTool(
    "propose_board_update",
    {
      title: "Propose board update",
      description:
        "Store a dry-run proposal for changes that should not be applied directly. If workspacePublicId is omitted, the token's default workspace is used.",
      inputSchema: {
        workspacePublicId: z.string().min(12).optional(),
        boardPublicId: z.string().min(12).optional(),
        title: z.string().min(1).max(255),
        summary: z.string().max(5000).optional(),
        actions: z.array(createProposedActionSchema()).min(1).max(20),
      },
    },
    async (input) => jsonText(await client.proposeBoardUpdate(input)),
  );

  server.registerTool(
    "apply_approved_update",
    {
      title: "Apply approved update",
      description: "Apply a previously approved Kan agent proposal.",
      inputSchema: {
        proposalPublicId: z.string().min(12),
        idempotencyKey: z.string().max(255).optional(),
      },
    },
    async (input) => {
      requireActionsEnabled();
      return jsonText(
        await client.applyApprovedUpdate({
          ...input,
          idempotencyKey: input.idempotencyKey ?? `mcp:apply:${randomUUID()}`,
        }),
      );
    },
  );

  server.registerTool(
    "ensure_ai_inbox",
    {
      title: "Ensure AI Inbox",
      description:
        "Create or return the AI Inbox board with the standard Kan columns. If workspacePublicId is omitted, the token's default workspace is used.",
      inputSchema: {
        workspacePublicId: z.string().min(12).optional(),
      },
    },
    async (input) => jsonText(await client.ensureAiInbox(input)),
  );

  return server;
};

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    name: "kan-mcp",
    actionsEnabled: env.actionsEnabled,
  });
});

app.post("/mcp", async (req, res) => {
  if (
    env.mcpBearerToken &&
    req.header("authorization") !== `Bearer ${env.mcpBearerToken}`
  ) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.all("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed" });
});

app.listen(env.port, env.host, () => {
  console.log(`kan-mcp listening on http://${env.host}:${env.port}/mcp`);
});
