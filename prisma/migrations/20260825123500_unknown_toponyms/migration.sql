-- CreateTable
CREATE TABLE "UnknownToponym" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "label" TEXT NOT NULL,
    "norm" TEXT NOT NULL,
    "sampleText" TEXT,
    "channel" TEXT,
    "hitCount" INTEGER NOT NULL DEFAULT 1,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "UnknownToponym_norm_key" ON "UnknownToponym"("norm");
