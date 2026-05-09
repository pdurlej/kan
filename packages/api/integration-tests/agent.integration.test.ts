import { beforeEach, describe, expect, it } from "vitest";

import * as agentRepo from "@kan/db/repository/agent.repo";
import * as cardRepo from "@kan/db/repository/card.repo";
import * as cardActivityRepo from "@kan/db/repository/cardActivity.repo";
import { boards, lists } from "@kan/db/schema";

import type { TestDbClient } from "./test-db";
import { createTestDb, seedTestData } from "./test-db";

describe("agent repository integration tests", () => {
  let db: TestDbClient;
  let testUser: { id: string; name: string | null };
  let testWorkspace: { id: number; publicId: string };

  beforeEach(async () => {
    db = await createTestDb();
    const seeded = await seedTestData(db);
    testUser = seeded.user;
    testWorkspace = seeded.workspace;
  });

  it("creates and verifies a scoped agent token", async () => {
    const created = await agentRepo.createToken(db, {
      name: "Iskra Readonly",
      workspaceId: testWorkspace.id,
      scopes: ["boards:read", "cards:read"],
      createdBy: testUser.id,
    });

    expect(created.token).toMatch(/^kan_agent_/);
    expect(created.scopes).toEqual(["boards:read", "cards:read"]);

    const verified = await agentRepo.getTokenBySecret(db, created.token);

    expect(verified).not.toBeNull();
    expect(verified!.name).toBe("Iskra Readonly");
    expect(verified!.scopes).toEqual(["boards:read", "cards:read"]);
    expect(verified!.workspaceId).toBe(testWorkspace.id);
  });

  it("replays audit events by idempotency key", async () => {
    const created = await agentRepo.createToken(db, {
      name: "Iskra Actions",
      workspaceId: testWorkspace.id,
      scopes: ["cards:create"],
      createdBy: testUser.id,
    });
    const verified = await agentRepo.getTokenBySecret(db, created.token);

    await agentRepo.createAuditEvent(db, {
      tokenId: verified!.id,
      workspaceId: testWorkspace.id,
      action: "create_card",
      mode: "action",
      actor: "Iskra Actions",
      idempotencyKey: "agent-test-key",
      input: { title: "Do thing" },
      result: { publicId: "card12345678" },
    });

    const replay = await agentRepo.findAuditByIdempotencyKey(db, {
      tokenId: verified!.id,
      action: "create_card",
      idempotencyKey: "agent-test-key",
    });

    expect(replay).not.toBeNull();
    expect(replay!.result).toEqual({ publicId: "card12345678" });
  });

  it("stores proposal actions and transitions status", async () => {
    const proposal = await agentRepo.createProposal(db, {
      workspaceId: testWorkspace.id,
      title: "Move inbox card",
      summary: "Dry-run movement prepared by Iskra.",
      createdBy: "Iskra",
      actions: [
        {
          type: "move_card",
          cardPublicId: "card12345678",
          toListPublicId: "list12345678",
        },
      ],
    });

    const stored = await agentRepo.getProposalByPublicId(db, proposal.publicId);

    expect(stored).not.toBeNull();
    expect(stored!.status).toBe("proposed");
    expect(stored!.actions).toEqual([
      {
        type: "move_card",
        cardPublicId: "card12345678",
        toListPublicId: "list12345678",
      },
    ]);

    const approved = await agentRepo.updateProposalStatus(db, {
      proposalPublicId: proposal.publicId,
      status: "approved",
      decidedBy: testUser.id,
    });

    expect(approved).toEqual({
      publicId: proposal.publicId,
      status: "approved",
    });
  });

  it("returns create and move activity with stable list names and public IDs", async () => {
    const [board] = await db
      .insert(boards)
      .values({
        publicId: "board1234567",
        name: "AI Inbox",
        slug: "ai-inbox",
        workspaceId: testWorkspace.id,
        createdBy: testUser.id,
      })
      .returning();

    const [captured, doing] = await db
      .insert(lists)
      .values([
        {
          publicId: "captured1234",
          name: "Captured",
          index: 0,
          boardId: board!.id,
          createdBy: testUser.id,
        },
        {
          publicId: "doing1234567",
          name: "Doing",
          index: 1,
          boardId: board!.id,
          createdBy: testUser.id,
        },
      ])
      .returning();

    const token = await agentRepo.createToken(db, {
      name: "OpenClaw Iskra MCP",
      workspaceId: testWorkspace.id,
      boardId: board!.id,
      scopes: ["activity:read", "cards:create", "cards:move"],
      createdBy: testUser.id,
    });
    const verifiedToken = await agentRepo.getTokenBySecret(db, token.token);
    expect(verifiedToken).not.toBeNull();

    const card = await cardRepo.create(db, {
      title: "sprawdzić coś od Piotra",
      description: "Signal-created test card.",
      createdBy: testUser.id,
      listId: captured!.id,
      workspaceId: testWorkspace.id,
      position: "end",
    });

    await agentRepo.upsertCardMetadata(db, {
      cardId: card.id,
      source: "signal",
      sourceRef: "signal:+48508463453:1778306367542",
      createdByKind: "iskra",
      sensitivity: "normal",
      approvalState: "applied",
    });

    await agentRepo.createAuditEvent(db, {
      tokenId: verifiedToken!.id,
      workspaceId: testWorkspace.id,
      boardId: board!.id,
      cardId: card.id,
      action: "create_card",
      mode: "action",
      actor: "OpenClaw Iskra MCP",
      idempotencyKey: "signal-create-card",
      input: {
        title: "sprawdzić coś od Piotra",
        toListPublicId: captured!.publicId,
      },
      result: { publicId: card.publicId },
    });

    const movedCard = await cardRepo.reorder(db, {
      cardId: card.id,
      newListId: doing!.id,
      newIndex: undefined,
    });
    expect(movedCard).not.toBeNull();

    await cardActivityRepo.create(db, {
      type: "card.updated.list",
      cardId: card.id,
      fromListId: captured!.id,
      toListId: doing!.id,
      createdBy: testUser.id,
    });

    await agentRepo.createAuditEvent(db, {
      tokenId: verifiedToken!.id,
      workspaceId: testWorkspace.id,
      boardId: board!.id,
      cardId: card.id,
      action: "move_card",
      mode: "action",
      actor: "OpenClaw Iskra MCP",
      idempotencyKey: "signal-move-card",
      input: {
        cardPublicId: card.publicId,
        toListPublicId: doing!.publicId,
      },
      result: { publicId: card.publicId },
    });

    const activities = await agentRepo.getRecentCardActivity(db, {
      workspaceId: testWorkspace.id,
      boardId: board!.id,
      limit: 10,
    });

    const createdActivity = activities.find(
      (activity) => activity.type === "card.created",
    );
    const movedActivity = activities.find(
      (activity) => activity.type === "card.updated.list",
    );

    expect(createdActivity).toMatchObject({
      cardPublicId: card.publicId,
      cardTitle: "sprawdzić coś od Piotra",
      boardName: "AI Inbox",
      fromListPublicId: null,
      fromListName: null,
      toListPublicId: "captured1234",
      toListName: "Captured",
      source: "signal",
      sourceRef: "signal:+48508463453:1778306367542",
      createdByKind: "iskra",
      sensitivity: "normal",
    });
    expect(movedActivity).toMatchObject({
      cardPublicId: card.publicId,
      fromListPublicId: "captured1234",
      fromListName: "Captured",
      toListPublicId: "doing1234567",
      toListName: "Doing",
      source: "signal",
      sourceRef: "signal:+48508463453:1778306367542",
      createdByKind: "iskra",
      sensitivity: "normal",
    });

    const audits = await agentRepo.getRecentAgentAudit(db, {
      workspaceId: testWorkspace.id,
      boardId: board!.id,
      limit: 10,
      source: "signal",
    });

    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "create_card",
          cardPublicId: card.publicId,
          actor: "OpenClaw Iskra MCP",
          idempotencyKey: "signal-create-card",
          source: "signal",
        }),
        expect.objectContaining({
          action: "move_card",
          cardPublicId: card.publicId,
          actor: "OpenClaw Iskra MCP",
          idempotencyKey: "signal-move-card",
          source: "signal",
        }),
      ]),
    );
  });
});
