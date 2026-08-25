-- CreateTable
CREATE TABLE "Channel" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT,
    "link" TEXT NOT NULL,
    "scrapTimeout" INTEGER NOT NULL DEFAULT 3000,
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "lastScrapedAt" DATETIME,
    "lastTelegramId" BIGINT NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "Message" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "telegramId" BIGINT NOT NULL,
    "message" TEXT NOT NULL,
    "mediaUrl" TEXT,
    "mediaType" TEXT,
    "date" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "channelId" INTEGER NOT NULL,
    CONSTRAINT "Message_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MessageAnalysis" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "messageId" INTEGER NOT NULL,
    "isThreat" BOOLEAN NOT NULL,
    "severity" TEXT,
    "threatType" TEXT,
    "summary" TEXT,
    "eventKey" TEXT,
    "rawJson" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MessageAnalysis_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ThreatPlace" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "messageId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "lat" REAL,
    "lon" REAL,
    "oblastCode" TEXT,
    "matchType" TEXT NOT NULL,
    CONSTRAINT "ThreatPlace_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "telegramId" BIGINT NOT NULL,
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

-- CreateTable
CREATE TABLE "FilterPhrase" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "phrase" TEXT NOT NULL,
    "exclude" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "Toponym" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "norm" TEXT NOT NULL,
    "aliases" TEXT NOT NULL DEFAULT '[]',
    "lat" REAL NOT NULL,
    "lon" REAL NOT NULL,
    "kind" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "Toponym_norm_key" ON "Toponym"("norm");

-- CreateTable
CREATE TABLE "AlertDelivery" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "messageId" INTEGER NOT NULL,
    "eventKey" TEXT,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AlertDelivery_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AlertDelivery_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_UserSubscriptions" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL,
    CONSTRAINT "_UserSubscriptions_A_fkey" FOREIGN KEY ("A") REFERENCES "Channel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_UserSubscriptions_B_fkey" FOREIGN KEY ("B") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Channel_link_key" ON "Channel"("link");

-- CreateIndex
CREATE UNIQUE INDEX "Message_telegramId_channelId_key" ON "Message"("telegramId", "channelId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageAnalysis_messageId_key" ON "MessageAnalysis"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "User_telegramId_key" ON "User"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "FilterPhrase_phrase_key" ON "FilterPhrase"("phrase");

-- CreateIndex
CREATE UNIQUE INDEX "AlertDelivery_userId_messageId_key" ON "AlertDelivery"("userId", "messageId");

-- CreateIndex
CREATE INDEX "AlertDelivery_userId_eventKey_idx" ON "AlertDelivery"("userId", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "_UserSubscriptions_AB_unique" ON "_UserSubscriptions"("A", "B");

-- CreateIndex
CREATE INDEX "_UserSubscriptions_B_index" ON "_UserSubscriptions"("B");
