/**
 * Categoria do chamado (dropdown que aparece ao **editar** o chamado).
 *
 * É uma classificação **interna** da equipe: serve para agrupar/filtrar os
 * chamados (impressoras, rede, etc.) e por isso **não** entra nas mensagens
 * enviadas ao cliente (WhatsApp/e-mail/Telegram) nem no cupom impresso.
 *
 * A lista fica em `src/lib` porque o backend usa o mesmo normalizador — assim a
 * tela e a API nunca discordam sobre quais valores são válidos.
 */

/** Opções do dropdown, na ordem em que aparecem. */
export const TICKET_CATEGORIES = [
  "Impressoras",
  "Computadores",
  "Notebooks",
  "Softwares",
  "Rede",
  "Suporte",
  "Outros",
] as const;

export type TicketCategory = (typeof TICKET_CATEGORIES)[number];

/** Sentinela da opção "sem categoria" no dropdown. */
export const TICKET_CATEGORY_EMPTY = "—";

/**
 * Sentinela usada nos **filtros** para achar os chamados ainda sem categoria.
 *
 * Diferente de `TICKET_CATEGORY_EMPTY` (que é um valor de formulário), esta é
 * enviada na query da API — por isso o valor precisa ser seguro em URL e
 * compartilhado entre a tela e o backend.
 */
export const TICKET_CATEGORY_UNSET = "sem_categoria";

/**
 * Converte qualquer entrada na categoria canônica.
 *
 * Aceita variações de caixa ("impressoras", "REDE") e devolve a grafia oficial.
 * Vazio/`null` → `null` (sem categoria); valor desconhecido → `null` também —
 * quem precisa recusar usa `isTicketCategory` antes.
 */
export function normalizeTicketCategory(value: unknown): TicketCategory | null {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === TICKET_CATEGORY_EMPTY) return null;
  const found = TICKET_CATEGORIES.find(
    (option) => option.toLowerCase() === trimmed.toLowerCase(),
  );
  return found ?? null;
}

/** `true` quando o valor é uma das opções da lista (ignorando a caixa). */
export function isTicketCategory(value: unknown): boolean {
  return normalizeTicketCategory(value) !== null;
}
