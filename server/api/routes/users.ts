/**
 * Gestão de usuários — espelha src/convex/users.ts (listManaged, createManaged,
 * updateManaged, resetPassword, deleteManaged).
 *
 * Só o administrador gerencia contas. Não há auto-cadastro: a conta existe
 * quando o admin a cria (o primeiro admin vem de POST /api/auth/setup ou do
 * seed).
 */

import { Router } from "express"
import { execute, newId, query, queryOne } from "../../mysql/pool"
import { asyncHandler, badRequest, notFound } from "../errors"
import { requireAdmin, requirePermission } from "../permissions"
import { hashPassword, invalidateSessions, normalizeUsername } from "../auth"
import { toBool, toPublicUser, type UserRow } from "../types"

export const usersRouter = Router()

async function countAdmins(): Promise<number> {
  const rows = await query<{ total: number }>(
    "SELECT COUNT(*) AS total FROM `users` WHERE `role` = 'admin'",
  )
  return Number(rows[0]?.total ?? 0)
}

// ── GET /api/users/current — usuário logado (null quando deslogado) ────────
// Espelha `api.users.currentUser` do Convex: usado por `useAuth()` em toda a
// aplicação, então nunca responde 401 (o app precisa saber que está deslogado).
usersRouter.get(
  "/current",
  asyncHandler(async (req, res) => {
    const ctx = req.auth
    if (!ctx || !toBool(ctx.user.active, true)) {
      res.json(null)
      return
    }
    res.json(toPublicUser(ctx.user))
  }),
)

// ── POST /api/users/ensure-bootstrap — papéis padrão (só administrador) ─────
// Antes rodava sem autenticação; agora exige sessão de admin, porque dispara a
// migração inteira (schema, papéis, contadores). O primeiro admin de um banco
// vazio é criado por POST /api/auth/setup com BOOTSTRAP_TOKEN (ver auth.ts).
usersRouter.post(
  "/ensure-bootstrap",
  asyncHandler(async (req, res) => {
    requireAdmin(req)
    // Reusa a migração (idempotente): garante papéis padrão e contadores.
    const { runMigrations } = await import("../../mysql/migrate")
    await runMigrations()
    res.json({ success: true })
  }),
)

// ── GET /api/users ──────────────────────────────────────────────────────────
usersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    requirePermission(req, "users.manage")
    const rows = await query<UserRow>("SELECT * FROM `users`")
    const users = rows.map(toPublicUser).sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    res.json(users)
  }),
)

// ── POST /api/users ─────────────────────────────────────────────────────────
usersRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const ctx = requireAdmin(req)
    const body = (req.body ?? {}) as Record<string, unknown>
    const username = normalizeUsername(body.username)
    const password = String(body.password ?? "")
    const name = String(body.name ?? "").trim()

    if (!name) throw badRequest("Informe o nome do usuário.")
    if (!username) throw badRequest("Informe um nome de usuário.")
    if (password.length < 8) {
      throw badRequest("A senha deve ter pelo menos 8 caracteres.")
    }
    if (!body.role) throw badRequest("Informe o papel do usuário.")

    const existing = await queryOne<{ id: string }>(
      "SELECT `id` FROM `users` WHERE `email` = ? LIMIT 1",
      [username],
    )
    if (existing) {
      throw badRequest("Já existe um usuário com esse nome de usuário.")
    }

    const id = newId()
    const now = Date.now()
    await execute(
      `INSERT INTO users
         (id, name, email, username, password_hash, is_anonymous, role, active,
          setor, contato, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 1, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        username,
        username,
        await hashPassword(password),
        String(body.role),
        String(body.setor ?? "").trim() || null,
        String(body.contato ?? "").trim() || null,
        ctx.user.id,
        now,
        now,
      ],
    )

    const created = await queryOne<UserRow>("SELECT * FROM `users` WHERE `id` = ?", [id])
    res.status(201).json(created ? toPublicUser(created) : null)
  }),
)

// ── PATCH /api/users/:id ────────────────────────────────────────────────────
usersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    requireAdmin(req)
    const body = (req.body ?? {}) as Record<string, unknown>
    const user = await queryOne<UserRow>("SELECT * FROM `users` WHERE `id` = ?", [req.params.id])
    if (!user) throw notFound("Usuário não encontrado.")

    const fields: Record<string, unknown> = { updated_at: Date.now() }

    if (body.name !== undefined) fields.name = String(body.name).trim()
    if (body.role !== undefined) fields.role = String(body.role)
    if (body.setor !== undefined) fields.setor = String(body.setor).trim() || null
    if (body.contato !== undefined) fields.contato = String(body.contato).trim() || null
    if (body.active !== undefined) fields.active = body.active ? 1 : 0
    if (body.permissions !== undefined) {
      // null = herdar do papel; lista = override explícito
      fields.permissions = body.permissions === null ? null : JSON.stringify(body.permissions ?? [])
    }

    // Não permite desativar ou rebaixar o último administrador.
    const demoting =
      (body.role !== undefined && String(body.role) !== "admin") || body.active === false
    if (demoting && user.role === "admin" && (await countAdmins()) === 1) {
      throw badRequest("Não é possível desativar/rebaixar o último administrador.")
    }

    if (body.username !== undefined) {
      const newUsername = normalizeUsername(body.username)
      if (!newUsername) throw badRequest("Informe um nome de usuário.")
      const oldUsername = user.username ?? user.email ?? ""
      if (newUsername !== oldUsername) {
        const clash = await queryOne<{ id: string }>(
          "SELECT `id` FROM `users` WHERE `email` = ? AND `id` <> ? LIMIT 1",
          [newUsername, user.id],
        )
        if (clash) throw badRequest("Já existe um usuário com esse nome de usuário.")
        // A senha é mantida (o hash não muda) — só o identificador de login.
        fields.email = newUsername
        fields.username = newUsername
      }
    }

    const columns = Object.keys(fields)
    await execute(
      `UPDATE \`users\` SET ${columns.map((c) => `\`${c}\` = ?`).join(", ")} WHERE \`id\` = ?`,
      [...columns.map((c) => fields[c]), user.id],
    )
    res.json({ success: true })
  }),
)

// ── POST /api/users/:id/password — redefinir senha ──────────────────────────
usersRouter.post(
  "/:id/password",
  asyncHandler(async (req, res) => {
    requireAdmin(req)
    const password = String((req.body ?? {}).password ?? "")
    if (password.length < 8) {
      throw badRequest("A senha deve ter pelo menos 8 caracteres.")
    }
    const user = await queryOne<UserRow>("SELECT * FROM `users` WHERE `id` = ?", [req.params.id])
    if (!user) throw notFound("Usuário não encontrado.")

    await execute("UPDATE `users` SET `password_hash` = ?, `updated_at` = ? WHERE `id` = ?", [
      await hashPassword(password),
      Date.now(),
      user.id,
    ])
    // Exige novo login nas sessões abertas.
    await invalidateSessions(user.id)
    res.json({ success: true })
  }),
)

// ── DELETE /api/users/:id ───────────────────────────────────────────────────
usersRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const ctx = requireAdmin(req)
    if (ctx.user.id === req.params.id) {
      throw badRequest("Você não pode excluir o próprio usuário.")
    }
    const user = await queryOne<UserRow>("SELECT * FROM `users` WHERE `id` = ?", [req.params.id])
    if (!user) throw notFound("Usuário não encontrado.")

    if (user.role === "admin" && (await countAdmins()) === 1) {
      throw badRequest("Não é possível excluir o último administrador.")
    }

    // Sessões caem em cascata (FK) e os chamados ficam com creator_id nulo.
    await execute("DELETE FROM `users` WHERE `id` = ?", [user.id])
    res.json({ success: true })
  }),
)
