/**
 * Consultas de permissão — espelha src/convex/permissions.ts.
 *
 *   GET /api/permissions/any-admin → true quando existe algum administrador
 *   (usado pela tela de configurações para decidir se mostra o card de usuários).
 *
 * As permissões do usuário logado continuam em `GET /api/auth/me`.
 */

import { Router } from "express"
import { query } from "../../mysql/pool"
import { asyncHandler } from "../errors"
import { requireAuth } from "../permissions"

export const permissionsRouter = Router()

permissionsRouter.get(
  "/any-admin",
  asyncHandler(async (req, res) => {
    requireAuth(req)
    const rows = await query<{ total: number }>(
      "SELECT COUNT(*) AS total FROM `users` WHERE `role` = 'admin' AND `active` = 1",
    )
    res.json(Number(rows[0]?.total ?? 0) > 0)
  }),
)
