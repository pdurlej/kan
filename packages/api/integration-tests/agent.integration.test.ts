import { beforeEach, describe, expect, it } from "vitest";

import * as agentRepo from "@kan/db/repository/agent.repo";

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
});
