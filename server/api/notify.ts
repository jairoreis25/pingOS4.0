/**
 * Despachante de notificações do PingOS.
 *
 * Substitui as actions do backend Convex (`notifyTicketCreated`, `notifyWhatsApp`,
 * `notifyInactivity`). O comportamento é dirigido pela aba
 * **Configurações → Notificações** (tabela `notification_settings`):
 *
 *   - **E-mail**     → Resend (`RESEND_API_KEY`), para os destinatários configurados
 *   - **Telegram**   → Bot API, com o token/chat_id configurados
 *   - **WhatsApp**   → API oficial da Meta (token + phone number id) ou, se não
 *                      houver token, a **ponte Baileys** do próprio PingOS
 *   - **In-app**     → sino do app (tabela `in_app_notifications`)
 *
 * Todo envio é registrado em `notifications` (sent/failed + erro), então o painel
 * e o log do servidor mostram exatamente o que saiu.
 *
 * Nada aqui derruba a requisição do usuário: falha de envio vira log.
 */

import { execute, newId, query, queryOne } from "../mysql/pool";
import { getEffectivePermissions } from "./permissions";
import { parseJsonArray, toBool, type TicketRow, type UserRow } from "./types";

// ── Rótulos (mesmos usados na interface) ────────────────────────────────────
const STATUS_LABELS: Record<string, string> = {
  aberto: "Aberto",
  em_andamento: "Em andamento",
  aguardando: "Aguardando",
  resolvido: "Resolvido",
  fechado: "Fechado",
};

const PRIORITY_LABELS: Record<string, string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
  critica: "Crítica",
};

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

export function priorityLabel(priority: string): string {
  return PRIORITY_LABELS[priority] ?? priority;
}

// ── Configuração ────────────────────────────────────────────────────────────
export interface NotifySettings {
  emailEnabled: boolean;
  emailRecipients: string[];
  telegramEnabled: boolean;
  telegramBotToken: string | null;
  telegramChatId: string | null;
  whatsappEnabled: boolean;
  whatsappToken: string | null;
  whatsappPhoneNumberId: string | null;
  whatsappRecipients: string[];
}

interface SettingsRow {
  email_enabled: number;
  email_recipients: unknown;
  telegram_enabled: number;
  telegram_bot_token: string | null;
  telegram_chat_id: string | null;
  whatsapp_enabled: number;
  whatsapp_token: string | null;
  whatsapp_phone_number_id: string | null;
  whatsapp_recipients: unknown;
}

export async function loadNotifySettings(): Promise<NotifySettings> {
  const row = await queryOne<SettingsRow>(
    "SELECT * FROM `notification_settings` WHERE `id` = 1",
  );
  return {
    emailEnabled: toBool(row?.email_enabled),
    emailRecipients: parseJsonArray(row?.email_recipients),
    telegramEnabled: toBool(row?.telegram_enabled),
    telegramBotToken: row?.telegram_bot_token ?? null,
    telegramChatId: row?.telegram_chat_id ?? null,
    whatsappEnabled: toBool(row?.whatsapp_enabled),
    whatsappToken: row?.whatsapp_token ?? null,
    whatsappPhoneNumberId: row?.whatsapp_phone_number_id ?? null,
    whatsappRecipients: parseJsonArray(row?.whatsapp_recipients),
  };
}

// ── Utilidades ──────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9()\-\s]{8,20}$/;

function isEmail(value: string | null | undefined): boolean {
  return Boolean(value && EMAIL_RE.test(value.trim()));
}

function isPhone(value: string | null | undefined): boolean {
  return Boolean(value && PHONE_RE.test(value.trim()));
}

/** Base pública do app (para os links nas notificações). */
function siteUrl(): string {
  return (process.env.SITE_URL ?? "").replace(/\/$/, "");
}

/** Prazo das chamadas externas (ms). */
function timeoutMs(): number {
  const parsed = Number.parseInt(process.env.NOTIFY_TIMEOUT_MS ?? "10000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

async function postJson(
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs()) });
    const text = await response.text();
    if (response.ok) return { ok: true, detail: text.slice(0, 500) };
    return { ok: false, detail: `${response.status} ${text.slice(0, 500)}` };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Quem recebeu (`recipient`) e, quando o envio veio de uma regra de
 * inatividade, qual regra (`ruleId`). São as duas colunas que o **relatório de
 * auditoria de notificações** mostra — sem elas o log diria apenas que "algo
 * foi enviado" por algum canal.
 */
export interface NotifyAudit {
  ruleId?: string | null;
}

/** Registra a tentativa de envio (aparece em `notifications`). */
export async function logNotification(
  ticketId: string,
  type: "email" | "telegram" | "whatsapp",
  status: "sent" | "failed",
  detail: string,
  meta?: { recipient?: string | null } & NotifyAudit,
): Promise<void> {
  try {
    await execute(
      `INSERT INTO \`notifications\`
         (\`id\`, \`ticket_id\`, \`type\`, \`status\`, \`recipient\`, \`rule_id\`, \`error\`, \`sent_at\`)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newId(),
        ticketId,
        type,
        status,
        meta?.recipient ? meta.recipient.slice(0, 255) : null,
        meta?.ruleId ?? null,
        status === "failed" ? detail.slice(0, 2000) : null,
        Date.now(),
      ],
    );
  } catch (error) {
    console.warn("[notify] não deu para registrar o envio:", error);
  }
}

/** Cria (ou ignora) uma notificação no sino do app. */
export async function createInAppNotification(params: {
  userId: string;
  ticketId: string;
  title: string;
  message: string;
  ruleId?: string | null;
}): Promise<void> {
  try {
    await execute(
      `INSERT INTO in_app_notifications
         (id, user_id, ticket_id, rule_id, title, message, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        newId(),
        params.userId,
        params.ticketId,
        params.ruleId ?? null,
        params.title.slice(0, 255),
        params.message,
        Date.now(),
      ],
    );
  } catch (error) {
    console.warn("[notify] não deu para criar a notificação in-app:", error);
  }
}

// ── Conteúdo das mensagens ──────────────────────────────────────────────────
/** Linhas comuns a todos os canais (texto puro, funciona em e-mail/Telegram). */
export function ticketLines(ticket: TicketRow): string[] {
  const requester = ticket.guest_name ?? ticket.creator_name ?? "Cliente";
  return [
    `Título: ${ticket.title ?? "(sem título)"}`,
    `Status: ${statusLabel(ticket.status)}`,
    `Prioridade: ${priorityLabel(ticket.priority)}`,
    `Solicitante: ${requester}`,
    ticket.location ? `Local: ${ticket.location}` : null,
    ticket.assignee_id ? "Responsável: atribuído" : "Responsável: não atribuído",
    siteUrl() ? `Link: ${siteUrl()}/dashboard` : null,
  ].filter((line): line is string => Boolean(line));
}

function createdMessage(ticket: TicketRow): { subject: string; body: string } {
  return {
    subject: `🎫 Novo chamado #${ticket.number}`,
    body: [`Novo chamado aberto no PingOS.`, "", ...ticketLines(ticket)].join("\n"),
  };
}

function statusMessage(ticket: TicketRow, previous: string): { subject: string; body: string } {
  return {
    subject: `🔄 Chamado #${ticket.number} → ${statusLabel(ticket.status)}`,
    body: [
      `O chamado #${ticket.number} mudou de status.`,
      `De ${statusLabel(previous)} para ${statusLabel(ticket.status)}.`,
      "",
      ...ticketLines(ticket),
    ].join("\n"),
  };
}

function inactivityMessage(ticket: TicketRow, days: number, ruleName: string): {
  subject: string;
  body: string;
} {
  return {
    subject: `⏰ Chamado #${ticket.number} parado há ${days} dia(s)`,
    body: [
      `A regra "${ruleName}" identificou um chamado sem movimentação.`,
      `Parado há ${days} dia(s) no status ${statusLabel(ticket.status)}.`,
      "",
      ...ticketLines(ticket),
    ].join("\n"),
  };
}

// ── Canais externos ─────────────────────────────────────────────────────────
/**
 * Envia o e-mail e devolve quantos destinatários foram atendidos (0 quando não
 * há destinatário válido ou a chave da Resend não está configurada).
 */
async function sendEmail(
  ticketId: string,
  subject: string,
  body: string,
  recipients: string[],
  audit?: NotifyAudit,
): Promise<number> {
  const targets = recipients.filter(isEmail);
  if (targets.length === 0) return 0;

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    await logNotification(ticketId, "email", "failed", "RESEND_API_KEY não configurada", {
      recipient: targets.join(", "),
      ruleId: audit?.ruleId,
    });
    return 0;
  }

  const result = await postJson("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM ?? "PingOS <onboarding@resend.dev>",
      to: targets,
      subject,
      text: body,
    }),
  });
  await logNotification(ticketId, "email", result.ok ? "sent" : "failed", result.detail, {
    recipient: targets.join(", "),
    ruleId: audit?.ruleId,
  });
  return targets.length;
}

async function sendTelegram(
  ticketId: string,
  settings: NotifySettings,
  body: string,
  audit?: NotifyAudit,
): Promise<number> {
  const token = settings.telegramBotToken;
  const chatId = settings.telegramChatId;
  if (!token || !chatId) {
    await logNotification(
      ticketId,
      "telegram",
      "failed",
      "Token ou chat_id do Telegram não configurados",
      { recipient: chatId ?? null, ruleId: audit?.ruleId },
    );
    return 0;
  }

  const result = await postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
  });
  await logNotification(ticketId, "telegram", result.ok ? "sent" : "failed", result.detail, {
    recipient: chatId,
    ruleId: audit?.ruleId,
  });
  return 1;
}

/**
 * WhatsApp em dois modos:
 *   1. **API oficial (Meta)** — quando há token + phone number id configurados.
 *   2. **Ponte Baileys do PingOS** — quando não há token; usa o número pareado
 *      pelo QR Code em Configurações → WhatsApp Web.
 */

/** Base da ponte Baileys do PingOS. */
function baileysBridge(): string {
  return (process.env.WHATSAPP_BRIDGE_URL ?? "http://whatsapp:3001").replace(/\/$/, "");
}

/**
 * true quando o painel pausou os envios na ponte
 * (Configurações → WhatsApp Web → Pausar envios).
 */
async function bridgePaused(bridge: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(`${bridge}/status`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return false;
    const data = (await response.json()) as { paused?: boolean };
    return data.paused === true;
  } catch {
    // Ponte fora do ar: deixa a tentativa de envio acontecer e registrar o erro
    // real ("não conectado" / sem resposta) em vez de afirmar que está pausado.
    return false;
  }
}
async function sendWhatsApp(
  ticketId: string,
  settings: NotifySettings,
  body: string,
  extraRecipients: string[] = [],
  audit?: NotifyAudit,
): Promise<number> {
  const recipients = [...settings.whatsappRecipients, ...extraRecipients].filter(isPhone);
  const unique = [...new Set(recipients.map((r) => r.replace(/[^\d+]/g, "")))];
  if (unique.length === 0) {
    await logNotification(ticketId, "whatsapp", "failed", "Nenhum destinatário de WhatsApp válido", {
      ruleId: audit?.ruleId,
    });
    return 0;
  }

  const { whatsappToken: token, whatsappPhoneNumberId: phoneNumberId } = settings;

  if (token && phoneNumberId) {
    for (const to of unique) {
      const result = await postJson(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to,
            type: "text",
            text: { body },
          }),
        },
      );
      await logNotification(ticketId, "whatsapp", result.ok ? "sent" : "failed", result.detail, {
        recipient: to,
        ruleId: audit?.ruleId,
      });
    }
    return unique.length;
  }

  // Ponte Baileys (mesmo contrato usado pelo painel: { phone, message })
  const bridge = baileysBridge();
  if (await bridgePaused(bridge)) {
    await logNotification(
      ticketId,
      "whatsapp",
      "failed",
      "Serviço de WhatsApp pausado no painel — envio ignorado",
      { recipient: unique.join(", "), ruleId: audit?.ruleId },
    );
    return 0;
  }
  for (const to of unique) {
    const result = await postJson(`${bridge}/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: to, message: body }),
    });
    await logNotification(ticketId, "whatsapp", result.ok ? "sent" : "failed", result.detail, {
      recipient: to,
      ruleId: audit?.ruleId,
    });
  }
  return unique.length;
}

/** Envia por todos os canais habilitados (usado por chamados e inatividade). */
export async function dispatchExternal(params: {
  ticket: TicketRow;
  subject: string;
  body: string;
  emailRecipients?: string[];
  whatsappRecipients?: string[];
  /** Regra de inatividade que originou o envio (auditoria), quando houver. */
  ruleId?: string | null;
}): Promise<void> {
  const settings = await loadNotifySettings();
  const tasks: Promise<unknown>[] = [];
  const audit: NotifyAudit = { ruleId: params.ruleId ?? null };

  if (settings.emailEnabled) {
    tasks.push(
      sendEmail(
        params.ticket.id,
        params.subject,
        params.body,
        [...settings.emailRecipients, ...(params.emailRecipients ?? [])],
        audit,
      ),
    );
  }
  if (settings.telegramEnabled) {
    tasks.push(sendTelegram(params.ticket.id, settings, params.body, audit));
  }
  if (settings.whatsappEnabled) {
    tasks.push(
      sendWhatsApp(
        params.ticket.id,
        settings,
        params.body,
        params.whatsappRecipients ?? [],
        audit,
      ),
    );
  }

  await Promise.all(tasks);
}

// ── Destinatários internos ──────────────────────────────────────────────────
/** Usuários ativos que podem ver chamados (para o sino in-app). */
export async function usersWhoCanViewTickets(): Promise<UserRow[]> {
  const users = await query<UserRow>("SELECT * FROM `users` WHERE `active` = 1");
  const allowed: UserRow[] = [];
  for (const user of users) {
    const permissions = await getEffectivePermissions(user);
    if (permissions.includes("tickets.view")) allowed.push(user);
  }
  return allowed;
}

async function findUser(id: string | null): Promise<UserRow | null> {
  if (!id) return null;
  return queryOne<UserRow>("SELECT * FROM `users` WHERE `id` = ?", [id]);
}

// ── Eventos ─────────────────────────────────────────────────────────────────
/**
 * Novo chamado: avisa os usuários que veem chamados (sino) e dispara os canais
 * externos configurados. Nunca lança — a criação do chamado já aconteceu.
 */
export async function notifyTicketCreated(
  ticket: TicketRow,
  actorId?: string | null,
): Promise<void> {
  try {
    const viewers = await usersWhoCanViewTickets();
    if (viewers.length > 0) {
      const title = `Novo chamado #${ticket.number}`;
      const message = `${ticket.title ?? "(sem título)"} · ${priorityLabel(ticket.priority)}` +
        ` · aberto por ${ticket.guest_name ?? ticket.creator_name ?? "cliente"}`;
      await Promise.all(
        viewers
          .filter((user) => user.id !== actorId && user.id !== ticket.creator_id)
          .map((user) =>
            createInAppNotification({ userId: user.id, ticketId: ticket.id, title, message }),
          ),
      );
    }

    const { subject, body } = createdMessage(ticket);
    await dispatchExternal({ ticket, subject, body });
  } catch (error) {
    console.error("[notify] falha ao notificar novo chamado:", error);
  }
}

/** Mudança de status: avisa solicitante/responsável (sino) e canais externos. */
export async function notifyTicketStatusChanged(
  ticket: TicketRow,
  previousStatus: string,
  actorId?: string | null,
): Promise<void> {
  try {
    const [creator, assignee] = await Promise.all([
      findUser(ticket.creator_id),
      findUser(ticket.assignee_id),
    ]);

    const title = `Chamado #${ticket.number}: ${statusLabel(ticket.status)}`;
    const message = `${statusLabel(previousStatus)} → ${statusLabel(ticket.status)}`;
    const targets = new Set<string>();
    for (const user of [creator, assignee]) {
      if (user && user.id !== actorId && toBool(user.active, true)) targets.add(user.id);
    }
    await Promise.all(
      [...targets].map((userId) =>
        createInAppNotification({ userId, ticketId: ticket.id, title, message }),
      ),
    );

    const { subject, body } = statusMessage(ticket, previousStatus);
    const emailRecipients = [creator?.email, assignee?.email].filter(
      (value): value is string => isEmail(value),
    );
    const whatsappRecipients = [ticket.guest_contact, assignee?.contato].filter(
      (value): value is string => isPhone(value),
    );

    await dispatchExternal({ ticket, subject, body, emailRecipients, whatsappRecipients });
  } catch (error) {
    console.error("[notify] falha ao notificar mudança de status:", error);
  }
}

/** Quantos envios cada canal fez neste alerta (usado pelo motor de inatividade). */
export interface InactivityCounts {
  inApp: number;
  email: number;
  whatsapp: number;
}

/** Usado pelo motor de inatividade. */
export async function notifyInactivity(
  ticket: TicketRow,
  rule: { id: string; name: string; days: number; recipient: string; channels: string[] },
): Promise<InactivityCounts> {
  const { subject, body } = inactivityMessage(ticket, rule.days, rule.name);
  const [creator, assignee] = await Promise.all([
    findUser(ticket.creator_id),
    findUser(ticket.assignee_id),
  ]);

  const wantsCliente = rule.recipient === "cliente" || rule.recipient === "ambos";
  const wantsResponsavel = rule.recipient === "responsavel" || rule.recipient === "ambos";

  const counts: InactivityCounts = { inApp: 0, email: 0, whatsapp: 0 };

  if (rule.channels.includes("inapp")) {
    const targets = new Set<string>();
    if (wantsCliente && creator) targets.add(creator.id);
    if (wantsResponsavel && assignee) targets.add(assignee.id);
    await Promise.all(
      [...targets].map((userId) =>
        createInAppNotification({
          userId,
          ticketId: ticket.id,
          title: `Chamado #${ticket.number} parado`,
          message: body,
          ruleId: rule.id,
        }),
      ),
    );
    counts.inApp = targets.size;
  }

  const emailRecipients: string[] = [];
  const whatsappRecipients: string[] = [];
  if (wantsCliente) {
    if (isEmail(creator?.email)) emailRecipients.push(creator!.email!);
    if (isPhone(ticket.guest_contact)) whatsappRecipients.push(ticket.guest_contact!);
  }
  if (wantsResponsavel) {
    if (isEmail(assignee?.email)) emailRecipients.push(assignee!.email!);
    if (isPhone(assignee?.contato)) whatsappRecipients.push(assignee!.contato!);
  }

  const channels = rule.channels.filter((channel) => channel !== "inapp");
  const settings = await loadNotifySettings();

  const audit: NotifyAudit = { ruleId: rule.id };
  if (channels.includes("email") && settings.emailEnabled) {
    counts.email = await sendEmail(ticket.id, subject, body, emailRecipients, audit);
  }
  if (channels.includes("whatsapp") && settings.whatsappEnabled) {
    counts.whatsapp = await sendWhatsApp(ticket.id, settings, body, whatsappRecipients, audit);
  }

  return counts;
}
