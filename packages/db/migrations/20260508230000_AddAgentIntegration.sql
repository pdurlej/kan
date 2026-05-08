DO $$ BEGIN
 CREATE TYPE "public"."agent_proposal_status" AS ENUM('proposed', 'approved', 'applied', 'rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."agent_approval_state" AS ENUM('draft', 'proposed', 'approved', 'applied', 'rejected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."agent_source" AS ENUM('signal', 'fastmail', 'meeting', 'forgejo', 'manual', 'obsidian', 'iskra', 'n8n');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."agent_created_by_kind" AS ENUM('human', 'iskra', 'n8n', 'import');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."agent_sensitivity" AS ENUM('normal', 'private', 'sensitive');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_token" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publicId" varchar(12) NOT NULL,
	"name" varchar(255) NOT NULL,
	"tokenHash" text NOT NULL,
	"scopes" text NOT NULL,
	"workspaceId" bigint NOT NULL,
	"boardId" bigint,
	"active" boolean DEFAULT true NOT NULL,
	"createdBy" uuid NOT NULL,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp,
	"lastUsedAt" timestamp,
	"expiresAt" timestamp,
	CONSTRAINT "agent_token_publicId_unique" UNIQUE("publicId"),
	CONSTRAINT "agent_token_tokenHash_unique" UNIQUE("tokenHash")
);
--> statement-breakpoint
ALTER TABLE "agent_token" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_audit_event" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publicId" varchar(12) NOT NULL,
	"tokenId" bigint,
	"workspaceId" bigint NOT NULL,
	"boardId" bigint,
	"cardId" bigint,
	"action" varchar(100) NOT NULL,
	"mode" varchar(40) NOT NULL,
	"actor" varchar(255) NOT NULL,
	"requestId" text,
	"idempotencyKey" text,
	"input" text,
	"result" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_audit_event_publicId_unique" UNIQUE("publicId")
);
--> statement-breakpoint
ALTER TABLE "agent_audit_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_proposal" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publicId" varchar(12) NOT NULL,
	"tokenId" bigint,
	"workspaceId" bigint NOT NULL,
	"boardId" bigint,
	"title" varchar(255) NOT NULL,
	"summary" text,
	"actions" text NOT NULL,
	"status" "agent_proposal_status" DEFAULT 'proposed' NOT NULL,
	"createdBy" varchar(255) NOT NULL,
	"decidedBy" uuid,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"decidedAt" timestamp,
	"appliedAt" timestamp,
	CONSTRAINT "agent_proposal_publicId_unique" UNIQUE("publicId")
);
--> statement-breakpoint
ALTER TABLE "agent_proposal" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_card_metadata" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"publicId" varchar(12) NOT NULL,
	"cardId" bigint NOT NULL,
	"source" "agent_source",
	"sourceRef" text,
	"createdByKind" "agent_created_by_kind",
	"approvalState" "agent_approval_state" DEFAULT 'draft' NOT NULL,
	"sensitivity" "agent_sensitivity" DEFAULT 'normal' NOT NULL,
	"relationshipRef" text,
	"projectRef" text,
	"lastAiSummary" text,
	"createdAt" timestamp DEFAULT now() NOT NULL,
	"updatedAt" timestamp,
	CONSTRAINT "agent_card_metadata_publicId_unique" UNIQUE("publicId")
);
--> statement-breakpoint
ALTER TABLE "agent_card_metadata" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_token_workspace_idx" ON "agent_token" USING btree ("workspaceId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_token_board_idx" ON "agent_token" USING btree ("boardId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_token_active_idx" ON "agent_token" USING btree ("active");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_audit_workspace_idx" ON "agent_audit_event" USING btree ("workspaceId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_audit_board_idx" ON "agent_audit_event" USING btree ("boardId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_audit_card_idx" ON "agent_audit_event" USING btree ("cardId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_audit_created_at_idx" ON "agent_audit_event" USING btree ("createdAt");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_audit_idempotency_idx" ON "agent_audit_event" USING btree ("tokenId","action","idempotencyKey") WHERE "idempotencyKey" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_proposal_workspace_idx" ON "agent_proposal" USING btree ("workspaceId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_proposal_board_idx" ON "agent_proposal" USING btree ("boardId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_proposal_status_idx" ON "agent_proposal" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_card_metadata_card_idx" ON "agent_card_metadata" USING btree ("cardId");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_card_metadata_source_idx" ON "agent_card_metadata" USING btree ("source");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_card_metadata_approval_idx" ON "agent_card_metadata" USING btree ("approvalState");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_token" ADD CONSTRAINT "agent_token_workspaceId_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_token" ADD CONSTRAINT "agent_token_boardId_board_id_fk" FOREIGN KEY ("boardId") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_token" ADD CONSTRAINT "agent_token_createdBy_user_id_fk" FOREIGN KEY ("createdBy") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_audit_event" ADD CONSTRAINT "agent_audit_event_tokenId_agent_token_id_fk" FOREIGN KEY ("tokenId") REFERENCES "public"."agent_token"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_audit_event" ADD CONSTRAINT "agent_audit_event_workspaceId_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_audit_event" ADD CONSTRAINT "agent_audit_event_boardId_board_id_fk" FOREIGN KEY ("boardId") REFERENCES "public"."board"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_audit_event" ADD CONSTRAINT "agent_audit_event_cardId_card_id_fk" FOREIGN KEY ("cardId") REFERENCES "public"."card"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_tokenId_agent_token_id_fk" FOREIGN KEY ("tokenId") REFERENCES "public"."agent_token"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_workspaceId_workspace_id_fk" FOREIGN KEY ("workspaceId") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_boardId_board_id_fk" FOREIGN KEY ("boardId") REFERENCES "public"."board"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_proposal" ADD CONSTRAINT "agent_proposal_decidedBy_user_id_fk" FOREIGN KEY ("decidedBy") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_card_metadata" ADD CONSTRAINT "agent_card_metadata_cardId_card_id_fk" FOREIGN KEY ("cardId") REFERENCES "public"."card"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
