/**
 * Pool de conexões MySQL do PingOS (backend paralelo).
 *
 * Todas as variáveis vêm do arquivo de ambiente do backend (veja
 * `mysql-api.env.example`) — este módulo não contém credenciais.
 *
 * A configuração é lida de forma preguiçosa (na primeira consulta), para que o
 * carregamento do arquivo de env em `server/api/env.ts` aconteça antes.
 */

import { randomBytes, randomUUID } from "node:crypto"
import mysql, { type Pool, type ResultSetHeader } from "mysql2/promise"

function toPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function toBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback
  return ["1", "true", "sim", "yes", "on"].includes(value.trim().toLowerCase())
}

let pool: Pool | null = null

/** Opções de conexão (sem o banco selecionado) — reusadas pelo ensureDatabase. */
function connectionOptions() {
  return {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: toPositiveInt(process.env.MYSQL_PORT, 3306),
    user: process.env.MYSQL_USER ?? "pingos",
    password: process.env.MYSQL_PASSWORD ?? "",
    ...(toBool(process.env.MYSQL_SSL) ? { ssl: { rejectUnauthorized: false } } : {}),
  }
}

/** Configuração efetiva do pool (útil para logs de diagnóstico). */
export function dbConfigInfo() {
  return {
    host: process.env.MYSQL_HOST ?? "127.0.0.1",
    port: toPositiveInt(process.env.MYSQL_PORT, 3306),
    user: process.env.MYSQL_USER ?? "pingos",
    database: process.env.MYSQL_DATABASE ?? "pingos",
    ssl: toBool(process.env.MYSQL_SSL),
  }
}

/** Pool compartilhado (criado na primeira consulta). */
export function getPool(): Pool {
  if (pool) return pool
  pool = mysql.createPool({
    ...connectionOptions(),
    database: process.env.MYSQL_DATABASE ?? "pingos",
    waitForConnections: true,
    connectionLimit: toPositiveInt(process.env.MYSQL_POOL_SIZE, 10),
    queueLimit: 0,
    charset: "utf8mb4",
    // Timestamps são BIGINT (ms) — nenhuma conversão de data pelo driver.
    dateStrings: true,
    supportBigNumbers: true,
    multipleStatements: false,
  })
  return pool
}

/** Executa um SELECT e devolve as linhas já tipadas pelo chamador. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const [rows] = await getPool().query(sql, params)
  return rows as T[]
}

/** Executa um SELECT que devolve no máximo uma linha. */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params)
  return rows[0] ?? null
}

/** Executa INSERT/UPDATE/DELETE e devolve o resultado do driver. */
export async function execute(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  // O mysql2 tipa `values` com uma união estrita; os valores chegam validados
  // pela camada de rotas.
  const [result] = await getPool().execute(sql, params as never)
  return result as ResultSetHeader
}

/** Executa uma função dentro de uma transação (rollback automático em erro). */
export async function withTransaction<T>(
  fn: (conn: Awaited<ReturnType<Pool["getConnection"]>>) => Promise<T>,
): Promise<T> {
  const conn = await getPool().getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (error) {
    try {
      await conn.rollback()
    } catch {
      /* ignora erro de rollback */
    }
    throw error
  } finally {
    conn.release()
  }
}

/** Gera um id opaco de 32 caracteres (mesmo formato dos ids usados no app). */
export function newId(): string {
  return randomBytes(16).toString("hex")
}

/** Token de sessão (64 caracteres hexadecimais). */
export function newSessionToken(): string {
  return randomBytes(32).toString("hex")
}

/** UUID v4 — usado apenas onde um formato padrão é desejado. */
export function newUuid(): string {
  return randomUUID()
}

/** Fecha o pool (usado nos scripts de CLI). */
export async function closePool(): Promise<void> {
  if (!pool) return
  const current = pool
  pool = null
  await current.end()
}

/** Verifica se o banco responde (usado pelo /api/health). */
export async function pingDatabase(): Promise<boolean> {
  try {
    await getPool().query("SELECT 1")
    return true
  } catch {
    return false
  }
}

/**
 * Garante que o banco exista e esteja acessível.
 *
 * O nome do banco não pode ser parâmetro de consulta, por isso é validado
 * contra uma lista estrita de caracteres antes de entrar no SQL.
 *
 * O `CREATE DATABASE` é "melhor esforço": em bancos gerenciados e no MySQL
 * criado pelo painel do Dokploy, o usuário do app normalmente **não** tem
 * privilégio de criar bancos — e nem precisa, porque o banco já existe. Se o
 * CREATE for negado, seguimos e validamos a conexão no banco configurado.
 */
export async function ensureDatabase(): Promise<void> {
  const database = process.env.MYSQL_DATABASE ?? "pingos"
  if (!/^[A-Za-z0-9_]+$/.test(database)) {
    throw new Error(`MYSQL_DATABASE inválido: ${database}`)
  }

  const { host, port } = connectionOptions()

  try {
    // 1. Tentativa de criação (melhor esforço — o banco do Dokploy já vem criado).
    const connection = await mysql.createConnection(connectionOptions())
    try {
      await connection.query(
        `CREATE DATABASE IF NOT EXISTS \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      )
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.warn(
        `[mysql] não deu para criar o banco "${database}" (${reason}). ` +
          "Seguindo — ele precisa já existir.",
      )
    } finally {
      await connection.end()
    }

    // 2. Confirma que o banco configurado existe e aceita as credenciais.
    const probe = await mysql.createConnection({ ...connectionOptions(), database })
    try {
      await probe.query("SELECT 1")
    } finally {
      await probe.end()
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Banco "${database}" inacessível em ${host}:${port} — ${reason}. ` +
        "Confira MYSQL_HOST/MYSQL_PORT/MYSQL_USER/MYSQL_PASSWORD/MYSQL_DATABASE.",
    )
  }
}

/** Aplica o schema.sql (idempotente: o arquivo usa CREATE TABLE IF NOT EXISTS). */
export async function applySchema(schemaPath: string): Promise<void> {
  const fs = await import("node:fs")
  const sql = fs.readFileSync(schemaPath, "utf8")
  // O driver está com multipleStatements: false; o schema é aplicado em
  // declarações separadas para manter a proteção contra injeção.
  const statements = sql
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const conn = await getPool().getConnection()
  try {
    for (const statement of statements) {
      // USE/CREATE DATABASE não podem rodar inline em alguns setups; são
      // aplicados pelo admin via CLI (ver MYSQL.md).
      if (/^(USE|CREATE\s+DATABASE)\b/i.test(statement)) continue
      await conn.query(statement)
    }
  } finally {
    conn.release()
  }
}
