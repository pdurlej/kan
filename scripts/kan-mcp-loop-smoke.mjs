#!/usr/bin/env node

const url = process.env.KAN_MCP_URL ?? "https://kan.pdurlej.com/mcp";
const id = process.env.KAN_SMOKE_ID ?? `smoke-${new Date().toISOString()}`;
const title =
  process.env.KAN_SMOKE_TITLE ?? `E2E smoke: Signal to Kan ${id}`;

const request = async (method, params, requestId) => {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      method,
      params,
    }),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`MCP ${response.status}: ${raw}`);
  }

  const dataLine = raw
    .split(/\r?\n/)
    .find((line) => line.startsWith("data: "));
  if (!dataLine) throw new Error(`No MCP data frame: ${raw}`);

  const parsed = JSON.parse(dataLine.slice("data: ".length));
  if (parsed.error) throw new Error(JSON.stringify(parsed.error));

  return parsed.result;
};

const callTool = async (name, args, requestId) => {
  const result = await request(
    "tools/call",
    { name, arguments: args },
    requestId,
  );
  const text = result.content?.[0]?.text;

  return text ? JSON.parse(text) : result;
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const createKey = `${id}:create`;
const moveKey = `${id}:move`;

console.log(`Kan MCP smoke: ${title}`);

await callTool("ensure_ai_inbox", {}, 1);

const created = await callTool(
  "create_ai_inbox_card",
  {
    title,
    columnName: "Captured",
    description: "Automated smoke for Signal -> Iskra -> Kan MCP loop.",
    metadata: {
      source: "signal",
      sourceRef: `signal:+48508463453:${id}`,
      createdByKind: "iskra",
      sensitivity: "normal",
      lastAiSummary: "Smoke card created through Kan MCP.",
    },
    idempotencyKey: createKey,
  },
  2,
);
assert(created.publicId, "create_ai_inbox_card did not return a card publicId");
assert(created.auditPublicId, "create_ai_inbox_card did not return auditPublicId");
assert(created.actor, "create_ai_inbox_card did not return actor");
assert(created.mode === "action", "create_ai_inbox_card did not return action mode");

const replayedCreate = await callTool(
  "create_ai_inbox_card",
  {
    title,
    columnName: "Captured",
    metadata: {
      source: "signal",
      sourceRef: `signal:+48508463453:${id}`,
      createdByKind: "iskra",
      sensitivity: "normal",
    },
    idempotencyKey: createKey,
  },
  3,
);
assert(replayedCreate.publicId === created.publicId, "create idempotency replay returned a different card");
assert(replayedCreate.idempotentReplay === true, "create idempotency replay was not marked");

const moved = await callTool(
  "move_ai_inbox_card",
  {
    cardPublicId: created.publicId,
    toColumnName: "Doing",
    idempotencyKey: moveKey,
  },
  4,
);
assert(moved.publicId === created.publicId, "move_ai_inbox_card moved the wrong card");
assert(moved.auditPublicId, "move_ai_inbox_card did not return auditPublicId");
assert(moved.actor, "move_ai_inbox_card did not return actor");
assert(moved.mode === "action", "move_ai_inbox_card did not return action mode");

const replayedMove = await callTool(
  "move_ai_inbox_card",
  {
    cardPublicId: created.publicId,
    toColumnName: "Doing",
    idempotencyKey: moveKey,
  },
  5,
);
assert(replayedMove.publicId === created.publicId, "move idempotency replay returned a different card");
assert(replayedMove.idempotentReplay === true, "move idempotency replay was not marked");

const activity = await callTool(
  "get_recent_activity",
  {
    today: true,
    onlyMoves: true,
    includeAgentAudit: true,
    limit: 20,
  },
  6,
);

const moveActivity = activity.cardActivities?.find(
  (item) => item.cardPublicId === created.publicId,
);
assert(moveActivity, "recent activity did not include the move");
assert(moveActivity.actorKind === "agent", "move activity is not attributed to an agent");
assert(
  moveActivity.displayActorName === moved.actor,
  "move activity display actor does not match the agent actor",
);

const auditKeys = new Set(
  activity.agentAudit?.map((event) => event.idempotencyKey) ?? [],
);
assert(auditKeys.has(createKey), "recent audit did not include create event");
assert(auditKeys.has(moveKey), "recent audit did not include move event");

console.log(
  JSON.stringify(
    {
      ok: true,
      cardPublicId: created.publicId,
      createAuditPublicId: created.auditPublicId,
      moveAuditPublicId: moved.auditPublicId,
      actor: moved.actor,
    },
    null,
    2,
  ),
);
