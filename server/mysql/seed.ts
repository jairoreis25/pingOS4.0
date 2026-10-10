/**
 * Seed do banco MySQL — CLI para `bun run mysql:seed`.
 *
 * Toda a lógica vive em `migrate.ts` (a mesma que o container da API executa no
 * boot). Aqui é só o wrapper: roda, fecha o pool e devolve o código de saída.
 *
 *   bun run mysql:seed
 *   ADMIN_USERNAME=admin ADMIN_PASSWORD=senha-forte bun run mysql:seed
 */

import { runMigrations } from "./migrate"
import { closePool } from "./pool"

runMigrations()
  .catch((error) => {
    console.error("\n❌ Falha no seed:", error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => {
    await closePool()
  })
