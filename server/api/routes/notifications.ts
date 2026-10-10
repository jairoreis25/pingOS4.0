/**
 * Notificações — espelha src/convex/notificationSettings.ts,
 * notificationRules.ts e inAppNotifications.ts.
 *
 *   GET/PUT   /api/notification-settings        (configuração de canais)
 *   CRUD      /api/notification-rules           (regras de inatividade)
 *   GET       /api/in-app-notifications         (sino do usuário logado)
 *   POST      /api/in-app-notifications/:id/read
 *   POST      /api/in-app-notifications/read-all
 *   POST      /api/inactivity/run               (disparo manual das regras)
 *
 * O envio (e-mail via Resend, Telegram, WhatsApp pela ponte) fica em
 * `server/api/notify.ts` e o motor das regras em `server/api/inactivity.ts` —
 * aqui só ficam a configuração, o CRUD das regras e o sino in-app.
 */

import { Router } from "express"
import { execute, newId, query, queryOne } from "../../mysql/pool"
import { asyncHandler, badRequest, notFound } from "../errors"
import { runInactivityCheck } from "../inactivity"
import { requireAuth, requirePermission } from "../permissions"
import { parseJsonArray, toBool } from "../types"

export const notificationsRouter = Router()
export const inactivityRouter = Router()

// ── Helpers ─────────────────────────────────────────────────────────────────
interface SettingsRow {
  email_enabled: number
  email_recipients: unknown
  telegram_enabled: number
  telegram_bot_token: string | null
  telegram_chat_id: string | null
  whatsapp_enabled: number
  whatsapp_token: string | null
  whatsapp_phone_number_id: string | null
  whatsapp_recipients: unknown
}

interface RuleRow {
  id: string
  name: string
  statuses: unknown
  days_inactive: number
  recipient: string
  channels: unknown
  active: number
  created_at: number
  updated_at: number
}

interface InAppRow {
  id: string
  ticket_id: string
  rule_id: string | null
  title: string
  message: string
  is_read: number
  created_at: number
  ticket_number: number | null
  ticket_title: string | null
}

function toSettings(row: SettingsRow | null) {
  if (!row) return null
  return {
    _id: "notification_settings",
    _creationTime: 0,
    emailEnabled: toBool(row.email_enabled),
    emailRecipients: parseJsonArray(row.email_recipients),
    telegramEnabled: toBool(row.telegram_enabled),
    telegramBotToken: row.telegram_bot_token ?? undefined,
    telegramChatId: row.telegram_chat_id ?? undefined,
    whatsappEnabled: toBool(row.whatsapp_enabled),
    whatsappToken: row.whatsapp_token ?? undefined,
    whatsappPhoneNumberId: row.whatsapp_phone_number_id ?? undefined,
    whatsappRecipients: parseJsonArray(row.whatsapp_recipients),
  }
}

function toRule(row: RuleRow) {
  return {
    _id: row.id,
    _creationTime: row.created_at,
    name: row.name,
    statuses: parseJsonArray(row.statuses),
    days: row.days_inactive,
    recipient: row.recipient,
    channels: parseJsonArray(row.channels),
    active: toBool(row.active, true),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Normaliza uma lista que pode vir como array ou como texto separado por vírgula. */
function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean)
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  }
  return []
}

const ALLOWED_STATUSES = ["aberto", "em_andamento", "aguardando"]
const ALLOWED_CHANNELS = ["email", "inapp", "whatsapp"]
const ALLOWED_RECIPIENTS = ["cliente", "responsavel", "ambos"]

interface RuleInput {
  name: string
  statuses: string[]
  days: number
  recipient: string
  channels: string[]
}

/** Mesmas validações do `validateRule` do Convex. */
function validateRule(input: RuleInput): RuleInput {
  const name = input.name.trim()
  if (!name) throw badRequest("Informe um nome para a regra.")
  if (input.statuses.length === 0) throw badRequest("Selecione pelo menos um status.")
  for (const status of input.statuses) {
    if (!ALLOWED_STATUSES.includes(status)) throw badRequest(`Status inválido: ${status}`)
  }
  if (!Number.isFinite(input.days) || input.days < 1 || input.days > 365) {
    throw badRequest("O tempo de inatividade deve ser entre 1 e 365 dias.")
  }
  if (!ALLOWED_RECIPIENTS.includes(input.recipient)) {
    throw badRequest("Destinatário inválido.")
  }
  if (input.channels.length === 0) {
    throw badRequest("Selecione pelo menos um canal de notificação.")
  }
  for (const channel of input.channels) {
    if (!ALLOWED_CHANNELS.includes(channel)) throw badRequest(`Canal inválido: ${channel}`)
  }
  return {
    name,
    statuses: [...new Set(input.statuses)],
    days: Math.floor(input.days),
    recipient: input.recipient,
    channels: [...new Set(input.channels)],
  }
}

// ── GET /api/notification-settings ──────────────────────────────────────────
notificationsRouter.get(
  "/notification-settings",
  asyncHandler(async (req, res) => {
    // Leitura restrita (como no Convex): sem `settings.manage` devolve null em
    // vez de 403, para a UI saber que não deve exibir a configuração.
    const ctx = req.auth
    if (!ctx || !ctx.permissions.includes("settings.manage")) {
      res.json(null)
      return
    }
    const row = await queryOne<SettingsRow>("SELECT * FROM `notification_settings` WHERE `id` = 1")
    res.json(toSettings(row))
  }),
)

// ── PUT /api/notification-settings ──────────────────────────────────────────
notificationsRouter.put(
  "/notification-settings",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage")
    const body = (req.body ?? {}) as Record<string, unknown>

    await execute(
      `INSERT INTO notification_settings
         (id, email_enabled, email_recipients, telegram_enabled, telegram_bot_token,
          telegram_chat_id, whatsapp_enabled, whatsapp_token, whatsapp_phone_number_id,
          whatsapp_recipients)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         email_enabled = VALUES(email_enabled),
         email_recipients = VALUES(email_recipients),
         telegram_enabled = VALUES(telegram_enabled),
         telegram_bot_token = VALUES(telegram_bot_token),
         telegram_chat_id = VALUES(telegram_chat_id),
         whatsapp_enabled = VALUES(whatsapp_enabled),
         whatsapp_token = VALUES(whatsapp_token),
         whatsapp_phone_number_id = VALUES(whatsapp_phone_number_id),
         whatsapp_recipients = VALUES(whatsapp_recipients)`,
      [
        body.emailEnabled ? 1 : 0,
        JSON.stringify(toStringList(body.emailRecipients)),
        body.telegramEnabled ? 1 : 0,
        String(body.telegramBotToken ?? "").trim() || null,
        String(body.telegramChatId ?? "").trim() || null,
        body.whatsappEnabled ? 1 : 0,
        String(body.whatsappToken ?? "").trim() || null,
        String(body.whatsappPhoneNumberId ?? "").trim() || null,
        JSON.stringify(toStringList(body.whatsappRecipients)),
      ],
    )

    const row = await queryOne<SettingsRow>("SELECT * FROM `notification_settings` WHERE `id` = 1")
    res.json(toSettings(row))
  }),
)

// ── GET /api/notification-rules ─────────────────────────────────────────────
notificationsRouter.get(
  "/notification-rules",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage")
    const rows = await query<RuleRow>(
      "SELECT * FROM `notification_rules` ORDER BY `created_at` ASC",
    )
    res.json(rows.map(toRule))
  }),
)

// ── POST /api/notification-rules ────────────────────────────────────────────
notificationsRouter.post(
  "/notification-rules",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage")
    const body = (req.body ?? {}) as Record<string, unknown>
    const rule = validateRule({
      name: String(body.name ?? ""),
      statuses: toStringList(body.statuses),
      days: Number(body.days ?? body.daysInactive ?? 0),
      recipient: String(body.recipient ?? ""),
      channels: toStringList(body.channels),
    })

    const id = newId()
    const now = Date.now()
    await execute(
      `INSERT INTO notification_rules
         (id, name, statuses, days_inactive, recipient, channels, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        rule.name,
        JSON.stringify(rule.statuses),
        rule.days,
        rule.recipient,
        JSON.stringify(rule.channels),
        body.active === false ? 0 : 1,
        now,
        now,
      ],
    )
    res.status(201).json({ _id: id, success: true })
  }),
)

// ── PATCH /api/notification-rules/:id ───────────────────────────────────────
notificationsRouter.patch(
  "/notification-rules/:id",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage")
    const existing = await queryOne<RuleRow>("SELECT * FROM `notification_rules` WHERE `id` = ?", [
      req.params.id,
    ])
    if (!existing) throw notFound("Regra não encontrada.")

    const body = (req.body ?? {}) as Record<string, unknown>
    const rule = validateRule({
      name: String(body.name ?? existing.name),
      statuses:
        body.statuses === undefined
          ? parseJsonArray(existing.statuses)
          : toStringList(body.statuses),
      days: Number(body.days ?? body.daysInactive ?? existing.days_inactive),
      recipient: String(body.recipient ?? existing.recipient),
      channels:
        body.channels === undefined
          ? parseJsonArray(existing.channels)
          : toStringList(body.channels),
    })

    await execute(
      `UPDATE notification_rules
          SET name = ?, statuses = ?, days_inactive = ?, recipient = ?, channels = ?,
              active = ?, updated_at = ?
        WHERE id = ?`,
      [
        rule.name,
        JSON.stringify(rule.statuses),
        rule.days,
        rule.recipient,
        JSON.stringify(rule.channels),
        body.active === undefined ? existing.active : body.active ? 1 : 0,
        Date.now(),
        existing.id,
      ],
    )
    res.json({ success: true })
  }),
)

// ── DELETE /api/notification-rules/:id ──────────────────────────────────────
notificationsRouter.delete(
  "/notification-rules/:id",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage")
    const existing = await queryOne<{ id: string }>(
      "SELECT `id` FROM `notification_rules` WHERE `id` = ?",
      [req.params.id],
    )
    if (!existing) throw notFound("Regra não encontrada.")
    // O anti-spam da regra some junto (FK também tem ON DELETE CASCADE).
    await execute("DELETE FROM `inactivity_logs` WHERE `rule_id` = ?", [existing.id])
    await execute("DELETE FROM `notification_rules` WHERE `id` = ?", [existing.id])
    res.json({ success: true })
  }),
)

// ── GET /api/in-app-notifications ───────────────────────────────────────────
notificationsRouter.get(
  "/in-app-notifications",
  asyncHandler(async (req, res) => {
    const ctx = requireAuth(req)
    const rows = await query<InAppRow>(
      `SELECT n.id, n.ticket_id, n.rule_id, n.title, n.message, n.is_read, n.created_at,
              t.number AS ticket_number, t.title AS ticket_title
         FROM in_app_notifications n
         LEFT JOIN tickets t ON t.id = n.ticket_id
        WHERE n.user_id = ?
        ORDER BY n.created_at DESC
        LIMIT 100`,
      [ctx.user.id],
    )

    const items = rows.map((row) => ({
      _id: row.id,
      ticketId: row.ticket_id,
      title: row.title,
      message: row.message,
      read: toBool(row.is_read),
      createdAt: row.created_at,
      ticketNumber: row.ticket_number ?? null,
      ticketTitle: row.ticket_title ?? null,
    }))
    const unreadCount = items.filter((item) => !item.read).length

    res.json({ items, unreadCount })
  }),
)

// ── POST /api/in-app-notifications/:id/read ─────────────────────────────────
notificationsRouter.post(
  "/in-app-notifications/:id/read",
  asyncHandler(async (req, res) => {
    const ctx = requireAuth(req)
    const row = await queryOne<{ id: string; user_id: string }>(
      "SELECT `id`, `user_id` FROM `in_app_notifications` WHERE `id` = ?",
      [req.params.id],
    )
    if (!row) throw notFound("Notificação não encontrada.")
    if (row.user_id !== ctx.user.id) {
      throw badRequest("Sem permissão para alterar esta notificação.")
    }
    await execute("UPDATE `in_app_notifications` SET `is_read` = 1 WHERE `id` = ?", [row.id])
    res.json({ success: true })
  }),
)

// ── POST /api/in-app-notifications/read-all ─────────────────────────────────
notificationsRouter.post(
  "/in-app-notifications/read-all",
  asyncHandler(async (req, res) => {
    const ctx = requireAuth(req)
    const result = await execute(
      "UPDATE `in_app_notifications` SET `is_read` = 1 WHERE `user_id` = ? AND `is_read` = 0",
      [ctx.user.id],
    )
    res.json({ success: true, count: result.affectedRows })
  }),
)

// ── POST /api/inactivity/run (disparo manual) ───────────────────────────────
// Roda exatamente a mesma verificação do agendador periódico. O resultado
// informa quantos chamados parados foram encontrados e quantos alertas saíram.
inactivityRouter.post(
  "/run",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage")
    const result = await runInactivityCheck()
    res.json({
      success: true,
      ...result,
      message:
        result.rulesChecked === 0
          ? "Nenhuma regra de inatividade ativa."
          : `${result.ticketsNotified} chamado(s) alertado(s)` +
            (result.skipped > 0 ? ` (${result.skipped} já alertado(s) antes).` : "."),
    })
  }),
)
