/**
 * Backup e restauração do banco MySQL (painel do Administrador).
 *
 * Formato: **um arquivo .json** com o conteúdo de todas as tabelas de dados —
 * o mesmo formato que o painel já oferecia (gerar, baixar, restaurar a partir de
 * um arquivo salvo no servidor ou enviado do computador).
 *
 * Por que JSON e não `mysqldump`? O container da API roda a imagem
 * `oven/bun:1-slim`, que não tem os clientes do MySQL instalados. Ler as tabelas
 * pelo pool (que já está conectado e autenticado) funciona em qualquer lugar —
 * inclusive em bancos gerenciados onde não há acesso à máquina do servidor.
 *
 * Estrutura do arquivo:
 *
 *   {
 *     "app": "PingOS", "format": "pingos-backup", "version": 1,
 *     "createdAt": 1757850000000, "database": "pingos",
 *     "counts": { "tickets": 42, ... },
 *     "tables": { "users": [ { ...colunas... } ], "tickets": [ ... ] }
 *   }
 *
 * A restauração roda em **uma transação**: apaga as tabelas exportadas, reinsere
 * os registros e, no fim, derruba todas as sessões (todo mundo faz login de
 * novo). Qualquer falha no meio dá rollback — o banco atual continua intacto.
 *
 * A auditoria fica em `backup_logs` (create/download/upload/restore/error) e o
 * histórico de arquivos em `backups`.
 */

import fs from "node:fs";
import path from "node:path";
import { badRequest } from "./errors";
import { execute, newId, query, queryOne, withTransaction } from "../mysql/pool";

export const BACKUP_FORMAT = "pingos-backup";
export const BACKUP_VERSION = 1;

/**
 * Tabelas exportadas, na ordem em que são inseridas de volta na restauração.
 * Ficam de fora as três que NÃO fazem parte do backup de dados:
 *   - `sessions`  → sempre derrubadas na restauração (exige novo login)
 *   - `backups`   → o próprio histórico de arquivos (o arquivo restaurado é um deles)
 *   - `backup_logs` → a auditoria, que precisa sobreviver à restauração
 */
export const BACKUP_TABLES = [
  "counters",
  "roles",
  "users",
  "technicians",
  "tickets",
  "notifications",
  "notification_settings",
  "notification_rules",
  "in_app_notifications",
  "inactivity_logs",
] as const;

/** Diretório dos arquivos de backup (criado no primeiro uso). */
export function backupDir(): string {
  return path.resolve(process.env.BACKUP_DIR ?? path.join(process.cwd(), "backups"));
}

/** Garante que o diretório exista e devolve o caminho absoluto. */
export function ensureBackupDir(): string {
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Tamanho máximo de um arquivo enviado para restauração (bytes). */
export function maxBackupBytes(): number {
  const parsed = Number.parseInt(process.env.BACKUP_MAX_BYTES ?? "", 10);
  const fallback = 256 * 1024 * 1024; // 256 MB
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface BackupRow {
  id: string;
  filename: string;
  storage_path: string | null;
  size: number;
  created_at: number;
  created_by: string | null;
  restored_at: number | null;
  restored_by: string | null;
}

export interface CreateBackupResult {
  id: string;
  filename: string;
  size: number;
  path: string;
  tables: number;
  entries: number;
}

export interface RestoreResult {
  tables: number;
  entries: number;
}

// ── Auditoria ───────────────────────────────────────────────────────────────
/** Registra uma ação de backup/restauração (aparece no histórico do painel). */
export async function logBackup(
  action: "create" | "download" | "upload" | "restore" | "error",
  filename: string | null,
  detail: string | null,
  userName?: string | null,
): Promise<void> {
  try {
    await execute(
      "INSERT INTO `backup_logs` (`id`, `action`, `filename`, `detail`, `user_name`, `created_at`) VALUES (?, ?, ?, ?, ?, ?)",
      [newId(), action, filename, detail ? detail.slice(0, 4000) : null, userName ?? null, Date.now()],
    );
  } catch (error) {
    console.warn("[backup] não deu para registrar a auditoria:", error);
  }
}

/** Nome do usuário para a auditoria (nome, e-mail ou "desconhecido"). */
export function actorName(user: { name?: string | null; email?: string | null } | null): string {
  return user?.name || user?.email || "administrador";
}

// ── Dump ────────────────────────────────────────────────────────────────────
function timestampSlug(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, "-");
}

/** Lê todas as tabelas exportáveis (SELECT * — os valores saem no formato JSON). */
async function dumpTables(): Promise<{ tables: Record<string, unknown[]>; counts: Record<string, number> }> {
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    const rows = await query<Record<string, unknown>>(`SELECT * FROM \`${table}\``);
    tables[table] = rows;
    counts[table] = rows.length;
  }
  return { tables, counts };
}

/**
 * Gera um backup completo e grava o arquivo em BACKUP_DIR.
 * Usado pelo botão "Gerar Backup Agora" e como backup de segurança automático
 * antes de cada restauração.
 */
export async function createBackup(params: {
  createdBy?: string | null;
  /** Detalhe gravado na auditoria (default: contagem de registros/tabelas). */
  logDetail?: string;
}): Promise<CreateBackupResult> {
  const dir = ensureBackupDir();
  const now = Date.now();
  const filename = `pingos-backup-${timestampSlug(now)}.json`;
  const filePath = path.join(dir, filename);

  const { tables, counts } = await dumpTables();
  const entries = Object.values(counts).reduce((total, value) => total + value, 0);

  const payload = {
    app: "PingOS",
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: now,
    database: process.env.MYSQL_DATABASE ?? "pingos",
    counts,
    tables,
  };
  fs.writeFileSync(filePath, JSON.stringify(payload));
  const size = fs.statSync(filePath).size;

  const id = newId();
  await execute(
    "INSERT INTO `backups` (`id`, `filename`, `storage_path`, `size`, `created_at`, `created_by`) VALUES (?, ?, ?, ?, ?, ?)",
    [id, filename, filePath, size, now, params.createdBy ?? null],
  );
  await logBackup(
    "create",
    filename,
    params.logDetail ?? `${entries} registros em ${Object.keys(counts).length} tabelas`,
    params.createdBy,
  );

  return { id, filename, size, path: filePath, tables: Object.keys(counts).length, entries };
}

// ── Restauração ─────────────────────────────────────────────────────────────
/** Normaliza valores vindos do JSON para o formato aceito pelo driver. */
function normalizeValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  // Colunas JSON chegam como objeto/array: o driver não aceita isso direto.
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

interface ParsedBackup {
  tables: Record<string, Array<Record<string, unknown>>>;
  createdAt: number | null;
}

/** Lê e valida o arquivo de backup (o arquivo errado falha aqui, não no banco). */
export function readBackupFile(filePath: string): ParsedBackup {
  if (!fs.existsSync(filePath)) {
    throw badRequest("O arquivo de backup não está mais no servidor.");
  }

  const raw = fs.readFileSync(filePath, "utf8");
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw badRequest("Arquivo de backup inválido: não é um JSON do PingOS.");
  }

  if (!payload || typeof payload !== "object") {
    throw badRequest("Arquivo de backup inválido: conteúdo inesperado.");
  }

  const file = payload as { format?: unknown; tables?: unknown; createdAt?: unknown };
  if (file.format && file.format !== BACKUP_FORMAT) {
    throw badRequest("Arquivo de backup inválido: formato não reconhecido.");
  }
  if (!file.tables || typeof file.tables !== "object") {
    throw badRequest("Arquivo de backup inválido: nenhuma tabela encontrada.");
  }

  const source = file.tables as Record<string, unknown>;
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  for (const table of BACKUP_TABLES) {
    const rows = source[table];
    if (Array.isArray(rows)) {
      tables[table] = rows.filter(
        (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object",
      );
    }
  }

  if (Object.keys(tables).length === 0) {
    throw badRequest(
      "Arquivo de backup inválido: nenhuma das tabelas do PingOS foi encontrada.",
    );
  }

  return {
    tables,
    createdAt: typeof file.createdAt === "number" ? file.createdAt : null,
  };
}

/**
 * Restaura o banco a partir de um arquivo de backup.
 *
 * - roda em transação (rollback em qualquer erro);
 * - apaga as tabelas exportadas e reinsere os registros do arquivo;
 * - derruba TODAS as sessões no fim (o painel já pede novo login em seguida).
 */
export async function restoreBackupFile(
  filePath: string,
  restoredBy?: string | null,
): Promise<RestoreResult> {
  const parsed = readBackupFile(filePath);
  const names = Object.keys(parsed.tables);

  return withTransaction(async (conn) => {
    // FKs desligadas apenas nesta conexão/transação — volta ao normal no finally.
    await conn.query("SET FOREIGN_KEY_CHECKS = 0");
    let entries = 0;
    try {
      // Remove na ordem inversa (filhas antes das mães).
      for (const table of [...names].reverse()) {
        await conn.query(`DELETE FROM \`${table}\``);
      }
      // Sessões e arquivos de backup ficam fora do arquivo: sessões caem sempre.
      await conn.query("DELETE FROM `sessions`");

      for (const table of names) {
        const rows = parsed.tables[table];
        if (rows.length === 0) continue;

        // Colunas = união das chaves de todas as linhas (tolera registros antigos
        // sem alguma coluna nova).
        const columns: string[] = [];
        for (const row of rows) {
          for (const column of Object.keys(row)) {
            if (!columns.includes(column)) columns.push(column);
          }
        }
        if (columns.length === 0) continue;

        const columnList = columns.map((column) => `\`${column}\``).join(", ");
        const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
        const chunkSize = 100;

        for (let index = 0; index < rows.length; index += chunkSize) {
          const chunk = rows.slice(index, index + chunkSize);
          const values = chunk.flatMap((row) =>
            columns.map((column) => normalizeValue(row[column])),
          );
          await conn.query(
            `INSERT INTO \`${table}\` (${columnList}) VALUES ${chunk
              .map(() => rowPlaceholder)
              .join(", ")}`,
            values,
          );
          entries += chunk.length;
        }
      }
    } finally {
      await conn.query("SET FOREIGN_KEY_CHECKS = 1");
    }

    return { tables: names.length, entries };
  });
}

/** Marca no histórico que este backup foi restaurado (e por quem). */
export async function markRestored(
  backupId: string,
  restoredBy?: string | null,
): Promise<void> {
  await execute(
    "UPDATE `backups` SET `restored_at` = ?, `restored_by` = ? WHERE `id` = ?",
    [Date.now(), restoredBy ?? null, backupId],
  );
}

/** Busca um backup pelo id. */
export async function findBackup(backupId: string): Promise<BackupRow | null> {
  return queryOne<BackupRow>("SELECT * FROM `backups` WHERE `id` = ?", [backupId]);
}

/** Caminho real do arquivo (tabela → disco, com fallback para BACKUP_DIR). */
export function backupFilePath(row: BackupRow): string {
  if (row.storage_path && fs.existsSync(row.storage_path)) return row.storage_path;
  return path.join(backupDir(), path.basename(row.filename));
}

/** Registra um arquivo enviado do computador na tabela `backups`. */
export async function registerUploadedBackup(params: {
  filename: string;
  filePath: string;
  createdBy?: string | null;
}): Promise<{ id: string; filename: string; size: number }> {
  const size = fs.statSync(params.filePath).size;
  const id = newId();
  await execute(
    "INSERT INTO `backups` (`id`, `filename`, `storage_path`, `size`, `created_at`, `created_by`) VALUES (?, ?, ?, ?, ?, ?)",
    [id, params.filename, params.filePath, size, Date.now(), params.createdBy ?? null],
  );
  await logBackup("upload", params.filename, `${size} bytes enviados ao servidor`, params.createdBy);
  return { id, filename: params.filename, size };
}

/** Nome de arquivo seguro para uploads (sem barra, com extensão .json). */
export function safeBackupFileName(original: string): string {
  const base = path
    .basename(original || "backup.json")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 120);
  const withoutExtension = base.replace(/\.json$/i, "") || "backup";
  return `enviado-${timestampSlug(Date.now())}-${withoutExtension}.json`;
}
