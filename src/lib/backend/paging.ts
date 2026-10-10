/**
 * Helpers puros da paginação por keyset no cliente.
 *
 * O servidor devolve a lista da página no corpo e o cursor da próxima no header
 * `X-Next-Cursor` (ver `server/api/tickets-page.ts`). Aqui ficam as duas regras
 * que dão trabalho: ler o cursor do header e juntar páginas sem duplicar item —
 * isso acontece de verdade quando o SSE avisa de uma mudança e a primeira página
 * é recarregada por cima das que o usuário já tinha carregado.
 */

/** Lê o cursor da próxima página. Header ausente/vazio = fim da lista. */
export function nextCursorFrom(headers: Headers | undefined): string | null {
  const raw = headers?.get("X-Next-Cursor")
  if (!raw) return null
  const value = raw.trim()
  return value === "" ? null : value
}

/**
 * Junta a página nova com o que já estava na tela, sem repetir item.
 *
 * A ordem é preservada: primeiro a página mais recente, depois os itens antigos
 * que não vieram nela (o usuário já os tinha carregado pelo "Carregar mais").
 */
export function mergePages<T>(current: T[], incoming: T[], keyOf: (item: T) => string): T[] {
  if (current.length === 0) return incoming
  const vistos = new Set(incoming.map(keyOf))
  const antigos = current.filter((item) => !vistos.has(keyOf(item)))
  return [...incoming, ...antigos]
}

/** Acrescenta uma página ao fim, sem repetir itens já presentes. */
export function appendPage<T>(current: T[], incoming: T[], keyOf: (item: T) => string): T[] {
  if (current.length === 0) return incoming
  const vistos = new Set(current.map(keyOf))
  return [...current, ...incoming.filter((item) => !vistos.has(keyOf(item)))]
}
