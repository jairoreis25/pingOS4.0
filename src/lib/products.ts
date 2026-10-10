/**
 * Catálogo de Produtos e Serviços (Configurações).
 *
 * O que diferencia um item do outro é o `itemType`:
 *
 *   produto  → peça, equipamento, licença, acessório
 *   servico  → mão de obra, formatação, reinstalação, visita técnica
 *
 * Fica em `src/lib` porque o backend também usa: a rota `/api/products` valida o
 * valor com o mesmo normalizador que a tela usa para escolher o rótulo, então os
 * dois nunca discordam sobre o que é um tipo válido.
 */

export const PRODUCT_SERVICE_TYPES = ["produto", "servico"] as const

export type ProductServiceType = (typeof PRODUCT_SERVICE_TYPES)[number]

export const PRODUCT_SERVICE_TYPE_LABELS: Record<ProductServiceType, string> = {
  produto: "Produto",
  servico: "Serviço",
}

/** Tipo de um item novo quando nada é informado (num Help Desk, a maioria é serviço). */
export const DEFAULT_PRODUCT_SERVICE_TYPE: ProductServiceType = "servico"

/**
 * Aceita "Produto", "produto", "SERVIÇO", "servico"… e devolve o valor canônico.
 * Com `fallback: null`, devolve `null` em vez de assumir um padrão — é assim que
 * a API recusa um tipo inválido em vez de gravar qualquer coisa.
 */
export function normalizeProductServiceType(
  value: unknown,
  fallback: ProductServiceType | null = DEFAULT_PRODUCT_SERVICE_TYPE,
): ProductServiceType | null {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // "Serviço" → "servico"

  return PRODUCT_SERVICE_TYPES.find((type) => type === raw) ?? fallback
}
