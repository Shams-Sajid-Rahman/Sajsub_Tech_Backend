-- AlterEnum
ALTER TYPE "OrderStatus" RENAME VALUE 'RETURNED' TO 'REFUNDED';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'ONLINE' AFTER 'CASH_ON_DELIVERY';



-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "carrier" VARCHAR(100),
ADD COLUMN     "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'CASH_ON_DELIVERY',
ADD COLUMN     "trackingNumber" VARCHAR(100);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "failureReason" VARCHAR(255),
ADD COLUMN     "gatewayUrl" VARCHAR(1000),
ADD COLUMN     "needsRefund" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "refundedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "riskFlagged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transactionRef" VARCHAR(64);

-- CreateTable
CREATE TABLE "order_status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderId" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL,
    "note" VARCHAR(500),
    "changedById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orderId" UUID NOT NULL,
    "paymentId" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "reference" VARCHAR(255),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "order_status_history_orderId_createdAt_idx" ON "order_status_history"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "refunds_orderId_idx" ON "refunds"("orderId");

-- CreateIndex
CREATE INDEX "refunds_paymentId_idx" ON "refunds"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "payments_transactionRef_key" ON "payments"("transactionRef");

-- CreateIndex
CREATE INDEX "payments_needsRefund_idx" ON "payments"("needsRefund");

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_status_history" ADD CONSTRAINT "order_status_history_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written rules. See docs/ER_DIAGRAM.md.
ALTER TABLE "payments" ADD CONSTRAINT "payments_refunded_within_amount" CHECK ("refundedAmount" >= 0 AND "refundedAmount" <= "amount");
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("amount" > 0);
-- Only one payment attempt per order can be open at a time.
CREATE UNIQUE INDEX "payments_one_open_online_attempt" ON "payments" ("orderId") WHERE "status" = 'PENDING' AND "transactionRef" IS NOT NULL;
