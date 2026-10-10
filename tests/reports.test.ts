import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  CHANNEL_LABELS,
  DAY_MS,
  PERIOD_PRESETS,
  REPORT_META,
  STATUS_LABELS,
  cellText,
  formatPeriodLabel,
  fromDateInput,
  money,
  presetRange,
  summarize,
  toDateInput,
  toTable,
} from "@/lib/reports"

const NBSP = "\u00a0"

describe("money", () => {
  it("formata reais com milhar e duas casas", () => {
    expect(money(1234.5)).toBe(`R$${NBSP}1.234,50`)
    expect(money(0)).toBe(`R$${NBSP}0,00`)
    expect(money(-50)).toBe(`-R$${NBSP}50,00`)
  })
})

describe("cellText", () => {
  it("mostra travessão para valor vazio", () => {
    expect(cellText({ key: "x", label: "X" }, null)).toBe("—")
    expect(cellText({ key: "x", label: "X" }, undefined)).toBe("—")
    expect(cellText({ key: "x", label: "X" }, "")).toBe("—")
  })

  it("formata moeda, decimal e inteiro conforme a coluna", () => {
    expect(cellText({ key: "v", label: "V", format: "currency" }, 1234.5)).toBe(`R$${NBSP}1.234,50`)
    expect(cellText({ key: "v", label: "V", format: "decimal" }, 2.5)).toBe("2,5")
    expect(cellText({ key: "v", label: "V", format: "decimal" }, 1.25)).toBe("1,3")
    expect(cellText({ key: "v", label: "V", format: "integer" }, 1234)).toBe("1.234")
  })

  it("não aplica formato numérico em texto", () => {
    expect(cellText({ key: "v", label: "V", format: "currency" }, "1234.5")).toBe("1234.5")
    expect(cellText({ key: "v", label: "V" }, 0)).toBe("0")
    expect(cellText({ key: "v", label: "V" }, "sem histórico")).toBe("sem histórico")
  })
})

describe("toTable", () => {
  it("monta a tabela de chamados traduzindo status e prioridade", () => {
    const tabela = toTable("tickets", {
      rows: [
        {
          number: 12,
          os: "OS-1",
          title: "Troca de fonte",
          status: "resolvido",
          priority: "critica",
          assignee: "",
          client: "Maria",
          setor: "TI",
          createdAtLabel: "01/01/2024",
          updatedAtLabel: "",
          totalDays: 2.5,
          valorTotal: 120,
        },
      ],
      totals: { total: 1, resolved: 1, open: 0, avgResolutionDays: 2.5, valorTotal: 120 },
    })

    expect(tabela.columns.map((coluna) => coluna.key)).toEqual([
      "number",
      "os",
      "title",
      "status",
      "priority",
      "assignee",
      "client",
      "setor",
      "createdAtLabel",
      "updatedAtLabel",
      "totalDays",
      "valorTotal",
    ])
    expect(tabela.rows[0]).toEqual({
      number: 12,
      os: "OS-1",
      title: "Troca de fonte",
      status: "Resolvido",
      priority: "Crítica",
      assignee: "—",
      client: "Maria",
      setor: "TI",
      createdAtLabel: "01/01/2024",
      updatedAtLabel: "—",
      totalDays: 2.5,
      valorTotal: 120,
    })
  })

  it("mantém o valor cru quando o status ou a prioridade são desconhecidos", () => {
    const tabela = toTable("tickets", {
      rows: [
        {
          number: 1,
          os: null,
          title: "X",
          status: "arquivado",
          priority: "urgente",
          assignee: null,
          client: "Ana",
          setor: "TI",
          createdAtLabel: null,
          updatedAtLabel: null,
          totalDays: null,
          valorTotal: null,
        },
      ],
      totals: {},
    })
    expect(tabela.rows[0].status).toBe("arquivado")
    expect(tabela.rows[0].priority).toBe("urgente")
    expect(tabela.rows[0].os).toBe("—")
  })

  it("marca taxa de reabertura sem histórico quando o período não rastreia reabertura", () => {
    const comHistorico = toTable("technicians", {
      rows: [
        {
          name: "Ana",
          total: 3,
          resolved: 2,
          inProgress: 1,
          avgResolutionDays: 1.25,
          reopenRate: 10,
          reopenTracked: true,
        },
      ],
      totals: {},
    })
    expect(comHistorico.rows[0].reopenRate).toBe(10)

    const semHistorico = toTable("technicians", {
      rows: [
        {
          name: "Ana",
          total: 3,
          resolved: 2,
          inProgress: 1,
          avgResolutionDays: 1.25,
          reopenRate: 10,
          reopenTracked: false,
        },
      ],
      totals: {},
    })
    expect(semHistorico.rows[0].reopenRate).toBe("sem histórico")
  })

  it("formata os tempos médios do relatório por setor", () => {
    const tabela = toTable("sectors", {
      rows: [
        {
          setor: "TI",
          total: 2,
          resolved: 1,
          pending: 1,
          avgResponseDays: null,
          avgResolutionDays: 3,
        },
      ],
      totals: {},
    })
    expect(tabela.rows[0].avgResponseDays).toBe("—")
    expect(tabela.rows[0].avgResolutionDays).toBe("3,0 d")
  })

  it("traduz a situação do usuário e protege campos vazios", () => {
    const tabela = toTable("users", {
      rows: [
        {
          name: "Ana",
          username: "",
          email: null,
          role: "admin",
          setor: "TI",
          active: true,
          permissionOverrides: 2,
          createdAtLabel: "01/02/2024",
        },
        {
          name: "Bia",
          username: "bia",
          email: "bia@exemplo.com",
          role: "user",
          setor: "",
          active: false,
          permissionOverrides: 0,
          createdAtLabel: "",
        },
      ],
      totals: { total: 2, active: 1, inactive: 1 },
    })
    expect(tabela.columns.map((coluna) => coluna.key)).toContain("overrides")
    expect(tabela.rows[0].active).toBe("Ativo")
    expect(tabela.rows[0].username).toBe("—")
    expect(tabela.rows[0].email).toBe("—")
    expect(tabela.rows[1].active).toBe("Inativo")
    expect(tabela.rows[1].createdAtLabel).toBe("—")
  })

  it("traduz canal e status do envio de notificações", () => {
    const tabela = toTable("notifications", {
      rows: [
        {
          sentAtLabel: "01/01/2024",
          ticket: "12",
          ticketTitle: "X",
          rule: "status_changed",
          recipient: "Ana",
          channel: "email",
          status: "sent",
        },
        {
          sentAtLabel: null,
          ticket: null,
          ticketTitle: null,
          rule: "status_changed",
          recipient: "Ana",
          channel: "sms",
          status: "desconhecido",
        },
      ],
      totals: {},
    })
    expect(tabela.rows[0].channel).toBe("E-mail")
    expect(tabela.rows[0].status).toBe("Enviado")
    expect(tabela.rows[1].channel).toBe("sms")
    expect(tabela.rows[1].status).toBe("desconhecido")
    expect(tabela.rows[1].sentAtLabel).toBe("—")
  })

  it("mantém os metadados e rótulos alinhados com os cinco relatórios", () => {
    expect(REPORT_META.map((meta) => meta.id)).toEqual([
      "tickets",
      "technicians",
      "sectors",
      "users",
      "notifications",
    ])
    expect(STATUS_LABELS.em_andamento).toBe("Em Andamento")
    expect(CHANNEL_LABELS.whatsapp).toBe("WhatsApp")
  })
})

describe("summarize", () => {
  it("totaliza os chamados, incluindo status ausente como zero", () => {
    const resumo = summarize("tickets", {
      totals: {
        total: 12,
        resolved: 3,
        open: 9,
        avgResolutionDays: 2.5,
        valorTotal: 1234.5,
        byStatus: { resolvido: 3 },
      },
    })
    expect(resumo[0]).toEqual({ label: "Quantidade total", value: "12" })
    expect(resumo).toContainEqual({ label: "Tempo médio de resolução", value: "2,5 d" })
    expect(resumo).toContainEqual({
      label: "Valor total dos chamados",
      value: `R$${NBSP}1.234,50`,
    })
    expect(resumo).toContainEqual({ label: "Status: Resolvido", value: "3" })
    expect(resumo).toContainEqual({ label: "Status: Fechado", value: "0" })
  })

  it("usa travessão no tempo médio ausente do relatório por técnico", () => {
    const resumo = summarize("technicians", {
      totals: {
        assignees: 2,
        total: 5,
        resolved: 4,
        inProgress: 1,
        reopened: 0,
        avgResolutionDays: null,
      },
    })
    expect(resumo).toContainEqual({ label: "Tempo médio (média simples)", value: "—" })
    expect(resumo).toContainEqual({ label: "Reabertos", value: "0" })
  })

  it("lista os setores e seus totais", () => {
    const resumo = summarize("sectors", {
      totals: { sectors: 2, total: 10, resolved: 6, pending: 4 },
    })
    expect(resumo).toHaveLength(4)
    expect(resumo).toContainEqual({ label: "Pendentes", value: "4" })
  })

  it("inclui um totalizador por papel apenas quando o mapa vem na resposta", () => {
    const comPapeis = summarize("users", {
      totals: { total: 3, active: 2, inactive: 1, byRole: { admin: 1, user: 2 } },
    })
    expect(comPapeis).toContainEqual({ label: "Papel: admin", value: "1" })
    expect(comPapeis).toContainEqual({ label: "Papel: user", value: "2" })

    const semPapeis = summarize("users", { totals: { total: 3, active: 2, inactive: 1 } })
    expect(semPapeis.some((item) => item.label.startsWith("Papel:"))).toBe(false)
  })

  it("zera os canais sem envio no relatório de notificações", () => {
    const resumo = summarize("notifications", {
      totals: { total: 5, sent: 4, failed: 1, byChannel: { email: 5 } },
    })
    expect(resumo).toContainEqual({ label: "Canal: E-mail", value: "5" })
    expect(resumo).toContainEqual({ label: "Canal: Telegram", value: "0" })
    expect(resumo).toContainEqual({ label: "Canal: WhatsApp", value: "0" })
  })
})

describe("utilitários de período", () => {
  it("define um dia em milissegundos", () => {
    expect(DAY_MS).toBe(86_400_000)
  })

  it("lista os presets na ordem exibida na tela", () => {
    expect(PERIOD_PRESETS.map((preset) => preset.id)).toEqual([
      "hoje",
      "7d",
      "30d",
      "mes",
      "mes_anterior",
      "ano",
      "personalizado",
    ])
  })

  describe("presetRange", () => {
    const agora = new Date(2024, 0, 15, 12, 0, 0).getTime()
    const fimDeHoje = new Date(2024, 0, 15, 23, 59, 59, 999).getTime()

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(agora)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("'hoje' começa no início do dia local", () => {
      expect(presetRange("hoje")).toEqual({ start: fimDeHoje - DAY_MS + 1, end: fimDeHoje })
    })

    it("'7d' e '30d' contam o dia de hoje dentro da janela", () => {
      expect(presetRange("7d")).toEqual({ start: fimDeHoje - 6 * DAY_MS, end: fimDeHoje })
      expect(presetRange("30d")).toEqual({ start: fimDeHoje - 29 * DAY_MS, end: fimDeHoje })
    })

    it("'mes' vai do dia 1º até o fim de hoje", () => {
      expect(presetRange("mes")).toEqual({
        start: new Date(2024, 0, 1).getTime(),
        end: fimDeHoje,
      })
    })

    it("'mes_anterior' cobre o mês fechado anterior", () => {
      expect(presetRange("mes_anterior")).toEqual({
        start: new Date(2023, 11, 1).getTime(),
        end: new Date(2023, 11, 31, 23, 59, 59, 999).getTime(),
      })
    })

    it("'ano' vai de 1º de janeiro até o fim de hoje", () => {
      expect(presetRange("ano")).toEqual({
        start: new Date(2024, 0, 1).getTime(),
        end: fimDeHoje,
      })
    })

    it("'personalizado' cai na janela padrão de 30 dias", () => {
      expect(presetRange("personalizado")).toEqual({
        start: fimDeHoje - 29 * DAY_MS,
        end: fimDeHoje,
      })
    })
  })

  describe("toDateInput", () => {
    it("devolve YYYY-MM-DD no fuso local com zero à esquerda", () => {
      expect(toDateInput(new Date(2024, 0, 5).getTime())).toBe("2024-01-05")
      expect(toDateInput(new Date(2024, 11, 31, 23, 59).getTime())).toBe("2024-12-31")
    })
  })

  describe("fromDateInput", () => {
    it("lê o dia inteiro no início e no fim", () => {
      expect(fromDateInput("2024-01-15", "start")).toBe(new Date(2024, 0, 15, 0, 0, 0, 0).getTime())
      expect(fromDateInput("2024-01-15", "end")).toBe(
        new Date(2024, 0, 15, 23, 59, 59, 999).getTime(),
      )
    })

    it("recusa formato fora de YYYY-MM-DD", () => {
      expect(fromDateInput("", "start")).toBeNull()
      expect(fromDateInput("15/01/2024", "start")).toBeNull()
      expect(fromDateInput("2024-1-5", "start")).toBeNull()
      expect(fromDateInput("2024-01-15T10:00", "start")).toBeNull()
    })

    it("documenta o comportamento atual com data impossível (aceita 30/02 rolando para 01/03)", () => {
      expect(fromDateInput("2024-02-30", "start")).toBe(new Date(2024, 2, 1, 0, 0, 0, 0).getTime())
    })

    it("documenta o deslocamento de ano com valor abaixo de 100 (0000 vira 1900)", () => {
      expect(fromDateInput("0000-01-01", "start")).toBe(new Date(1900, 0, 1, 0, 0, 0, 0).getTime())
    })
  })

  describe("formatPeriodLabel", () => {
    it("mostra as duas pontas em pt-BR", () => {
      expect(
        formatPeriodLabel({
          start: new Date(2024, 0, 1).getTime(),
          end: new Date(2024, 0, 31).getTime(),
        }),
      ).toBe("01/01/2024 a 31/01/2024")
    })
  })
})
