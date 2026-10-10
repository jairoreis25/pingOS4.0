import { describe, expect, it } from "vitest"

import {
  DEFAULT_PRODUCT_SERVICE_TYPE,
  PRODUCT_SERVICE_TYPE_LABELS,
  PRODUCT_SERVICE_TYPES,
  normalizeProductServiceType,
} from "@/lib/products"

describe("catálogo de produtos e serviços", () => {
  it("define os dois tipos canônicos", () => {
    expect(PRODUCT_SERVICE_TYPES).toEqual(["produto", "servico"])
  })

  it("tem rótulo para cada tipo", () => {
    expect(PRODUCT_SERVICE_TYPE_LABELS).toEqual({ produto: "Produto", servico: "Serviço" })
  })

  it("assume 'servico' como padrão de um item novo", () => {
    expect(DEFAULT_PRODUCT_SERVICE_TYPE).toBe("servico")
  })
})

describe("normalizeProductServiceType", () => {
  it("devolve o valor canônico ignorando caixa e acento", () => {
    expect(normalizeProductServiceType("produto")).toBe("produto")
    expect(normalizeProductServiceType("Produto")).toBe("produto")
    expect(normalizeProductServiceType("SERVIÇO")).toBe("servico")
    expect(normalizeProductServiceType("Servico")).toBe("servico")
    expect(normalizeProductServiceType("  serviço  ")).toBe("servico")
  })

  it("usa 'servico' como fallback quando nada é informado", () => {
    expect(normalizeProductServiceType(undefined)).toBe("servico")
    expect(normalizeProductServiceType(null)).toBe("servico")
    expect(normalizeProductServiceType("")).toBe("servico")
    expect(normalizeProductServiceType("   ")).toBe("servico")
  })

  it("usa 'servico' como fallback para valor inválido (comportamento de escrita)", () => {
    expect(normalizeProductServiceType("peca")).toBe("servico")
    expect(normalizeProductServiceType(42)).toBe("servico")
    expect(normalizeProductServiceType({})).toBe("servico")
  })

  it("devolve null para valor inválido quando o fallback é null (validação da API)", () => {
    expect(normalizeProductServiceType("peca", null)).toBeNull()
    expect(normalizeProductServiceType("", null)).toBeNull()
    expect(normalizeProductServiceType(null, null)).toBeNull()
    expect(normalizeProductServiceType(undefined, null)).toBeNull()
  })

  it("aceita valor válido mesmo com fallback null", () => {
    expect(normalizeProductServiceType("PRODUTO", null)).toBe("produto")
    expect(normalizeProductServiceType(" serviço ", null)).toBe("servico")
  })
})
