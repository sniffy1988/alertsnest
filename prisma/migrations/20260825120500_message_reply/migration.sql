-- AlterTable
ALTER TABLE "Message" ADD COLUMN "replyToTelegramId" BIGINT;

-- CreateIndex
CREATE INDEX "Message_channelId_replyToTelegramId_idx" ON "Message"("channelId", "replyToTelegramId");
