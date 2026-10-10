/**
 * Tipos de dados do frontend no backend MySQL.
 *
 * Antes esses tipos vinham do Convex (`Doc<"tickets">`, `FunctionReturnType<...>`).
 * Agora vivem aqui, descrevendo exatamente o que a API Express devolve — os
 * componentes continuam usando os mesmos nomes de campo (camelCase, `_id`,
 * `_creationTime`, datas em ms).
 */

import type { ProductServiceType } from "@/lib/products"
import type { TicketPriority } from "@/lib/ticket-utils"

/**
 * Identificador de registro. No Convex era um tipo "branded"; no MySQL é uma
 * string opaca de 32 caracteres. Mantido como alias genérico para os componentes
 * que ainda escrevem `Id<"tickets">`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type Id<Table extends string = string> = string

export type TicketStatus = "aberto" | "em_andamento" | "aguardando" | "resolvido" | "fechado"

export type AssigneeType = "user" | "technician"

/** Chamado como o frontend consome (inclui campos calculados da API). */
export interface Ticket {
  _id: string
  _creationTime: number
  id: string
  number: number
  title?: string
  description?: string
  solucao?: string
  orcamento?: string
  obs?: string
  statusEquipamento?: string
  /** Categoria do chamado (Impressoras, Rede, ...) — classificação interna. */
  categoria?: string
  status: TicketStatus
  priority: TicketPriority
  creatorId?: string
  guestName?: string
  guestContact?: string
  imageUrl?: string
  valorTotal?: number
  os?: string
  creatorName: string
  creatorImage?: string
  location?: string
  assigneeId?: string
  assigneeType?: AssigneeType
  assigneeName: string | null
  assigneeImage: string | null
  createdAt: number
  updatedAt: number
}

export interface Technician {
  _id: string
  _creationTime: number
  id: string
  name: string
  funcao?: string
  contato?: string
  active: boolean
  createdAt: number
}

/** Produto ou serviço do catálogo (Configurações → Produtos e Serviços). */
export interface ProductService {
  _id: string
  _creationTime: number
  id: string
  name: string
  /** `produto` (peça/equipamento) ou `servico` (mão de obra). */
  itemType: ProductServiceType
  price: number
  active: boolean
  createdAt: number
  updatedAt: number
}

export interface ManagedUser {
  _id: string
  _creationTime: number
  id: string
  name: string
  image?: string | null
  email: string
  username: string
  role: string | null
  active: boolean
  setor: string
  contato: string
  permissions: string[] | null
  createdBy?: string | null
  createdAt: number
  updatedAt: number | null
  hasPassword: boolean
}

export interface Role {
  _id: string
  _creationTime: number
  id: string
  name: string
  permissions: string[]
  isSystem: boolean
  createdAt: number
}

/** Permissões efetivas do usuário logado (`GET /api/auth/me`). */
export interface EffectivePermissions {
  userId: string
  name: string | null
  role: string | null
  isAdmin: boolean
  active: boolean
  permissions: string[]
}

export type RuleRecipient = "cliente" | "responsavel" | "ambos"

export interface NotificationRule {
  _id: string
  _creationTime: number
  name: string
  statuses: string[]
  days: number
  recipient: RuleRecipient
  channels: string[]
  active: boolean
  createdAt: number
  updatedAt: number
}

/** Métricas do painel (`GET /api/metrics/dashboard`). */
export interface DashboardMetrics {
  total: number
  open: number
  byStatus: Record<string, number>
  byPriority: Record<string, number>
  valorTotal: number
  valorLast30: number
  createdLast30: number
  createdLast90: number
  criticalOpen: number
  avgResolutionHours: number
  resolvedThisMonth: { count: number; total: number }
  resolvedPrevMonth: { count: number; total: number }
  resolvedAllTime: { count: number; total: number }
  techniciansRanking: { name: string; total: number; valor: number; resolved: number }[]
  breakdown: { month: string; created: number; resolved: number; total: number }[]
}

export interface BackupItem {
  _id: string
  _creationTime: number
  filename: string
  size: number
  createdAt: number
  createdBy: string | null
  restoredAt: number | null
  restoredBy: string | null
}

export interface BackupLog {
  _id: string
  action: string
  filename: string | null
  detail: string | null
  user: string | null
  createdAt: number
}

export interface BackupList {
  backups: BackupItem[]
  logs: BackupLog[]
}
