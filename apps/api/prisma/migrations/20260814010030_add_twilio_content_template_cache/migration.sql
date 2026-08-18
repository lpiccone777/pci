-- CreateTable
CREATE TABLE "TwilioContentTemplate" (
    "id" TEXT NOT NULL,
    "shapeHash" TEXT NOT NULL,
    "contentSid" TEXT NOT NULL,
    "friendlyName" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TwilioContentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TwilioContentTemplate_shapeHash_key" ON "TwilioContentTemplate"("shapeHash");

-- CreateIndex
CREATE INDEX "TwilioContentTemplate_shapeHash_idx" ON "TwilioContentTemplate"("shapeHash");
