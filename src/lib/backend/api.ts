/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Referências de operação do backend MySQL (substitui o `api.*` do Convex).
 *
 * Cada entrada aqui é um "endereço" de uma operação na API Express. O formato da
 * objeto é propositalmente parecido com o do Convex para que os componentes
 * continuem escrevendo `useQuery(api.tickets.list)` / `useMutation(api.roles.create)`
 * — só o import muda:
 *
 *   import { api } from "@/convex/_generated/api";   // antes (Convex)
 *   import { api } from "@/lib/backend/api";         // depois (MySQL)
 *
 * O `path(args)` monta a URL (com o id no caminho, quando houver) e o `body(args)`
 * monta o corpo JSON (normalmente os argumentos sem os campos de id).
 */

import type {
  BackupList,
  DashboardMetrics,
  ManagedUser,
  NotificationRule,
  ProductService,
  Technician,
  Ticket,
} from "./types"

export type HttpMethod = "POST" | "PATCH" | "PUT" | "DELETE"

export interface QueryRef<T = any> {
  readonly __kind: "query"
  readonly name: string
  readonly path: (args: any) => string
  readonly __result?: T
}

export interface MutationRef {
  readonly __kind: "mutation"
  readonly name: string
  readonly method: HttpMethod
  readonly path: (args: any) => string
  readonly body?: (args: any) => unknown
}

export type ApiRef = QueryRef | MutationRef

/** Provedor de IA do bot "Ping IA" (item do dropdown de Configurações). */
export interface BotProviderOption {
  id: string
  label: string
  /** Rótulo do campo da chave ("OpenAI API Key"). */
  apiKeyLabel: string
  /** Placeholder do campo (prefixo da chave, quando existe). */
  apiKeyHint: string
  /** Onde criar a chave (mostrado como dica). */
  docsUrl: string
  /** URL base padrão do provedor (vazia no provedor "Outro"). */
  baseUrl: string
  /** `true` quando o admin pode escrever a URL base. */
  customBaseUrl: boolean
  hint: string
}

/** Personalidade do bot "Ping IA" (item da seção Personalidades). */
export interface BotPersonalidade {
  id: number
  /** 1 a 4. O slot 4 é o limite do banco, não uma regra de UI. */
  slot: number
  nome: string
  emoji: string
  /** Vazio no slot fixo (o prompt dele vem do código). */
  system_prompt: string
  /** 1 no slot Padrão (não editável); 0 nos editáveis. */
  fixo: number
  /** 1 quando é a personalidade em uso; 0 nos demais. */
  ativo: number
  updatedAt: string | null
}

/** Catálogo de modelos do provedor escolhido (dropdown do bot). */
export interface BotModelsResult {
  /** Catálogo vivo do provedor (vazio quando a listagem falha). */
  models: string[]
  provider: string
  label: string
  defaultModel: string
  suggested: string[]
  /** Vazio quando o provedor não lê imagem. */
  defaultVisionModel: string
  visionSuggested: string[]
  supportsVision: boolean
  /** Teto do catálogo mostrado no dropdown. */
  catalogLimit: number
  /** Catálogo de provedores que o formulário usa para montar os campos. */
  providers: BotProviderOption[]
  /** URL base salva (vazia = padrão do provedor). */
  baseUrl: string
}

/** Chaves que identificam o registro na URL (a primeira presente é usada). */
const ID_KEYS = [
  "id",
  "_id",
  "ticketId",
  "userId",
  "roleId",
  "technicianId",
  "productId",
  "notificationId",
  "ruleId",
  "backupId",
  "filename",
] as const

/** Descobre o id do registro a partir dos argumentos da chamada. */
function pickId(args: Record<string, unknown> | undefined): string {
  for (const key of ID_KEYS) {
    const value = args?.[key]
    if (value !== undefined && value !== null && String(value) !== "") {
      return encodeURIComponent(String(value))
    }
  }
  throw new Error("[backend] chamada sem id — confira os argumentos da operação.")
}

/** Remove os campos de id (o resto vira o corpo da requisição). */
function withoutIds(args: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(args ?? {}) }
  for (const key of ID_KEYS) delete out[key]
  return out
}

// ── Construtores ─────────────────────────────────────────────────────────────
function q<T = any>(name: string, path: (args: any) => string): QueryRef<T> {
  return { __kind: "query", name, path } as QueryRef<T>
}

function m(
  name: string,
  method: HttpMethod,
  path: (args: any) => string,
  body?: (args: any) => unknown,
): MutationRef {
  return { __kind: "mutation", name, method, path, body }
}

/** Mutation que envia os argumentos (menos o id) no corpo. */
function mBody(name: string, method: HttpMethod, base: string): MutationRef {
  return m(
    name,
    method,
    (args) => `${base}/${pickId(args)}`,
    (args) => withoutIds(args),
  )
}

function mCreate(name: string, base: string, body?: (args: any) => unknown): MutationRef {
  return m(name, "POST", () => base, body ?? ((args) => args ?? {}))
}

export const api = {
  // ── Chamados / Kanban ─────────────────────────────────────────────────────
  tickets: {
    list: q<Ticket[]>("tickets.list", (args: { limit?: number; cursor?: string } | undefined) => {
      const params = new URLSearchParams()
      if (args?.limit) params.set("limit", String(args.limit))
      if (args?.cursor) params.set("cursor", args.cursor)
      const query = params.toString()
      return query ? `/api/tickets?${query}` : "/api/tickets"
    }),
    get: q<Ticket | null>("tickets.get", (args) => `/api/tickets/${pickId(args)}`),
    create: mCreate("tickets.create", "/api/tickets"),
    createAsGuest: mCreate("tickets.createAsGuest", "/api/tickets/guest"),
    update: mBody("tickets.update", "PATCH", "/api/tickets"),
    updateStatus: m(
      "tickets.updateStatus",
      "POST",
      (args) => `/api/tickets/${pickId(args)}/status`,
      (args) => ({ status: args?.status }),
    ),
    remove: mBody("tickets.remove", "DELETE", "/api/tickets"),
    dashboardMetrics: q<DashboardMetrics>(
      "tickets.dashboardMetrics",
      () => "/api/metrics/dashboard",
    ),
    monthlyMetrics: q("tickets.monthlyMetrics", () => "/api/metrics/monthly"),
  },

  // ── Usuários ──────────────────────────────────────────────────────────────
  users: {
    currentUser: q("users.currentUser", () => "/api/users/current"),
    systemStatus: q("users.systemStatus", () => "/api/auth/status"),
    ensureBootstrap: m("users.ensureBootstrap", "POST", () => "/api/users/ensure-bootstrap"),
    listManaged: q<ManagedUser[]>("users.listManaged", () => "/api/users"),
    createManaged: mCreate("users.createManaged", "/api/users"),
    updateManaged: mBody("users.updateManaged", "PATCH", "/api/users"),
    deleteManaged: mBody("users.deleteManaged", "DELETE", "/api/users"),
    resetPassword: m(
      "users.resetPassword",
      "POST",
      (args) => `/api/users/${pickId(args)}/password`,
      (args) => ({ password: args?.password ?? args?.newPassword }),
    ),
  },

  // ── Papéis / permissões ───────────────────────────────────────────────────
  roles: {
    list: q("roles.list", () => "/api/roles"),
    create: mCreate("roles.create", "/api/roles", (args) => ({
      name: args?.name,
      permissions: args?.permissions,
    })),
    update: mBody("roles.update", "PATCH", "/api/roles"),
    remove: mBody("roles.remove", "DELETE", "/api/roles"),
  },

  permissions: {
    effective: q("permissions.effective", () => "/api/auth/me"),
    anyAdmin: q("permissions.anyAdmin", () => "/api/permissions/any-admin"),
  },

  // ── Técnicos ──────────────────────────────────────────────────────────────
  technicians: {
    list: q<Technician[]>("technicians.list", () => "/api/technicians"),
    create: mCreate("technicians.create", "/api/technicians"),
    rename: mBody("technicians.rename", "PATCH", "/api/technicians"),
    toggleActive: m(
      "technicians.toggleActive",
      "POST",
      (args) => `/api/technicians/${pickId(args)}/toggle`,
    ),
    remove: mBody("technicians.remove", "DELETE", "/api/technicians"),
  },

  // ── Produtos e serviços (catálogo) ────────────────────────────────────────
  products: {
    list: q<ProductService[]>("products.list", () => "/api/products"),
    create: mCreate("products.create", "/api/products", (args) => ({
      name: args?.name,
      itemType: args?.itemType,
      price: args?.price,
    })),
    update: mBody("products.update", "PATCH", "/api/products"),
    remove: mBody("products.remove", "DELETE", "/api/products"),
  },

  // ── Notificações ──────────────────────────────────────────────────────────
  inAppNotifications: {
    listForUser: q("inAppNotifications.listForUser", () => "/api/in-app-notifications"),
    markRead: m(
      "inAppNotifications.markRead",
      "POST",
      (args) => `/api/in-app-notifications/${pickId(args)}/read`,
    ),
    markAllRead: m(
      "inAppNotifications.markAllRead",
      "POST",
      () => "/api/in-app-notifications/read-all",
    ),
  },

  notificationSettings: {
    get: q("notificationSettings.get", () => "/api/notification-settings"),
    upsert: m(
      "notificationSettings.upsert",
      "PUT",
      () => "/api/notification-settings",
      (args) => args ?? {},
    ),
  },

  notificationRules: {
    list: q<NotificationRule[]>("notificationRules.list", () => "/api/notification-rules"),
    create: mCreate("notificationRules.create", "/api/notification-rules", (args) => args ?? {}),
    update: mBody("notificationRules.update", "PATCH", "/api/notification-rules"),
    remove: mBody("notificationRules.remove", "DELETE", "/api/notification-rules"),
  },

  inactivityCheck: {
    runNow: m("inactivityCheck.runNow", "POST", () => "/api/inactivity/run"),
  },

  // ── Backup e restauração (admin) ──────────────────────────────────────────
  backups: {
    list: q<BackupList>("backups.list", () => "/api/backups"),
    create: m("backups.create", "POST", () => "/api/backups"),
    restore: m(
      "backups.restore",
      "POST",
      (args) => `/api/backups/${pickId(args)}/restore`,
      () => undefined,
    ),
  },

  // ── Personalidades do bot "Ping IA" (só admin) ────────────────────────────
  botPersonalidades: {
    list: q<BotPersonalidade[]>("botPersonalidades.list", () => "/api/admin/bot-personalidades"),
    update: m(
      "botPersonalidades.update",
      "PUT",
      (args) => `/api/admin/bot-personalidades/${args?.slot}`,
      (args) => ({
        nome: args?.nome,
        emoji: args?.emoji,
        system_prompt: args?.system_prompt,
      }),
    ),
    ativar: m(
      "botPersonalidades.ativar",
      "POST",
      (args) => `/api/admin/bot-personalidades/${args?.slot}/ativar`,
      () => undefined,
    ),
    desativarTodas: m(
      "botPersonalidades.desativarTodas",
      "POST",
      () => "/api/admin/bot-personalidades/desativar-todas",
      () => undefined,
    ),
  },

  // ── Bot "Ping IA" (Configurações → Bot Ping IA, só admin) ──────────────────
  botConfig: {
    get: q("botConfig.get", () => "/api/admin/bot-config"),
    update: m(
      "botConfig.update",
      "PUT",
      () => "/api/admin/bot-config",
      (args) => args ?? {},
    ),
    test: m(
      "botConfig.test",
      "POST",
      () => "/api/admin/bot-config/test",
      (args) => args ?? {},
    ),
    // `{ provider, base_url }` deixa o formulário consultar o catálogo do
    // provedor ANTES de salvar a troca. A chave nunca vai na URL.
    models: q<BotModelsResult>("botConfig.models", (args) => {
      const params = new URLSearchParams()
      if (args?.provider) params.set("provider", String(args.provider))
      if (args?.base_url) params.set("base_url", String(args.base_url))
      const query = params.toString()
      return `/api/admin/bot-config/models${query ? `?${query}` : ""}`
    }),
  },
}

export type Api = typeof api
