-- CreateTable
CREATE TABLE "ScheduleCalendarEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "roleId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "allDay" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduleCalendarEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowAlternative" (
    "id" TEXT NOT NULL,
    "baseFlowId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "variantFlowId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlowAlternative_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduleCalendarEntry_tenantId_type_idx" ON "ScheduleCalendarEntry"("tenantId", "type");

-- CreateIndex
CREATE INDEX "ScheduleCalendarEntry_roleId_idx" ON "ScheduleCalendarEntry"("roleId");

-- CreateIndex
CREATE INDEX "ScheduleCalendarEntry_startAt_endAt_idx" ON "ScheduleCalendarEntry"("startAt", "endAt");

-- CreateIndex
CREATE UNIQUE INDEX "FlowAlternative_variantFlowId_key" ON "FlowAlternative"("variantFlowId");

-- CreateIndex
CREATE INDEX "FlowAlternative_baseFlowId_idx" ON "FlowAlternative"("baseFlowId");

-- CreateIndex
CREATE UNIQUE INDEX "FlowAlternative_baseFlowId_type_key" ON "FlowAlternative"("baseFlowId", "type");

-- AddForeignKey
ALTER TABLE "ScheduleCalendarEntry" ADD CONSTRAINT "ScheduleCalendarEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduleCalendarEntry" ADD CONSTRAINT "ScheduleCalendarEntry_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowAlternative" ADD CONSTRAINT "FlowAlternative_baseFlowId_fkey" FOREIGN KEY ("baseFlowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowAlternative" ADD CONSTRAINT "FlowAlternative_variantFlowId_fkey" FOREIGN KEY ("variantFlowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;
