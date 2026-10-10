import { describe, expect, it } from "vitest"

import {
  formatBRL,
  maskCurrencyInput,
  parseCurrencyInput,
  resolveItemsTotal,
  sumBRLInText,
} from "@/lib/currency"

/**
 * O Intl de pt-BR separa "R$" do número com espaço não-quebrável (U+00A0), e não
 * com espaço comum — por isso as constantes abaixo.
 */
const NBSP = "\u00a0"
const R_1234_50 = `R$${NBSP}1.234,50`
const R_1234_56 = `R$${NBSP}1.234,56`
const R_0_00 = `R$${NBSP}0,00`
const R_0_01 = `R$${NBSP}0,01`
const R_0_05 = `R$${NBSP}0,05`
const R_0_12 = `R$${NBSP}0,12`
const R_0_15 = `R$${NBSP}0,15`
const R_NEG_50 = `-R$${NBSP}50,00`

describe("formatBRL", () => {
  it("formata valores positivos com milhar e duas casas", () => {
    expect(formatBRL(1234.5)).toBe(R_1234_50)
    expect(formatBRL(1234567.89)).toBe(`R$${NBSP}1.234.567,89`)
    expect(formatBRL(0)).toBe(R_0_00)
  })

  it("formata valores negativos com o sinal antes do cifrão", () => {
    expect(formatBRL(-50)).toBe(R_NEG_50)
  })

  it("arredonda centavos com excesso de casas", () => {
    expect(formatBRL(0.005)).toBe(R_0_01)
  })
})

describe("maskCurrencyInput", () => {
  it("devolve string vazia quando não há dígito", () => {
    expect(maskCurrencyInput("")).toBe("")
    expect(maskCurrencyInput("abc")).toBe("")
    expect(maskCurrencyInput("R$ ,.")).toBe("")
  })

  it("trata os dígitos como centavos (máquina de cartão)", () => {
    expect(maskCurrencyInput("12")).toBe(R_0_12)
    expect(maskCurrencyInput("0")).toBe(R_0_00)
    expect(maskCurrencyInput("123456")).toBe(R_1234_56)
  })

  it("ignora separadores digitados pelo usuário", () => {
    expect(maskCurrencyInput("1.234,56")).toBe(R_1234_56)
    expect(maskCurrencyInput("1,5")).toBe(R_0_15)
    expect(maskCurrencyInput("R$ 12,34")).toBe(`R$${NBSP}12,34`)
  })

  it("é idempotente sobre um valor já mascarado", () => {
    const mascarado = maskCurrencyInput("987654")
    expect(maskCurrencyInput(mascarado)).toBe(mascarado)
  })

  it("limita a entrada a 12 dígitos (até bilhões)", () => {
    expect(maskCurrencyInput("123456789012")).toBe(`R$${NBSP}1.234.567.890,12`)
    expect(maskCurrencyInput("1234567890123")).toBe(`R$${NBSP}1.234.567.890,12`)
  })
})

describe("parseCurrencyInput", () => {
  it("converte o texto mascarado de volta para número", () => {
    expect(parseCurrencyInput(R_1234_50)).toBe(1234.5)
    expect(parseCurrencyInput(R_0_05)).toBe(0.05)
    expect(parseCurrencyInput("5")).toBe(0.05)
  })

  it("devolve zero para entrada vazia ou sem dígitos", () => {
    expect(parseCurrencyInput("")).toBe(0)
    expect(parseCurrencyInput("abc")).toBe(0)
  })

  it("faz o caminho de ida e volta sem perder centavos", () => {
    expect(parseCurrencyInput(maskCurrencyInput("987654"))).toBe(9876.54)
    expect(parseCurrencyInput(maskCurrencyInput(""))).toBe(0)
  })
})

describe("sumBRLInText", () => {
  it("soma os valores citados na Solução", () => {
    expect(sumBRLInText("Troca de fonte — R$ 120,00")).toBe(120)
    expect(sumBRLInText("Peça A R$ 100,00 e Peça B R$ 50,50")).toBe(150.5)
  })

  it("não confunde o hífen separador com sinal negativo", () => {
    expect(sumBRLInText("Frete - R$ 30,00")).toBe(30)
  })

  it("desconta valores negativos nas duas grafias aceitas", () => {
    expect(sumBRLInText("-R$ 50,00")).toBe(-50)
    expect(sumBRLInText("R$ -50,00")).toBe(-50)
    expect(sumBRLInText("Desconto -R$ 10,00 e taxa R$ 4,00")).toBe(-6)
  })

  it("aceita vírgula como decimal e ponto como milhar", () => {
    expect(sumBRLInText("R$ 1.234,56")).toBe(1234.56)
    expect(sumBRLInText("R$ 1.200")).toBe(1200)
  })

  it("aceita a grafia com ponto decimal (120.50)", () => {
    expect(sumBRLInText("R$ 120.50")).toBe(120.5)
  })

  it("ignora pontuação solta depois do número", () => {
    expect(sumBRLInText("R$ 10,,")).toBe(10)
    expect(sumBRLInText("R$ 10,00 e R$")).toBe(10)
  })

  it("devolve zero quando não há valor em reais", () => {
    expect(sumBRLInText("")).toBe(0)
    expect(sumBRLInText("sem valor")).toBe(0)
    expect(sumBRLInText("R$ abc")).toBe(0)
  })

  it("arredonda a soma para centavos (evita erro de ponto flutuante)", () => {
    expect(sumBRLInText("R$ 0,10 R$ 0,20")).toBe(0.3)
    expect(sumBRLInText("R$ 0,01 R$ 0,02")).toBe(0.03)
  })
})

describe("resolveItemsTotal", () => {
  it("prioriza a Solução quando ela tem valor", () => {
    expect(resolveItemsTotal("R$ 100,00", "R$ 50,00")).toEqual({
      value: 100,
      source: "solucao",
    })
  })

  it("cai no Orçamento quando a Solução não tem valor", () => {
    expect(resolveItemsTotal("", "R$ 50,00")).toEqual({ value: 50, source: "orcamento" })
    expect(resolveItemsTotal(null, "R$ 50,00")).toEqual({ value: 50, source: "orcamento" })
    expect(resolveItemsTotal(undefined, "R$ 50,00")).toEqual({ value: 50, source: "orcamento" })
  })

  it("devolve zero e origem nula quando nenhum dos dois tem valor", () => {
    expect(resolveItemsTotal("", "")).toEqual({ value: 0, source: null })
    expect(resolveItemsTotal(null, null)).toEqual({ value: 0, source: null })
    expect(resolveItemsTotal(undefined, undefined)).toEqual({ value: 0, source: null })
    expect(resolveItemsTotal("sem valores", "sem valores")).toEqual({ value: 0, source: null })
  })

  it("nunca soma Solução e Orçamento (evita contar o serviço duas vezes)", () => {
    const resultado = resolveItemsTotal("R$ 100,00", "R$ 200,00")
    expect(resultado.value).toBe(100)
  })

  it("trata Solução que soma zero como ausente e usa o Orçamento", () => {
    expect(resolveItemsTotal("-R$ 20,00 R$ 20,00", "R$ 30,00")).toEqual({
      value: 30,
      source: "orcamento",
    })
    expect(resolveItemsTotal("R$ 0,00", "R$ 30,00")).toEqual({ value: 30, source: "orcamento" })
  })
})
