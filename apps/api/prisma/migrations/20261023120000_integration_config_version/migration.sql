-- CreateTable
CREATE TABLE "IntegrationConfigVersion" (
    "id" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationConfigVersion_pkey" PRIMARY KEY ("id")
);

-- La única fila: así el incremento siempre es un UPDATE atómico, sin carrera de creación.
INSERT INTO "IntegrationConfigVersion" ("id", "version", "updatedAt") VALUES ('voicebot', 0, CURRENT_TIMESTAMP);
