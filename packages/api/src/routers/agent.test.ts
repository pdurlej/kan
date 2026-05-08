import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as agentRepo from "@kan/db/repository/agent.repo";
import * as boardRepo from "@kan/db/repository/board.repo";
import * as workspaceRepo from "@kan/db/repository/workspace.repo";

import { assertPermission } from "../utils/permissions";

vi.mock("@kan/db/repository/agent.repo", () => ({
  allAgentScopes: [
    "boards:read",
    "columns:read",
    "cards:read",
    "activity:read",
    "cards:create",
    "cards:move",
    "comments:create",
    "proposals:create",
    "proposals:apply",
    "inbox:manage",
  ],
  createToken: vi.fn(),
  findBoardByName: vi.fn(),
  getTokenBySecret: vi.fn(),
  touchToken: vi.fn(),
}));

vi.mock("@kan/db/repository/board.repo", () => ({
  getAllByWorkspaceId: vi.fn(),
  getWorkspaceAndBoardIdByBoardPublicId: vi.fn(),
}));

vi.mock("@kan/db/repository/workspace.repo", () => ({
  getByPublicId: vi.fn(),
}));

vi.mock("../utils/permissions", () => ({
  assertPermission: vi.fn(),
}));

const mockCreateToken = agentRepo.createToken as ReturnType<typeof vi.fn>;
const mockFindBoardByName = agentRepo.findBoardByName as ReturnType<
  typeof vi.fn
>;
const mockGetTokenBySecret = agentRepo.getTokenBySecret as ReturnType<
  typeof vi.fn
>;
const mockTouchToken = agentRepo.touchToken as ReturnType<typeof vi.fn>;
const mockGetAllByWorkspaceId = boardRepo.getAllByWorkspaceId as ReturnType<
  typeof vi.fn
>;
const mockGetWorkspaceAndBoardIdByBoardPublicId =
  boardRepo.getWorkspaceAndBoardIdByBoardPublicId as ReturnType<typeof vi.fn>;
const mockWorkspaceGetByPublicId = workspaceRepo.getByPublicId as ReturnType<
  typeof vi.fn
>;
const mockAssertPermission = assertPermission as ReturnType<typeof vi.fn>;

describe("agent router", () => {
  const mockDb = {} as never;
  const mockUser = {
    id: "user-123",
    name: "Test User",
    email: "test@example.com",
  };
  const mockWorkspace = { id: 1, publicId: "workspace123" };
  const mockAgentToken = {
    id: 7,
    publicId: "token1234567",
    name: "Iskra MCP",
    scopes: ["boards:read"],
    workspaceId: mockWorkspace.id,
    boardId: null,
    active: true,
    createdBy: mockUser.id,
    expiresAt: null,
    workspace: { publicId: mockWorkspace.publicId, name: "Ops" },
    board: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTouchToken.mockResolvedValue(undefined);
    mockAssertPermission.mockResolvedValue(undefined);
    mockFindBoardByName.mockResolvedValue(null);
  });

  it("rejects agent requests without a bearer token", async () => {
    const { agentRouter } = await import("./agent");

    const ctx = {
      user: null,
      db: mockDb,
      headers: new Headers(),
      requestId: "req-1",
    } as never;

    await expect(
      agentRouter.createCaller(ctx).listBoards({
        workspacePublicId: mockWorkspace.publicId,
      }),
    ).rejects.toThrow(TRPCError);
  });

  it("rejects agent requests missing the required scope", async () => {
    const { agentRouter } = await import("./agent");

    mockGetTokenBySecret.mockResolvedValueOnce({
      ...mockAgentToken,
      scopes: [],
    });

    const ctx = {
      user: null,
      db: mockDb,
      headers: new Headers({ authorization: "Bearer kan_agent_test" }),
      requestId: "req-2",
    } as never;

    await expect(
      agentRouter.createCaller(ctx).listBoards({
        workspacePublicId: mockWorkspace.publicId,
      }),
    ).rejects.toThrow(TRPCError);

    expect(mockTouchToken).toHaveBeenCalledWith(mockDb, mockAgentToken.id);
  });

  it("filters board reads to the token board scope", async () => {
    const { agentRouter } = await import("./agent");

    mockGetTokenBySecret.mockResolvedValueOnce({
      ...mockAgentToken,
      boardId: 55,
      board: { publicId: "boardScoped1", name: "AI Inbox" },
    });
    mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
    mockGetAllByWorkspaceId.mockResolvedValueOnce([
      { publicId: "boardScoped1", name: "AI Inbox", lists: [] },
      { publicId: "boardOther01", name: "Other", lists: [] },
    ]);

    const ctx = {
      user: null,
      db: mockDb,
      headers: new Headers({ authorization: "Bearer kan_agent_test" }),
      requestId: "req-3",
    } as never;

    const result = await agentRouter.createCaller(ctx).listBoards({
      workspacePublicId: mockWorkspace.publicId,
    });

    expect(result).toEqual([
      { publicId: "boardScoped1", name: "AI Inbox", lists: [] },
    ]);
  });

  it("returns default token context for MCP discovery", async () => {
    const { agentRouter } = await import("./agent");

    mockGetTokenBySecret.mockResolvedValueOnce(mockAgentToken);
    mockFindBoardByName.mockResolvedValueOnce({
      id: 88,
      publicId: "aiInbox00001",
      name: "AI Inbox",
      lists: [
        { publicId: "doing0000001", name: "Doing", index: 3 },
        { publicId: "captured0001", name: "Captured", index: 0 },
      ],
    });

    const ctx = {
      user: null,
      db: mockDb,
      headers: new Headers({ authorization: "Bearer kan_agent_test" }),
      requestId: "req-context",
    } as never;

    const result = await agentRouter.createCaller(ctx).getContext({});

    expect(result).toEqual({
      workspace: { publicId: mockWorkspace.publicId, name: "Ops" },
      boardScope: null,
      aiInbox: {
        boardPublicId: "aiInbox00001",
        name: "AI Inbox",
        lists: [
          { publicId: "captured0001", name: "Captured", index: 0 },
          { publicId: "doing0000001", name: "Doing", index: 3 },
        ],
      },
      scopes: ["boards:read"],
    });
  });

  it("lists the token scoped workspace for discovery", async () => {
    const { agentRouter } = await import("./agent");

    mockGetTokenBySecret.mockResolvedValueOnce(mockAgentToken);

    const ctx = {
      user: null,
      db: mockDb,
      headers: new Headers({ authorization: "Bearer kan_agent_test" }),
      requestId: "req-workspaces",
    } as never;

    const result = await agentRouter.createCaller(ctx).listWorkspaces({});

    expect(result).toEqual([
      { publicId: mockWorkspace.publicId, name: "Ops", default: true },
    ]);
  });

  it("requires workspace management permission to create an agent token", async () => {
    const { agentRouter } = await import("./agent");

    mockWorkspaceGetByPublicId.mockResolvedValueOnce(mockWorkspace);
    mockGetWorkspaceAndBoardIdByBoardPublicId.mockResolvedValueOnce(null);
    mockCreateToken.mockResolvedValueOnce({
      publicId: "tokenPublic1",
      name: "OpenClaw",
      token: "kan_agent_secret",
      scopes: ["boards:read"],
      expiresAt: null,
    });

    const ctx = {
      user: mockUser,
      db: mockDb,
      headers: new Headers(),
      requestId: "req-4",
    } as never;

    const result = await agentRouter.createCaller(ctx).createToken({
      workspacePublicId: mockWorkspace.publicId,
      name: "OpenClaw",
      scopes: ["boards:read"],
    });

    expect(mockAssertPermission).toHaveBeenCalledWith(
      mockDb,
      mockUser.id,
      mockWorkspace.id,
      "workspace:manage",
    );
    expect(result.token).toBe("kan_agent_secret");
  });
});
