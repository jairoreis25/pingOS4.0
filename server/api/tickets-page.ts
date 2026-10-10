/**
 * Paginação por keyset da lista de chamados (`GET /api/tickets`).
 *
 * A lista do Kanban é o maior tráfego do app: o cliente baixava a base inteira,
 * e até a chegada do SSE isso acontecia a cada 10 s. Com `limit`/`cursor` o
 * servidor devolve uma página e o cursor da próxima; **sem parâmetros o
 * comportamento antigo (lista completa) é mantido** para não quebrar clientes.
 *
 * Por que keyset e não `OFFSET`: com `OFFSET`, um chamado criado durante a
 * navegação empurra as linhas seguintes e o usuário vê registros repetidos. O
 * cursor aponta para a última linha lida (`created_at`, `id`) e o `id` desempata
 * `created_at` iguais — sem ele a ordem não é estável e a paginação pode pular
 * ou repetir registros.
 */

export type TicketCursor = { createdAt: number; id: string }

/** Tamanho padrão quando o cliente manda `limit` sem valor utilizável. */
export const DEFAULT_PAGE_SIZE = 200

/** Teto por página: protege o servidor de um `limit` absurdo. */
export const MAX_PAGE_SIZE = 500

/**
 * Lê o `limit` da query string.
 *
 * Devolve `undefined` para "sem paginação" (valor ausente, vazio, zero, negativo
 * ou não numérico), preservando o contrato antigo da rota.
 */
export function parseTicketLimit(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined
  const parsed = Number.parseInt(String(raw), 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return Math.min(parsed, MAX_PAGE_SIZE)
}

/** Serializa o cursor para o header `X-Next-Cursor` (base64url de `[createdAt, id]`). */
export function encodeTicketCursor(cursor: TicketCursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), "utf8").toString("base64url")
}

/** Lê o cursor do header/query. Devolve `null` quando ausente ou inválido. */
export function parseTicketCursor(raw: unknown): TicketCursor | null {
  if (typeof raw !== "string" || raw === "") return null
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
    if (!Array.isArray(parsed) || parsed.length !== 2) return null
    const [createdAt, id] = parsed as [unknown, unknown]
    if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null
    if (typeof id !== "string" || id === "") return null
    return { createdAt, id }
  } catch {
    return null
  }
}

/** `WHERE`, `ORDER BY` e parâmetros da página (sem o `LIMIT`). */
export function buildTicketPage(options: { cursor?: TicketCursor | null; limit: number }): {
  where: string
  orderBy: string
  params: unknown[]
  limit: number
} {
  const orderBy = "`created_at` DESC, `id` DESC"
  if (!options.cursor) {
    return { where: "", orderBy, params: [], limit: options.limit }
  }
  return {
    where: "(`created_at` < ? OR (`created_at` = ? AND `id` < ?))",
    orderBy,
    params: [options.cursor.createdAt, options.cursor.createdAt, options.cursor.id],
    limit: options.limit,
  }
}

/** SQL completo da página. O `LIMIT` vai como parâmetro (`?`), nunca interpolado. */
export function buildTicketPageQuery(
  columns: string,
  options: { cursor?: TicketCursor | null; limit: number },
): { sql: string; params: unknown[] } {
  const page = buildTicketPage(options)
  const sql =
    `SELECT ${columns} FROM \`tickets\`` +
    (page.where ? ` WHERE ${page.where}` : "") +
    ` ORDER BY ${page.orderBy} LIMIT ?`
  return { sql, params: [...page.params, page.limit] }
}
