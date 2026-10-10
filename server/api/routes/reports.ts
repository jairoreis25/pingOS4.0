/**
 * Módulo de Relatórios do PingOS.
 *
 * Cinco relatórios, todos **calculados no MySQL** (JOIN + GROUP BY + agregações)
 * e nunca em memória como o painel de métricas fazia:
 *
 *   GET /api/reports/tickets        chamados do Kanban (com totalizadores)
 *   GET /api/reports/technicians    desempenho por responsável
 *   GET /api/reports/sectors        produtividade por setor
 *   GET /api/reports/users          usuários e permissões  (só admin)
 *   GET /api/reports/notifications  auditoria de envios
 *   GET /api/reports/filters        opções dos filtros (responsáveis, setores)
 *   POST /api/reports/log           auditoria de quem gerou/exportou
 *
 * Regras que valem para todas as rotas:
 *   * RBAC — `reports.view` em tudo; `reports.export` para registrar exportação;
 *     o relatório de usuários exige **administrador**.
 *   * Escopo de visão — um usuário com Kanban restrito (colunas/atribuição) só
 *     enxerga nos relatórios os mesmos chamados que enxerga no quadro. Sem isso
 *     o relatório seria uma porta lateral para os chamados que ele não pode ver.
 *   * SQL sempre com placeholders (`?`) — nenhum valor de filtro entra na
 *     string da query.
 *   * Teto de linhas por página (`MAX_LIMIT`) + `LIMIT/OFFSET`: um relatório
 *     grande é paginado em vez de derrubar a API tentando devolver tudo.
 *   * Datas são BIGINT em milissegundos (padrão do banco), então o período é
 *     filtrado por número — sem conversão de timezone no SQL. O painel manda
 *     timestamps em ms calculados no navegador, para que valha o fuso do
 *     usuário, e não o do servidor.
 */

import { Router } from "express"
import {
  TICKET_STATUSES,
  canViewStatus,
  hasViewAssignmentRestriction,
  isAdmin,
} from "../../../src/lib/permissions"
import { TICKET_CATEGORY_UNSET, normalizeTicketCategory } from "../../../src/lib/ticket-categories"
import { execute, newId, query, queryOne } from "../../mysql/pool"
import { asyncHandler, badRequest, forbidden } from "../errors"
import { requireAdmin, requirePermission, type AuthContext } from "../permissions"
import { toNumber } from "../types"

export const reportsRouter = Router()

const PRIORITIES = ["baixa", "media", "alta", "critica"] as const
const DAY_MS = 86_400_000

/** Teto de linhas por página (protege a API e o navegador). */
const MAX_LIMIT = 1000
const DEFAULT_LIMIT = 100

/* -------------------------------------------------------------------------- */
/* Leitura dos filtros                                                         */
/* -------------------------------------------------------------------------- */

/** Um valor de query pode chegar repetido (`?status=a&status=b`) — usa o 1º. */
function firstValue(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value
}

function readText(value: unknown, maxLength = 200): string | null {
  const raw = firstValue(value)
  if (raw === undefined || raw === null) return null
  const text = String(raw).trim()
  if (!text) return null
  return text.length > maxLength ? text.slice(0, maxLength) : text
}

/** Um limite do período: data pura (`YYYY-MM-DD`) ou timestamp em ms. */
function parseBoundary(value: unknown, edge: "start" | "end"): number | null {
  const text = readText(value, 40)
  if (!text) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-").map(Number)
    const date =
      edge === "start"
        ? new Date(year, month - 1, day, 0, 0, 0, 0)
        : new Date(year, month - 1, day, 23, 59, 59, 999)
    if (Number.isNaN(date.getTime())) throw badRequest(`Data inválida: ${text}`)
    return date.getTime()
  }
  const numeric = Number(text)
  if (Number.isFinite(numeric) && numeric > 0) return numeric
  throw badRequest(`Data inválida: ${text}`)
}

/** Janela do relatório — sem filtro, os últimos 30 dias. */
function readRange(q: Record<string, unknown>): { start: number; end: number } {
  const end = parseBoundary(q.end, "end") ?? Date.now()
  const start = parseBoundary(q.start, "start") ?? end - 30 * DAY_MS
  if (start > end) throw badRequest("A data inicial não pode ser maior que a final.")
  return { start, end }
}

function readPagination(q: Record<string, unknown>): { limit: number; offset: number } {
  const rawLimit = Number(firstValue(q.limit))
  const rawOffset = Number(firstValue(q.offset))
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
      : DEFAULT_LIMIT
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
  return { limit, offset }
}

/* -------------------------------------------------------------------------- */
/* Montagem do WHERE                                                           */
/* -------------------------------------------------------------------------- */

interface WhereBuilder {
  conditions: string[]
  params: unknown[]
}

/**
 * Restringe o resultado ao que o usuário pode ver no Kanban.
 *
 * Aplica as mesmas regras do quadro (`canViewStatus` + restrições de
 * atribuição). Administrador não sofre restrição — igual ao resto do sistema.
 */
function applyVisibility(ctx: AuthContext, qb: WhereBuilder): void {
  if (isAdmin(ctx.user.role)) return

  const allowed = TICKET_STATUSES.filter((status) => canViewStatus(ctx.permissions, status))
  if (allowed.length < TICKET_STATUSES.length) {
    if (allowed.length === 0) {
      qb.conditions.push("1 = 0")
      return
    }
    qb.conditions.push(`t.status IN (${allowed.map(() => "?").join(", ")})`)
    qb.params.push(...allowed)
  }

  if (hasViewAssignmentRestriction(ctx.permissions)) {
    const rules: string[] = []
    if (ctx.permissions.includes("tickets.view.own")) {
      rules.push("t.assignee_id = ?")
      qb.params.push(ctx.user.id)
    }
    if (ctx.permissions.includes("tickets.view.unassigned")) {
      rules.push("t.assignee_id IS NULL")
    }
    qb.conditions.push(rules.length > 0 ? `(${rules.join(" OR ")})` : "1 = 0")
  }
}

interface TicketFilterOptions {
  /** Coluna de data do período (padrão: criação do chamado). */
  dateColumn?: string
  /** Ignora `status`/`priority` da query (relatórios em que não fazem sentido). */
  ignoreStatus?: boolean
  ignorePriority?: boolean
  /** Só chamados com responsável atribuído. */
  assignedOnly?: boolean
}

/**
 * Filtros comuns dos relatórios de chamados.
 *
 * Toda query que usar `setor` precisa ter `LEFT JOIN users cu ON cu.id =
 * t.creator_id` — o setor de quem abriu o chamado é o setor do chamado.
 */
function ticketFilters(
  ctx: AuthContext,
  q: Record<string, unknown>,
  opts: TicketFilterOptions = {},
): WhereBuilder & { start: number; end: number } {
  const { start, end } = readRange(q)
  const qb: WhereBuilder = { conditions: [], params: [] }

  qb.conditions.push(`${opts.dateColumn ?? "t.created_at"} BETWEEN ? AND ?`)
  qb.params.push(start, end)

  if (opts.assignedOnly) qb.conditions.push("t.assignee_id IS NOT NULL")

  const status = readText(q.status, 20)
  if (status && !opts.ignoreStatus) {
    if (!(TICKET_STATUSES as readonly string[]).includes(status)) {
      throw badRequest("Status inválido.")
    }
    qb.conditions.push("t.status = ?")
    qb.params.push(status)
  }

  const priority = readText(q.priority, 20)
  if (priority && !opts.ignorePriority) {
    if (!(PRIORITIES as readonly string[]).includes(priority)) {
      throw badRequest("Prioridade inválida.")
    }
    qb.conditions.push("t.priority = ?")
    qb.params.push(priority)
  }

  const assigneeId = readText(q.assigneeId, 64)
  if (assigneeId) {
    qb.conditions.push("t.assignee_id = ?")
    qb.params.push(assigneeId)
  }

  const categoria = readText(q.categoria, 40)
  if (categoria) {
    if (categoria === TICKET_CATEGORY_UNSET) {
      // "Sem categoria": é onde caem os chamados anteriores à coluna existir.
      qb.conditions.push("(t.categoria IS NULL OR t.categoria = '')")
    } else {
      // Qualquer outra coisa precisa ser uma categoria válida — a mesma lista
      // que o dropdown de edição usa (o normalizador aceita variações de caixa).
      const normalized = normalizeTicketCategory(categoria)
      if (!normalized) throw badRequest("Categoria inválida.")
      qb.conditions.push("t.categoria = ?")
      qb.params.push(normalized)
    }
  }

  const client = readText(q.client, 120)
  if (client) {
    qb.conditions.push("(t.guest_name LIKE ? OR t.creator_name LIKE ?)")
    const like = `%${client}%`
    qb.params.push(like, like)
  }

  const setor = readText(q.setor, 120)
  if (setor) {
    qb.conditions.push("cu.setor = ?")
    qb.params.push(setor)
  }

  const search = readText(q.q, 120)
  if (search) {
    qb.conditions.push("(t.title LIKE ? OR CAST(t.number AS CHAR) = ?)")
    qb.params.push(`%${search}%`, search.replace(/\D/g, "") || "-1")
  }

  applyVisibility(ctx, qb)
  return { ...qb, start, end }
}

function whereClause(qb: WhereBuilder): string {
  return qb.conditions.length > 0 ? `WHERE ${qb.conditions.join(" AND ")}` : ""
}

/* -------------------------------------------------------------------------- */
/* Helpers de dados                                                            */
/* -------------------------------------------------------------------------- */

interface AssigneeInfo {
  name: string
  type: "user" | "technician"
}

/** Nomes dos responsáveis (usuários + técnicos) em duas consultas curtas. */
async function loadAssignees(): Promise<Map<string, AssigneeInfo>> {
  const [users, technicians] = await Promise.all([
    query<{ id: string; name: string | null }>("SELECT `id`, `name` FROM `users`"),
    query<{ id: string; name: string | null }>("SELECT `id`, `name` FROM `technicians`"),
  ])
  const map = new Map<string, AssigneeInfo>()
  for (const user of users) {
    map.set(user.id, { name: user.name ?? "(sem nome)", type: "user" })
  }
  for (const technician of technicians) {
    map.set(technician.id, { name: technician.name ?? "(sem nome)", type: "technician" })
  }
  return map
}

/** Arredonda para 1 casa — evita "3,6666666 dias" na tela. */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** Arredonda para 2 casas — dinheiro (valor total do chamado). */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

function daysBetween(from: number, to: number): number {
  return round1(Math.max(0, to - from) / DAY_MS)
}

/** Data legível (pt-BR) — o relatório sai em PDF/XLS igual ao que está na tela. */
function toIso(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/* -------------------------------------------------------------------------- */
/* 1. Relatório de Chamados                                                    */
/* -------------------------------------------------------------------------- */

interface TicketReportRow {
  id: string
  number: number
  os: string | null
  title: string | null
  status: string
  priority: string
  assignee_id: string | null
  assignee_type: string | null
  client_name: string | null
  client_setor: string | null
  valor_total: number | null
  created_at: number
  updated_at: number
}

reportsRouter.get(
  "/tickets",
  asyncHandler(async (req, res) => {
    const ctx = requirePermission(req, "reports.view")
    const q = (req.query ?? {}) as Record<string, unknown>
    const filters = ticketFilters(ctx, q)
    const { limit, offset } = readPagination(q)
    const where = whereClause(filters)

    // A listagem e os totalizadores usam o MESMO WHERE — o número do rodapé
    // sempre fecha com as linhas da tabela (a página é só um recorte).
    const [rows, totalsRow, grouped] = await Promise.all([
      query<TicketReportRow>(
        `SELECT t.id, t.number, t.title, t.status, t.priority,
                t.os, t.valor_total,
                t.assignee_id, t.assignee_type,
                COALESCE(NULLIF(t.guest_name, ''), t.creator_name, 'Cliente') AS client_name,
                cu.setor AS client_setor,
                t.created_at, t.updated_at
           FROM tickets t
           LEFT JOIN users cu ON cu.id = t.creator_id
           ${where}
          ORDER BY t.created_at DESC
          LIMIT ? OFFSET ?`,
        [...filters.params, limit, offset],
      ),
      queryOne<{
        total: number
        finished: number | null
        finished_ms: number | null
        valor_total: number | null
      }>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN t.status IN ('resolvido','fechado') THEN 1 ELSE 0 END) AS finished,
                SUM(CASE WHEN t.status IN ('resolvido','fechado')
                         THEN (t.updated_at - t.created_at) ELSE 0 END) AS finished_ms,
                SUM(COALESCE(t.valor_total, 0)) AS valor_total
           FROM tickets t
           LEFT JOIN users cu ON cu.id = t.creator_id
           ${where}`,
        filters.params,
      ),
      query<{ status: string; priority: string; qty: number }>(
        `SELECT t.status, t.priority, COUNT(*) AS qty
           FROM tickets t
           LEFT JOIN users cu ON cu.id = t.creator_id
           ${where}
          GROUP BY t.status, t.priority`,
        filters.params,
      ),
    ])

    const assignees = await loadAssignees()
    const now = Date.now()

    const byStatus: Record<string, number> = {}
    const byPriority: Record<string, number> = {}
    for (const row of grouped) {
      byStatus[row.status] = (byStatus[row.status] ?? 0) + toNumber(row.qty)
      byPriority[row.priority] = (byPriority[row.priority] ?? 0) + toNumber(row.qty)
    }

    const total = toNumber(totalsRow?.total)
    const finished = toNumber(totalsRow?.finished)
    const finishedMs = toNumber(totalsRow?.finished_ms)

    res.json({
      report: "tickets",
      period: { start: filters.start, end: filters.end },
      rows: rows.map((row) => {
        const done = row.status === "resolvido" || row.status === "fechado"
        const assignee = row.assignee_id ? assignees.get(row.assignee_id) : undefined
        return {
          id: row.id,
          number: toNumber(row.number),
          os: row.os?.trim() ?? "",
          title: row.title ?? "(sem título)",
          status: row.status,
          priority: row.priority,
          assignee: assignee?.name ?? "",
          assigneeType: assignee?.type ?? null,
          client: row.client_name ?? "Cliente",
          setor: row.client_setor?.trim() || "Sem setor",
          // `null` = chamado sem valor lançado (a tela mostra "—" e a planilha
          // deixa a célula vazia em vez de escrever 0,00).
          valorTotal: row.valor_total === null ? null : round2(toNumber(row.valor_total)),
          createdAt: toNumber(row.created_at),
          updatedAt: toNumber(row.updated_at),
          createdAtLabel: toIso(row.created_at),
          updatedAtLabel: toIso(row.updated_at),
          // "Tempo total em dias": fechado conta até a última atualização;
          // em andamento conta até agora (o chamado ainda está parado na fila).
          totalDays: daysBetween(toNumber(row.created_at), done ? toNumber(row.updated_at) : now),
          resolutionDays: done
            ? daysBetween(toNumber(row.created_at), toNumber(row.updated_at))
            : null,
        }
      }),
      totals: {
        total,
        resolved: finished,
        open: total - finished,
        avgResolutionDays: finished > 0 ? round1(finishedMs / finished / DAY_MS) : 0,
        valorTotal: round2(toNumber(totalsRow?.valor_total)),
        byStatus,
        byPriority,
      },
      page: {
        limit,
        offset,
        count: rows.length,
        hasMore: offset + rows.length < total,
        maxLimit: MAX_LIMIT,
      },
    })
  }),
)

/* -------------------------------------------------------------------------- */
/* 2. Desempenho por Técnico                                                   */
/* -------------------------------------------------------------------------- */

reportsRouter.get(
  "/technicians",
  asyncHandler(async (req, res) => {
    const ctx = requirePermission(req, "reports.view")
    const q = (req.query ?? {}) as Record<string, unknown>
    const filters = ticketFilters(ctx, q, { assignedOnly: true })
    const where = whereClause(filters)

    const [performance, events] = await Promise.all([
      query<{
        id: string
        total: number
        resolved: number
        in_progress: number
        avg_ms: number | null
      }>(
        `SELECT t.assignee_id AS id,
                COUNT(*) AS total,
                SUM(CASE WHEN t.status = 'resolvido' THEN 1 ELSE 0 END) AS resolved,
                SUM(CASE WHEN t.status IN ('aberto','em_andamento','aguardando')
                         THEN 1 ELSE 0 END) AS in_progress,
                AVG(CASE WHEN t.status = 'resolvido'
                         THEN (t.updated_at - t.created_at) END) AS avg_ms
           FROM tickets t
           LEFT JOIN users cu ON cu.id = t.creator_id
           ${where}
          GROUP BY t.assignee_id
          ORDER BY resolved DESC, total DESC`,
        filters.params,
      ),
      // Taxa de reabertura: precisa do histórico de status — o chamado guarda
      // apenas o status atual. Vale a partir do histórico gravado.
      query<{ id: string; ticket_id: string; to_status: string; created_at: number }>(
        `SELECT t.assignee_id AS id, e.ticket_id, e.to_status, e.created_at
           FROM ticket_status_events e
           JOIN tickets t ON t.id = e.ticket_id
           LEFT JOIN users cu ON cu.id = t.creator_id
           ${where}
          ORDER BY t.assignee_id, e.ticket_id, e.created_at`,
        filters.params,
      ),
    ])

    const assignees = await loadAssignees()

    // Agrupa os eventos por (responsável, chamado) para identificar reaberturas:
    // o chamado foi para Resolvido/Fechado e depois voltou para a fila.
    const perTicket = new Map<string, { resolved: boolean; reopened: boolean }>()
    const perAssignee = new Map<
      string,
      { resolvedTickets: Set<string>; reopenedTickets: Set<string> }
    >()
    for (const event of events) {
      const key = `${event.id}|${event.ticket_id}`
      const state = perTicket.get(key) ?? { resolved: false, reopened: false }
      if (event.to_status === "resolvido" || event.to_status === "fechado") {
        state.resolved = true
      } else if (state.resolved) {
        // Voltou para a fila depois de ter sido resolvido → reaberto.
        state.reopened = true
      }
      perTicket.set(key, state)

      const stats = perAssignee.get(event.id) ?? {
        resolvedTickets: new Set<string>(),
        reopenedTickets: new Set<string>(),
      }
      if (state.resolved) stats.resolvedTickets.add(event.ticket_id)
      if (state.reopened) stats.reopenedTickets.add(event.ticket_id)
      perAssignee.set(event.id, stats)
    }

    const rows = performance.map((row) => {
      const assignee = assignees.get(row.id)
      const stats = perAssignee.get(row.id)
      const resolvedEvents = stats?.resolvedTickets.size ?? 0
      const reopened = stats?.reopenedTickets.size ?? 0
      const avgMs = row.avg_ms === null ? 0 : toNumber(row.avg_ms)
      return {
        id: row.id,
        name: assignee?.name ?? "(removido)",
        type: assignee?.type ?? null,
        total: toNumber(row.total),
        resolved: toNumber(row.resolved),
        inProgress: toNumber(row.in_progress),
        avgResolutionDays: round1(avgMs / DAY_MS),
        reopenRate: resolvedEvents > 0 ? round1((reopened / resolvedEvents) * 100) : 0,
        reopened,
        // `false` quando o histórico ainda não tem dados deste responsável —
        // a tela avisa em vez de mostrar "0,0% de reabertura" como se fosse real.
        reopenTracked: resolvedEvents > 0,
      }
    })

    res.json({
      report: "technicians",
      period: { start: filters.start, end: filters.end },
      rows,
      totals: {
        assignees: rows.length,
        total: rows.reduce((sum, row) => sum + row.total, 0),
        resolved: rows.reduce((sum, row) => sum + row.resolved, 0),
        inProgress: rows.reduce((sum, row) => sum + row.inProgress, 0),
        reopened: rows.reduce((sum, row) => sum + row.reopened, 0),
        avgResolutionDays:
          rows.length > 0
            ? round1(rows.reduce((sum, row) => sum + row.avgResolutionDays, 0) / rows.length)
            : 0,
      },
    })
  }),
)

/* -------------------------------------------------------------------------- */
/* 3. Produtividade por Setor                                                  */
/* -------------------------------------------------------------------------- */

reportsRouter.get(
  "/sectors",
  asyncHandler(async (req, res) => {
    const ctx = requirePermission(req, "reports.view")
    const q = (req.query ?? {}) as Record<string, unknown>
    const filters = ticketFilters(ctx, q)
    const where = whereClause(filters)

    // O setor vem do usuário solicitante (o setor "dono" do chamado). Chamados
    // abertos pelo formulário público não têm setor → "Sem setor".
    // Tempo de resposta = criação → primeira saída de "Aberto" (histórico de
    // status). Chamados que nunca saíram de Aberto não entram na média.
    const rows = await query<{
      setor: string
      total: number
      resolved: number
      pending: number
      resolution_ms: number | null
      response_ms: number | null
    }>(
      `SELECT COALESCE(NULLIF(cu.setor, ''), 'Sem setor') AS setor,
              COUNT(*) AS total,
              SUM(CASE WHEN t.status IN ('resolvido','fechado') THEN 1 ELSE 0 END) AS resolved,
              SUM(CASE WHEN t.status IN ('aberto','em_andamento','aguardando') THEN 1 ELSE 0 END) AS pending,
              AVG(CASE WHEN t.status IN ('resolvido','fechado')
                       THEN (t.updated_at - t.created_at) END) AS resolution_ms,
              AVG(fm.first_move - t.created_at) AS response_ms
         FROM tickets t
         LEFT JOIN users cu ON cu.id = t.creator_id
         LEFT JOIN (
              SELECT ticket_id, MIN(created_at) AS first_move
                FROM ticket_status_events
               WHERE from_status = 'aberto'
               GROUP BY ticket_id
         ) fm ON fm.ticket_id = t.id
         ${where}
        GROUP BY setor
        ORDER BY total DESC`,
      filters.params,
    )

    const mapped = rows.map((row) => ({
      setor: row.setor,
      total: toNumber(row.total),
      resolved: toNumber(row.resolved),
      pending: toNumber(row.pending),
      avgResolutionDays: round1(toNumber(row.resolution_ms) / DAY_MS),
      avgResponseDays: row.response_ms === null ? null : round1(toNumber(row.response_ms) / DAY_MS),
    }))

    res.json({
      report: "sectors",
      period: { start: filters.start, end: filters.end },
      rows: mapped,
      totals: {
        sectors: mapped.length,
        total: mapped.reduce((sum, row) => sum + row.total, 0),
        resolved: mapped.reduce((sum, row) => sum + row.resolved, 0),
        pending: mapped.reduce((sum, row) => sum + row.pending, 0),
      },
    })
  }),
)

/* -------------------------------------------------------------------------- */
/* 4. Usuários e Permissões (apenas administrador)                             */
/* -------------------------------------------------------------------------- */

reportsRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    // Dados de acesso do sistema: só o administrador, nunca por permissão.
    requireAdmin(req)
    const q = (req.query ?? {}) as Record<string, unknown>
    const { limit, offset } = readPagination(q)

    const conditions: string[] = []
    const params: unknown[] = []

    const search = readText(q.q, 120)
    if (search) {
      conditions.push("(u.name LIKE ? OR u.username LIKE ? OR u.email LIKE ?)")
      const like = `%${search}%`
      params.push(like, like, like)
    }
    const role = readText(q.role, 64)
    if (role) {
      conditions.push("u.role = ?")
      params.push(role)
    }
    const setor = readText(q.setor, 120)
    if (setor) {
      conditions.push("u.setor = ?")
      params.push(setor)
    }
    const active = readText(q.active, 5)
    if (active === "true" || active === "false") {
      conditions.push("u.active = ?")
      params.push(active === "true" ? 1 : 0)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

    const [rows, totalsRow, byRole] = await Promise.all([
      query<{
        id: string
        name: string | null
        username: string | null
        email: string | null
        role: string | null
        setor: string | null
        contato: string | null
        active: number
        created_at: number | null
        has_password: number
        permissions: unknown
      }>(
        `SELECT u.id, u.name, u.username, u.email, u.role, u.setor, u.contato,
                u.active, u.created_at, (u.password_hash IS NOT NULL) AS has_password,
                u.permissions
           FROM users u
           ${where}
          ORDER BY u.name
          LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      queryOne<{ total: number; active: number | null }>(
        `SELECT COUNT(*) AS total, SUM(u.active = 1) AS active FROM users u ${where}`,
        params,
      ),
      query<{ role: string; qty: number }>(
        `SELECT COALESCE(NULLIF(u.role, ''), '(sem papel)') AS role, COUNT(*) AS qty
           FROM users u ${where}
          GROUP BY role
          ORDER BY qty DESC`,
        params,
      ),
    ])

    const total = toNumber(totalsRow?.total)

    res.json({
      report: "users",
      period: null,
      rows: rows.map((row) => {
        const overrides = Array.isArray(row.permissions) ? row.permissions.length : 0
        return {
          id: row.id,
          name: row.name ?? "(sem nome)",
          username: row.username ?? row.email ?? "",
          email: row.email ?? "",
          role: row.role ?? "(sem papel)",
          setor: row.setor?.trim() || "Sem setor",
          contato: row.contato ?? "",
          active: toNumber(row.active) === 1,
          hasPassword: toNumber(row.has_password) === 1,
          // Quantas permissões foram marcadas "na mão" para este usuário
          // (override do papel) — é o que explica um acesso fora do padrão.
          permissionOverrides: overrides,
          createdAt: row.created_at === null ? null : toNumber(row.created_at),
          createdAtLabel: toIso(row.created_at),
        }
      }),
      totals: {
        total,
        active: toNumber(totalsRow?.active),
        inactive: total - toNumber(totalsRow?.active),
        byRole: Object.fromEntries(byRole.map((row) => [row.role, toNumber(row.qty)])),
      },
      page: {
        limit,
        offset,
        count: rows.length,
        hasMore: offset + rows.length < total,
        maxLimit: MAX_LIMIT,
      },
    })
  }),
)

/* -------------------------------------------------------------------------- */
/* 5. Notificações enviadas (auditoria)                                        */
/* -------------------------------------------------------------------------- */

reportsRouter.get(
  "/notifications",
  asyncHandler(async (req, res) => {
    requirePermission(req, "reports.view")
    const q = (req.query ?? {}) as Record<string, unknown>
    const { start, end } = readRange(q)
    const { limit, offset } = readPagination(q)

    const conditions = ["n.sent_at BETWEEN ? AND ?"]
    const params: unknown[] = [start, end]

    const type = readText(q.type, 20)
    if (type) {
      if (!["email", "telegram", "whatsapp"].includes(type)) {
        throw badRequest("Canal inválido.")
      }
      conditions.push("n.type = ?")
      params.push(type)
    }
    const status = readText(q.notificationStatus, 20)
    if (status) {
      if (!["sent", "failed", "pending"].includes(status)) {
        throw badRequest("Situação inválida.")
      }
      conditions.push("n.status = ?")
      params.push(status)
    }
    const search = readText(q.q, 120)
    if (search) {
      conditions.push("(t.title LIKE ? OR n.recipient LIKE ? OR CAST(t.number AS CHAR) = ?)")
      params.push(`%${search}%`, `%${search}%`, search.replace(/\D/g, "") || "-1")
    }

    const where = `WHERE ${conditions.join(" AND ")}`

    const [rows, totalsRow, byChannel] = await Promise.all([
      query<{
        id: string
        sent_at: number
        type: string
        status: string
        recipient: string | null
        error: string | null
        ticket_number: number | null
        ticket_title: string | null
        rule_name: string | null
      }>(
        `SELECT n.id, n.sent_at, n.type, n.status, n.recipient, n.error,
                t.number AS ticket_number, t.title AS ticket_title,
                r.name AS rule_name
           FROM notifications n
           LEFT JOIN tickets t ON t.id = n.ticket_id
           LEFT JOIN notification_rules r ON r.id = n.rule_id
           ${where}
          ORDER BY n.sent_at DESC
          LIMIT ? OFFSET ?`,
        [...params, limit, offset],
      ),
      queryOne<{ total: number; sent: number | null; failed: number | null }>(
        `SELECT COUNT(*) AS total,
                SUM(n.status = 'sent') AS sent,
                SUM(n.status = 'failed') AS failed
           FROM notifications n
           LEFT JOIN tickets t ON t.id = n.ticket_id
           ${where}`,
        params,
      ),
      query<{ type: string; qty: number }>(
        `SELECT n.type, COUNT(*) AS qty
           FROM notifications n
           LEFT JOIN tickets t ON t.id = n.ticket_id
           ${where}
          GROUP BY n.type`,
        params,
      ),
    ])

    const total = toNumber(totalsRow?.total)

    res.json({
      report: "notifications",
      period: { start, end },
      rows: rows.map((row) => ({
        id: row.id,
        sentAt: toNumber(row.sent_at),
        sentAtLabel: toIso(row.sent_at),
        ticket: row.ticket_number === null ? "" : `#${toNumber(row.ticket_number)}`,
        ticketTitle: row.ticket_title ?? "",
        rule: row.rule_name?.trim() || "—",
        recipient: row.recipient?.trim() || "—",
        channel: row.type,
        status: row.status,
        error: row.error ?? "",
      })),
      totals: {
        total,
        sent: toNumber(totalsRow?.sent),
        failed: toNumber(totalsRow?.failed),
        byChannel: Object.fromEntries(byChannel.map((row) => [row.type, toNumber(row.qty)])),
      },
      page: {
        limit,
        offset,
        count: rows.length,
        hasMore: offset + rows.length < total,
        maxLimit: MAX_LIMIT,
      },
    })
  }),
)

/* -------------------------------------------------------------------------- */
/* Opções dos filtros                                                          */
/* -------------------------------------------------------------------------- */

reportsRouter.get(
  "/filters",
  asyncHandler(async (req, res) => {
    requirePermission(req, "reports.view")

    const [assignees, setores] = await Promise.all([
      loadAssignees(),
      query<{ setor: string }>(
        "SELECT DISTINCT `setor` FROM `users` WHERE `setor` IS NOT NULL AND `setor` <> '' ORDER BY `setor`",
      ),
    ])

    res.json({
      assignees: [...assignees.entries()]
        .map(([id, info]) => ({ id, name: info.name, type: info.type }))
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR")),
      setores: setores.map((row) => row.setor),
      statuses: [...TICKET_STATUSES],
      priorities: [...PRIORITIES],
    })
  }),
)

/* -------------------------------------------------------------------------- */
/* Auditoria dos relatórios                                                    */
/* -------------------------------------------------------------------------- */

/** Registra quem gerou/exportou, quando, com quais filtros e em qual formato. */
reportsRouter.post(
  "/log",
  asyncHandler(async (req, res) => {
    const ctx = requirePermission(req, "reports.view")
    const body = (req.body ?? {}) as Record<string, unknown>

    const report = readText(body.report, 40) ?? "desconhecido"
    const rawFormat = readText(body.format, 10)
    const format: "tela" | "xls" | "pdf" =
      rawFormat === "xls" || rawFormat === "pdf" ? rawFormat : "tela"

    // Exportar exige permissão própria; ver na tela, não.
    if (format !== "tela" && !ctx.permissions.includes("reports.export")) {
      throw forbidden("Sem permissão para exportar relatórios.")
    }

    const filters = body.filters && typeof body.filters === "object" ? body.filters : {}
    await execute(
      "INSERT INTO `report_logs` (`id`, `report`, `format`, `filters`, `row_count`, `user_id`, `user_name`, `created_at`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        newId(),
        report,
        format,
        JSON.stringify(filters).slice(0, 4000),
        toNumber(body.rowCount),
        ctx.user.id,
        ctx.user.name ?? ctx.user.email ?? null,
        Date.now(),
      ],
    )

    res.status(201).json({ success: true })
  }),
)
