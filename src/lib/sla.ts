/**
 * Regras visuais do Kanban derivadas dos dados do chamado.
 *
 * O banco não tem campo de SLA: `prazo`/`sla_estourado` não existem na tabela
 * `tickets`. Em vez de inventar coluna nova (que ninguém alimentaria), o atraso é
 * derivado de `createdAt` + prioridade, com prazos por prioridade declarados
 * AQUI — um lugar só para ajustar. Se um dia entrar um prazo real no banco, esta
 * função passa a recebê-lo e o resto da tela não muda.
 *
 * Status finais (resolvido/fechado) nunca contam como atrasados.
 */

export type SlaPriority = "baixa" | "media" | "alta" | "critica"

/** Horas até o chamado ser considerado atrasado, por prioridade. */
export const SLA_HOURS: Record<SlaPriority, number> = {
  critica: 4,
  alta: 24,
  media: 72,
  baixa: 168,
}

/** Status em que o chamado já foi atendido — não faz sentido falar em atraso. */
export const SLA_FINAL_STATUSES = ["resolvido", "fechado"]

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export type SlaTicket = {
  priority?: string | null
  status?: string | null
  createdAt?: number | null
  visualizado?: boolean | null
  /** Prazo explícito (quando existir no futuro) tem prioridade sobre o cálculo. */
  dueAt?: number | null
}

function priorityOf(ticket: SlaTicket): SlaPriority {
  const value = String(ticket.priority ?? "media")
  return value in SLA_HOURS ? (value as SlaPriority) : "media"
}

/** Prazo do chamado (timestamp). `null` quando não se aplica. */
export function slaDueAt(ticket: SlaTicket): number | null {
  if (ticket.dueAt) return ticket.dueAt
  if (!ticket.createdAt) return null
  return ticket.createdAt + SLA_HOURS[priorityOf(ticket)] * HOUR_MS
}

/** O chamado passou do prazo e ainda não foi resolvido/fechado? */
export function isSlaOverdue(ticket: SlaTicket, now: number = Date.now()): boolean {
  const status = String(ticket.status ?? "")
  if (SLA_FINAL_STATUSES.includes(status)) return false
  const due = slaDueAt(ticket)
  if (due === null) return false
  return now > due
}

/** Quanto tempo passou do prazo, em texto curto ("2d atrasado"). */
export function slaOverdueLabel(ticket: SlaTicket, now: number = Date.now()): string | null {
  const due = slaDueAt(ticket)
  if (due === null || !isSlaOverdue(ticket, now)) return null

  const late = now - due
  if (late >= DAY_MS) {
    const dias = Math.floor(late / DAY_MS)
    return `${dias}d atrasado`
  }
  const horas = Math.max(1, Math.floor(late / HOUR_MS))
  return `${horas}h atrasado`
}

/** Chamado que ninguém abriu ainda — o card ganha o destaque "NOVO". */
export function isUnseenTicket(ticket: SlaTicket): boolean {
  return ticket.visualizado === false
}

/**
 * Rótulo do prazo para exibição ("vence em 3h" / "2d atrasado" / "").
 * Útil no card sem precisar de outra função.
 */
export function slaLabel(ticket: SlaTicket, now: number = Date.now()): string {
  // Chamado já resolvido/fechado não tem prazo a anunciar.
  if (SLA_FINAL_STATUSES.includes(String(ticket.status ?? ""))) return ""

  const overdue = slaOverdueLabel(ticket, now)
  if (overdue) return overdue
  const due = slaDueAt(ticket)
  if (due === null) return ""
  const remaining = due - now
  if (remaining >= DAY_MS) return `vence em ${Math.floor(remaining / DAY_MS)}d`
  if (remaining >= HOUR_MS) return `vence em ${Math.floor(remaining / HOUR_MS)}h`
  return "vence em menos de 1h"
}
