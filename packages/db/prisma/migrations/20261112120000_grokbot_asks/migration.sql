-- Create table for ask_grokbot advisor consultations (pending replies resolved
-- by inbound grokbot webhooks in the API process; polled by the worker tool).
CREATE TABLE "grokbot_asks" (
    "id" TEXT NOT NULL,
    "correlation" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "reply" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grokbot_asks_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "grokbot_asks_correlation_key" ON "grokbot_asks"("correlation");
CREATE INDEX "grokbot_asks_status_expiresAt_idx" ON "grokbot_asks"("status", "expiresAt");
