/**
 * Testes da via de impressão (extraída do `Dashboard`).
 *
 * Além do conteúdo, fixam a **escapagem**: o texto do chamado vem do usuário
 * (inclusive do formulário público) e a janela de impressão abre na mesma origem
 * do sistema — sem escapar, uma descrição com `<script>` executaria ali.
 */

import { describe, expect, it } from "vitest"
import { buildTicketPrintHtml, escapeHtml } from "../src/lib/ticket-print"

const base = {
  number: 7,
  title: "Notebook não liga",
  description: "Sem sinal de carga",
  creatorName: "João",
  createdAt: 1_791_600_000_000,
}

const labels = { statusLabel: "Aberto", priorityLabel: "Alta", valorTotal: "R$ 120,00" }

describe("escapeHtml", () => {
  it("escapa os caracteres que mudam a estrutura do HTML", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    )
    expect(escapeHtml("Tom & Jerry's")).toBe("Tom &amp; Jerry&#39;s")
  })

  it("trata null/undefined como texto vazio", () => {
    expect(escapeHtml(null)).toBe("")
    expect(escapeHtml(undefined)).toBe("")
  })
})

describe("buildTicketPrintHtml", () => {
  it("monta a via com número, rótulos, valor e solicitante", () => {
    const html = buildTicketPrintHtml(base, labels)

    expect(html).toContain("<title>Chamado #7</title>")
    expect(html).toContain("Aberto")
    expect(html).toContain("Alta")
    expect(html).toContain("R$ 120,00")
    expect(html).toContain("João")
    expect(html).toContain("Notebook não liga")
  })

  it("dispara a impressão ao carregar a janela", () => {
    expect(buildTicketPrintHtml(base, labels)).toContain("window.print()")
  })

  it("omite blocos vazios (solução, orçamento, obs, situação, contato, local)", () => {
    const html = buildTicketPrintHtml(base, labels)

    expect(html).not.toContain("Solução")
    expect(html).not.toContain("Orçamento")
    expect(html).not.toContain("Contato")
    expect(html).not.toContain("Responsável")
  })

  it("mostra os blocos quando existem", () => {
    const html = buildTicketPrintHtml(
      { ...base, solucao: "Trocado o carregador", obs: "Cliente ausente", assigneeName: "Ana" },
      labels,
    )

    expect(html).toContain("Solução")
    expect(html).toContain("Trocado o carregador")
    expect(html).toContain("Cliente ausente")
    expect(html).toContain("Ana")
  })

  it("não injeta HTML vindo do chamado (XSS na janela de impressão)", () => {
    const html = buildTicketPrintHtml(
      {
        ...base,
        title: '<img src=x onerror="alert(1)">',
        description: "<script>alert('xss')</script>",
        imageUrl: 'data:image/png;base64,AAA" onload="alert(2)',
      },
      labels,
    )

    expect(html).not.toContain("<script>alert('xss')</script>")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain('onerror="alert(1)"')
    expect(html).not.toContain('onload="alert(2)')
  })

  it("inclui a imagem apenas quando o chamado tem uma", () => {
    expect(buildTicketPrintHtml(base, labels)).not.toContain("<img")
    expect(
      buildTicketPrintHtml({ ...base, imageUrl: "data:image/png;base64,AAA" }, labels),
    ).toContain("<img")
  })

  it("usa a data de hoje recebida (facilita teste determinístico)", () => {
    const html = buildTicketPrintHtml(base, labels, new Date(2026, 9, 10))
    expect(html).toContain("10/10/2026")
  })
})
