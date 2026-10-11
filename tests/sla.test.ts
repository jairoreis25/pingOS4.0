/**
 * Testes das regras de atraso do Kanban.
 *
 * O banco não tem SLA: o prazo é derivado de prioridade + criação, então estes
 * testes são o contrato do que a tela considera "atrasado".
 */

import { describe, expect, it } from "vitest"
import {
  SLA_HOURS,
  isSlaOverdue,
  isUnseenTicket,
  slaDueAt,
  slaLabel,
  slaOverdueLabel,
} from "../src/lib/sla"

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const AGORA = 1_791_600_000_000

describe("slaDueAt", () => {
  it("usa o prazo da prioridade sobre a criação", () => {
    expect(slaDueAt({ priority: "critica", createdAt: AGORA })).toBe(
      AGORA + SLA_HOURS.critica * HOUR,
    )
    expect(slaDueAt({ priority: "baixa", createdAt: AGORA })).toBe(AGORA + SLA_HOURS.baixa * HOUR)
  })

  it("prioridade desconhecida cai no prazo de 'media'", () => {
    expect(slaDueAt({ priority: "urgentissima", createdAt: AGORA })).toBe(
      AGORA + SLA_HOURS.media * HOUR,
    )
    expect(slaDueAt({ createdAt: AGORA })).toBe(AGORA + SLA_HOURS.media * HOUR)
  })

  it("prazo explícito (dueAt) tem prioridade sobre o cálculo", () => {
    const dueAt = AGORA + HOUR
    expect(slaDueAt({ priority: "baixa", createdAt: AGORA, dueAt })).toBe(dueAt)
  })

  it("sem criação e sem dueAt não há prazo", () => {
    expect(slaDueAt({ priority: "alta" })).toBeNull()
  })
})

describe("isSlaOverdue", () => {
  it("crítica atrasa em 4 horas", () => {
    const chamado = { priority: "critica", status: "aberto", createdAt: AGORA }
    expect(isSlaOverdue(chamado, AGORA + 3 * HOUR)).toBe(false)
    expect(isSlaOverdue(chamado, AGORA + 5 * HOUR)).toBe(true)
  })

  it("baixa só atrasa depois de uma semana", () => {
    const chamado = { priority: "baixa", status: "aberto", createdAt: AGORA }
    expect(isSlaOverdue(chamado, AGORA + 6 * DAY)).toBe(false)
    expect(isSlaOverdue(chamado, AGORA + 8 * DAY)).toBe(true)
  })

  it("resolvido e fechado nunca contam como atrasados", () => {
    expect(
      isSlaOverdue(
        { priority: "critica", status: "resolvido", createdAt: AGORA },
        AGORA + 10 * DAY,
      ),
    ).toBe(false)
    expect(
      isSlaOverdue({ priority: "critica", status: "fechado", createdAt: AGORA }, AGORA + 10 * DAY),
    ).toBe(false)
  })

  it("sem dados de data não atrasa", () => {
    expect(isSlaOverdue({ priority: "critica", status: "aberto" }, AGORA)).toBe(false)
  })
})

describe("slaOverdueLabel", () => {
  it("mostra dias quando passa de 24h de atraso", () => {
    const chamado = { priority: "media", status: "aberto", createdAt: AGORA }
    expect(slaOverdueLabel(chamado, AGORA + 3 * DAY + 2 * DAY)).toBe("2d atrasado")
  })

  it("mostra horas quando o atraso é do mesmo dia", () => {
    const chamado = { priority: "critica", status: "aberto", createdAt: AGORA }
    expect(slaOverdueLabel(chamado, AGORA + 4 * HOUR + 3 * HOUR)).toBe("3h atrasado")
  })

  it("no prazo não devolve rótulo", () => {
    expect(
      slaOverdueLabel({ priority: "alta", status: "aberto", createdAt: AGORA }, AGORA + HOUR),
    ).toBeNull()
  })
})

describe("slaLabel", () => {
  it("anuncia o tempo restante antes do prazo", () => {
    expect(
      slaLabel({ priority: "media", status: "aberto", createdAt: AGORA }, AGORA + 2 * DAY),
    ).toBe("vence em 1d")
    expect(
      slaLabel({ priority: "alta", status: "aberto", createdAt: AGORA }, AGORA + 6 * HOUR),
    ).toBe("vence em 18h")
    expect(
      slaLabel({ priority: "critica", status: "aberto", createdAt: AGORA }, AGORA + 2 * HOUR),
    ).toBe("vence em 2h")
  })

  it("dentro da última hora avisa sem número", () => {
    expect(
      slaLabel(
        { priority: "critica", status: "aberto", createdAt: AGORA },
        AGORA + 4 * HOUR - 60_000,
      ),
    ).toBe("vence em menos de 1h")
  })

  it("atrasado usa o rótulo de atraso", () => {
    expect(
      slaLabel({ priority: "critica", status: "aberto", createdAt: AGORA }, AGORA + 10 * HOUR),
    ).toBe("6h atrasado")
  })

  it("resolvido não anuncia prazo (mesmo depois do vencimento)", () => {
    expect(slaLabel({ priority: "alta", status: "resolvido", createdAt: AGORA }, AGORA + DAY)).toBe(
      "",
    )
    expect(
      slaLabel({ priority: "alta", status: "fechado", createdAt: AGORA }, AGORA + 10 * DAY),
    ).toBe("")
  })
})

describe("isUnseenTicket", () => {
  it("só é novo quando explicitamente não visualizado", () => {
    expect(isUnseenTicket({ visualizado: false })).toBe(true)
    expect(isUnseenTicket({ visualizado: true })).toBe(false)
    expect(isUnseenTicket({})).toBe(false)
    expect(isUnseenTicket({ visualizado: null })).toBe(false)
  })
})
