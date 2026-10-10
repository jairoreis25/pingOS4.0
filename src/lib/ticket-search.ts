/**
 * Busca do painel (campo de pesquisa do Kanban).
 *
 * Estava inline no `Dashboard` (junto de drag, impressão, formulários): extrair
 * a regra para cá deixa o componente menor e a busca testável sem renderizar a
 * tela. A varredura é por campo, sem acento-insensibilidade — o mesmo
 * comportamento de antes, agora com testes que fixam esse contrato.
 */

/** Campos considerados na busca (todos em texto, exceto `number`). */
export type SearchableTicket = {
  number?: number | string | null
  title?: string | null
  description?: string | null
  os?: string | null
  guestContact?: string | null
  guestName?: string | null
}

/**
 * O chamado casa com a busca?
 *
 * - busca vazia (ou só espaço) casa com tudo;
 * - é case-insensitive;
 * - `number` é comparado como texto (buscar "12" acha o #12 e o #120).
 */
export function matchesTicketSearch(ticket: SearchableTicket, query: string): boolean {
  const alvo = (query ?? "").trim().toLowerCase()
  if (!alvo) return true

  const campos = [
    ticket.title,
    ticket.description,
    ticket.os,
    ticket.guestContact,
    ticket.guestName,
    ticket.number == null ? null : String(ticket.number),
  ]

  return campos.some((valor) => typeof valor === "string" && valor.toLowerCase().includes(alvo))
}

/** Filtra a lista pelo termo (usado direto pelo Kanban). */
export function filterTickets<T extends SearchableTicket>(
  tickets: T[] | undefined,
  query: string,
): T[] {
  if (!tickets) return []
  if (!query || !query.trim()) return tickets
  return tickets.filter((ticket) => matchesTicketSearch(ticket, query))
}

/** Contagem por status, usada nos chips/indicadores do topo. */
export function countByStatus<T extends { status: string }>(
  tickets: T[] | undefined,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const ticket of tickets ?? []) {
    out[ticket.status] = (out[ticket.status] ?? 0) + 1
  }
  return out
}
