/**
 * Autenticação do backend MySQL — substitui o Convex Auth.
 *
 * Login é por usuário + senha (sem auto-cadastro): as contas são criadas pelo
 * administrador (`POST /api/users`). As senhas usam scrypt (node:crypto), com
 * salt aleatório por usuário, e as sessões são linhas em `sessions` com prazo
 * de validade — trocar a senha invalida as sessões abertas.
 */

import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"
import { Router } from "express"
import { execute, newId, newSessionToken, query, queryOne } from "../mysql/pool"
import { badRequest, forbidden, unauthorized } from "./errors"
import { asyncHandler } from "./errors"
import { getEffectivePermissions, requireAuth } from "./permissions"
import { toBool, toPublicUser, type UserRow } from "./types"

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>

const SALT_BYTES = 16
const KEY_BYTES = 64

// ── Bootstrap do primeiro administrador ─────────────────────────────────────
// Com o banco vazio, `POST /api/auth/setup` cria o primeiro admin. Sem trava,
// quem chamasse a rota primeiro viraria administrador. A rota passa a exigir um
// token: o valor de BOOTSTRAP_TOKEN ou, quando a variável não existe, um token
// aleatório gerado neste boot e impresso apenas no log do servidor.
const BOOTSTRAP_TOKEN =
  (process.env.BOOTSTRAP_TOKEN ?? "").trim() || randomBytes(24).toString("hex")

if (!(process.env.BOOTSTRAP_TOKEN ?? "").trim()) {
  console.log(
    `[bootstrap] BOOTSTRAP_TOKEN não definido — token desta execução (só aparece aqui): ${BOOTSTRAP_TOKEN}`,
  )
}

function assertBootstrapToken(value: unknown): void {
  const provided = typeof value === "string" ? value.trim() : ""
  const a = Buffer.from(provided)
  const b = Buffer.from(BOOTSTRAP_TOKEN)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw forbidden("Token de bootstrap ausente ou inválido.")
  }
}

/** Hash no formato `scrypt$<salt-hex>$<hash-hex>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await scrypt(password, salt, KEY_BYTES)
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`
}

/** Compara a senha informada com o hash armazenado (tempo constante). */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false
  const [scheme, saltHex, hashHex] = stored.split("$")
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, "hex")
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export function normalizeUsername(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
}

function sessionTtlMs(): number {
  const days = Number.parseInt(process.env.SESSION_TTL_DAYS ?? "30", 10)
  const safeDays = Number.isFinite(days) && days > 0 ? days : 30
  return safeDays * 24 * 60 * 60 * 1000
}

/**
 * Hash do token de sessão gravado no banco (SHA-256 em hex, 64 caracteres).
 *
 * O token em claro só existe no cliente: quem ler a tabela `sessions` (dump,
 * backup, log de query) não consegue se autenticar com o que está lá. O tamanho
 * continua 64 caracteres, então a coluna `CHAR(64)` não mudou.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

/** Seleciona a sessão pelo hash do token, já trazendo o usuário e a validade. */
const SESSION_LOOKUP = `SELECT u.*, s.expires_at AS session_expires_at
   FROM \`sessions\` s
   JOIN \`users\` u ON u.id = s.user_id
  WHERE s.token = ? AND s.expires_at > ?
  LIMIT 1`

type SessionUserRow = UserRow & { session_expires_at?: number }

/** Cria uma sessão e devolve o token (o banco guarda apenas o hash). */
export async function createSession(userId: string, userAgent?: string): Promise<string> {
  const token = newSessionToken()
  const now = Date.now()
  await execute(
    "INSERT INTO `sessions` (`token`, `user_id`, `created_at`, `expires_at`, `user_agent`) VALUES (?, ?, ?, ?, ?)",
    [hashSessionToken(token), userId, now, now + sessionTtlMs(), userAgent?.slice(0, 255) ?? null],
  )
  return token
}

/** Invalida todas as sessões de um usuário (usado ao trocar a senha). */
export async function invalidateSessions(userId: string): Promise<void> {
  await execute("DELETE FROM `sessions` WHERE `user_id` = ?", [userId])
}

/** Limpa sessões expiradas (chamado no boot e a cada login). */
export async function purgeExpiredSessions(): Promise<void> {
  await execute("DELETE FROM `sessions` WHERE `expires_at` < ?", [Date.now()])
}

function bearerToken(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  return match ? match[1].trim() : null
}

/** Middleware: resolve o usuário da sessão e anexa `req.auth`. */
export const attachUser = asyncHandler(async (req, _res, next) => {
  const token = bearerToken(req.headers.authorization)
  if (!token) {
    next()
    return
  }

  const now = Date.now()
  const hashed = hashSessionToken(token)
  let row = await queryOne<SessionUserRow>(SESSION_LOOKUP, [hashed, now])

  if (!row) {
    // Compatibilidade: versões anteriores guardavam o token em claro. Se for o
    // caso, a própria requisição migra a linha para o hash — o usuário não
    // precisa entrar de novo.
    const legado = await queryOne<{ token: string }>(
      "SELECT `token` FROM `sessions` WHERE `token` = ? AND `expires_at` > ? LIMIT 1",
      [token, now],
    )
    if (legado) {
      await execute("UPDATE `sessions` SET `token` = ? WHERE `token` = ?", [hashed, token])
      row = await queryOne<SessionUserRow>(SESSION_LOOKUP, [hashed, now])
    }
  }

  if (!row) {
    next()
    return
  }

  // Renovação deslizante: sessão na metade do prazo ganha mais um ciclo (uma
  // escrita rara em vez de uma por requisição). Sem isso, quem usa o sistema
  // todo dia continuaria sendo deslogado no 30º dia.
  const expiresAt = Number(row.session_expires_at ?? 0)
  const ttl = sessionTtlMs()
  if (expiresAt && expiresAt - now < ttl / 2) {
    await execute("UPDATE `sessions` SET `expires_at` = ? WHERE `token` = ?", [now + ttl, hashed])
  }

  const permissions = await getEffectivePermissions(row)
  req.auth = { user: row, permissions }
  next()
})

/** Busca o usuário pelo identificador de login (email/username). */
export async function findUserByLogin(username: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    "SELECT * FROM `users` WHERE `email` = ? OR `username` = ? ORDER BY `created_at` ASC LIMIT 1",
    [username, username],
  )
}

export const authRouter = Router()

// ── POST /api/auth/login ────────────────────────────────────────────────────
authRouter.post(
  "/login",
  asyncHandler(async (req, res) => {
    const username = normalizeUsername((req.body ?? {}).username ?? (req.body ?? {}).email)
    const password = String((req.body ?? {}).password ?? "")
    if (!username || !password) {
      throw badRequest("Informe usuário e senha.")
    }

    await purgeExpiredSessions()

    const user = await findUserByLogin(username)
    // Mensagem única para usuário inexistente e senha errada (não vaza quais
    // nomes de usuário existem).
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      throw unauthorized("Usuário ou senha inválidos.")
    }
    if (!toBool(user.active, true)) {
      throw unauthorized("Usuário inativo. Contate o administrador.")
    }

    const token = await createSession(user.id, req.headers["user-agent"])
    res.json({
      token,
      user: toPublicUser(user),
      permissions: await getEffectivePermissions(user),
    })
  }),
)

// ── POST /api/auth/logout ───────────────────────────────────────────────────
authRouter.post(
  "/logout",
  asyncHandler(async (req, res) => {
    const token = bearerToken(req.headers.authorization)
    if (token) {
      // O banco guarda o hash (ver `createSession`).
      await execute("DELETE FROM `sessions` WHERE `token` = ?", [hashSessionToken(token)])
    }
    res.json({ success: true })
  }),
)

// ── POST /api/auth/rotate — troca o token da sessão atual ───────────────────
// Rotação explícita: o cliente pede um token novo e substitui o que tem. Não é
// feita "sozinha" em toda requisição porque requisições que não passam pelo
// transporte do app (a conexão SSE, um <img>) não teriam como guardar o token
// novo — e o antigo já teria sido apagado.
authRouter.post(
  "/rotate",
  asyncHandler(async (req, res) => {
    const ctx = requireAuth(req)
    const atual = bearerToken(req.headers.authorization)

    const token = await createSession(ctx.user.id, req.headers["user-agent"])
    if (atual) {
      await execute("DELETE FROM `sessions` WHERE `token` = ?", [hashSessionToken(atual)])
    }

    res.json({ token })
  }),
)

// ── GET /api/auth/me ────────────────────────────────────────────────────────
authRouter.get(
  "/me",
  asyncHandler(async (req, res) => {
    const auth = req.auth
    if (!auth || !toBool(auth.user.active, true)) {
      res.json(null)
      return
    }
    res.json({
      userId: auth.user.id,
      name: auth.user.name ?? null,
      role: auth.user.role ?? null,
      isAdmin: auth.user.role === "admin",
      active: true,
      permissions: auth.permissions,
    })
  }),
)

// ── GET /api/auth/status — bootstrap público da tela de login ───────────────
authRouter.get(
  "/status",
  asyncHandler(async (_req, res) => {
    const rows = await query<{ total: number; admins: number }>(
      "SELECT COUNT(*) AS total, SUM(`role` = 'admin') AS admins FROM `users`",
    )
    const total = Number(rows[0]?.total ?? 0)
    const admins = Number(rows[0]?.admins ?? 0)
    res.json({
      hasUsers: total > 0,
      hasAdmin: admins > 0,
      needsSetup: total === 0,
      // Alias consumido pela tela de login (mesmo nome usado no Convex Auth).
      needsBootstrap: total === 0,
    })
  }),
)

// ── POST /api/auth/setup — cria o primeiro administrador ────────────────────
authRouter.post(
  "/setup",
  asyncHandler(async (req, res) => {
    const rows = await query<{ total: number }>("SELECT COUNT(*) AS total FROM `users`")
    if (Number(rows[0]?.total ?? 0) > 0) {
      throw badRequest("O sistema já foi configurado.")
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    assertBootstrapToken(body.bootstrapToken)
    const username = normalizeUsername(body.username ?? "admin")
    const password = String(body.password ?? "")
    const name = String(body.name ?? "Administrador").trim() || "Administrador"

    if (!username) throw badRequest("Informe um nome de usuário.")
    if (password.length < 8) throw badRequest("A senha deve ter pelo menos 8 caracteres.")

    const id = newId()
    const now = Date.now()
    await execute(
      `INSERT INTO users
         (id, name, email, username, password_hash, email_verification_time, is_anonymous, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'admin', 1, ?, ?)`,
      [id, name, username, username, await hashPassword(password), now, now, now],
    )

    const user = await queryOne<UserRow>("SELECT * FROM `users` WHERE `id` = ?", [id])
    const token = await createSession(id, req.headers["user-agent"])
    res.status(201).json({
      token,
      user: user ? toPublicUser(user) : null,
      permissions: user ? await getEffectivePermissions(user) : [],
    })
  }),
)
