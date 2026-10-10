/**
 * Boot do container da API MySQL.
 *
 * No Dokploy não existe um passo "rode o seed na mão": o container precisa
 * chegar já com o banco pronto. Este entrypoint faz, nesta ordem:
 *
 *   1. carrega `mysql-api.env` (se existir — em Docker as variáveis vêm do
 *      ambiente do serviço)
 *   2. se MYSQL_AUTO_MIGRATE não for `false`, aplica o schema + papéis + o
 *      admin definido em ADMIN_USERNAME/ADMIN_PASSWORD (idempotente)
 *   3. sobe o servidor Express (server/api/index.ts)
 *
 * A migração é "melhor esforço": se o banco ainda não estiver acessível, o erro
 * é registrado no log e a API sobe mesmo assim — o `/api/health` responde 503
 * com o motivo, o que é bem mais fácil de diagnosticar do que um container em
 * restart loop. Basta reiniciar o serviço depois de corrigir as credenciais.
 */

import { loadEnvFile } from "./env";

const envInfo = loadEnvFile();
console.log(`[boot] env: ${envInfo.file ?? "(nenhum — usando o ambiente do container)"}`);

function isEnabled(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return !["0", "false", "nao", "não", "no", "off"].includes(value.trim().toLowerCase());
}

async function main(): Promise<void> {
  if (isEnabled(process.env.MYSQL_AUTO_MIGRATE, true)) {
    try {
      const { runMigrations } = await import("../mysql/migrate");
      await runMigrations();
    } catch (error) {
      console.error(
        "\n⚠️  [boot] migração automática falhou — a API vai subir mesmo assim.",
        "\n    Motivo:",
        error instanceof Error ? error.message : error,
        "\n    Confira MYSQL_HOST/PORT/USER/PASSWORD/DATABASE na aba Environment",
        "\n    (num banco criado no Dokploy, MYSQL_HOST é o 'Internal Host' da aba Connection).",
        "\n    Para desligar esta etapa: MYSQL_AUTO_MIGRATE=false\n",
      );
    }
  } else {
    console.log("[boot] MYSQL_AUTO_MIGRATE desligado — pulando migrações.");
  }

  await import("./index");
}

void main();
