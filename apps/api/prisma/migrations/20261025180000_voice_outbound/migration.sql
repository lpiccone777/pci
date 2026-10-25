-- Salientes desde pci (H5, contrato C63)

-- AlterTable
ALTER TABLE "VoiceCall" ALTER COLUMN "extensionNumber" DROP NOT NULL;
ALTER TABLE "VoiceCall" ADD COLUMN "outboundAttemptId" TEXT;

-- CreateTable
CREATE TABLE "VoiceOutbound" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdById" TEXT,
    "mode" TEXT NOT NULL,
    "flowId" TEXT,
    "to" TEXT[],
    "audioUrl" TEXT,
    "digits" TEXT,
    "maxRounds" INTEGER NOT NULL,
    "retryDelayMs" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "outcome" TEXT,
    "attemptsCount" INTEGER NOT NULL DEFAULT 0,
    "busyCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lockUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VoiceOutbound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceOutboundAttempt" (
    "id" TEXT NOT NULL,
    "outboundId" TEXT NOT NULL,
    "to" TEXT,
    "round" INTEGER,
    "outcome" TEXT,
    "answered" BOOLEAN NOT NULL DEFAULT false,
    "digit" TEXT,
    "lastAttempt" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resultAt" TIMESTAMP(3),

    CONSTRAINT "VoiceOutboundAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "VoiceCall_outboundAttemptId_key" ON "VoiceCall"("outboundAttemptId");

-- CreateIndex
CREATE INDEX "VoiceOutbound_tenantId_createdAt_idx" ON "VoiceOutbound"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "VoiceOutbound_status_nextAttemptAt_idx" ON "VoiceOutbound"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "VoiceOutboundAttempt_outboundId_createdAt_idx" ON "VoiceOutboundAttempt"("outboundId", "createdAt");

-- AddForeignKey
ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_outboundAttemptId_fkey" FOREIGN KEY ("outboundAttemptId") REFERENCES "VoiceOutboundAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceOutbound" ADD CONSTRAINT "VoiceOutbound_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceOutbound" ADD CONSTRAINT "VoiceOutbound_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceOutbound" ADD CONSTRAINT "VoiceOutbound_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceOutboundAttempt" ADD CONSTRAINT "VoiceOutboundAttempt_outboundId_fkey" FOREIGN KEY ("outboundId") REFERENCES "VoiceOutbound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
