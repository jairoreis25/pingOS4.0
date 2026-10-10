/**
 * Testes do outbox: a parte pura (backoff e validação do payload).
 *
 * A entrega em si depende de banco e do worker; aqui garantimos que uma linha
 * corrompida nunca é entregue e que o backoff cresce com teto (um canal quebrado
 * não pode virar laço apertado).
 */

import { describe, expect, it } from "vitest"
import {
  MAX_ATTEMPTS,
  backoffMs,
  decodeJob,
  encodeJob,
  type OutboxPayload,
} from "../server/api/outbox"

describe("backoffMs", () => {
  it("cresce exponencialmente a partir de 5 s", () => {
    expect(backoffMs(1)).toBe(5_000)
    expect(backoffMs(2)).toBe(10_000)
    expect(backoffMs(3)).toBe(20_000)
    expect(backoffMs(4)).toBe(40_000)
  })

  it("tem teto de 5 minutos", () => {
    expect(backoffMs(7)).toBe(300_000)
    expect(backoffMs(20)).toBe(300_000)
  })

  it("trata tentativa inválida como a primeira", () => {
    expect(backoffMs(0)).toBe(5_000)
    expect(backoffMs(-3)).toBe(5_000)
    expect(backoffMs(Number.NaN)).toBe(5_000)
  })
})

describe("MAX_ATTEMPTS", () => {
  it("é um teto pequeno e positivo (não deixa canal quebrado em laço)", () => {
    expect(MAX_ATTEMPTS).toBeGreaterThan(1)
    expect(MAX_ATTEMPTS).toBeLessThanOrEqual(10)
  })
})

describe("payload do outbox", () => {
  const job: OutboxPayload = {
    kind: "external_dispatch",
    ticketId: "t1",
    subject: "Novo chamado #1",
    body: "corpo",
    emailRecipients: ["a@b.com"],
    whatsappRecipients: ["5511999999999"],
  }

  it("vai e volta preservando os campos", () => {
    expect(decodeJob(encodeJob(job))).toEqual({ ...job, ruleId: null })
  })

  it("aceita payload mínimo", () => {
    const minimo: OutboxPayload = {
      kind: "external_dispatch",
      ticketId: "t2",
      subject: "s",
      body: "b",
    }
    const decoded = decodeJob(encodeJob(minimo))

    expect(decoded?.ticketId).toBe("t2")
    expect(decoded?.emailRecipients).toBeUndefined()
  })

  it("recusa JSON inválido, valor vazio, não-objeto e tipo desconhecido", () => {
    expect(decodeJob("{")).toBeNull()
    expect(decodeJob("")).toBeNull()
    expect(decodeJob(null)).toBeNull()
    expect(decodeJob(42)).toBeNull()
    expect(decodeJob(JSON.stringify({ kind: "outra_coisa", ticketId: "t1" }))).toBeNull()
  })

  it("recusa payload sem campos obrigatórios", () => {
    expect(
      decodeJob(JSON.stringify({ kind: "external_dispatch", subject: "s", body: "b" })),
    ).toBeNull()
    expect(
      decodeJob(
        JSON.stringify({ kind: "external_dispatch", ticketId: "", subject: "s", body: "b" }),
      ),
    ).toBeNull()
    expect(
      decodeJob(JSON.stringify({ kind: "external_dispatch", ticketId: "t1", body: "b" })),
    ).toBeNull()
    expect(
      decodeJob(JSON.stringify({ kind: "external_dispatch", ticketId: "t1", subject: "s" })),
    ).toBeNull()
  })

  it("descarta destinatários que não são texto em vez de quebrar a entrega", () => {
    const decoded = decodeJob(
      JSON.stringify({
        kind: "external_dispatch",
        ticketId: "t1",
        subject: "s",
        body: "b",
        emailRecipients: ["ok@x.com", 42, null],
      }),
    )

    expect(decoded?.emailRecipients).toEqual(["ok@x.com"])
  })

  it("não carrega imagem no payload (o worker recarrega o chamado pelo id)", () => {
    const payload = JSON.parse(
      encodeJob({
        kind: "external_dispatch",
        ticketId: "t1",
        subject: "s",
        body: "b",
      }),
    ) as Record<string, unknown>

    expect(payload).not.toHaveProperty("image_url")
    expect(Object.keys(payload)).toEqual(["kind", "ticketId", "subject", "body"])
  })
})
