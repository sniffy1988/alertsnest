-- Allow multiple place alerts from the same message (one delivery per eventKey).
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AlertDelivery" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "eventKey" TEXT NOT NULL DEFAULT '',
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "new_AlertDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "new_AlertDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_AlertDelivery" ("id", "userId", "messageId", "eventKey", "sentAt")
SELECT "id", "userId", "messageId", COALESCE("eventKey", ''), "sentAt" FROM "AlertDelivery";
DROP TABLE "AlertDelivery";
ALTER TABLE "new_AlertDelivery" RENAME TO "AlertDelivery";
CREATE UNIQUE INDEX "AlertDelivery_userId_messageId_eventKey_key" ON "AlertDelivery"("userId", "messageId", "eventKey");
CREATE INDEX "AlertDelivery_userId_eventKey_idx" ON "AlertDelivery"("userId", "eventKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
