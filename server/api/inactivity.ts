/**
 * Motor de inatividade do PingOS.
 *
 * Substitui o cron do backend Convex (`checkInactivity`, que rodava de hora em
 * hora). Para cada regra ativa em **Configurações → Regras de inatividade**:
 *
 *   1. procura chamados nos status da regra que estão parados há mais de
 *      `days_inactive` dias (o contador é `tickets.updated_at`, que é reiniciado
 *      a cada edição ou mudança de status);
 *   2. ignora os pares chamado+regra que já foram alertados — a tabela
 *      `inactivity_logs` funciona como anti-spam;
 *   3. dispara o alerta pelos canais da regra (sino in-app, e-mail, WhatsApp).
 *
 * O envio em si vive em `server/api/notify.ts` (mesmo despachante usado pelos
 * chamados). Este módulo é chamado:
 *   - pelo agendador do servidor, a cada `INACTIVITY_INTERVAL_MINUTES`
 *     (padrão 60; `0` desliga);
 *   - manualmente, por `POST /api/inactivity/run` (botão "verificar agora").
 */

import { execute, newId, query } from "../mysql/pool";
import { notifyInactivity } from "./notify";
import { parseJsonArray, type TicketRow } from "./types";

/** Status que podem "parar" (os mesmos aceitos nas regras). */
const RULE_STATUSES = ["aberto", "em_andamento", "aguardando"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

interface RuleRow {
  id: string;
  name: string;
  statuses: unknown;
  days_inactive: number;
  recipient: string;
  channels: unknown;
  active: number;
}

/**
 * Resultado de uma execução — os nomes são os que o painel já exibe no aviso
 * de "verificar agora" (`rulesChecked`, `ticketsNotified`, ...).
 */
export interface InactivityRunResult {
  /** Regras ativas consideradas. */
  rulesChecked: number;
  /** Chamados que receberam alerta nesta execução. */
  ticketsNotified: number;
  /** Notificações criadas no sino. */
  inAppCreated: number;
  /** E-mails enviados (quantidade de destinatários atendidos). */
  emailsScheduled: number;
  /** Mensagens de WhatsApp enviadas. */
  whatsappScheduled: number;
  /** Chamados já alertados antes por esta regra (anti-spam). */
  skipped: number;
}

/**
 * Roda a verificação de inatividade. Nunca lança por falha de envio (o
 * despachante já captura), mas propaga erro de banco para o chamador registrar.
 */
export async function runInactivityCheck(): Promise<InactivityRunResult> {
  const rules = await query<RuleRow>(
    "SELECT * FROM `notification_rules` WHERE `active` = 1 ORDER BY `created_at` ASC",
  );

  const result: InactivityRunResult = {
    rulesChecked: rules.length,
    ticketsNotified: 0,
    inAppCreated: 0,
    emailsScheduled: 0,
    whatsappScheduled: 0,
    skipped: 0,
  };
  if (rules.length === 0) return result;

  for (const rule of rules) {
    const statuses = parseJsonArray(rule.statuses).filter((status) =>
      (RULE_STATUSES as readonly string[]).includes(status),
    );
    if (statuses.length === 0) continue;

    const cutoff = Date.now() - Math.max(1, rule.days_inactive) * DAY_MS;
    const placeholders = statuses.map(() => "?").join(", ");
    const tickets = await query<TicketRow>(
      `SELECT * FROM \`tickets\` WHERE \`status\` IN (${placeholders}) AND \`updated_at\` <= ?`,
      [...statuses, cutoff],
    );
    if (tickets.length === 0) continue;

    // Anti-spam: 1 alerta por chamado+regra até o chamado mudar de status ou
    // ser editado (as duas ações limpam os logs do chamado).
    const alreadyLogged = new Set(
      (
        await query<{ ticket_id: string }>(
          "SELECT `ticket_id` FROM `inactivity_logs` WHERE `rule_id` = ?",
          [rule.id],
        )
      ).map((row) => row.ticket_id),
    );

    const channels = parseJsonArray(rule.channels);

    for (const ticket of tickets) {
      if (alreadyLogged.has(ticket.id)) {
        result.skipped++;
        continue;
      }

      const counts = await notifyInactivity(ticket, {
        id: rule.id,
        name: rule.name,
        days: rule.days_inactive,
        recipient: rule.recipient,
        channels,
      });
      result.ticketsNotified++;
      result.inAppCreated += counts.inApp;
      result.emailsScheduled += counts.email;
      result.whatsappScheduled += counts.whatsapp;

      // Registra o alerta ANTES da próxima execução (mesmo se o envio falhar,
      // não fica reenviando a cada hora — o erro fica em `notifications`).
      await execute(
        "INSERT INTO `inactivity_logs` (`id`, `ticket_id`, `rule_id`, `sent_at`) VALUES (?, ?, ?, ?)",
        [newId(), ticket.id, rule.id, Date.now()],
      );
    }
  }

  if (result.ticketsNotified > 0) {
    console.log(
      `[inatividade] ${result.ticketsNotified} alerta(s) enviado(s) — ` +
        `${result.inAppCreated} no sino, ${result.emailsScheduled} e-mail(s), ` +
        `${result.whatsappScheduled} WhatsApp.`,
    );
  }
  return result;
}

/** Liga o agendador periódico (usado no start da API). */
export function startInactivityScheduler(): NodeJS.Timeout | null {
  const minutes = Number.parseInt(process.env.INACTIVITY_INTERVAL_MINUTES ?? "60", 10);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.log("[inatividade] agendador desligado (INACTIVITY_INTERVAL_MINUTES=0).");
    return null;
  }

  const intervalMs = minutes * 60 * 1000;
  const timer = setInterval(() => {
    runInactivityCheck().catch((error) =>
      console.error("[inatividade] falha na verificação periódica:", error),
    );
  }, intervalMs);
  // Não impede o processo de encerrar (SIGTERM do Docker encerra normalmente).
  timer.unref?.();

  console.log(`[inatividade] verificando chamados parados a cada ${minutes} minuto(s).`);
  return timer;
}
