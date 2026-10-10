/**
 * Personalidades do bot "Ping IA" — espelha a seção Personalidades da aba
 * Configurações → Bot Ping IA.
 *
 *   GET    /api/admin/bot-personalidades              (os 4 slots)
 *   PUT    /api/admin/bot-personalidades/:slot        (grava nome/emoji/prompt)
 *   POST   /api/admin/bot-personalidades/:slot/ativar (ativa um e desativa os outros)
 *   POST   /api/admin/bot-personalidades/desativar-todas
 *
 * O slot 1 é o **Padrão fixo**: nome, emoji e system prompt vêm do código
 * (`DEFAULT_SYSTEM_PROMPT` em `hermes/bot-ia.ts`) e o `PUT` recusa editá-lo
 * (403) — o bloqueio é do servidor, não só da tela. Ele ainda pode ser
 * ativado/desativado normalmente para voltar ao comportamento padrão.
 *
 * No máximo um slot fica ativo por vez: a ativação roda numa transação que
 * desliga todos antes de ligar o escolhido.
 *
 * Todas as rotas exigem administrador (`requireAdmin`).
 */

import { Router } from "express"
import { execute, query, withTransaction } from "../../mysql/pool"
import { asyncHandler, badRequest, notFound } from "../errors"
import { requireAdmin } from "../permissions"

export const botPersonalidadesRouter = Router()

interface PersonalidadeRow {
  id: number
  slot: number
  nome: string
  emoji: string | null
  system_prompt: string | null
  fixo: number
  ativo: number
  updated_at: string | null
}

/** Formato que o componente `BotPersonalidades.tsx` consome. */
function toPersonalidade(row: PersonalidadeRow) {
  return {
    id: row.id,
    slot: row.slot,
    nome: row.nome,
    emoji: row.emoji ?? "🤖",
    // O prompt do slot fixo nunca vai para o cliente: quem manda nele é o código.
    system_prompt: row.fixo === 1 ? "" : (row.system_prompt ?? ""),
    fixo: row.fixo,
    ativo: row.ativo,
    updatedAt: row.updated_at,
  }
}

/** Lê os 4 slots na ordem (o seed da migração garante que existem). */
async function readSlots(): Promise<PersonalidadeRow[]> {
  return query<PersonalidadeRow>(
    "SELECT `id`, `slot`, `nome`, `emoji`, `system_prompt`, `fixo`, `ativo`, `updated_at`\n" +
      "  FROM `bot_personalidades` ORDER BY `slot` ASC",
  )
}

/** Converte o `:slot` da URL em número inteiro, ou lança 400. */
function parseSlot(raw: string | string[]): number {
  const slot = Number.parseInt(String(raw), 10)
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
    throw badRequest("Slot inválido: use um número de 1 a 4.")
  }
  return slot
}

// ── GET /api/admin/bot-personalidades ───────────────────────────────────────
botPersonalidadesRouter.get(
  "/bot-personalidades",
  asyncHandler(async (req, res) => {
    requireAdmin(req)
    const rows = await readSlots()
    res.json(rows.map(toPersonalidade))
  }),
)

// ── PUT /api/admin/bot-personalidades/:slot ─────────────────────────────────
// O slot 1 (Padrão) é fixo: recusa com 403 e a mensagem que o componente exibe.
// Nos editáveis, nome/emoji vazios mantêm o valor atual (COALESCE(NULLIF(...))),
// e o `system_prompt` vazio volta ao prompt padrão (grava NULL).
botPersonalidadesRouter.put(
  "/bot-personalidades/:slot",
  asyncHandler(async (req, res) => {
    requireAdmin(req)
    const slot = parseSlot(req.params.slot)

    if (slot === 1) {
      const mensagem = "O slot Padrão é fixo e não pode ser editado."
      // `erro` é o campo que o componente lê; `message` mantém o formato das
      // demais rotas (é o que o cliente HTTP usa para montar o texto do erro).
      res.status(403).json({ erro: mensagem, message: mensagem })
      return
    }

    const body = (req.body ?? {}) as Record<string, unknown>
    const nome = String(body.nome ?? "").trim()
    const emoji = String(body.emoji ?? "").trim()
    const systemPrompt = String(body.system_prompt ?? "")

    if (nome.length > 50) {
      throw badRequest("O nome da personalidade deve ter no máximo 50 caracteres.")
    }
    if (emoji.length > 10) {
      throw badRequest("O emoji da personalidade deve ter no máximo 10 caracteres.")
    }
    if (systemPrompt.length > 8000) {
      throw badRequest("O system prompt deve ter no máximo 8000 caracteres.")
    }

    await execute(
      "UPDATE `bot_personalidades` SET\n" +
        "    `nome` = COALESCE(NULLIF(?, ''), `nome`),\n" +
        "    `emoji` = COALESCE(NULLIF(?, ''), `emoji`),\n" +
        "    `system_prompt` = ?\n" +
        "  WHERE `slot` = ? AND `fixo` = 0",
      [nome, emoji, systemPrompt.trim() || null, slot],
    )

    const rows = await query<PersonalidadeRow>(
      "SELECT `id`, `slot`, `nome`, `emoji`, `system_prompt`, `fixo`, `ativo`, `updated_at`\n" +
        "  FROM `bot_personalidades` WHERE `slot` = ? LIMIT 1",
      [slot],
    )
    const salva = rows[0]
    if (!salva) throw notFound("Personalidade não encontrada.")
    res.json(toPersonalidade(salva))
  }),
)

// ── POST /api/admin/bot-personalidades/:slot/ativar ─────────────────────────
// Permitido para qualquer slot, inclusive o 1 (voltar ao padrão). A transação
// desliga todos antes de ligar o escolhido — só um fica ativo por vez.
botPersonalidadesRouter.post(
  "/bot-personalidades/:slot/ativar",
  asyncHandler(async (req, res) => {
    requireAdmin(req)
    const slot = parseSlot(req.params.slot)

    const existe = await query<{ slot: number }>(
      "SELECT `slot` FROM `bot_personalidades` WHERE `slot` = ? LIMIT 1",
      [slot],
    )
    if (existe.length === 0) throw notFound("Personalidade não encontrada.")

    await withTransaction(async (conn) => {
      await conn.execute("UPDATE `bot_personalidades` SET `ativo` = 0")
      await conn.execute("UPDATE `bot_personalidades` SET `ativo` = 1 WHERE `slot` = ?", [slot])
    })

    const rows = await readSlots()
    res.json(rows.map(toPersonalidade))
  }),
)

// ── POST /api/admin/bot-personalidades/desativar-todas ──────────────────────
// Volta o agente ao prompt padrão do código sem apagar nenhuma personalidade.
botPersonalidadesRouter.post(
  "/bot-personalidades/desativar-todas",
  asyncHandler(async (req, res) => {
    requireAdmin(req)
    await execute("UPDATE `bot_personalidades` SET `ativo` = 0")
    const rows = await readSlots()
    res.json(rows.map(toPersonalidade))
  }),
)
