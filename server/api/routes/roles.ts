/**
 * Papéis e permissões — espelha src/convex/roles.ts.
 * "admin" é protegido: não pode ser editado nem excluído.
 */

import { Router } from "express"
import { DEFAULT_ROLE, ADMIN_ROLE } from "../../../src/lib/permissions"
import { execute, newId, query, queryOne } from "../../mysql/pool"
import { asyncHandler, badRequest, notFound } from "../errors"
import { requireAdmin, requirePermission } from "../permissions"
import { toPublicRole, type RoleRow } from "../types"

export const rolesRouter = Router()

function permissionList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((v) => String(v))
}

// ── GET /api/roles ──────────────────────────────────────────────────────────
rolesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    requirePermission(req, "users.manage")
    const rows = await query<RoleRow>("SELECT * FROM `roles`")
    res.json(rows.map(toPublicRole).sort((a, b) => a.name.localeCompare(b.name)))
  }),
)

// ── POST /api/roles ─────────────────────────────────────────────────────────
rolesRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    requireAdmin(req)
    const body = (req.body ?? {}) as Record<string, unknown>
    const name = String(body.name ?? "").trim()
    if (!name) throw badRequest("Informe um nome para o papel.")

    const existing = await queryOne<{ id: string }>(
      "SELECT `id` FROM `roles` WHERE `name` = ? LIMIT 1",
      [name],
    )
    if (existing) throw badRequest("Já existe um papel com esse nome.")

    const id = newId()
    await execute(
      "INSERT INTO `roles` (`id`, `name`, `permissions`, `is_system`, `created_at`) VALUES (?, ?, ?, 0, ?)",
      [id, name, JSON.stringify(permissionList(body.permissions)), Date.now()],
    )
    const created = await queryOne<RoleRow>("SELECT * FROM `roles` WHERE `id` = ?", [id])
    res.status(201).json(created ? toPublicRole(created) : null)
  }),
)

// ── PATCH /api/roles/:id ────────────────────────────────────────────────────
rolesRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    requireAdmin(req)
    const body = (req.body ?? {}) as Record<string, unknown>
    const role = await queryOne<RoleRow>("SELECT * FROM `roles` WHERE `id` = ?", [req.params.id])
    if (!role) throw notFound("Papel não encontrado.")
    if (role.name === ADMIN_ROLE) {
      throw badRequest("O papel Administrador não pode ser editado.")
    }

    let newName = role.name
    if (body.name !== undefined) {
      const trimmed = String(body.name).trim()
      if (!trimmed) throw badRequest("Informe um nome para o papel.")
      if (trimmed !== role.name) {
        const clash = await queryOne<{ id: string }>(
          "SELECT `id` FROM `roles` WHERE `name` = ? AND `id` <> ? LIMIT 1",
          [trimmed, role.id],
        )
        if (clash) throw badRequest("Já existe um papel com esse nome.")
        // Atualiza a referência nos usuários que usam o papel.
        await execute("UPDATE `users` SET `role` = ? WHERE `role` = ?", [trimmed, role.name])
        newName = trimmed
      }
    }

    await execute("UPDATE `roles` SET `name` = ?, `permissions` = ? WHERE `id` = ?", [
      newName,
      body.permissions !== undefined
        ? JSON.stringify(permissionList(body.permissions))
        : JSON.stringify(permissionList(role.permissions)),
      role.id,
    ])
    res.json({ success: true })
  }),
)

// ── DELETE /api/roles/:id ───────────────────────────────────────────────────
rolesRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    requireAdmin(req)
    const role = await queryOne<RoleRow>("SELECT * FROM `roles` WHERE `id` = ?", [req.params.id])
    if (!role) throw notFound("Papel não encontrado.")
    if (role.name === ADMIN_ROLE || role.name === "user") {
      throw badRequest("Este papel é padrão do sistema e não pode ser excluído.")
    }
    // Usuários que usavam o papel voltam para o papel padrão.
    await execute("UPDATE `users` SET `role` = ? WHERE `role` = ?", [DEFAULT_ROLE, role.name])
    await execute("DELETE FROM `roles` WHERE `id` = ?", [role.id])
    res.json({ success: true })
  }),
)
