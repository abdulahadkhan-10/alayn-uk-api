-- AlterTable
ALTER TABLE "WasteLog" ADD COLUMN IF NOT EXISTS "unitCostAtLoggingPaise" INTEGER;
ALTER TABLE "WasteLog" ADD COLUMN IF NOT EXISTS "notes" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "WasteLog_outletId_createdAt_idx" ON "WasteLog"("outletId", "createdAt");

-- CreateTable
CREATE TABLE IF NOT EXISTS "AiChat" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "businessId" UUID,
    "outletKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "AiChatMessage" (
    "id" UUID NOT NULL,
    "chatId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "topics" TEXT NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'done',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "AiChat_userId_outletKey_updatedAt_idx" ON "AiChat"("userId", "outletKey", "updatedAt");
CREATE INDEX IF NOT EXISTS "AiChat_updatedAt_idx" ON "AiChat"("updatedAt");
CREATE INDEX IF NOT EXISTS "AiChatMessage_chatId_createdAt_idx" ON "AiChatMessage"("chatId", "createdAt");

-- AddForeignKey
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiChat_userId_fkey') THEN
        ALTER TABLE "AiChat" ADD CONSTRAINT "AiChat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AiChatMessage_chatId_fkey') THEN
        ALTER TABLE "AiChatMessage" ADD CONSTRAINT "AiChatMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "AiChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
