import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { TICKET_STATUSES } from "@/lib/permissions"
import {
  COLUMNS,
  DRAG_TICKET_MIME,
  PRIORITY_CONFIG,
  getInitials,
  sameTicketList,
  statusLabel,
  timeAgo,
} from "@/lib/ticket-ui"

describe("COLUMNS", () => {
  it("cobre exatamente os status do catálogo de permissões, na mesma ordem", () => {
    expect(COLUMNS.map((coluna) => coluna.id)).toEqual([...TICKET_STATUSES])
  })

  it("dá rótulo e classes de cor a toda coluna", () => {
    for (const coluna of COLUMNS) {
      expect(coluna.label.length).toBeGreaterThan(0)
      expect(coluna.color.length).toBeGreaterThan(0)
      expect(coluna.barColor.length).toBeGreaterThan(0)
      expect(coluna.pillClass.length).toBeGreaterThan(0)
    }
  })
})

describe("PRIORITY_CONFIG", () => {
  it("cobre as quatro prioridades com rótulo em pt-BR", () => {
    expect(Object.keys(PRIORITY_CONFIG).sort()).toEqual(["alta", "baixa", "critica", "media"])
    expect(PRIORITY_CONFIG.critica.label).toBe("Crítica")
    expect(PRIORITY_CONFIG.alta.label).toBe("Alta")
    expect(PRIORITY_CONFIG.media.label).toBe("Média")
    expect(PRIORITY_CONFIG.baixa.label).toBe("Baixa")
  })
})

describe("getInitials", () => {
  it("usa as iniciais dos dois primeiros nomes", () => {
    expect(getInitials("Jairo Reis")).toBe("JR")
    expect(getInitials("ana maria silva")).toBe("AM")
  })

  it("devolve no máximo duas letras", () => {
    expect(getInitials("A B C D")).toBe("AB")
    expect(getInitials("Ana")).toBe("A")
  })

  it("devolve string vazia para nome vazio", () => {
    expect(getInitials("")).toBe("")
  })

  it("lida com espaços extras sem quebrar", () => {
    expect(getInitials("  Jairo   Reis  ")).toBe("JR")
  })
})

describe("statusLabel", () => {
  it("traduz o status para o rótulo da coluna", () => {
    expect(statusLabel("aberto")).toBe("Aberto")
    expect(statusLabel("em_andamento")).toBe("Em Andamento")
    expect(statusLabel("fechado")).toBe("Fechado")
  })

  it("devolve vazio quando não há status", () => {
    expect(statusLabel()).toBe("")
    expect(statusLabel(null)).toBe("")
  })
})

describe("sameTicketList", () => {
  it("reconhece a mesma referência sem percorrer a lista", () => {
    const lista = [{ id: "1" }, { id: "2" }]
    expect(sameTicketList(lista, lista)).toBe(true)
  })

  it("compara item a item por identidade (evita redesenho à toa)", () => {
    const a = { id: "1" }
    const b = { id: "2" }
    expect(sameTicketList([a, b], [a, b])).toBe(true)
    expect(sameTicketList([a, b], [a, { id: "2" }])).toBe(false)
    expect(sameTicketList([a], [a, b])).toBe(false)
  })

  it("considera duas listas vazias iguais", () => {
    expect(sameTicketList([], [])).toBe(true)
    expect(sameTicketList<string>([], [])).toBe(true)
  })
})

describe("timeAgo", () => {
  const agora = new Date(2024, 0, 15, 12, 0, 0).getTime()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(agora)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("mostra 'agora' para menos de um minuto", () => {
    expect(timeAgo(agora - 30_000)).toBe("agora")
    expect(timeAgo(agora)).toBe("agora")
  })

  it("mostra minutos inteiros até completar uma hora", () => {
    expect(timeAgo(agora - 5 * 60_000)).toBe("5min")
    expect(timeAgo(agora - 59 * 60_000)).toBe("59min")
  })

  it("mostra horas inteiras até completar um dia", () => {
    expect(timeAgo(agora - 60 * 60_000)).toBe("1h")
    expect(timeAgo(agora - 23 * 60 * 60_000)).toBe("23h")
  })

  it("mostra dias a partir de 24 horas", () => {
    expect(timeAgo(agora - 25 * 60 * 60_000)).toBe("1d")
    expect(timeAgo(agora - 72 * 60 * 60_000)).toBe("3d")
  })

  it("trata data futura como 'agora' (diferença negativa)", () => {
    expect(timeAgo(agora + 60_000)).toBe("agora")
  })
})

describe("DRAG_TICKET_MIME", () => {
  it("usa um tipo MIME próprio do app no dataTransfer", () => {
    expect(DRAG_TICKET_MIME).toBe("application/x-pingos-chamado")
  })
})
