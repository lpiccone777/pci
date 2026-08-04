-- Separa `User.name` en `firstName` / `lastName`.
-- Migración manual (no autogenerada) para preservar los datos existentes:
-- `prisma migrate dev` habría dropeado la columna sin copiar nada.

ALTER TABLE "User" ADD COLUMN "firstName" TEXT;
ALTER TABLE "User" ADD COLUMN "lastName" TEXT;

-- Nombres compuestos: primera palabra a firstName, el resto a lastName.
UPDATE "User"
SET "firstName" = NULLIF(split_part("name", ' ', 1), ''),
    "lastName"  = NULLIF(TRIM(SUBSTRING("name" FROM POSITION(' ' IN "name") + 1)), '')
WHERE "name" IS NOT NULL
  AND POSITION(' ' IN "name") > 0;

-- Nombre de una sola palabra: va entero a firstName, lastName queda NULL.
UPDATE "User"
SET "firstName" = NULLIF(TRIM("name"), '')
WHERE "name" IS NOT NULL
  AND POSITION(' ' IN "name") = 0;

ALTER TABLE "User" DROP COLUMN "name";
