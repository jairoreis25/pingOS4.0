/**
 * Chamados (quadro Kanban) — espelha src/convex/tickets.ts.
 *
 * Notificações: a criação e a mudança de status disparam o despachante de
 * `server/api/notify.ts` (sino in-app para quem vê chamados + e-mail, Telegram e
 * WhatsApp conforme **Configurações → Notificações**). Os envios são
 * "fire-and-forget": nunca atrasam nem derrubam a resposta da requisição.
 */

import { Router } from "express"
import { execute, newId, query, queryOne, withTransaction } from "../../mysql/pool"
import { notifyTicketCreated, notifyTicketStatusChanged } from "../notify"
import { requireAuth, requirePermission } from "../permissions"
import { asyncHandler, badRequest, forbidden, notFound } from "../errors"
import { toNumber, toPublicTicket, type TicketRow } from "../types"
import { canEditTicket, canMoveTo, canViewTicket, isAdmin } from "../../../src/lib/permissions"
import { isTicketCategory, normalizeTicketCategory } from "../../../src/lib/ticket-categories"
import {
  buildTicketPageQuery,
  encodeTicketCursor,
  parseTicketCursor,
  parseTicketLimit,
  type TicketCursor,
} from "../tickets-page"

const TICKET_STATUSES = ["aberto", "em_andamento", "aguardando", "resolvido", "fechado"] as const

const PRIORITIES = ["baixa", "media", "alta", "critica"] as const

/**
 * Colunas da listagem do Kanban.
 *
 * `image_url` fica de fora de propósito: cada imagem é uma data URL de centenas
 * de KB e o quadro é revalidado a cada 10s — enviar todas elas em toda leitura
 * dominava o tráfego do app. Quem precisa da imagem de um chamado específico usa
 * `GET /api/tickets/:id` (abrir o chamado) ou
 * `GET /api/tickets/by-number/:number` (ponte local do WhatsApp, ao mover no
 * Kanban).
 */
const LIST_COLUMNS =
  "`id`, `number`, `title`, `description`, `solucao`, `orcamento`, `obs`, " +
  "`status_equipamento`, `categoria`, `status`, `priority`, `creator_id`, `guest_name`, " +
  "`guest_contact`, `valor_total`, `os`, `creator_name`, `location`, " +
  "`assignee_id`, `assignee_type`, `created_at`, `updated_at`"

type TicketStatus = (typeof TICKET_STATUSES)[number]
type Priority = (typeof PRIORITIES)[number]

/** Chamado "rico" devolvido pela API (nomes resolvidos por `enrichTicket`). */
type Ticket = ReturnType<typeof enrichTicket>

/**
 * Grava a transição de status no histórico (`ticket_status_events`).
 *
 * O chamado guarda só o status atual; sem este log os relatórios não saberiam
 * quando ele saiu de "Aberto" (tempo de resposta) nem se voltou de "Resolvido"
 * (taxa de reabertura). Nunca lança: o status já foi alterado com sucesso, e a
 * perda de uma linha de histórico não pode derrubar a resposta ao usuário.
 */
async function recordStatusEvent(params: {
  ticketId: string
  fromStatus: string | null
  toStatus: string
  userId?: string | null
  userName?: string | null
}): Promise<void> {
  try {
    await execute(
      `INSERT INTO \`ticket_status_events\`
         (\`id\`, \`ticket_id\`, \`from_status\`, \`to_status\`, \`user_id\`, \`user_name\`, \`created_at\`)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        params.ticketId,
        params.fromStatus,
        params.toStatus,
        params.userId ?? null,
        params.userName ?? null,
        Date.now(),
      ],
    )
  } catch (error) {
    console.warn("[tickets] não deu para registrar a mudança de status:", error)
  }
}

/**
 * Categoria do chamado (dropdown de edição) — classificação interna da equipe.
 * Aceita vazio (`null`/"") para limpar; recusa valor fora da lista para não
 * gravar uma categoria que a tela não sabe exibir.
 */
function assertCategoria(value: unknown): string | null {
  if (value === undefined || value === null || String(value).trim() === "") return null
  if (!isTicketCategory(value)) {
    throw badRequest("Categoria inválida.")
  }
  return normalizeTicketCategory(value)
}

/** Normaliza e limita o tamanho de campos de texto (igual ao backend Convex). */
function sanitizeText(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

/**
 * Imagens dos chamados são data URLs (`data:image/jpeg;base64,...`) geradas no
 * navegador por `compressImage` (JPEG 1200px). Isso dá centenas de KB — não
 * pode ser cortado como um campo de texto comum, senão a imagem chega quebrada.
 * O limite real de tamanho é o JSON_BODY_LIMIT do servidor (2 MB por padrão).
 */
const IMAGE_MAX_CHARS = 3_000_000

function sanitizeImage(value: unknown): string | null {
  const text = sanitizeText(value, IMAGE_MAX_CHARS)
  if (!text) return null
  if (text.length > IMAGE_MAX_CHARS) {
    throw badRequest("A imagem é grande demais. Envie uma imagem menor.")
  }
  return text
}

function assertStatus(value: unknown): TicketStatus {
  const status = String(value ?? "") as TicketStatus
  if (!TICKET_STATUSES.includes(status)) {
    throw badRequest("Status inválido.")
  }
  return status
}

function assertPriority(value: unknown): Priority {
  const priority = String(value ?? "media") as Priority
  if (!PRIORITIES.includes(priority)) {
    throw badRequest("Prioridade inválida.")
  }
  return priority
}

/**
 * Próximo número de chamado usando o contador na própria linha: o UPDATE trava
 * a linha (`SELECT ... FOR UPDATE` implícito) e LAST_INSERT_ID devolve o valor
 * já incrementado — dois chamados criados ao mesmo tempo não repetem número.
 */
export async function getNextNumber(): Promise<number> {
  return withTransaction(async (conn) => {
    await conn.query(
      "INSERT IGNORE INTO `counters` (`name`, `value`) SELECT 'ticket_number', COALESCE(MAX(`number`), 0) FROM `tickets`",
    )
    await conn.query(
      "UPDATE `counters` SET `value` = LAST_INSERT_ID(`value` + 1) WHERE `name` = 'ticket_number'",
    )
    const [rows] = await conn.query("SELECT LAST_INSERT_ID() AS value")
    const first = (rows as Array<{ value: number | string }>)[0]
    return toNumber(first?.value, 1)
  })
}

interface EnrichUserRow {
  id: string
  name: string | null
  email: string | null
  image: string | null
}

interface EnrichTechnicianRow {
  id: string
  name: string | null
}

interface Enrichment {
  users: Map<string, EnrichUserRow>
  technicians: Map<string, EnrichTechnicianRow>
}

/**
 * Carrega usuários e técnicos uma vez (evita N+1 no Kanban).
 *
 * Só as colunas usadas para montar nome/imagem do criador e do responsável:
 * `SELECT *` trazia o `password_hash` e os campos de perfil inteiros para cada
 * linha, a troco de nada.
 */
async function loadEnrichment(): Promise<Enrichment> {
  const [users, technicians] = await Promise.all([
    query<EnrichUserRow>("SELECT `id`, `name`, `email`, `image` FROM `users`"),
    query<EnrichTechnicianRow>("SELECT `id`, `name` FROM `technicians`"),
  ])
  return {
    users: new Map(users.map((u) => [u.id, u])),
    technicians: new Map(technicians.map((t) => [t.id, t])),
  }
}

function assigneeInfo(enrichment: Enrichment, row: TicketRow) {
  if (!row.assignee_id) return { name: null as string | null, image: null as string | null }
  const user = enrichment.users.get(row.assignee_id)
  if (user) return { name: user.name ?? user.email ?? null, image: user.image ?? null }
  const tech = enrichment.technicians.get(row.assignee_id)
  if (tech) return { name: tech.name ?? null, image: null }
  return { name: null as string | null, image: null as string | null }
}

/** Versão "rica" do chamado (nomes de criador e responsável resolvidos). */
function enrichTicket(enrichment: Enrichment, row: TicketRow) {
  const base = toPublicTicket(row)
  const creator = row.creator_id ? enrichment.users.get(row.creator_id) : undefined
  const assignee = assigneeInfo(enrichment, row)
  return {
    ...base,
    creatorName:
      row.creator_name ?? row.guest_name ?? creator?.name ?? creator?.email ?? "Convidado",
    creatorImage: creator?.image ?? undefined,
    assigneeName: assignee.name,
    assigneeImage: assignee.image,
  }
}

/** Descobre se o id pertence a um usuário ou a um técnico. */
async function resolveAssigneeType(
  assigneeId: string | null,
): Promise<"user" | "technician" | null> {
  if (!assigneeId) return null
  const user = await queryOne<{ id: string }>("SELECT `id` FROM `users` WHERE `id` = ?", [
    assigneeId,
  ])
  if (user) return "user"
  const tech = await queryOne<{ id: string }>("SELECT `id` FROM `technicians` WHERE `id` = ?", [
    assigneeId,
  ])
  return tech ? "technician" : null
}

/** Reinicia o contador de inatividade do chamado (anti-spam). */
async function resetInactivityLogs(ticketId: string): Promise<void> {
  await execute("DELETE FROM `inactivity_logs` WHERE `ticket_id` = ?", [ticketId])
}

export const ticketsRouter = Router()

// ── GET /api/tickets — lista do Kanban (com paginação por keyset) ───────────
// Sem `limit` devolve a lista completa (contrato antigo). Com `limit`, devolve
// até `limit` chamados **visíveis** e o cursor da próxima página no header
// `X-Next-Cursor`.
ticketsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const ctx = requirePermission(req, "tickets.view")
    const limit = parseTicketLimit(req.query.limit)
    const cursor = parseTicketCursor(req.query.cursor)
    const enrichment = await loadEnrichment()

    const user = ctx.user
    const isVisible = (ticket: Ticket) =>
      canViewTicket(
        ctx.permissions,
        ticket.status,
        ticket.assigneeId,
        user.id,
        ticket.assigneeName,
        user.name,
        isAdmin(user.role),
      )

    if (!limit) {
      const rows = await query<TicketRow>(
        `SELECT ${LIST_COLUMNS} FROM \`tickets\` ORDER BY \`created_at\` DESC, \`id\` DESC`,
      )
      res.json(rows.map((row) => enrichTicket(enrichment, row)).filter(isVisible))
      return
    }

    // O filtro de permissão acontece depois do SELECT, então uma página crua pode
    // render menos chamados visíveis que o `limit`: segue buscando (com teto)
    // até completar a página ou acabar a tabela.
    const MAX_RAW_PAGES = 5
    const visible: Ticket[] = []
    let nextCursor: TicketCursor | null = null
    let pageCursor: TicketCursor | null = cursor

    for (let page = 0; page < MAX_RAW_PAGES; page++) {
      const { sql, params } = buildTicketPageQuery(LIST_COLUMNS, {
        cursor: pageCursor,
        limit,
      })
      const rows = await query<TicketRow>(sql, params)
      if (rows.length === 0) {
        nextCursor = null
        break
      }

      for (const row of rows) {
        if (visible.length >= limit) break
        const ticket = enrichTicket(enrichment, row)
        if (isVisible(ticket)) visible.push(ticket)
      }

      const last = rows[rows.length - 1]
      pageCursor = { createdAt: Number(last.created_at), id: String(last.id) }
      nextCursor = pageCursor

      // Página crua incompleta = acabaram os registros.
      if (rows.length < limit) {
        nextCursor = null
        break
      }
      if (visible.length >= limit) break
    }

    if (nextCursor) res.setHeader("X-Next-Cursor", encodeTicketCursor(nextCursor))
    res.json(visible)
  }),
)

// ── GET /api/tickets/:id ────────────────────────────────────────────────────
ticketsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const ctx = requirePermission(req, "tickets.view")
    const row = await queryOne<TicketRow>("SELECT * FROM `tickets` WHERE `id` = ?", [req.params.id])
    if (!row) {
      res.json(null)
      return
    }
    const enrichment = await loadEnrichment()
    const ticket = enrichTicket(enrichment, row)
    const allowed = canViewTicket(
      ctx.permissions,
      ticket.status,
      ticket.assigneeId,
      ctx.user.id,
      ticket.assigneeName,
      ctx.user.name,
      isAdmin(ctx.user.role),
    )
    res.json(allowed ? ticket : null)
  }),
)

// ── GET /api/tickets/by-number/:number — chamado completo (com imagem) ───────
// A listagem do Kanban omite `image_url`; a ponte local do WhatsApp usa esta
// rota para anexar a imagem na hora de enviar, sem carregar as imagens de todos
// os chamados.
ticketsRouter.get(
  "/by-number/:number",
  asyncHandler(async (req, res) => {
    const ctx = requirePermission(req, "tickets.view")
    const row = await queryOne<TicketRow>("SELECT * FROM `tickets` WHERE `number` = ?", [
      toNumber(req.params.number, 0),
    ])
    if (!row) {
      res.json(null)
      return
    }
    const enrichment = await loadEnrichment()
    const ticket = enrichTicket(enrichment, row)
    const allowed = canViewTicket(
      ctx.permissions,
      ticket.status,
      ticket.assigneeId,
      ctx.user.id,
      ticket.assigneeName,
      ctx.user.name,
      isAdmin(ctx.user.role),
    )
    res.json(allowed ? ticket : null)
  }),
)

// ── POST /api/tickets — abre um chamado (usuário logado) ────────────────────
ticketsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const ctx = requirePermission(req, "tickets.create")
    const body = (req.body ?? {}) as Record<string, unknown>
    const now = Date.now()
    const number = await getNextNumber()
    const id = newId()

    // `solucao`/`orcamento`/`obs`/`status_equipamento`/`categoria` também entram
    // na criação: é o que permite **clonar** um chamado (reusar o serviço
    // executado, os itens, as observações e a categoria) em uma única chamada.
    await execute(
      `INSERT INTO tickets
         (id, number, title, description, status, priority, creator_id, guest_name,
          guest_contact, image_url, valor_total, os, location, solucao, orcamento,
          obs, status_equipamento, categoria, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'aberto', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        number,
        sanitizeText(body.title, 200),
        sanitizeText(body.description, 5000),
        assertPriority(body.priority),
        ctx.user.id,
        sanitizeText(body.guestName, 120),
        sanitizeText(body.guestContact, 160),
        sanitizeImage(body.imageUrl),
        body.valorTotal === undefined || body.valorTotal === null
          ? null
          : toNumber(body.valorTotal),
        sanitizeText(body.os, 60),
        sanitizeText(body.location, 200),
        sanitizeText(body.solucao, 5000),
        sanitizeText(body.orcamento, 5000),
        sanitizeText(body.obs, 5000),
        sanitizeText(body.statusEquipamento, 100),
        assertCategoria(body.categoria),
        now,
        now,
      ],
    )

    // Sino in-app + e-mail/Telegram/WhatsApp (não bloqueia a resposta).
    const created = await queryOne<TicketRow>("SELECT * FROM `tickets` WHERE `id` = ?", [id])
    if (created) void notifyTicketCreated(created, ctx.user.id)

    res.status(201).json({ ticketId: id, id, number })
  }),
)

// ── POST /api/tickets/guest — abertura pública (sem login) ──────────────────
ticketsRouter.post(
  "/guest",
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const guestName = sanitizeText(body.guestName, 120)
    const guestContact = sanitizeText(body.guestContact, 160)
    if (!guestName || !guestContact) {
      throw badRequest("Informe o nome e o contato do solicitante.")
    }

    const now = Date.now()
    const number = await getNextNumber()
    const id = newId()

    await execute(
      `INSERT INTO tickets
         (id, number, title, description, status, priority, guest_name, guest_contact,
          image_url, valor_total, os, location, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'aberto', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        number,
        sanitizeText(body.title, 200),
        sanitizeText(body.description, 5000),
        assertPriority(body.priority),
        guestName,
        guestContact,
        sanitizeImage(body.imageUrl),
        body.valorTotal === undefined || body.valorTotal === null
          ? null
          : toNumber(body.valorTotal),
        sanitizeText(body.os, 60),
        sanitizeText(body.location, 200),
        now,
        now,
      ],
    )

    // Chamado aberto por um visitante: avisa a equipe (sem autor logado).
    const created = await queryOne<TicketRow>("SELECT * FROM `tickets` WHERE `id` = ?", [id])
    if (created) void notifyTicketCreated(created, null)

    res.status(201).json({ ticketId: id, id, number })
  }),
)

// ── POST /api/tickets/:id/status — mover no Kanban ──────────────────────────
ticketsRouter.post(
  "/:id/status",
  asyncHandler(async (req, res) => {
    const ctx = requireAuth(req)
    const status = assertStatus((req.body ?? {}).status)
    if (!canMoveTo(ctx.permissions, status)) {
      throw forbidden("Sem permissão para mover chamados para esta coluna.")
    }

    const row = await queryOne<TicketRow>("SELECT * FROM `tickets` WHERE `id` = ?", [req.params.id])
    if (!row) throw notFound("Chamado não encontrado.")

    const oldStatus = row.status
    await execute("UPDATE `tickets` SET `status` = ?, `updated_at` = ? WHERE `id` = ?", [
      status,
      Date.now(),
      row.id,
    ])
    // Qualquer mudança de status reinicia o contador de inatividade.
    await resetInactivityLogs(row.id)

    // Avisa solicitante/responsável (sino) e os canais externos configurados.
    // O alerta de "Resolvido" do painel chega por aqui, com o status novo.
    if (oldStatus !== status) {
      await recordStatusEvent({
        ticketId: row.id,
        fromStatus: oldStatus,
        toStatus: status,
        userId: ctx.user.id,
        userName: ctx.user.name,
      })
      void notifyTicketStatusChanged({ ...row, status }, oldStatus, ctx.user.id)
    }

    res.json({ success: true, status, previousStatus: oldStatus })
  }),
)

// ── PATCH /api/tickets/:id — editar chamado ─────────────────────────────────
ticketsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const ctx = requirePermission(req, "tickets.edit")
    const body = (req.body ?? {}) as Record<string, unknown>
    if (body.assigneeId !== undefined) {
      if (!ctx.permissions.includes("tickets.assign")) {
        throw forbidden("Sem permissão para atribuir responsáveis.")
      }
    }

    const row = await queryOne<TicketRow>("SELECT * FROM `tickets` WHERE `id` = ?", [req.params.id])
    if (!row) throw notFound("Chamado não encontrado.")

    const enrichment = await loadEnrichment()
    const assignee = assigneeInfo(enrichment, row)
    const allowed = canEditTicket(
      ctx.permissions,
      row.status,
      row.assignee_id,
      ctx.user.id,
      assignee.name,
      ctx.user.name,
      isAdmin(ctx.user.role),
    )
    if (!allowed) {
      throw forbidden(
        "Sem permissão para editar este chamado (coluna ou responsável não permitido).",
      )
    }

    const fields: Record<string, unknown> = { updated_at: Date.now() }
    const set = (column: string, value: unknown) => {
      fields[column] = value
    }

    if (body.title !== undefined) set("title", sanitizeText(body.title, 200))
    if (body.description !== undefined) set("description", sanitizeText(body.description, 5000))
    if (body.solucao !== undefined) set("solucao", sanitizeText(body.solucao, 5000))
    if (body.orcamento !== undefined) set("orcamento", sanitizeText(body.orcamento, 5000))
    if (body.obs !== undefined) set("obs", sanitizeText(body.obs, 5000))
    if (body.statusEquipamento !== undefined)
      set("status_equipamento", sanitizeText(body.statusEquipamento, 100))
    if (body.categoria !== undefined) set("categoria", assertCategoria(body.categoria))
    if (body.priority !== undefined) set("priority", assertPriority(body.priority))
    if (body.imageUrl !== undefined) set("image_url", sanitizeImage(body.imageUrl))
    if (body.guestContact !== undefined) set("guest_contact", sanitizeText(body.guestContact, 160))
    if (body.creatorName !== undefined) set("creator_name", sanitizeText(body.creatorName, 120))
    if (body.location !== undefined) set("location", sanitizeText(body.location, 200))
    if (body.valorTotal !== undefined) {
      set("valor_total", body.valorTotal === null ? null : toNumber(body.valorTotal))
    }
    if (body.os !== undefined) set("os", sanitizeText(body.os, 60))

    if (body.assigneeId !== undefined) {
      const assigneeId = body.assigneeId === null ? null : String(body.assigneeId)
      set("assignee_id", assigneeId)
      set("assignee_type", assigneeId ? await resolveAssigneeType(assigneeId) : null)
    }

    const columns = Object.keys(fields)
    await execute(
      `UPDATE \`tickets\` SET ${columns.map((c) => `\`${c}\` = ?`).join(", ")} WHERE \`id\` = ?`,
      [...columns.map((c) => fields[c]), row.id],
    )
    // Qualquer edição no chamado reinicia o contador de inatividade.
    await resetInactivityLogs(row.id)

    res.json({ success: true })
  }),
)

// ── DELETE /api/tickets/:id ─────────────────────────────────────────────────
ticketsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    requirePermission(req, "tickets.delete")
    // Notificações, alertas in-app e logs de inatividade caem em cascata (FK).
    const result = await execute("DELETE FROM `tickets` WHERE `id` = ?", [req.params.id])
    if (result.affectedRows === 0) throw notFound("Chamado não encontrado.")
    res.json({ success: true })
  }),
)
