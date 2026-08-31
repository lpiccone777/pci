-- CreateTable
CREATE TABLE "PendingTenantSelection" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "originalBody" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PendingTenantSelection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingTenantSelection_phone_channel_key" ON "PendingTenantSelection"("phone", "channel");

-- Limpieza: el ruteo del tenant entrante ahora sale de la membresía del teléfono, no de
-- configuración. Se eliminan las opciones "Tenant que recibe los mensajes" que hayan quedado
-- guardadas por canal (ya no existen en el catálogo de settings).
DELETE FROM "Setting" WHERE "key" IN (
  'WHATSAPP_TENANT_ID',
  'TWILIO_TENANT_ID',
  'GUPSHUP_WHATSAPP_TENANT_ID',
  'TWILIO_SMS_TENANT_ID',
  'GUPSHUP_SMS_TENANT_ID'
);
