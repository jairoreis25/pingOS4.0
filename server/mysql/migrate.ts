/**
 * Migrações do banco MySQL do PingOS — schema + dados mínimos.
 *
 * É **idempotente**: pode rodar quantas vezes quiser (schema com
 * `CREATE TABLE IF NOT EXISTS`, papéis e registros únicos via INSERT/IGNORE).
 *
 * Dois usos:
 *   1. CLI:  `bun run mysql:seed`            (server/mysql/seed.ts)
 *   2. Boot: o container da API chama `runMigrations()` antes de subir
 *      (server/api/boot.ts), controlado por MYSQL_AUTO_MIGRATE.
 *
 * Importante: esta função **não fecha o pool** — quem chama decide.
 */

import { fileURLToPath } from "node:url";
import {
  ADMIN_ROLE,
  ALL_PERMISSIONS,
  DEFAULT_ROLE,
  DEFAULT_USER_PERMISSIONS,
} from "../../src/lib/permissions";
import { loadEnvFile } from "../api/env";
import { hashPassword, normalizeUsername } from "../api/auth";
import {
  applySchema,
  ensureDatabase,
  execute,
  newId,
  query,
  queryOne,
} from "./pool";

/**
 * Colunas que precisam de mais espaço do que o schema original previa.
 *
 * As imagens dos chamados são data URLs (base64 de um JPEG 1200px) e não cabem
 * nos 64 KB do TEXT; no Convex esse campo era uma string sem limite. O schema
 * novo já cria as colunas como MEDIUMTEXT — esta rotina ajusta bancos que já
 * existiam (o CREATE TABLE IF NOT EXISTS não altera tabela criada).
 */
const WIDE_COLUMNS: { table: string; column: string }[] = [
  { table: "tickets", column: "image_url" },
  { table: "users", column: "image" },
];

/**
 * Colunas que entraram no schema depois que ele já estava em produção.
 * `CREATE TABLE IF NOT EXISTS` não altera tabela existente, então estes ALTER
 * rodam no boot para os bancos antigos acompanharem o schema novo.
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  {
    // Produto x Serviço no catálogo (Configurações → Produtos e Serviços).
    table: "products_services",
    column: "item_type",
    ddl: "`item_type` ENUM('produto','servico') NOT NULL DEFAULT 'servico'",
  },
  {
    // Categoria do chamado (dropdown de edição) — classificação interna.
    table: "tickets",
    column: "categoria",
    ddl: "`categoria` VARCHAR(40) NULL",
  },
  {
    // Relatório de auditoria de notificações: para quem o envio foi feito.
    table: "notifications",
    column: "recipient",
    ddl: "`recipient` VARCHAR(255) NULL",
  },
  {
    // Regra de inatividade que originou o envio (quando houver).
    table: "notifications",
    column: "rule_id",
    ddl: "`rule_id` VARCHAR(64) NULL",
  },
  {
    // Id do administrador no Telegram (o antigo ADMIN_ID de ambiente), agora
    // preenchido pelo dashboard em Configurações → Bot Ping IA.
    table: "bot_config",
    column: "admin_id",
    ddl: "`admin_id` VARCHAR(64) NULL",
  },
  {
    // Modelo de visão (leitura de fotos de O.S.), separado do modelo de texto.
    table: "bot_config",
    column: "modelo_visao",
    ddl: "`modelo_visao` VARCHAR(150) NULL",
  },
  {
    // Provedor de IA do bot (NVIDIA, OpenAI, Gemini, Anthropic...). O padrão
    // 'nvidia' mantém funcionando quem já usava o agente antes desta coluna.
    table: "bot_config",
    column: "provider",
    ddl: "`provider` VARCHAR(32) NOT NULL DEFAULT 'nvidia'",
  },
  {
    // URL base alternativa (endpoint próprio compatível com a OpenAI/Azure).
    table: "bot_config",
    column: "base_url",
    ddl: "`base_url` VARCHAR(255) NULL",
  },
];

/**
 * Índices dos filtros dos relatórios.
 *
 * Os relatórios filtram por período + status/prioridade/responsável, quase
 * sempre nessa ordem, então o índice composto (coluna do filtro, data) resolve
 * a consulta sem varrer a tabela. `CREATE INDEX IF NOT EXISTS` não existe no
 * MySQL, daí a checagem em information_schema.
 */
const ADDED_INDEXES: { table: string; name: string; columns: string }[] = [
  { table: "tickets", name: "idx_tickets_status_created", columns: "`status`, `created_at`" },
  { table: "tickets", name: "idx_tickets_assignee_status", columns: "`assignee_id`, `status`" },
  { table: "tickets", name: "idx_tickets_priority_created", columns: "`priority`, `created_at`" },
  // Filtros do bot Ping IA ("chamados parados", atualizado_apos/antes).
  { table: "tickets", name: "idx_tickets_updated_at", columns: "`updated_at`" },
  // Busca de chamado pela O.S. impressa (evita cadastrar a mesma foto duas vezes).
  { table: "tickets", name: "idx_tickets_os", columns: "`os`" },
];

async function ensureWideColumns(): Promise<void> {
  for (const target of WIDE_COLUMNS) {
    const column = await queryOne<{ data_type: string }>(
      `SELECT DATA_TYPE AS data_type FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [target.table, target.column],
    );
    if (!column || column.data_type.toLowerCase() === "mediumtext") continue;
    await execute(`ALTER TABLE \`${target.table}\` MODIFY \`${target.column}\` MEDIUMTEXT NULL`);
    console.log(`[migrate] ${target.table}.${target.column}: ${column.data_type} → MEDIUMTEXT`);
  }
}

/** Adiciona a coluna se ela faltar. Lança se o banco recusar o ALTER. */
async function addColumnIfMissing(target: {
  table: string;
  column: string;
  ddl: string;
}): Promise<void> {
  const column = await queryOne<{ data_type: string }>(
    `SELECT DATA_TYPE AS data_type FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [target.table, target.column],
  );
  if (column) return;
  await execute(`ALTER TABLE \`${target.table}\` ADD COLUMN ${target.ddl}`);
  console.log(`[migrate] ${target.table}.${target.column}: coluna adicionada`);
}

async function ensureAddedColumns(): Promise<void> {
  for (const target of ADDED_COLUMNS) await addColumnIfMissing(target);
}

/**
 * Garante uma coluna pontual desta lista, na hora, **sem lançar**.
 *
 * Existe para o caso do banco ser anterior à coluna e o serviço da API ainda
 * não ter subido com a migração nova: aí o `UPDATE` estourava com "Unknown
 * column ... in 'field list'" e o administrador não conseguia salvar nada pelo
 * dashboard. Quem chama usa o retorno para montar a query com ou sem a coluna.
 *
 * Devolve `true` quando a coluna existe ao final do processo.
 */
export async function ensureColumn(
  table: string,
  column: string,
): Promise<boolean> {
  const target = ADDED_COLUMNS.find(
    (item) => item.table === table && item.column === column,
  );
  if (!target) return false;
  try {
    await addColumnIfMissing(target);
    return true;
  } catch (error) {
    console.warn(
      `[migrate] não deu para garantir ${table}.${column}:`,
      error instanceof Error ? error.message : error,
    );
    return false;
  }
}

async function ensureAddedIndexes(): Promise<void> {
  for (const target of ADDED_INDEXES) {
    const index = await queryOne<{ INDEX_NAME: string }>(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
      [target.table, target.name],
    );
    if (index) continue;
    await execute(
      `CREATE INDEX \`${target.name}\` ON \`${target.table}\` (${target.columns})`,
    );
    console.log(`[migrate] ${target.table}.${target.name}: índice criado`);
  }
}

const DEFAULT_ROLES = [
  { name: ADMIN_ROLE, permissions: [...ALL_PERMISSIONS], isSystem: 1 },
  { name: DEFAULT_ROLE, permissions: [...DEFAULT_USER_PERMISSIONS], isSystem: 1 },
];

/**
 * Garante as 4 personalidades do bot (o `slot` é UNIQUE, então `INSERT IGNORE`
 * só cria as que faltam e nunca sobrescreve o que o admin editou).
 */
async function ensureBotPersonalidades(): Promise<void> {
  try {
    await execute(
      `INSERT IGNORE INTO \`bot_personalidades\` (\`slot\`, \`nome\`, \`emoji\`, \`fixo\`) VALUES
         (1, 'Padrão', '🤖', 1),
         (2, 'Descontraída', '🎭', 0),
         (3, 'Ranzinza', '😒', 0),
         (4, 'Preguiçoso', '😴', 0)`,
    );
  } catch (error) {
    // Sem permissão de DDL a tabela pode não existir: as personalidades são um
    // extra do bot, não podem derrubar o boot da API.
    console.warn(
      "[migrate] não deu para garantir as personalidades do bot:",
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * Garante o schema inteiro na hora e **nunca lança**.
 *
 * `runMigrations()` é o caminho oficial (boot da API). Esta versão existe para
 * os processos que podem ficar mais novos que o banco: um serviço reimplantado
 * sozinho (o `bot` do Telegram sem o `api`, por exemplo) usava tabelas que só a
 * migração da API criava — `acoes_pendentes`, `audit_log` — e quebrava com
 * "Table doesn't exist". Sem permissão de DDL, quem chama apenas segue.
 */
export async function ensureSchema(): Promise<void> {
  try {
    await ensureDatabase();
    await applySchema(fileURLToPath(new URL("./schema.sql", import.meta.url)));
    await ensureWideColumns();
    await ensureAddedColumns();
    await ensureAddedIndexes();
    await ensureBotPersonalidades();
    console.log("[migrate] schema verificado (tabelas, colunas e índices).");
  } catch (error) {
    console.warn(
      "[migrate] não deu para garantir o schema:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** Garante schema, papéis padrão, registros únicos e (opcional) o 1º admin. */
export async function runMigrations(): Promise<void> {
  const envInfo = loadEnvFile();
  console.log(`[migrate] env: ${envInfo.file ?? "(nenhum — usando o ambiente)"}`);

  // 1. Garante o banco e as tabelas (idempotente).
  await ensureDatabase();
  console.log(`[migrate] banco "${process.env.MYSQL_DATABASE ?? "pingos"}" garantido.`);
  await applySchema(fileURLToPath(new URL("./schema.sql", import.meta.url)));
  console.log("[migrate] schema aplicado (CREATE TABLE IF NOT EXISTS).");
  await ensureWideColumns();
  await ensureAddedColumns();
  await ensureAddedIndexes();
  await ensureBotPersonalidades();

  // 2. Papéis padrão.
  for (const role of DEFAULT_ROLES) {
    const existing = await queryOne<{ id: string; permissions: unknown }>(
      "SELECT `id`, `permissions` FROM `roles` WHERE `name` = ?",
      [role.name],
    );
    if (existing) {
      console.log(`[migrate] papel "${role.name}" já existe — mantido.`);
      continue;
    }
    await execute(
      "INSERT INTO `roles` (`id`, `name`, `permissions`, `is_system`, `created_at`) VALUES (?, ?, ?, ?, ?)",
      [newId(), role.name, JSON.stringify(role.permissions), role.isSystem, Date.now()],
    );
    console.log(
      `[migrate] papel "${role.name}" criado (${role.permissions.length} permissões).`,
    );
  }

  // 3. Registros únicos.
  await execute(
    "INSERT IGNORE INTO `counters` (`name`, `value`) SELECT 'ticket_number', COALESCE(MAX(`number`), 0) FROM `tickets`",
  );
  await execute(
    `INSERT INTO notification_settings
       (id, email_enabled, email_recipients, telegram_enabled, whatsapp_enabled, whatsapp_recipients)
     VALUES (1, 0, JSON_ARRAY(), 0, 0, JSON_ARRAY())
     ON DUPLICATE KEY UPDATE id = id`,
  );

  // 4. Primeiro administrador (opcional).
  const username = normalizeUsername(process.env.ADMIN_USERNAME ?? "");
  const password = process.env.ADMIN_PASSWORD ?? "";
  if (username && password) {
    if (password.length < 8) {
      throw new Error("[migrate] ADMIN_PASSWORD precisa ter pelo menos 8 caracteres.");
    }
    const existing = await queryOne<{ id: string }>(
      "SELECT `id` FROM `users` WHERE `email` = ? OR `username` = ? LIMIT 1",
      [username, username],
    );
    if (existing) {
      console.log(`[migrate] usuário "${username}" já existe — senha não alterada.`);
    } else {
      const now = Date.now();
      await execute(
        `INSERT INTO users
           (id, name, email, username, password_hash, email_verification_time, is_anonymous, role, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'admin', 1, ?, ?)`,
        [
          newId(),
          process.env.ADMIN_NAME ?? "Administrador",
          username,
          username,
          await hashPassword(password),
          now,
          now,
          now,
        ],
      );
      console.log(`[migrate] administrador "${username}" criado.`);
    }
  } else {
    console.log(
      "[migrate] nenhum admin criado. Use POST /api/auth/setup (1º acesso) ou defina ADMIN_USERNAME e ADMIN_PASSWORD.",
    );
  }

  const [{ total }] = await query<{ total: number }>("SELECT COUNT(*) AS total FROM `users`");
  console.log(`[migrate] concluído — ${total} usuário(s) no banco.`);
}
