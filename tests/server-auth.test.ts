/**
 * Testes do token de sessão.
 *
 * O que importa garantir aqui: o banco guarda hash (nunca o token em claro) e o
 * hash é estável — se ele mudasse entre gravação e leitura, ninguém conseguiria
 * usar uma sessão.
 */

import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { hashSessionToken } from "../server/api/auth"

describe("hashSessionToken", () => {
  it("é determinístico: o mesmo token gera sempre o mesmo hash", () => {
    const token = "a".repeat(64)
    expect(hashSessionToken(token)).toBe(hashSessionToken(token))
  })

  it("devolve 64 caracteres hexadecimais (mesmo tamanho da coluna CHAR(64))", () => {
    const hash = hashSessionToken("token-de-sessao")
    expect(hash).toHaveLength(64)
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("não devolve o token em claro", () => {
    const token = "b".repeat(64)
    expect(hashSessionToken(token)).not.toBe(token)
    expect(hashSessionToken(token)).not.toContain(token.slice(0, 16))
  })

  it("tokens diferentes geram hashes diferentes", () => {
    expect(hashSessionToken("token-1")).not.toBe(hashSessionToken("token-2"))
  })

  it("segue o SHA-256 padrão (vetor conhecido)", () => {
    expect(hashSessionToken("abc")).toBe(createHash("sha256").update("abc").digest("hex"))
    expect(hashSessionToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
  })

  it("tolera token vazio sem quebrar (a validação de formato é outra camada)", () => {
    expect(hashSessionToken("")).toHaveLength(64)
  })
})
