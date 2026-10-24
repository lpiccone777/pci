-- AlterTable
ALTER TABLE "Conversation" ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Flow" ADD COLUMN     "channel" TEXT NOT NULL DEFAULT 'text';

-- CreateTable
CREATE TABLE "VoiceCall" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extensionId" TEXT,
    "extensionNumber" TEXT NOT NULL,
    "calledNumber" TEXT,
    "callerNumber" TEXT,
    "direction" TEXT NOT NULL DEFAULT 'inbound',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,
    "lastSpoken" JSONB,
    "turnLockToken" TEXT,
    "turnLockUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceTurn" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT,
    "response" JSONB,
    "committed" BOOLEAN NOT NULL DEFAULT false,
    "superseded" BOOLEAN NOT NULL DEFAULT false,
    "snapshot" JSONB,
    "userMessageId" TEXT,
    "botMessageId" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VoiceTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceCall_conversationId_key" ON "VoiceCall"("conversationId");

-- CreateIndex
CREATE INDEX "VoiceCall_tenantId_idx" ON "VoiceCall"("tenantId");

-- CreateIndex
CREATE INDEX "VoiceTurn_callId_createdAt_idx" ON "VoiceTurn"("callId", "createdAt");

-- CreateIndex
CREATE INDEX "Flow_channel_idx" ON "Flow"("channel");

-- AddForeignKey
ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceTurn" ADD CONSTRAINT "VoiceTurn_callId_fkey" FOREIGN KEY ("callId") REFERENCES "VoiceCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

