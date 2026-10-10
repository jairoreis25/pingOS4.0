/**
 * Resumo legível das permissões de um papel (cards de Configurações → Usuários).
 *
 * Estava dentro de `UsersManagementDialog.tsx` (1.177 linhas) junto de formulário
 * e tabela. Aqui fica puro e testável, e usa `statusLabel` de `ticket-ui` em vez
 * de manter uma terceira cópia dos rótulos de status.
 */

import {
  TICKET_STATUSES,
  hasEditAssignmentRestriction,
  hasStatusEditRestriction,
  hasStatusViewRestriction,
  hasViewAssignmentRestriction,
} from "./permissions"
import { statusLabel } from "./ticket-ui"

export type RoleSummary = { chips: string[]; notes: string[] }

/** Converte a lista crua de permissões em capacidades e escopos legíveis. */
export function summarizeRole(permissions: string[]): RoleSummary {
  const set = new Set(permissions)
  const has = (key: string) => set.has(key)
  const hasAny = (prefix: string) => [...set].some((key) => key.startsWith(prefix))
  const chips: string[] = []
  const notes: string[] = []

  if (has("tickets.view") || has("tickets.view.all") || hasAny("tickets.view.")) {
    chips.push("Ver chamados")
  }
  if (has("tickets.create")) chips.push("Criar chamados")
  if (has("tickets.edit") || has("tickets.edit.all") || hasAny("tickets.edit.")) {
    chips.push("Editar chamados")
  }
  if (has("tickets.assign")) chips.push("Atribuir responsável")
  if (has("tickets.move") || hasAny("tickets.move.")) {
    chips.push("Mover no Kanban")
  }
  if (has("tickets.delete")) chips.push("Excluir chamados")
  if (has("metrics.view")) chips.push("Ver métricas")
  if (has("settings.manage")) chips.push("Configurações")
  if (has("users.manage")) chips.push("Gerenciar usuários")

  // Escopos restritos por coluna (espelham o que o backend aplica de fato).
  if (!has("tickets.view.all") && hasStatusViewRestriction(permissions)) {
    const cols = TICKET_STATUSES.filter((s) => has(`tickets.view.${s}`)).map((s) => statusLabel(s))
    notes.push(`Visível: ${cols.join(", ")}`)
  }
  if (!has("tickets.edit.all") && hasStatusEditRestriction(permissions)) {
    const cols = TICKET_STATUSES.filter((s) => has(`tickets.edit.${s}`)).map((s) => statusLabel(s))
    notes.push(`Edição: ${cols.join(", ")}`)
  }
  if (!has("tickets.move") && hasAny("tickets.move.")) {
    const cols = TICKET_STATUSES.filter((s) => has(`tickets.move.${s}`)).map((s) => statusLabel(s))
    notes.push(`Mover para: ${cols.join(", ")}`)
  }
  if (hasEditAssignmentRestriction(permissions)) {
    const bits: string[] = []
    if (has("tickets.edit.own")) bits.push("apenas os próprios chamados")
    if (has("tickets.edit.unassigned")) bits.push("também sem responsável")
    notes.push(`Edição: ${bits.join(" · ")}`)
  }
  if (hasViewAssignmentRestriction(permissions)) {
    const bits: string[] = []
    if (has("tickets.view.own")) bits.push("apenas os próprios chamados")
    if (has("tickets.view.unassigned")) bits.push("também sem responsável")
    notes.push(`Visualização: ${bits.join(" · ")}`)
  }

  return { chips, notes }
}
