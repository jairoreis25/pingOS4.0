/**
 * Formatos de linha do banco e conversores para o formato da API.
 *
 * O backend MySQL devolve os mesmos nomes de campo que o frontend já consome
 * hoje do Convex (camelCase, `_id`, `_creationTime`, timestamps em ms). Assim a
 * migração do frontend é mecânica: troca-se a chamada Convex pela chamada HTTP
 * e o resto do componente continua igual.
 */

import { DEFAULT_PRODUCT_SERVICE_TYPE, normalizeProductServiceType } from "../../src/lib/products"

export interface UserRow {
  id: string
  name: string | null
  image: string | null
  email: string | null
  username: string | null
  password_hash: string | null
  email_verification_time: number | null
  is_anonymous: number
  role: string | null
  active: number
  setor: string | null
  contato: string | null
  permissions: unknown
  created_by: string | null
  created_at: number | null
  updated_at: number | null
}

export interface TicketRow {
  id: string
  number: number
  title: string | null
  description: string | null
  solucao: string | null
  orcamento: string | null
  obs: string | null
  status_equipamento: string | null
  categoria: string | null
  status: string
  priority: string
  creator_id: string | null
  guest_name: string | null
  guest_contact: string | null
  image_url: string | null
  valor_total: number | string | null
  os: string | null
  creator_name: string | null
  location: string | null
  assignee_id: string | null
  assignee_type: string | null
  created_at: number
  updated_at: number
  /** 0 = ninguém abriu o chamado ainda (usado pelo destaque "NOVO" no Kanban). */
  visualizado: number | null
}

export interface TechnicianRow {
  id: string
  name: string
  funcao: string | null
  contato: string | null
  active: number
  created_at: number
}

export interface ProductServiceRow {
  id: string
  name: string
  item_type: string | null
  price: number | string
  active: number
  created_at: number
  updated_at: number
}

export interface RoleRow {
  id: string
  name: string
  permissions: unknown
  is_system: number
  created_at: number
}

/** Normaliza um valor JSON do MySQL (o driver pode devolver string ou objeto). */
export function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v))
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
    } catch {
      return []
    }
  }
  return []
}

/** `permissions` pode ser null (herda do papel) ou uma lista explícita. */
export function parsePermissionsOverride(value: unknown): string[] | null {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map((v) => String(v))
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : null
    } catch {
      return null
    }
  }
  return null
}

export function toBool(value: unknown, fallback = false): boolean {
  if (value === null || value === undefined) return fallback
  return value === 1 || value === true || value === "1"
}

export function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback
  const n = typeof value === "number" ? value : Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Usuário no formato consumido pela API (nunca expõe `password_hash`). */
export function toPublicUser(row: UserRow) {
  return {
    _id: row.id,
    _creationTime: row.created_at ?? 0,
    id: row.id,
    name: row.name ?? "",
    image: row.image ?? null,
    email: row.email ?? "",
    username: row.username ?? row.email ?? "",
    role: row.role ?? null,
    active: toBool(row.active, true),
    setor: row.setor ?? "",
    contato: row.contato ?? "",
    permissions: parsePermissionsOverride(row.permissions),
    createdBy: row.created_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
    hasPassword: Boolean(row.password_hash),
  }
}

/** Chamado no formato consumido pela API (inclui `_id`/`_creationTime`). */
export function toPublicTicket(row: TicketRow) {
  return {
    _id: row.id,
    _creationTime: row.created_at,
    id: row.id,
    number: row.number,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
    solucao: row.solucao ?? undefined,
    orcamento: row.orcamento ?? undefined,
    obs: row.obs ?? undefined,
    statusEquipamento: row.status_equipamento ?? undefined,
    categoria: row.categoria ?? undefined,
    status: row.status,
    priority: row.priority,
    creatorId: row.creator_id ?? undefined,
    guestName: row.guest_name ?? undefined,
    guestContact: row.guest_contact ?? undefined,
    imageUrl: row.image_url ?? undefined,
    valorTotal: row.valor_total === null ? undefined : toNumber(row.valor_total),
    os: row.os ?? undefined,
    creatorName: row.creator_name ?? undefined,
    location: row.location ?? undefined,
    assigneeId: row.assignee_id ?? undefined,
    assigneeType: row.assignee_type ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    visualizado: toBool(row.visualizado, false),
  }
}

export function toPublicTechnician(row: TechnicianRow) {
  return {
    _id: row.id,
    _creationTime: row.created_at,
    id: row.id,
    name: row.name,
    funcao: row.funcao ?? undefined,
    contato: row.contato ?? undefined,
    active: toBool(row.active, true),
    createdAt: row.created_at,
  }
}

export function toPublicProductService(row: ProductServiceRow) {
  return {
    _id: row.id,
    _creationTime: row.created_at,
    id: row.id,
    name: row.name,
    itemType: normalizeProductServiceType(row.item_type) ?? DEFAULT_PRODUCT_SERVICE_TYPE,
    price: toNumber(row.price),
    active: toBool(row.active, true),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function toPublicRole(row: RoleRow) {
  return {
    _id: row.id,
    _creationTime: row.created_at,
    id: row.id,
    name: row.name,
    permissions: parseJsonArray(row.permissions),
    isSystem: toBool(row.is_system),
    createdAt: row.created_at,
  }
}
