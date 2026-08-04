-- Agrega `context` a Flow: fuente de datos que respalda las respuestas del flujo.
-- Default 'none' para que los flujos existentes queden como "genérico / sin fuente".

ALTER TABLE "Flow" ADD COLUMN "context" TEXT NOT NULL DEFAULT 'none';

CREATE INDEX "Flow_context_idx" ON "Flow"("context");
