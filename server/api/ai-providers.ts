/**
 * Catálogo de provedores de IA do Ping IA.
 *
 * O agente nasceu falando só com a NVIDIA (`build.nvidia.com`), mas hoje quase
 * todo provedor de LLM expõe um endpoint **compatível com a API da OpenAI**:
 * basta trocar a URL base e a chave. Este módulo guarda, num lugar só, o que
 * muda de provedor para provedor — URL base, rótulo da chave, catálogo
 * sugerido e os modelos padrão de texto e de visão — e o chat genérico que o
 * bot (`hermes/bot-ia.ts`) e as rotas do dashboard usam.
 *
 * A NVIDIA continua sendo o padrão (é o provedor que o PingOS usa em produção e
 * o único com catálogo de visão próprio), então uma configuração antiga segue
 * funcionando sem o administrador mexer em nada: `resolveProvider` devolve a
 * NVIDIA para qualquer valor desconhecido/vazio.
 *
 * A **chave continua guardada na coluna `nvidia_api_key`** (nome herdado da
 * época em que só existia NVIDIA): renomear a coluna exigiria migrar o segredo
 * de todo mundo sem ganho nenhum. O que a coluna guarda agora é a chave do
 * provedor escolhido em `provider`.
 */

import OpenAI from "openai";
import {
  DEFAULT_MODEL as NVIDIA_DEFAULT_MODEL,
  DEFAULT_VISION_MODEL as NVIDIA_DEFAULT_VISION_MODEL,
  nvidiaChat,
  resolveModel as resolveNvidiaModel,
  resolveVisionModel as resolveNvidiaVisionModel,
  SUGGESTED_MODELS as NVIDIA_SUGGESTED_MODELS,
  VISION_SUGGESTED_MODELS as NVIDIA_VISION_SUGGESTED_MODELS,
} from "./nvidia";

export interface AiProvider {
  /** Identificador gravado em `bot_config.provider`. */
  id: string;
  /** Nome mostrado no dropdown do dashboard. */
  label: string;
  /** URL base do endpoint compatível com a OpenAI. */
  baseUrl: string;
  /** Rótulo do campo da chave ("OpenAI API Key"). */
  apiKeyLabel: string;
  /** Placeholder do campo (o prefixo da chave, quando o provedor usa um). */
  apiKeyHint: string;
  /** Onde o administrador cria a chave. */
  docsUrl: string;
  /** Modelo de texto usado quando o dashboard não define nenhum. */
  defaultModel: string;
  suggestedModels: string[];
  /** Modelo multimodal padrão — `null` quando o provedor não lê imagem. */
  defaultVisionModel: string | null;
  visionSuggestedModels: string[];
  /**
   * `true` só na NVIDIA: lá os modelos de raciocínio (Nemotron 3) precisam do
   * parâmetro extra `chat_template_kwargs` para não gastar o orçamento de
   * tokens "pensando" e devolver texto vazio.
   */
  thinkingParam?: boolean;
  /** Cabeçalhos padrão da chamada (o OpenRouter usa para atribuir o app). */
  headers?: Record<string, string>;
  /** Teto do catálogo vivo mostrado no dropdown (OpenRouter tem 500+ IDs). */
  catalogLimit?: number;
  /** `true` quando a URL base pode ser editada (servidor próprio, Azure...). */
  customBaseUrl?: boolean;
  /** Linha de ajuda embaixo do campo no dashboard. */
  hint?: string;
}

/**
 * Ordem em que os provedores aparecem no dashboard. A NVIDIA vem primeiro
 * porque é o padrão e o que o PingOS usa em produção.
 *
 * Os modelos de cada provedor são só **sugestões**: o dropdown é alimentado
 * pelo catálogo vivo (`GET /v1/models`) e o administrador pode digitar qualquer
 * ID — trocar de modelo não deve depender de recompilar o PingOS.
 */
export const PROVIDERS: AiProvider[] = [
  {
    id: "nvidia",
    label: "NVIDIA (build.nvidia.com)",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKeyLabel: "NVIDIA API Key",
    apiKeyHint: "nvapi-...",
    docsUrl: "build.nvidia.com",
    defaultModel: NVIDIA_DEFAULT_MODEL,
    suggestedModels: NVIDIA_SUGGESTED_MODELS,
    defaultVisionModel: NVIDIA_DEFAULT_VISION_MODEL,
    visionSuggestedModels: NVIDIA_VISION_SUGGESTED_MODELS,
    thinkingParam: true,
    hint: "Obtenha em build.nvidia.com → API Keys.",
  },
  {
    id: "openai",
    label: "OpenAI (api.openai.com)",
    baseUrl: "https://api.openai.com/v1",
    apiKeyLabel: "OpenAI API Key",
    apiKeyHint: "sk-...",
    docsUrl: "platform.openai.com/api-keys",
    defaultModel: "gpt-4o-mini",
    suggestedModels: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
    defaultVisionModel: "gpt-4o-mini",
    visionSuggestedModels: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
    hint: "Obtenha em platform.openai.com → API keys.",
  },
  {
    id: "google",
    label: "Google Gemini (AI Studio)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyLabel: "Google AI Studio API Key",
    apiKeyHint: "AIza...",
    docsUrl: "aistudio.google.com/apikey",
    defaultModel: "gemini-2.5-flash",
    suggestedModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    defaultVisionModel: "gemini-2.5-flash",
    visionSuggestedModels: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"],
    hint:
      "Obtenha em aistudio.google.com → Get API key. O PingOS usa o endpoint " +
      "compatível com a OpenAI do Gemini.",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    baseUrl: "https://api.anthropic.com/v1/",
    apiKeyLabel: "Anthropic API Key",
    apiKeyHint: "sk-ant-...",
    docsUrl: "console.anthropic.com/settings/keys",
    defaultModel: "claude-sonnet-4-5",
    suggestedModels: ["claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1"],
    defaultVisionModel: "claude-sonnet-4-5",
    visionSuggestedModels: ["claude-sonnet-4-5", "claude-haiku-4-5"],
    hint:
      "Obtenha em console.anthropic.com → API keys. Usa o endpoint compatível " +
      "com a OpenAI da Anthropic.",
  },
  {
    id: "groq",
    label: "Groq (groq.com)",
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyLabel: "Groq API Key",
    apiKeyHint: "gsk_...",
    docsUrl: "console.groq.com/keys",
    defaultModel: "llama-3.3-70b-versatile",
    suggestedModels: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "openai/gpt-oss-120b",
    ],
    defaultVisionModel: "meta-llama/llama-4-scout-17b-16e-instruct",
    visionSuggestedModels: ["meta-llama/llama-4-scout-17b-16e-instruct"],
    hint: "Obtenha em console.groq.com → API Keys. Tem cota gratuita.",
  },
  {
    id: "openrouter",
    label: "OpenRouter (openrouter.ai)",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyLabel: "OpenRouter API Key",
    apiKeyHint: "sk-or-...",
    docsUrl: "openrouter.ai/keys",
    defaultModel: "openai/gpt-4o-mini",
    suggestedModels: [
      "openai/gpt-4o-mini",
      "anthropic/claude-sonnet-4.5",
      "google/gemini-2.5-flash",
      "meta-llama/llama-3.3-70b-instruct",
    ],
    defaultVisionModel: "openai/gpt-4o-mini",
    visionSuggestedModels: ["openai/gpt-4o-mini", "google/gemini-2.5-flash"],
    headers: { "X-Title": "PingOS" },
    // O catálogo do OpenRouter passa de 500 IDs: o dropdown fica inutilizável
    // inteiro, então mostramos só o começo e o administrador digita o resto.
    catalogLimit: 200,
    hint:
      "Um provedor, centenas de modelos (inclusive gratuitos). Obtenha em " +
      "openrouter.ai → Keys.",
  },
  {
    id: "deepseek",
    label: "DeepSeek (deepseek.com)",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyLabel: "DeepSeek API Key",
    apiKeyHint: "sk-...",
    docsUrl: "platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
    suggestedModels: ["deepseek-chat", "deepseek-reasoner"],
    // Sem modelo multimodal: a leitura de fotos de O.S. fica indisponível e o
    // dashboard avisa (o bot continua funcionando por texto).
    defaultVisionModel: null,
    visionSuggestedModels: [],
    hint: "Obtenha em platform.deepseek.com → API keys. Não lê imagens.",
  },
  {
    id: "mistral",
    label: "Mistral (mistral.ai)",
    baseUrl: "https://api.mistral.ai/v1",
    apiKeyLabel: "Mistral API Key",
    apiKeyHint: "...",
    docsUrl: "console.mistral.ai/api-keys",
    defaultModel: "mistral-large-latest",
    suggestedModels: ["mistral-large-latest", "mistral-small-latest"],
    defaultVisionModel: "pixtral-large-latest",
    visionSuggestedModels: ["pixtral-large-latest"],
    hint: "Obtenha em console.mistral.ai → API Keys.",
  },
  {
    id: "custom",
    label: "Outro (compatível com OpenAI)",
    baseUrl: "",
    apiKeyLabel: "API Key do provedor",
    apiKeyHint: "cole a chave do provedor",
    docsUrl: "",
    // Sem catálogo nem padrão: quem usa servidor próprio (vLLM, LM Studio,
    // Azure, Ollama...) informa a URL base e digita o ID do modelo.
    defaultModel: "",
    suggestedModels: [],
    defaultVisionModel: null,
    visionSuggestedModels: [],
    customBaseUrl: true,
    hint:
      "Qualquer endpoint compatível com a OpenAI (/chat/completions). " +
      "Informe a URL base e digite o ID do modelo.",
  },
];

/** Provedor padrão (o que uma configuração antiga/vazia recebe). */
export const DEFAULT_PROVIDER = "nvidia";

const BY_ID = new Map(PROVIDERS.map((provider) => [provider.id, provider]));

/** Provedor pelo id, ou `null` se não existir no catálogo. */
export function getProvider(id: string | null | undefined): AiProvider | null {
  const key = (id ?? "").trim().toLowerCase();
  return BY_ID.get(key) ?? null;
}

/** Nunca falha: id desconhecido ou vazio cai no provedor padrão (NVIDIA). */
export function resolveProvider(id: string | null | undefined): AiProvider {
  return getProvider(id) ?? BY_ID.get(DEFAULT_PROVIDER)!;
}

/** Nome do provedor para mensagens ("NVIDIA", "OpenAI"...). */
export function providerLabel(id: string | null | undefined): string {
  return resolveProvider(id).label.split(" (")[0];
}

/**
 * URL base da chamada: a informada pelo administrador vence (é o que permite
 * Azure, LM Studio, vLLM...), depois a do catálogo.
 */
export function resolveBaseUrl(
  provider: string | null | undefined,
  baseUrl: string | null | undefined,
): string {
  const custom = (baseUrl ?? "").trim();
  if (custom) return custom.replace(/\/+$/, "");
  return resolveProvider(provider).baseUrl;
}

/**
 * Modelo de texto: vazio vira o padrão do provedor e, na NVIDIA, um ID
 * aposentado se cura sozinho (`resolveModel`). Nos outros provedores o valor
 * salvo é respeitado como está — só o `Testar` do dashboard valida de verdade.
 */
export function resolveModelFor(
  provider: string | null | undefined,
  model: string | null | undefined,
): string {
  if (resolveProvider(provider).id === DEFAULT_PROVIDER) {
    return resolveNvidiaModel(model);
  }
  return (model ?? "").trim() || resolveProvider(provider).defaultModel;
}

/**
 * Modelo de visão: vazio vira o padrão multimodal do provedor. Devolve `""`
 * quando o provedor escolhido não lê imagem (aí a linha de "Modelo de visão"
 * some do dashboard e o bot avisa que a foto de O.S. está indisponível).
 */
export function resolveVisionModelFor(
  provider: string | null | undefined,
  model: string | null | undefined,
): string {
  const info = resolveProvider(provider);
  const value = (model ?? "").trim();
  if (value) return info.id === DEFAULT_PROVIDER ? resolveNvidiaVisionModel(value) : value;
  return info.defaultVisionModel ?? "";
}

/** `true` quando o provedor tem (ou aceita) modelo de visão. */
export function providerSupportsVision(provider: string | null | undefined): boolean {
  return Boolean(resolveProvider(provider).defaultVisionModel);
}

/**
 * Cliente do provedor escolhido. O SDK da OpenAI é reaproveitado porque todos
 * os endpoints do catálogo falam o mesmo dialeto.
 */
export function createAiClient(options: {
  provider?: string | null;
  apiKey: string;
  baseUrl?: string | null;
}): OpenAI {
  const info = resolveProvider(options.provider);
  const baseURL = resolveBaseUrl(info.id, options.baseUrl);
  return new OpenAI({
    apiKey: options.apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(info.headers ? { defaultHeaders: info.headers } : {}),
  });
}

/** `true` quando `base_url` está em branco num provedor que exige a URL. */
export function missingBaseUrl(
  provider: string | null | undefined,
  baseUrl: string | null | undefined,
): boolean {
  const info = resolveProvider(provider);
  return Boolean(info.customBaseUrl) && !(baseUrl ?? "").trim();
}

/** Corpo da chamada de chat, com o parâmetro extra aceito pela NVIDIA. */
type AiChatParams = OpenAI.ChatCompletionCreateParamsNonStreaming & {
  chat_template_kwargs?: { enable_thinking?: boolean };
};

/**
 * Chamada de chat no provedor escolhido.
 *
 * Na NVIDIA passa pelo `nvidiaChat` (que desliga o raciocínio dos Nemotron 3 e
 * repete a chamada sem o parâmetro extra se o modelo recusar). Nos demais, a
 * chamada é direta — o corpo deles não conhece `chat_template_kwargs`.
 */
export async function aiChat(
  client: OpenAI,
  params: AiChatParams,
  options: { provider?: string | null; timeoutMs?: number } = {},
): Promise<OpenAI.ChatCompletion> {
  const timeout = options.timeoutMs ?? 60_000;
  if (resolveProvider(options.provider).id === DEFAULT_PROVIDER) {
    return nvidiaChat(client, params, { timeoutMs: options.timeoutMs });
  }
  const body = { ...params } as AiChatParams;
  delete body.chat_template_kwargs;
  try {
    return await client.chat.completions.create(body, { timeout });
  } catch (error) {
    // Os modelos mais novos da OpenAI (família o/gpt-5) recusam `max_tokens` e
    // exigem `max_completion_tokens`: em vez de devolver um 400 confuso para o
    // administrador, a chamada é repetida com o nome novo do parâmetro.
    const status = (error as { status?: number }).status;
    const mensagem = String((error as { message?: string }).message ?? "");
    if (status !== 400 || !/max_tokens/i.test(mensagem)) throw error;
    if (body.max_completion_tokens || !body.max_tokens) throw error;
    const { max_tokens } = body;
    console.warn(
      `[ai] o modelo ${body.model} recusou max_tokens — repetindo com max_completion_tokens.`,
    );
    return client.chat.completions.create(
      { ...body, max_tokens: undefined, max_completion_tokens: max_tokens } as AiChatParams,
      { timeout },
    );
  }
}

/**
 * Catálogo de modelos sugeridos por provedor.
 *
 * O dashboard não guarda ID de modelo nenhum: ele recebe esta lista, tenta o
 * catálogo vivo de `GET /v1/models` com a chave salva e mostra as duas coisas.
 * Assim trocar de provedor (ou a NVIDIA aposentar um Nemotron) não exige
 * atualizar o frontend.
 */
export interface ProviderModels {
  provider: string;
  label: string;
  defaultModel: string;
  suggested: string[];
  defaultVisionModel: string;
  visionSuggested: string[];
  supportsVision: boolean;
  catalogLimit: number;
}

/** Teto padrão do catálogo vivo mostrado no dropdown. */
export const DEFAULT_CATALOG_LIMIT = 300;

export function providerModels(id: string | null | undefined): ProviderModels {
  const info = resolveProvider(id);
  return {
    provider: info.id,
    label: info.label,
    defaultModel: info.defaultModel,
    suggested: info.suggestedModels,
    defaultVisionModel: info.defaultVisionModel ?? "",
    visionSuggested: info.visionSuggestedModels,
    supportsVision: providerSupportsVision(info.id),
    catalogLimit: info.catalogLimit ?? DEFAULT_CATALOG_LIMIT,
  };
}

/** Catálogo inteiro no formato que o dashboard consome (sem segredos). */
export function providerCatalogForDashboard(): {
  id: string;
  label: string;
  apiKeyLabel: string;
  apiKeyHint: string;
  docsUrl: string;
  baseUrl: string;
  customBaseUrl: boolean;
  hint: string;
}[] {
  return PROVIDERS.map((provider) => ({
    id: provider.id,
    label: provider.label,
    apiKeyLabel: provider.apiKeyLabel,
    apiKeyHint: provider.apiKeyHint,
    docsUrl: provider.docsUrl,
    baseUrl: provider.baseUrl,
    customBaseUrl: Boolean(provider.customBaseUrl),
    hint: provider.hint ?? "",
  }));
}
