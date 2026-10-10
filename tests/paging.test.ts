/**
 * Testes dos helpers de paginação do cliente.
 *
 * Cobrem as duas regras que já causaram bug em paginação: ler o cursor do header
 * e juntar páginas sem duplicar item quando o SSE recarrega a primeira página.
 */

import { describe, expect, it } from "vitest"
import { appendPage, mergePages, nextCursorFrom } from "../src/lib/backend/paging"

function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init)
}

describe("nextCursorFrom", () => {
  it("devolve o cursor quando o servidor manda o header", () => {
    expect(nextCursorFrom(headers({ "X-Next-Cursor": "abc123" }))).toBe("abc123")
  })

  it("trata ausente, vazio, só espaço e headers indefinidos como fim da lista", () => {
    expect(nextCursorFrom(headers())).toBeNull()
    expect(nextCursorFrom(headers({ "X-Next-Cursor": "" }))).toBeNull()
    expect(nextCursorFrom(headers({ "X-Next-Cursor": "   " }))).toBeNull()
    expect(nextCursorFrom(undefined)).toBeNull()
  })

  it("apara espaço em volta do valor", () => {
    expect(nextCursorFrom(headers({ "X-Next-Cursor": "  xyz  " }))).toBe("xyz")
  })
})

describe("mergePages", () => {
  const id = (item: { _id: string }) => item._id

  it("devolve a página nova quando não havia nada na tela", () => {
    const nova = [{ _id: "2" }, { _id: "1" }]
    expect(mergePages([], nova, id)).toEqual(nova)
  })

  it("põe a página nova na frente e mantém os itens antigos que não vieram nela", () => {
    const antigos = [{ _id: "3" }, { _id: "2" }, { _id: "1" }]
    const nova = [{ _id: "4" }, { _id: "3" }]

    expect(mergePages(antigos, nova, id)).toEqual([
      { _id: "4" },
      { _id: "3" },
      { _id: "2" },
      { _id: "1" },
    ])
  })

  it("não duplica item que aparece nas duas listas", () => {
    const antigos = [{ _id: "1" }, { _id: "2" }]
    const nova = [{ _id: "2" }, { _id: "1" }]

    expect(mergePages(antigos, nova, id)).toHaveLength(2)
  })

  it("não repete quando a nova página está vazia", () => {
    const antigos = [{ _id: "1" }]
    expect(mergePages(antigos, [], id)).toEqual(antigos)
  })
})

describe("appendPage", () => {
  const id = (item: { _id: string }) => item._id

  it("acrescenta ao fim preservando a ordem carregada", () => {
    const atuais = [{ _id: "3" }, { _id: "2" }]
    const proxima = [{ _id: "1" }, { _id: "0" }]

    expect(appendPage(atuais, proxima, id)).toEqual([
      { _id: "3" },
      { _id: "2" },
      { _id: "1" },
      { _id: "0" },
    ])
  })

  it("ignora itens que já estavam na tela (cursor sobreposto)", () => {
    const atuais = [{ _id: "3" }, { _id: "2" }]
    const proxima = [{ _id: "2" }, { _id: "1" }]

    expect(appendPage(atuais, proxima, id)).toEqual([{ _id: "3" }, { _id: "2" }, { _id: "1" }])
  })

  it("começa pela página quando a lista está vazia", () => {
    const proxima = [{ _id: "9" }]
    expect(appendPage([], proxima, id)).toEqual(proxima)
  })
})
