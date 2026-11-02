-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "idempotencyKey" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "orders_userId_idempotencyKey_key" ON "orders"("userId", "idempotencyKey");

