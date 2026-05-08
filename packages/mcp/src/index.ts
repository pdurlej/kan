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

const createProposedActionSchema = () =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("create_card"),
      listPublicId: z.string().min(12),
      title: z.string().min(1).max(2000),
      description: z.string().max(10000).optional(),
      dueDate: z.string().datetime().nullable().optional(),
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

const createServer = () => {
  const server = new McpServer({
    name: "kan",
    version: "0.1.0",
  });

  server.registerTool(
    "list_boards",
    {
      title: "List boards",
      description: "List Kan boards visible to this integration token.",
      inputSchema: {
        workspacePublicId: z.string().min(12),
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
      description: "Search Kan cards in a workspace.",
      inputSchema: {
        workspacePublicId: z.string().min(12),
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
      description: "Get recent human card activity and agent audit events.",
      inputSchema: {
        workspacePublicId: z.string().min(12),
        boardPublicId: z.string().min(12).optional(),
        since: z.string().datetime().optional(),
        onlyMoves: z.boolean().optional(),
        includeAgentAudit: z.boolean().optional(),
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
        dueDate: z.string().datetime().nullable().optional(),
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
        "Store a dry-run proposal for changes that should not be applied directly.",
      inputSchema: {
        workspacePublicId: z.string().min(12),
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
        "Create or return the AI Inbox board with the standard Kan columns.",
      inputSchema: {
        workspacePublicId: z.string().min(12),
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
