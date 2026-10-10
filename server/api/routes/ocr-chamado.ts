/**
 * Leitura de O.S. por foto — o "Nova OS por Foto" do dashboard.
 *
 * Recebe a foto da O.S. impressa (multipart, campo `imagem`), pede ao modelo de
 * VISÃO configurado em **Configurações → Bot Ping IA** para extrair os campos da
 * O.S. e abre o chamado já preenchido no `tickets`.
 *
 * Diferenças conscientes em relação à primeira versão desta rota (que mirava um
 * schema que não existe neste projeto):
 *   - usa `tickets` (com `guest_name`/`guest_contact`/`image_url`/`categoria`),
 *     não `clientes`/`chamados`/`chamado_anexos`/`audit_log`;
 *   - o número do chamado vem de `getNextNumber()` (a tabela `counters`), não de
 *     um `numero_os` de O.S.;
 *   - reaproveita o pool MySQL (`MYSQL_*`) em vez de `process.env.DATABASE_URL`;
 *   - fala com o provedor escolhido pelo administrador via `../ai-providers`
 *     (NVIDIA, OpenAI, Gemini, ...), em vez de fixar a NVIDIA;
 *   - datas em BIGINT (ms) e status/prioridade minúsculos.
 *
 * A rota é autenticada (é o dashboard que usa) e exige a permissão
 * `tickets.create` — a mesma que faz o botão aparecer na tela.
 */

import { Router } from "express"
import multer from "multer"
import { execute, newId, queryOne } from "../../mysql/pool"
import type { TicketRow } from "../types"
import { ApiError, asyncHandler, badRequest } from "../errors"
import { requirePermission } from "../permissions"
import { notifyTicketCreated } from "../notify"
import { getNextNumber } from "./tickets"
import { normalizeTicketCategory } from "../../../src/lib/ticket-categories"
import {
  aiChat,
  createAiClient,
  missingBaseUrl,
  providerLabel,
  providerSupportsVision,
  resolveProvider,
  resolveVisionModelFor,
} from "../ai-providers"

export const ocrChamadoRouter = Router()

/** Teto do arquivo enviado. O navegador já comprime para ≤ 2 MB. */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024

/**
 * Teto do data URL guardado em `image_url`. O `MEDIUMTEXT` aceita 16 MB, mas
 * uma imagem desse tamanho atrapalharia a leitura do chamado (a listagem do
 * Kanban omite `image_url`, o `GET /api/tickets/:id` não) — o mesmo limite que
 * `routes/tickets.ts` usa em `IMAGE_MAX_CHARS`.
 */
const IMAGE_MAX_CHARS = 3_000_000

/** Resultado da extração. Os nomes são os que o prompt pede ao modelo. */
interface DadosOs {
  numero_os: string | null
  solicitante: string | null
  fone: string | null
  descricao: string | null
  problemas: string | null
}

const CAMPOS_VAZIOS: DadosOs = {
  numero_os: null,
  solicitante: null,
  fone: null,
  descricao: null,
  problemas: null,
}

const PROMPT_EXTRACAO = `Você é um extrator de dados de Ordens de Serviço (O.S.) impressas.

Analise a imagem e extraia APENAS estes 5 campos. Retorne um JSON válido, SEM markdown, SEM explicação:

{
  "numero_os": "número da O.S. (apenas dígitos)",
  "solicitante": "nome completo em MAIÚSCULAS",
  "fone": "telefone apenas com dígitos",
  "descricao": "conteúdo do campo Descrição (ex: 'NOTEBOOK PRETO C/ FONTE')",
  "problemas": "conteúdo do campo PROBLEMAS (ex: 'REPARO NA CARCAÇA / NÃO ENTRA NO WINDOWS.')"
}

REGRAS:
- Retorne SOMENTE o JSON.
- Se um campo não for encontrado, retorne null.
- NÃO inclua CNPJ, endereço, atendente, datas, preços, assinaturas.
- Mantenha MAIÚSCULAS como no original.`

// ── Upload ──────────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    // Só o que um modelo de visão aceita de verdade.
    if (!/^image\/(png|jpe?g|webp)$/i.test(file.mimetype)) {
      cb(badRequest("Envie uma foto PNG, JPG ou WEBP."))
      return
    }
    cb(null, true)
  },
})

/** `upload.single` com os erros do multer traduzidos para mensagens da API. */
function uploadFoto(
  req: import("express").Request,
  res: import("express").Response,
  next: import("express").NextFunction,
) {
  upload.single("imagem")(req, res, (error) => {
    if (!error) {
      next()
      return
    }
    if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
      next(badRequest("A foto é grande demais. Envie uma imagem menor."))
      return
    }
    next(error)
  })
}

// ── Extração ────────────────────────────────────────────────────────────────

/** Texto do data URL da imagem enviada. */
function dataUrlDaImagem(buffer: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${buffer.toString("base64")}`
}

/**
 * Pede ao modelo de visão do provedor configurado que leia os campos da O.S.
 *
 * A chave vem da `bot_config` (coluna herdada `nvidia_api_key`), não do
 * ambiente — é o mesmo valor que o dashboard (Configurações → Bot Ping IA)
 * grava e que o `hermes/bot-ia.ts` usa.
 */
async function extrairOsDaImagem(buffer: Buffer, mimeType: string): Promise<DadosOs> {
  const row = await queryOne<{
    nvidia_api_key: string | null
    provider: string | null
    base_url: string | null
    modelo_visao: string | null
  }>(
    "SELECT `nvidia_api_key`, `provider`, `base_url`, `modelo_visao` FROM `bot_config` WHERE `id` = 1",
  )

  const provider = resolveProvider(row?.provider).id
  const label = providerLabel(provider)
  const apiKey = (row?.nvidia_api_key ?? "").trim()
  if (!apiKey) {
    throw badRequest(
      `Configure a chave do provedor de IA (${label}) em Configurações → Bot Ping IA.`,
    )
  }
  if (missingBaseUrl(provider, row?.base_url)) {
    throw badRequest("Informe a URL base do provedor de IA em Configurações → Bot Ping IA.")
  }
  if (!providerSupportsVision(provider)) {
    throw badRequest(
      `O provedor ${label} não lê imagens. Escolha um provedor com visão ` +
        "(ex.: NVIDIA) em Configurações → Bot Ping IA.",
    )
  }
  const modelo = resolveVisionModelFor(provider, row?.modelo_visao)
  if (!modelo) {
    throw badRequest(
      `Nenhum modelo de visão configurado para ${label}. Defina um em ` +
        "Configurações → Bot Ping IA.",
    )
  }

  const client = createAiClient({ provider, apiKey, baseUrl: row?.base_url })

  let resposta
  try {
    resposta = await aiChat(
      client,
      {
        model: modelo,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT_EXTRACAO },
              {
                type: "image_url",
                image_url: { url: dataUrlDaImagem(buffer, mimeType) },
              },
            ],
          },
        ],
        max_tokens: 500,
        temperature: 0.1,
      },
      { provider, timeoutMs: 90_000 },
    )
  } catch (error) {
    const detalhe = error instanceof Error ? error.message : String(error)
    throw new ApiError(502, `A IA (${label}) não conseguiu ler a foto: ${detalhe}`)
  }

  const conteudo = resposta.choices[0]?.message?.content
  const texto = typeof conteudo === "string" ? conteudo : ""
  const limpo = texto.replace(/```json\n?|```/g, "").trim()

  // O modelo às vezes embrulha o JSON em texto: tenta o todo e, se falhar, o
  // primeiro bloco `{...}` que aparecer.
  const bruto = limpo.match(/\{[\s\S]*\}/)?.[0] ?? limpo

  try {
    const parsed = JSON.parse(bruto) as Partial<DadosOs>
    return {
      numero_os: parsed.numero_os ?? null,
      solicitante: parsed.solicitante ?? null,
      fone: parsed.fone ?? null,
      descricao: parsed.descricao ?? null,
      problemas: parsed.problemas ?? null,
    }
  } catch {
    // O modelo devolveu algo que não é JSON: segue como "não identificado" e a
    // rota responde 422 com a orientação de tirar outra foto.
    return { ...CAMPOS_VAZIOS }
  }
}

/** Categoria interna do chamado a partir do texto da O.S. */
function detectarCategoria(descricao: string | null, problemas: string | null): string {
  const texto = `${descricao ?? ""} ${problemas ?? ""}`.toUpperCase()
  if (/NOTEBOOK|LAPTOP/.test(texto)) return "Notebooks"
  if (/IMPRESSORA|EPSON|CANON|BROTHER|\bHP\b/.test(texto)) return "Impressoras"
  if (/\bPC\b|COMPUTADOR|DESKTOP|\bCPU\b/.test(texto)) return "Computadores"
  if (/WINDOWS|OFFICE|SISTEMA|PROGRAMA|SOFTWARE|DRIVER/.test(texto)) return "Softwares"
  return "Suporte"
}

/** Texto opcional vindo do formulário (multipart), com tamanho limitado. */
function textoDoCorpo(value: unknown, maxLength: number): string | null {
  if (value === undefined || value === null) return null
  const trimmed = String(value).trim()
  if (!trimmed) return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

// ── POST /ocr — lê a foto da O.S. e abre o chamado ──────────────────────────
ocrChamadoRouter.post(
  "/ocr",
  uploadFoto,
  asyncHandler(async (req, res) => {
    // Quem abre por foto é o técnico logado no dashboard (mesma permissão do
    // botão "Novo chamado"/"Nova OS por Foto").
    const ctx = requirePermission(req, "tickets.create")

    const file = req.file
    if (!file) throw badRequest("Nenhuma imagem enviada.")

    const imageUrl = dataUrlDaImagem(file.buffer, file.mimetype)
    if (imageUrl.length > IMAGE_MAX_CHARS) {
      throw badRequest("A imagem é grande demais. Envie uma imagem menor.")
    }

    const dados = await extrairOsDaImagem(file.buffer, file.mimetype)

    const numeroOs = (dados.numero_os ?? "").replace(/\D/g, "")
    const solicitante = (dados.solicitante ?? "").trim()
    if (!solicitante && !numeroOs) {
      throw new ApiError(
        422,
        "Não foi possível identificar a O.S. na imagem. Tente outra foto, mais próxima e com boa luz.",
      )
    }

    const categoria = normalizeTicketCategory(detectarCategoria(dados.descricao, dados.problemas))

    // Mapeamento pedido: o campo "Descrição" da O.S. vira o TÍTULO do chamado e
    // o campo "PROBLEMAS" vira a DESCRIÇÃO.
    const title = (dados.descricao || (numeroOs ? `O.S. ${numeroOs}` : "") || "Chamado via foto")
      .trim()
      .slice(0, 200)
    const description =
      (dados.problemas ?? "").trim().slice(0, 5000) || "Sem descrição de problemas."

    // Solicitante/contato vêm da própria O.S.; o formulário serve de reserva
    // quando a foto não traz o telefone (o nome do usuário logado não substitui
    // o do cliente, então só usamos o contato informado como fallback).
    const guestName = solicitante || textoDoCorpo(req.body?.guestName, 120)
    const guestContact =
      (dados.fone ?? "").replace(/\D/g, "") || textoDoCorpo(req.body?.guestContact, 160)

    const now = Date.now()
    const number = await getNextNumber()
    const id = newId()

    await execute(
      `INSERT INTO \`tickets\`
         (\`id\`, \`number\`, \`title\`, \`description\`, \`status\`, \`priority\`,
          \`creator_id\`, \`guest_name\`, \`guest_contact\`, \`image_url\`, \`os\`,
          \`categoria\`, \`location\`, \`created_at\`, \`updated_at\`)
       VALUES (?, ?, ?, ?, 'aberto', 'media', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        number,
        title,
        description,
        ctx.user.id,
        guestName,
        guestContact,
        imageUrl,
        numeroOs || null,
        categoria,
        textoDoCorpo(req.body?.location, 200),
        now,
        now,
      ],
    )

    // Avisa a equipe (sino + canais externos) sem atrasar a resposta.
    const created = await queryOne<TicketRow>("SELECT * FROM `tickets` WHERE `id` = ?", [id])
    if (created) void notifyTicketCreated(created, ctx.user.id)

    res.status(201).json({
      ok: true,
      ticketId: id,
      id,
      number,
      // Mantido por compatibilidade com o cliente que já consumia esta rota.
      chamado_id: number,
      dados_extraidos: dados,
      categoria_detectada: categoria,
    })
  }),
)
