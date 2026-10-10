import { describe, expect, it } from "vitest"

import {
  PRIORITY_LABELS,
  STATUS_EQUIPAMENTO_EMPTY,
  STATUS_EQUIPAMENTO_OPTIONS,
  STATUS_LABELS,
  STATUS_PLAIN,
  buildTicketMessage,
  describeDescFields,
} from "@/lib/desc-fields"

const NBSP = "\u00a0"
const CRIADO_EM = new Date(2024, 0, 15, 9, 30).getTime()

describe("describeDescFields", () => {
  it("monta as linhas em negrito na ordem Solução, Orçamento, Obs e Situação", () => {
    const texto = describeDescFields({
      solucao: "Troca de fonte",
      orcamento: "R$ 120,00",
      obs: "Cliente avisado",
      statusEquipamento: "Entregue",
    })
    expect(texto).toBe(
      [
        "*Solução:* Troca de fonte",
        "*Orçamento:* R$ 120,00",
        "*Obs:* Cliente avisado",
        "*Situação:* Entregue",
      ].join("\n"),
    )
  })

  it("remove espaços das pontas dos valores", () => {
    expect(describeDescFields({ solucao: "  Formatação  " })).toBe("*Solução:* Formatação")
  })

  it("omite campos vazios, nulos ou só com espaços", () => {
    expect(describeDescFields({ solucao: "", orcamento: "   ", obs: null })).toBe("")
    expect(describeDescFields({})).toBe("")
    expect(describeDescFields({ solucao: "", obs: "  Troca  " })).toBe("*Obs:* Troca")
  })
})

describe("rótulos fixos", () => {
  it("cobre os cinco status do Kanban nos dois formatos", () => {
    const status = ["aberto", "em_andamento", "aguardando", "resolvido", "fechado"]
    for (const chave of status) {
      expect(STATUS_LABELS[chave]).toBeTruthy()
      expect(STATUS_PLAIN[chave]).toBeTruthy()
    }
    expect(STATUS_LABELS.aberto).toContain("Aberto")
    expect(STATUS_PLAIN.fechado).toBe("Fechado")
  })

  it("cobre as quatro prioridades", () => {
    expect(Object.keys(PRIORITY_LABELS).sort()).toEqual(["alta", "baixa", "critica", "media"])
  })

  it("mantém as opções de situação do equipamento com a sentinela '—'", () => {
    expect(STATUS_EQUIPAMENTO_OPTIONS).toContain("Aguardando retirada")
    expect(STATUS_EQUIPAMENTO_OPTIONS).toContain("Entregue")
    expect(STATUS_EQUIPAMENTO_EMPTY).toBe("—")
    expect(STATUS_EQUIPAMENTO_OPTIONS).not.toContain(STATUS_EQUIPAMENTO_EMPTY)
  })
})

describe("buildTicketMessage", () => {
  it("abre a mensagem de criação cumprimentando o solicitante", () => {
    const msg = buildTicketMessage(
      {
        number: 123,
        creatorName: "Ana",
        status: "aberto",
        priority: "media",
        createdAt: CRIADO_EM,
      },
      "created",
    )
    expect(msg).toContain("*Olá, Ana! tudo bem?*")
    expect(msg).toContain("foi aberta no PingOS")
    expect(msg).toContain("*Status:* Aberto")
    expect(msg).toContain("📅 Aberto em 15/01/2024 às 09:30")
  })

  it("usa 'Solicitante' quando o nome não vem no chamado", () => {
    const msg = buildTicketMessage(
      { number: 1, status: "aberto", priority: "baixa", createdAt: CRIADO_EM },
      "created",
    )
    expect(msg).toContain("*Olá, Solicitante! tudo bem?*")
  })

  it("monta o bloco De ➜ Para na mudança de status", () => {
    const msg = buildTicketMessage(
      { number: 7, status: "resolvido", priority: "alta", createdAt: CRIADO_EM },
      "status_changed",
      { oldStatus: "em_andamento", newStatus: "resolvido" },
    )
    expect(msg).toContain("foi atualizada")
    expect(msg).toContain("*De: Em Andamento*  ➜ *Resolvido*")
    expect(msg).toContain("📅 Atualizado em 15/01/2024 às 09:30")
  })

  it("remove o cabeçalho de saudação quando greeting é false", () => {
    const msg = buildTicketMessage(
      { number: 42, creatorName: "Ana", status: "aberto", priority: "media", createdAt: CRIADO_EM },
      "created",
      { greeting: false },
    )
    expect(msg.startsWith("📋 *Ordem de Serviço #42*")).toBe(true)
    expect(msg).not.toContain("Olá")
  })

  it("cai no rótulo cru quando o status é desconhecido", () => {
    const msg = buildTicketMessage(
      { number: 3, status: "arquivado", priority: "media", createdAt: CRIADO_EM },
      "created",
    )
    expect(msg).toContain("*Status:* arquivado")
  })

  it("usa a O.S. quando o número não existe e '?' quando não há nenhum dos dois", () => {
    const comOs = buildTicketMessage(
      { os: "OS-9", status: "aberto", priority: "baixa", createdAt: CRIADO_EM },
      "created",
      { greeting: false },
    )
    expect(comOs.startsWith("📋 *Ordem de Serviço #OS-9*")).toBe(true)

    const semNumero = buildTicketMessage(
      { status: "aberto", priority: "baixa", createdAt: CRIADO_EM },
      "created",
      { greeting: false },
    )
    expect(semNumero.startsWith("📋 *Ordem de Serviço #?*")).toBe(true)
  })

  it("mostra prioridade desconhecida ou ausente sem quebrar", () => {
    const desconhecida = buildTicketMessage(
      { number: 1, status: "aberto", priority: "urgente", createdAt: CRIADO_EM },
      "created",
    )
    expect(desconhecida).toContain("🚦 *Prioridade:* urgente")

    const ausente = buildTicketMessage(
      { number: 1, status: "aberto", createdAt: CRIADO_EM },
      "created",
    )
    expect(ausente).toContain("🚦 *Prioridade:* —")
  })

  it("prefere o valor total gravado e usa a soma dos itens quando ele não existe", () => {
    const gravado = buildTicketMessage(
      {
        number: 1,
        status: "aberto",
        priority: "media",
        valorTotal: 150,
        solucao: "R$ 999,00",
        createdAt: CRIADO_EM,
      },
      "created",
    )
    expect(gravado).toContain(`💰 *Valor:* R$${NBSP}150,00`)
    // A Solução aparece no corpo (R$ 999,00), mas o valor total continua sendo o gravado.
    expect(gravado).toContain("🔧 *SOLUÇÃO*\nR$ 999,00")

    const pelaSolucao = buildTicketMessage(
      {
        number: 1,
        status: "aberto",
        priority: "media",
        solucao: "Fonte R$ 120,00",
        createdAt: CRIADO_EM,
      },
      "created",
    )
    expect(pelaSolucao).toContain(`💰 *Valor:* R$${NBSP}120,00`)
  })

  it("omite a linha de valor quando não há total nem itens com valor", () => {
    const msg = buildTicketMessage(
      { number: 1, status: "aberto", priority: "media", createdAt: CRIADO_EM },
      "created",
    )
    expect(msg).not.toContain("💰")
  })

  it("lista solicitante, contato, local e responsável quando existem", () => {
    const msg = buildTicketMessage(
      {
        number: 1,
        status: "aberto",
        priority: "media",
        creatorName: "Ana",
        guestContact: "11 99999-0000",
        location: "Matriz",
        assigneeName: "Técnico Bia",
        createdAt: CRIADO_EM,
      },
      "created",
    )
    expect(msg).toContain("👤 *Solicitante:* Ana")
    expect(msg).toContain("📞 *Contato:* 11 99999-0000")
    expect(msg).toContain("📍 *Local:* Matriz")
    expect(msg).toContain("🛠️ *Responsável:* Técnico Bia")
  })

  it("usa 'Sem descrição.' quando o chamado não tem descrição", () => {
    const msg = buildTicketMessage(
      { number: 1, status: "aberto", priority: "media", createdAt: CRIADO_EM },
      "created",
    )
    expect(msg).toContain("📝 *DESCRIÇÃO*")
    expect(msg).toContain("Sem descrição.")
  })

  it("trunca seções muito longas em 600 caracteres com reticências", () => {
    const descricao = "x".repeat(700)
    const msg = buildTicketMessage(
      {
        number: 1,
        description: descricao,
        status: "aberto",
        priority: "media",
        createdAt: CRIADO_EM,
      },
      "created",
    )
    expect(msg).toContain(`${"x".repeat(600)}…`)
    expect(msg).not.toContain("x".repeat(601))
  })

  it("escreve a situação do equipamento em linha própria", () => {
    const msg = buildTicketMessage(
      {
        number: 1,
        status: "aguardando",
        statusEquipamento: "Aguardando retirada",
        priority: "media",
        createdAt: CRIADO_EM,
      },
      "created",
    )
    expect(msg).toContain("*Situação:* *Aguardando retirada*")
  })

  it("formata a data no fuso local a partir de createdAt", () => {
    const msg = buildTicketMessage({ number: 1, status: "aberto", createdAt: CRIADO_EM }, "created")
    expect(msg).toMatch(/📅 Aberto em \d{2}\/\d{2}\/\d{4} às \d{2}:\d{2}$/)
  })
})
