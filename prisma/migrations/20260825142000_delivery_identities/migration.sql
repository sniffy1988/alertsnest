-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "telegramId" BIGINT,
    "whatsappPhone" TEXT,
    "viberId" TEXT,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "registeredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "silentMode" BOOLEAN NOT NULL DEFAULT false,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT NOT NULL DEFAULT 'ua',
    "isBanned" BOOLEAN NOT NULL DEFAULT false,
    "lat" REAL,
    "lon" REAL,
    "radiusKm" INTEGER NOT NULL DEFAULT 40,
    "oblastCode" TEXT,
    "locationUpdatedAt" DATETIME
);
INSERT INTO "new_User" (
    "id", "telegramId", "username", "firstName", "lastName", "registeredAt",
    "silentMode", "isAdmin", "locale", "isBanned", "lat", "lon", "radiusKm",
    "oblastCode", "locationUpdatedAt"
)
SELECT
    "id", "telegramId", "username", "firstName", "lastName", "registeredAt",
    "silentMode", "isAdmin", "locale", "isBanned", "lat", "lon", "radiusKm",
    "oblastCode", "locationUpdatedAt"
FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");
CREATE UNIQUE INDEX "User_whatsappPhone_key" ON "User"("whatsappPhone");
CREATE UNIQUE INDEX "User_viberId_key" ON "User"("viberId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
