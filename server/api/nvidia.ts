/**
 * Catálogo de modelos da NVIDIA usado pelo Ping IA.
 *
 * Os IDs ficam num lugar só de propósito: a NVIDIA aposenta modelos sem aviso
 * (a API passa a responder **410 Gone** e o modelo nunca mais volta). Quando
 * isso acontece, basta trocar `DEFAULT_MODEL` aqui — o bot (`hermes/bot-ia.ts`)
 * e as rotas de configuração (`server/api/routes/bot-config.ts`) importam
 * daqui, então não há como um deles ficar apontando para um modelo morto.
 */

import OpenAI from "openai"

/** Endpoint compatível com a API da OpenAI (o SDK aponta para cá). */
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1"

/**
 * Modelo usado quando o dashboard não define um.
 *
 * Atenção: `meta/llama-3.3-70b-instruct` (o padrão antigo) foi aposentado em
 * 2026-08-26 e hoje responde 410 Gone — não volte para ele.
 */
export const DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b"

/** Sugestões mostradas primeiro no dropdown do dashboard. */
export const SUGGESTED_MODELS = [
  "nvidia/nemotron-3-super-120b-a12b",
  "nvidia/nemotron-3.5-lightning-30b-a3b",
  "nvidia/nemotron-3-ultra-550b-a55b",
]

/**
 * Modelo de **visão** usado para ler fotos de O.S. impressas.
 *
 * É um campo separado do modelo de texto (`modelo`) porque as duas tarefas não
 * são a mesma: o agente conversa (texto) e, quando chega uma foto, precisa de um
 * modelo que aceite `image_url` no conteúdo da mensagem. Os IDs que o "senso
 * comum" sugere para OCR (llama-3.2-*-vision, phi-3.5-vision) são de 2024 e a
 * NVIDIA já não mantém essa linha — hoje quem lê documento/imagem é a família
 * Nemotron (Omni/Parse).
 *
 * O NIM `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` aceita imagem em
 * base64 (`data:image/jpeg;base64,...`) e é o padrão aqui. É um modelo de
 * raciocínio — o `enable_thinking: false` do `nvidiaChat` também se aplica.
 */
export const DEFAULT_VISION_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning"

/**
 * Sugestões iniciais do dropdown de visão. Só o padrão: `nemotron-parse` tem
 * saída própria de parsing (não é chat JSON) e confundiria a extração — o resto
 * da lista vem do catálogo vivo da conta NVIDIA.
 */
export const VISION_SUGGESTED_MODELS = [DEFAULT_VISION_MODEL]

/**
 * Normaliza o modelo de visão: vazio vira o padrão. Diferente do texto, aqui
 * **não** existe lista de aposentados: o catálogo de visão muda rápido (Omni,
 * Parse, VL) e o valor salvo pelo administrador é respeitado como está — quem
 * valida de verdade é o teste de visão no dashboard.
 */
export function resolveVisionModel(model: string | null | undefined): string {
  const value = (model ?? "").trim()
  return value || DEFAULT_VISION_MODEL
}

/** IDs que a NVIDIA já aposentou (410 Gone) e que não podem mais ser usados. */
const RETIRED_MODELS = new Set([
  "meta/llama-3.3-70b-instruct",
  "meta/llama-3.1-70b-instruct",
  "meta/llama-4-maverick-17b-128e-instruct",
  "nvidia/llama-3.3-nemotron-super-49b-v1.5",
  "nvidia/nemotron-3-nano-30b-a3b",
  "nvidia/nvidia-nemotron-nano-9b-v2",
  "nvidia/nemotron-nano-12b-v2-vl",
])

/** `true` se a NVIDIA já aposentou este modelo. */
export function isRetiredModel(model: string | null | undefined): boolean {
  return RETIRED_MODELS.has((model ?? "").trim())
}

/**
 * Normaliza o modelo vindo do banco/formulário: vazio ou aposentado viram o
 * padrão atual. É o que faz uma configuração antiga (apontando para o
 * llama-3.3) se curar sozinha ao ser lida, sem o administrador mexer em nada.
 */
export function resolveModel(model: string | null | undefined): string {
  const value = (model ?? "").trim()
  if (!value || isRetiredModel(value)) return DEFAULT_MODEL
  return value
}

/** Corpo da chamada de chat, com o parâmetro extra aceito pela NVIDIA. */
type NvidiaChatParams = OpenAI.ChatCompletionCreateParamsNonStreaming & {
  chat_template_kwargs?: { enable_thinking?: boolean }
}

/**
 * Chamada de chat na NVIDIA com o raciocínio desligado.
 *
 * Os modelos da família Nemotron 3 (os que sobraram no lugar do Llama 3.3)
 * "pensam" antes de responder: com um teto de tokens baixo o raciocínio
 * consome o orçamento inteiro, o `finish_reason` vira `length` e o `content`
 * chega **vazio** — o que parecia um modelo quebrado ou sem conexão.
 * `enable_thinking: false` desliga isso. Se o modelo recusar o parâmetro extra
 * (400/422), a chamada é repetida sem ele.
 */
export async function nvidiaChat(
  client: OpenAI,
  params: NvidiaChatParams,
  options: { timeoutMs?: number } = {},
): Promise<OpenAI.ChatCompletion> {
  const timeout = options.timeoutMs ?? 60_000
  const body: NvidiaChatParams = {
    ...params,
    chat_template_kwargs: { enable_thinking: false },
  }

  try {
    return await client.chat.completions.create(body, { timeout })
  } catch (error) {
    const status = (error as { status?: number }).status
    if (status !== 400 && status !== 422) throw error
    return client.chat.completions.create(params, { timeout })
  }
}

/** Texto da resposta, caindo para o `reasoning_content` se o `content` vier vazio. */
export function extractText(message: OpenAI.ChatCompletionMessage): string {
  const content = (message.content ?? "")
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "")
    .trim()
  if (content) return content

  const reasoning = (message as { reasoning_content?: string }).reasoning_content
  return reasoning?.trim() ?? ""
}
