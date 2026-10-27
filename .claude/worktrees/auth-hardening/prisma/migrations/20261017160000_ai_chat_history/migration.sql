-- CreateTable
CREATE TABLE "AiChat" (
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
CREATE TABLE "AiChatMessage" (
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
CREATE INDEX "AiChat_userId_outletKey_updatedAt_idx" ON "AiChat"("userId", "outletKey", "updatedAt");

-- CreateIndex
CREATE INDEX "AiChat_updatedAt_idx" ON "AiChat"("updatedAt");

-- CreateIndex
CREATE INDEX "AiChatMessage_chatId_createdAt_idx" ON "AiChatMessage"("chatId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiChat" ADD CONSTRAINT "AiChat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiChatMessage" ADD CONSTRAINT "AiChatMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "AiChat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

