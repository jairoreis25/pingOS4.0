/**
 * Permissões e sessão do backend MySQL.
 *
 * A regra de negócio (papéis, overrides por usuário e permissões padrão) vem de
 * `src/lib/permissions.ts`, o MESMO módulo usado pelo frontend, para não existir
 * duas verdades sobre quem pode ver/editar o quê.
 */

import type { Request } from "express"
import { ALL_PERMISSIONS, DEFAULT_USER_PERMISSIONS, isAdmin } from "../../src/lib/permissions"
import { queryOne } from "../mysql/pool"
import { ApiError, forbidden, unauthorized } from "./errors"
import { parseJsonArray, parsePermissionsOverride, toBool, type UserRow } from "./types"

export interface AuthContext {
  user: UserRow
  permissions: string[]
}

// A sessão resolvida pelo middleware `attachUser` fica disponível em req.auth
// para todos os handlers (sem precisar de cast em cada rota).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext
    }
  }
}

/** Permissões efetivas (admin → todas; override → lista; senão papel; senão padrão). */
export async function getEffectivePermissions(user: UserRow): Promise<string[]> {
  if (isAdmin(user.role)) return [...ALL_PERMISSIONS]

  const override = parsePermissionsOverride(user.permissions)
  if (Array.isArray(override)) return override

  if (user.role) {
    const role = await queryOne<{ permissions: unknown }>(
      "SELECT `permissions` FROM `roles` WHERE `name` = ? LIMIT 1",
      [user.role],
    )
    if (role) return parseJsonArray(role.permissions)
  }

  return [...DEFAULT_USER_PERMISSIONS]
}

/** Lança 403 quando o usuário não tem a permissão informada. */
export function assertPermission(ctx: AuthContext, permission: string): void {
  if (!ctx.permissions.includes(permission)) {
    throw forbidden()
  }
}

/** Lança 403 quando o usuário não é administrador. */
export function assertAdmin(ctx: AuthContext): void {
  if (!isAdmin(ctx.user.role)) {
    throw forbidden("Apenas administradores podem realizar esta ação.")
  }
}

/** Bloqueia usuários inativos (regra única para todas as rotas autenticadas). */
export function assertActive(ctx: AuthContext): void {
  if (!toBool(ctx.user.active, true)) {
    throw new ApiError(403, "Usuário inativo. Contate o administrador.")
  }
}

/** Recupera o contexto de autenticação da requisição (ou lança 401). */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw unauthorized()
  assertActive(req.auth)
  return req.auth
}

/** Como `requireAuth`, mas exige uma permissão específica. */
export function requirePermission(req: Request, permission: string): AuthContext {
  const ctx = requireAuth(req)
  assertPermission(ctx, permission)
  return ctx
}

/** Como `requireAuth`, mas exige o papel de administrador. */
export function requireAdmin(req: Request): AuthContext {
  const ctx = requireAuth(req)
  assertAdmin(ctx)
  return ctx
}
