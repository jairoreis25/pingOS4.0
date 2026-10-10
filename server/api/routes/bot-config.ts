/**
 * Configuração do bot "Ping IA" — espelha a aba Configurações → Bot Ping IA.
 *
 *   GET  /api/admin/bot-config           (config com as chaves mascaradas)
 *   PUT  /api/admin/bot-config           (grava a config; string vazia mantém o valor)
 *   POST /api/admin/bot-config/test      (testa a chave/modelo no provedor escolhido)
 *   GET  /api/admin/bot-config/models    (catálogo de modelos do provedor escolhido)
 *
 * Todas as rotas exigem administrador (`requireAdmin`). As chaves nunca saem
 * inteiras para o cliente e nunca são logadas: a leitura devolve só os 8
 * primeiros caracteres + "••••••", e o `PUT` aceita string vazia para preservar
 * o valor guardado (o campo aparece vazio no formulário).
 *
 * O **provedor de IA** é escolhido aqui (`provider`): NVIDIA (padrão), OpenAI,
 * Google Gemini, Anthropic, Groq, OpenRouter, DeepSeek, Mistral ou um endpoint
 * próprio compatível com a OpenAI. O catálogo de provedores (URL base, rótulo da
 * chave, modelos sugeridos) vive em `../ai-providers` — o mesmo módulo que o bot
 * usa, então dashboard e agente nunca apontam para provedores diferentes.
 *
 * O processo do bot em si vive em `hermes/bot-ia.ts` — ele lê a mesma linha da
 * tabela `bot_config`. Aqui só ficam a configuração e o teste de conexão.
 */

import { Router } from "express";
import { ensureColumn } from "../../mysql/migrate";
import { execute, queryOne } from "../../mysql/pool";
import {
  aiChat,
  createAiClient,
  getProvider,
  missingBaseUrl,
  providerCatalogForDashboard,
  providerLabel,
  providerModels,
  resolveModelFor,
  resolveProvider,
  resolveVisionModelFor,
} from "../ai-providers";
import { asyncHandler, badRequest } from "../errors";
import { extractText } from "../nvidia";
import { requireAdmin } from "../permissions";
import { toBool } from "../types";

export const botConfigRouter = Router();

interface BotConfigRow {
  id: number;
  /** Chave do provedor escolhido em `provider` (nome antigo da coluna). */
  nvidia_api_key: string | null;
  /** Ausente em bancos anteriores à migração — `resolveProvider` trata. */
  provider?: string | null;
  /** URL base alternativa; vazia usa a do provedor. */
  base_url?: string | null;
  modelo: string | null;
  /** Ausente em bancos anteriores à migração — `resolveVisionModelFor` trata. */
  modelo_visao?: string | null;
  telegram_token: string | null;
  admin_id: string | null;
  ativo: number;
  system_prompt: string | null;
  updated_at: string | null;
}

/** Mostra apenas os 8 primeiros caracteres da chave (o resto é omitido). */
function maskSecret(secret: string | null | undefined): string {
  const value = (secret ?? "").trim();
  if (!value) return "";
  return `${value.slice(0, 8)}••••••`;
}

function toConfig(row: BotConfigRow) {
  const provider = resolveProvider(row.provider).id;
  const info = resolveProvider(provider);
  const chave = maskSecret(row.nvidia_api_key);
  return {
    _id: "bot_config",
    _creationTime: 0,
    provider,
    providerLabel: info.label,
    // URL base própria (Azure/LM Studio/servidor próprio); vazia = padrão do
    // provedor, então o campo do formulário aparece em branco.
    baseUrl: (row.base_url ?? "").trim(),
    apiKey: chave,
    hasApiKey: Boolean(row.nvidia_api_key),
    // Apelidos da era "só NVIDIA": mantidos para uma aba aberta num bundle
    // antigo continuar funcionando enquanto o deploy termina.
    nvidiaApiKey: chave,
    hasNvidiaApiKey: Boolean(row.nvidia_api_key),
    // Um modelo aposentado guardado no banco não é mostrado nem usado: na
    // NVIDIA o campo volta já apontando para o padrão vivo.
    modelo: resolveModelFor(provider, row.modelo),
    // Modelo de leitura de imagem (fotos de O.S.): campo próprio, com padrão
    // próprio — vazio volta ao multimodal recomendado (ou "" se o provedor não
    // lê imagem).
    modeloVisao: resolveVisionModelFor(provider, row.modelo_visao),
    supportsVision: Boolean(info.defaultVisionModel),
    telegramToken: maskSecret(row.telegram_token),
    hasTelegramToken: Boolean(row.telegram_token),
    // Não é segredo: é o Id numérico do administrador no Telegram, que o bot
    // usa para saber quem pode conversar com ele.
    adminId: row.admin_id ?? "",
    ativo: toBool(row.ativo),
    systemPrompt: row.system_prompt ?? "",
    updatedAt: row.updated_at,
    defaultModel: info.defaultModel,
    defaultVisionModel: info.defaultVisionModel ?? "",
  };
}

async function readConfig(): Promise<BotConfigRow | null> {
  return queryOne<BotConfigRow>("SELECT * FROM `bot_config` WHERE `id` = 1");
}

/**
 * Erro amigável do teste de conexão. O `410 Gone` é coisa da NVIDIA (que
 * aposenta modelo sem aviso); nos outros provedores o que aparece é chave
 * recusada (401/403) ou modelo inexistente (404).
 */
function describeError(error: unknown, modelo: string, provider: string): string {
  const info = resolveProvider(provider);
  const status = (error as { status?: number }).status;
  if (status === 410) {
    return (
      `A ${providerLabel(info.id)} aposentou o modelo "${modelo}" (410 Gone) e ele não ` +
      `volta mais. Escolha outro na lista — o padrão agora é ${info.defaultModel}.`
    );
  }
  if (status === 401 || status === 403) {
    return (
      `A ${providerLabel(info.id)} recusou a API Key. Confira a chave ` +
      `(${info.apiKeyHint}) — ela é do provedor selecionado?`
    );
  }
  if (status === 404) {
    return (
      `O modelo "${modelo}" não existe em ${providerLabel(info.id)}. ` +
      "Escolha um da lista ou digite o ID exato."
    );
  }
  if (status === 429) {
    return `A ${providerLabel(info.id)} recusou por limite de uso (429). Tente de novo em instantes.`;
  }
  return error instanceof Error ? error.message : String(error);
}

// ── GET /api/admin/bot-config ───────────────────────────────────────────────
botConfigRouter.get(
  "/bot-config",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const row = await readConfig();
    res.json(
      row ? toConfig(row) : toConfig({
        id: 1,
        nvidia_api_key: null,
        provider: null,
        base_url: null,
        modelo: null,
        modelo_visao: null,
        telegram_token: null,
        admin_id: null,
        ativo: 0,
        system_prompt: null,
        updated_at: null,
      }),
    );
  }),
);

// ── PUT /api/admin/bot-config ───────────────────────────────────────────────
// String vazia em api_key/telegram_token/modelo mantém o valor atual
// (COALESCE(NULLIF(?, ''), coluna)). O system_prompt vazio volta ao padrão do
// bot (grava NULL).
//
// As colunas `modelo_visao`, `provider` e `base_url` entraram no schema depois:
// se o banco for anterior a elas (serviço da API sem redeploy, ou
// MYSQL_AUTO_MIGRATE desligado), o UPDATE estourava com "Unknown column ... in
// 'field list'" e o administrador não conseguia salvar mais nada. Aqui as
// colunas são garantidas na hora e, se o banco não deixar, a gravação segue sem
// elas — o resto é salvo normalmente e a resposta traz um aviso.
//
// Trocar de provedor troca também o "dono" da chave: como a coluna é única, o
// modelo guardado do provedor antigo seria inválido no novo. Por isso, quando o
// provedor muda, o modelo volta ao padrão do provedor novo e a resposta avisa
// que a chave precisa ser colada de novo (a antiga é do provedor anterior).
botConfigRouter.put(
  "/bot-config",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const current = await readConfig();

    const ativo =
      body.ativo === undefined ? toBool(current?.ativo) : body.ativo ? 1 : 0;
    const systemPrompt = String(body.system_prompt ?? "").trim();
    // Vazio = mantém o que está salvo (a coluna tem NOT NULL DEFAULT).
    const requestedModel = String(body.modelo ?? "").trim();
    // Modelo de visão: vazio mantém o salvo (a coluna é NULL até alguém mexer,
    // e aí `resolveVisionModelFor` devolve o padrão multimodal).
    const requestedVision = String(body.modelo_visao ?? "").trim();
    // O admin_id é gravado direto (sem COALESCE) para permitir apagar o campo
    // — o formulário sempre manda o valor que carregou do servidor.
    const adminId = String(body.admin_id ?? "").trim().slice(0, 64) || null;
    // Aceita o nome novo (`api_key`) e o antigo (`nvidia_api_key`).
    const apiKeyInput = String(
      body.api_key ?? body.nvidia_api_key ?? "",
    ).trim();
    const baseUrlInput = String(body.base_url ?? "").trim().slice(0, 255);

    const currentProvider = resolveProvider(current?.provider).id;
    let provider = currentProvider;
    if (body.provider !== undefined && String(body.provider).trim()) {
      const requested = getProvider(String(body.provider));
      if (!requested) {
        throw badRequest(`Provedor de IA desconhecido: ${String(body.provider)}.`);
      }
      provider = requested.id;
    }
    const trocouProvedor = provider !== currentProvider;
    const info = resolveProvider(provider);

    // Com o provedor novo, o modelo do provedor antigo não vale: cai no padrão
    // do provedor escolhido ("" é o valor que mantém o que já está salvo).
    const modelo = requestedModel
      ? resolveModelFor(provider, requestedModel)
      : trocouProvedor
        ? resolveModelFor(provider, "")
        : "";
    const visionPadrao = resolveVisionModelFor(provider, "");
    const modeloVisao = requestedVision
      ? resolveVisionModelFor(provider, requestedVision)
      : trocouProvedor
        ? visionPadrao
        : "";

    const colunas = {
      modeloVisao: await ensureColumn("bot_config", "modelo_visao"),
      provider: await ensureColumn("bot_config", "provider"),
      baseUrl: await ensureColumn("bot_config", "base_url"),
    };

    // Cada item carrega o SQL e, opcionalmente, o valor — assim os `?` não
    // saem de sincronia quando uma coluna não existe no banco.
    const sets: { sql: string; value?: unknown }[] = [
      { sql: "`nvidia_api_key` = COALESCE(NULLIF(?, ''), `nvidia_api_key`)", value: apiKeyInput },
      { sql: "`telegram_token` = COALESCE(NULLIF(?, ''), `telegram_token`)", value: String(body.telegram_token ?? "").trim() },
      { sql: "`modelo` = COALESCE(NULLIF(?, ''), `modelo`)", value: modelo },
      { sql: "`admin_id` = ?", value: adminId },
      { sql: "`ativo` = ?", value: ativo },
      { sql: "`system_prompt` = ?", value: systemPrompt || null },
    ];
    if (colunas.provider) {
      sets.push({ sql: "`provider` = ?", value: provider });
    }
    if (colunas.baseUrl) {
      sets.push({ sql: "`base_url` = ?", value: baseUrlInput || null });
    }
    if (colunas.modeloVisao) {
      // Provedor sem visão não pode ficar com um modelo multimodal "órfão"
      // guardado: a coluna é limpa para o padrão do provedor novo.
      if (trocouProvedor && !visionPadrao) {
        sets.push({ sql: "`modelo_visao` = NULL" });
      } else {
        sets.push({
          sql: "`modelo_visao` = COALESCE(NULLIF(?, ''), `modelo_visao`)",
          value: modeloVisao,
        });
      }
    }

    await execute(
      `UPDATE \`bot_config\` SET ${sets.map((item) => item.sql).join(", ")} WHERE \`id\` = 1`,
      sets.filter((item) => "value" in item).map((item) => item.value),
    );

    const row = await readConfig();
    const config = row ? toConfig(row) : null;

    const avisos: string[] = [];
    if (!colunas.modeloVisao && requestedVision) {
      avisos.push(
        "a coluna do modelo de visão ainda não existe neste banco — reimplante " +
          "o serviço da API (é ele que aplica a migração) e salve de novo",
      );
    }
    if (!colunas.provider) {
      avisos.push(
        "a coluna do provedor de IA ainda não existe neste banco — reimplante o " +
          "serviço da API e salve de novo",
      );
    }
    if (trocouProvedor && !apiKeyInput) {
      avisos.push(
        `o provedor mudou para ${info.label}, mas a chave salva é da anterior — ` +
          `cole a ${info.apiKeyLabel} e salve de novo`,
      );
    }
    if (missingBaseUrl(provider, baseUrlInput)) {
      avisos.push(
        "informe a URL base do endpoint (ex.: https://meu-servidor/v1) para o bot " +
          "conseguir falar com o provedor escolhido",
      );
    }
    if (avisos.length > 0) {
      res.json({
        ...config,
        aviso: `A configuração foi salva, mas ${avisos.join("; ")}.`,
      });
      return;
    }
    res.json(config);
  }),
);

// ── POST /api/admin/bot-config/test ─────────────────────────────────────────
// Envia uma mensagem mínima para o provedor escolhido com a chave informada (ou
// a guardada) e devolve a resposta. Nunca lança: o erro vira
// `{ ok: false, erro }` para a UI mostrar no campo de resultado.
//
// O `timeout` é generoso porque modelos de raciocínio (Nemotron, o3, Claude com
// thinking) demoram na primeira resposta. Na NVIDIA o parâmetro que desliga o
// raciocínio (`enable_thinking: false`) é enviado pelo `nvidiaChat` — sem ele o
// modelo gasta o orçamento de tokens "pensando" e devolve texto vazio, que era
// exatamente o "(vazia)" que aparecia aqui.
//
// `alvo: "visao"` testa o modelo de LEITURA DE IMAGEM. Aí o corpo pode trazer
// `imagem` (data URL gerada no próprio dashboard, com dígitos sorteados): o
// teste manda essa imagem de verdade, que é o único jeito de descobrir se o
// modelo escolhido aceita `image_url` — um "teste" só de texto passaria mesmo
// num modelo sem visão nenhuma.
botConfigRouter.post(
  "/bot-config/test",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const providedKey = String(
      body.api_key ?? body.nvidia_api_key ?? "",
    ).trim();
    const current = await readConfig();
    const apiKey = providedKey || current?.nvidia_api_key || "";
    const provider = getProvider(String(body.provider ?? ""))?.id
      ?? resolveProvider(current?.provider).id;
    const info = resolveProvider(provider);
    const baseUrl =
      String(body.base_url ?? "").trim() || (current?.base_url ?? "").trim();
    const visao = String(body.alvo ?? "") === "visao";
    const modelo = visao
      ? resolveVisionModelFor(
          provider,
          String(body.modelo_visao ?? "").trim() || current?.modelo_visao,
        )
      : resolveModelFor(
          provider,
          String(body.modelo ?? "").trim() || current?.modelo,
        );

    if (!apiKey) {
      throw badRequest(`Informe a ${info.apiKeyLabel} para testar.`);
    }
    if (visao && !modelo) {
      res.json({
        ok: false,
        erro:
          `O provedor ${info.label} não tem modelo de visão definido — a leitura ` +
          "de fotos de O.S. fica indisponível. Escolha um provedor com visão " +
          "(NVIDIA, OpenAI, Gemini...) ou informe um modelo multimodal.",
        modelo,
        alvo: "visao",
      });
      return;
    }

    // Só aceita data URL de imagem: o valor vem do navegador e não pode virar
    // um link arbitrário para o servidor buscar.
    const imagem = String(body.imagem ?? "").trim();
    const imagemValida = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(imagem);
    const pergunta = imagemValida
      ? "Leia a imagem e responda SOMENTE com os dígitos que aparecem nela."
      : "Responda apenas: OK";

    try {
      const client = createAiClient({ provider, apiKey, baseUrl });
      const completion = await aiChat(
        client,
        {
          model: modelo,
          messages: [
            {
              role: "user",
              content: imagemValida
                ? [
                    { type: "text", text: pergunta },
                    { type: "image_url", image_url: { url: imagem } },
                  ]
                : pergunta,
            },
          ],
          max_tokens: 512,
        },
        { provider, timeoutMs: 120_000 },
      );
      const message = completion.choices[0]?.message;
      const resposta = message ? extractText(message) : "";
      if (!resposta) {
        res.json({
          ok: false,
          erro: visao
            ? `O modelo ${modelo} respondeu, mas sem texto. Ele parece não ler ` +
              "imagens — escolha um modelo multimodal no catálogo."
            : `O modelo ${modelo} respondeu, mas sem texto. Use um modelo de chat ` +
              `— ex.: ${info.defaultModel}.`,
          modelo,
          alvo: visao ? "visao" : "texto",
        });
        return;
      }
      res.json({
        ok: true,
        resposta,
        modelo,
        provider,
        alvo: visao ? "visao" : "texto",
      });
    } catch (error) {
      const status = (error as { status?: number }).status;
      const erro =
        visao && (status === 400 || status === 422)
          ? `A ${providerLabel(provider)} recusou a imagem no modelo "${modelo}" ` +
            `(HTTP ${status}). Escolha um modelo multimodal (que aceite image_url) na lista.`
          : describeError(error, modelo, provider);
      console.warn("[bot-config] teste falhou:", erro);
      res.json({ ok: false, erro, modelo, provider, alvo: visao ? "visao" : "texto" });
    }
  }),
);

// ── GET /api/admin/bot-config/models ────────────────────────────────────────
// Lista os modelos do provedor escolhido (para os dropdowns do dashboard) e o
// catálogo de provedores que o formulário usa para montar os campos.
// Devolve também as sugestões e o padrão: o frontend não guarda ID nenhum, logo
// não tem como ficar desatualizado quando um provedor aposentar um modelo.
//
// `?provider=` permite consultar o catálogo ANTES de salvar a troca. O catálogo
// vivo (`GET /v1/models`) só é buscado quando o provedor consultado é o que está
// salvo — a chave guardada é dele, e pedir a lista de outro provedor com a chave
// errada só devolveria 401 (as sugestões estáticas aparecem de qualquer forma).
botConfigRouter.get(
  "/bot-config/models",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const current = await readConfig();
    const salvo = resolveProvider(current?.provider).id;
    const provider = getProvider(String(req.query.provider ?? ""))?.id ?? salvo;
    const baseUrl =
      String(req.query.base_url ?? "").trim() || (current?.base_url ?? "").trim();
    const apiKey = current?.nvidia_api_key ?? "";

    const base = {
      ...providerModels(provider),
      providers: providerCatalogForDashboard(),
      baseUrl: (current?.base_url ?? "").trim(),
    };

    if (!apiKey || provider !== salvo) {
      res.json({ ...base, models: [] });
      return;
    }

    try {
      const client = createAiClient({ provider, apiKey, baseUrl });
      const list = await client.models.list();
      const models = [...new Set(list.data.map((model) => model.id).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b))
        .slice(0, base.catalogLimit);
      res.json({ ...base, models });
    } catch (error) {
      console.warn(
        "[bot-config] não deu para listar os modelos:",
        error instanceof Error ? error.message : error,
      );
      res.json({ ...base, models: [] });
    }
  }),
);
