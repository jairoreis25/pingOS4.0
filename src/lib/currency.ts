/**
 * Formatação e digitação de valores em reais (pt-BR).
 *
 * O campo de valor do app inteiro funciona como um caixa eletrônico: o usuário
 * digita apenas dígitos e os dois últimos viram os centavos (123456 →
 * "R$ 1.234,56"). Assim não existe ambiguidade entre "1.234" (milhar) e
 * "1,234" (decimal), que é o erro clássico de campos de dinheiro.
 */

/** Formata um número em reais: 1234.5 → "R$ 1.234,50". */
export function formatBRL(value: number): string {
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  })
}

/** Aplica a máscara enquanto o usuário digita. Devolve "" quando não há dígito. */
export function maskCurrencyInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 12)
  if (!digits) return ""
  return formatBRL(Number(digits) / 100)
}

/** Converte o texto mascarado de volta para número (ex.: "R$ 1.234,56" → 1234.56). */
export function parseCurrencyInput(masked: string): number {
  const digits = masked.replace(/\D/g, "")
  return digits ? Number(digits) / 100 : 0
}

/**
 * Total dos itens de um chamado.
 *
 * A Solução manda: é nela que fica o que foi executado. Quando ela não tem
 * nenhum valor, vale o Orçamento (a cotação). Os dois **nunca** são somados —
 * em um fluxo de orçamento aprovado e depois executado, somar contaria o mesmo
 * serviço duas vezes.
 */
export function resolveItemsTotal(
  solucao?: string | null,
  orcamento?: string | null,
): { value: number; source: "solucao" | "orcamento" | null } {
  const solucaoSum = sumBRLInText(solucao ?? "")
  if (solucaoSum !== 0) return { value: solucaoSum, source: "solucao" }

  const orcamentoSum = sumBRLInText(orcamento ?? "")
  if (orcamentoSum !== 0) return { value: orcamentoSum, source: "orcamento" }

  return { value: 0, source: null }
}

/**
 * Soma todos os valores em reais citados em um texto.
 *
 * É o que faz o Valor Total acompanhar os itens da Solução do chamado, onde o
 * menu "/" escreve linhas como "Troca de fonte — R$ 120,00". Aceita as duas
 * grafias decimais ("1.234,56" e "120.50") para não depender de quem digitou.
 *
 * Valores negativos são descontados ("-R$ 50,00" ou "R$ -50,00"). O sinal só
 * conta quando encosta no "R$", para o hífen separador de "Frete - R$ 30,00"
 * continuar sendo soma.
 */
export function sumBRLInText(text: string): number {
  const matches = text.matchAll(/(-)?R\$\s*(-)?\s*([\d.,]+)/g)
  let total = 0

  for (const match of matches) {
    const negative = match[1] === "-" || match[2] === "-"
    const raw = match[3].replace(/[.,]+$/, "")
    if (!raw) continue
    // Com vírgula, ela é o separador decimal e os pontos são de milhar.
    const normalized = raw.includes(",")
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/\.(?=\d{3}\b)/g, "")
    const value = Number(normalized)
    if (Number.isFinite(value)) total += negative ? -value : value
  }

  return Math.round(total * 100) / 100
}
