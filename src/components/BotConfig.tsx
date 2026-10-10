/**
 * Configurações → Bot Ping IA (somente administrador).
 *
 * Grava na tabela `bot_config` (via `/api/admin/bot-config`) o **provedor de
 * IA** escolhido, a chave dele, os modelos de texto e de visão, o token do
 * Telegram, o system prompt e o liga/desliga do bot. O processo
 * `hermes/bot-ia.ts` lê essa mesma configuração para subir o agente no Telegram.
 *
 * Provedores: NVIDIA (padrão), OpenAI, Google Gemini, Anthropic, Groq,
 * OpenRouter, DeepSeek, Mistral e um endpoint próprio compatível com a OpenAI.
 * A lista de provedores e os modelos sugeridos vêm do servidor
 * (`/api/admin/bot-config/models`), então acrescentar um provedor novo não
 * exige mexer aqui.
 *
 * Segurança: a API devolve as chaves já mascaradas. Os campos começam vazios e
 * um valor vazio no "Salvar" mantém o que já está guardado — por isso o texto de
 * apoio avisa quando a chave já existe.
 */

import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery } from "@/lib/backend/react"
import { api, type BotModelsResult } from "@/lib/backend/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "sonner"
import { Bot, Loader2, Save, Sparkles } from "lucide-react"
import { BotPersonalidades } from "@/components/BotPersonalidades"

interface BotConfigData {
  provider: string
  providerLabel: string
  baseUrl: string
  apiKey: string
  hasApiKey: boolean
  modelo: string
  modeloVisao: string
  supportsVision: boolean
  telegramToken: string
  hasTelegramToken: boolean
  adminId: string
  ativo: boolean
  systemPrompt: string
  defaultModel: string
  defaultVisionModel: string
}

/**
 * Valor sentinela do dropdown de modelo: em vez de escolher da lista, o
 * administrador digita o ID (útil no OpenRouter, que tem centenas de modelos,
 * e em provedor próprio, que não tem catálogo).
 */
const OUTRO_MODELO = "__outro__"

/**
 * Gera uma imagem de teste (4 dígitos desenhados num canvas) para conferir, com
 * a chave do próprio administrador, se o modelo de visão escolhido **lê mesmo**
 * uma foto — testar só com texto passaria mesmo num modelo sem visão.
 */
/** Monta as opções de um dropdown de modelo (padrão → sugeridos → catálogo → salvo). */
function montarOpcoes(
  sugestoes: string[] | undefined,
  padrao: string | undefined,
  atual: string,
  catalogo: string[] | undefined,
): { value: string; label: string }[] {
  const options: { value: string; label: string }[] = []
  const seen = new Set<string>()
  const push = (value: string | undefined, sufixo?: string) => {
    const id = (value ?? "").trim()
    if (!id || seen.has(id)) return
    seen.add(id)
    options.push({ value: id, label: sufixo ? `${id} ${sufixo}` : id })
  }

  push(padrao, "(padrão)")
  for (const id of sugestoes ?? []) push(id, "(recomendado)")
  for (const id of catalogo ?? []) push(id)
  push(atual)
  return options
}

function gerarImagemTeste(): { dataUrl: string; digitos: string } | null {
  if (typeof document === "undefined") return null
  const canvas = document.createElement("canvas")
  canvas.width = 420
  canvas.height = 150
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.strokeStyle = "#000000"
  ctx.lineWidth = 4
  ctx.strokeRect(2, 2, canvas.width - 4, canvas.height - 4)
  ctx.fillStyle = "#000000"
  ctx.font = "bold 96px monospace"
  ctx.textBaseline = "middle"
  const digitos = String(Math.floor(1000 + Math.random() * 9000))
  ctx.fillText(digitos, 58, 80)
  return { dataUrl: canvas.toDataURL("image/png"), digitos }
}

/**
 * Dropdown de modelo + botão "Testar". A opção "Outro" troca o select por um
 * campo de texto: catálogos como o do OpenRouter têm centenas de IDs e listar
 * tudo num select só atrapalha.
 */
function ModeloSelect({
  rotulo,
  opcoes,
  valor,
  onChange,
  placeholder,
  testando,
  onTestar,
  teste,
}: {
  rotulo: string
  opcoes: { value: string; label: string }[]
  valor: string
  onChange: (valor: string, personalizado: boolean) => void
  placeholder: string
  testando: boolean
  onTestar: () => void
  teste: string
}) {
  const [personalizado, setPersonalizado] = useState(false)
  const conhecido = opcoes.some((option) => option.value === valor)
  // Modelo salvo que não está em nenhuma lista (ID digitado antes): já abre no
  // modo texto, senão o select apareceria vazio.
  const emTexto = personalizado || (Boolean(valor) && !conhecido)

  return (
    <div className="space-y-2">
      <Label>{rotulo}</Label>
      <div className="flex items-center gap-2">
        <Select
          value={emTexto ? OUTRO_MODELO : valor}
          onValueChange={(novo) => {
            if (novo === OUTRO_MODELO) {
              setPersonalizado(true)
              onChange("", true)
              return
            }
            setPersonalizado(false)
            onChange(novo, false)
          }}
        >
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Selecione o modelo" />
          </SelectTrigger>
          <SelectContent>
            {opcoes.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
            <SelectItem value={OUTRO_MODELO}>Outro (digitar o ID)</SelectItem>
          </SelectContent>
        </Select>
        <Button type="button" variant="outline" onClick={onTestar} disabled={testando}>
          {testando ? <Loader2 className="size-3.5 animate-spin" /> : "Testar"}
        </Button>
      </div>
      {emTexto && (
        <Input
          value={valor}
          onChange={(e) => onChange(e.target.value, true)}
          placeholder={placeholder}
          autoComplete="off"
        />
      )}
      {teste && (
        <p className="whitespace-pre-wrap break-words rounded-md bg-muted/40 px-3 py-2 font-mono text-[11px] text-muted-foreground">
          {teste}
        </p>
      )}
    </div>
  )
}

export default function BotConfig({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const config = useQuery<BotConfigData>(api.botConfig.get, open ? {} : "skip")
  const updateConfig = useMutation(api.botConfig.update)
  const testConfig = useMutation<{
    ok: boolean
    resposta?: string
    erro?: string
    modelo?: string
    alvo?: string
  }>(api.botConfig.test)

  const [provider, setProvider] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [baseUrl, setBaseUrl] = useState("")
  const [modelo, setModelo] = useState("")
  const [modeloVisao, setModeloVisao] = useState("")
  const [telegramToken, setTelegramToken] = useState("")
  const [adminId, setAdminId] = useState("")
  const [ativo, setAtivo] = useState(false)
  const [systemPrompt, setSystemPrompt] = useState("")

  const [testando, setTestando] = useState(false)
  const [resultado, setResultado] = useState("")
  const [testandoVisao, setTestandoVisao] = useState(false)
  const [resultadoVisao, setResultadoVisao] = useState("")
  const [salvando, setSalvando] = useState(false)
  const [initialized, setInitialized] = useState(false)

  // Catálogo do provedor selecionado (modelos sugeridos, visão, informações do
  // campo da chave). O `provider` vai na query: trocar no select já recarrega a
  // lista antes de salvar. A URL base **não** entra aqui de propósito — ela é
  // digitada campo a campo e cada tecla dispararia uma busca; na listagem o
  // servidor usa a URL salva.
  const modelsResult = useQuery<BotModelsResult>(
    api.botConfig.models,
    open && provider ? { provider } : "skip",
  )

  // Ao fechar, libera o formulário para recarregar da API na próxima abertura.
  useEffect(() => {
    if (!open) {
      setInitialized(false)
      return
    }
    if (config && !initialized) {
      setProvider(config.provider || "nvidia")
      setApiKey("")
      setBaseUrl(config.baseUrl ?? "")
      setTelegramToken("")
      setAdminId(config.adminId ?? "")
      setModelo(config.modelo || config.defaultModel)
      setModeloVisao(config.modeloVisao || config.defaultVisionModel)
      setAtivo(config.ativo)
      setSystemPrompt(config.systemPrompt ?? "")
      setResultado("")
      setResultadoVisao("")
      setInitialized(true)
    }
  }, [open, config, initialized])

  // O catálogo é do provedor selecionado: quando ele chega, cai no padrão do
  // provedor (campo vazio) e limpa o modelo de visão se o provedor não lê foto.
  useEffect(() => {
    if (!modelsResult || modelsResult.provider !== provider) return
    if (!modelsResult.supportsVision) {
      setModeloVisao("")
      return
    }
    setModelo((atual) => atual || modelsResult.defaultModel || "")
    setModeloVisao((atual) => atual || modelsResult.defaultVisionModel || "")
  }, [modelsResult, provider])

  const catalogoAtual = modelsResult?.provider === provider ? modelsResult : undefined
  const provedorInfo = (modelsResult?.providers ?? []).find((item) => item.id === provider)
  // Provedor "Outro" não traz catálogo: o campo de visão fica disponível para
  // quem aponta para um endpoint multimodal próprio.
  const permiteVisao = provider === "custom" ? true : (catalogoAtual?.supportsVision ?? true)

  // Lista dos dropdowns (texto e visão): padrão → recomendados → catálogo vivo
  // → modelo salvo. Nenhum ID de modelo fica fixo aqui de propósito: quando um
  // provedor aposenta um modelo ele passa a responder 410 Gone, e uma lista fixa
  // no frontend continuaria oferecendo um modelo morto.
  const modelos = useMemo(
    () =>
      montarOpcoes(
        catalogoAtual?.suggested,
        catalogoAtual?.defaultModel ?? config?.defaultModel,
        modelo,
        catalogoAtual?.models,
      ),
    [catalogoAtual, config?.defaultModel, modelo],
  )

  const modelosVisao = useMemo(
    () =>
      montarOpcoes(
        catalogoAtual?.visionSuggested,
        catalogoAtual?.defaultVisionModel ?? config?.defaultVisionModel,
        modeloVisao,
        catalogoAtual?.models,
      ),
    [catalogoAtual, config?.defaultVisionModel, modeloVisao],
  )

  // Trocar de provedor zera os modelos: o ID que valia na NVIDIA não existe na
  // OpenAI, e o padrão do provedor novo chega junto com o catálogo.
  const trocarProvedor = (novo: string) => {
    setProvider(novo)
    setModelo("")
    setModeloVisao("")
    setResultado("")
    setResultadoVisao("")
  }

  const testarConexao = async () => {
    setTestando(true)
    setResultado("Testando a conexão…")
    try {
      const result = await testConfig({
        api_key: apiKey,
        provider,
        base_url: baseUrl,
        modelo,
      })
      // A API resolve modelo aposentado para o padrão vivo: reflete no select
      // para o admin ver qual modelo respondeu de fato.
      const trocou = Boolean(result.modelo && result.modelo !== modelo)
      if (trocou) setModelo(result.modelo!)
      if (result.ok) {
        setResultado(
          `✅ Conexão OK — resposta: ${result.resposta || "(vazia)"}` +
            (trocou ? `\n(modelo aposentado — testado com ${result.modelo})` : ""),
        )
      } else {
        setResultado(`❌ ${result.erro ?? "Falha ao testar a conexão."}`)
      }
    } catch (err) {
      setResultado(`❌ ${err instanceof Error ? err.message : "Falha ao testar."}`)
    } finally {
      setTestando(false)
    }
  }

  // Testa a LEITURA DE IMAGEM: desenha 4 dígitos aleatórios num canvas, manda
  // a imagem para o modelo de visão e confere se ele devolveu os mesmos
  // dígitos. É o único teste que prova que o modelo aceita foto.
  const testarVisao = async () => {
    const imagem = gerarImagemTeste()
    setTestandoVisao(true)
    setResultadoVisao("Testando a leitura de imagem…")
    try {
      const result = await testConfig({
        api_key: apiKey,
        provider,
        base_url: baseUrl,
        modelo_visao: modeloVisao,
        alvo: "visao",
        imagem: imagem?.dataUrl,
      })
      if (result.modelo && result.modelo !== modeloVisao) setModeloVisao(result.modelo)
      const lidos = (result.resposta ?? "").replace(/\D/g, "")
      const esperado = imagem?.digitos ?? ""
      if (!result.ok) {
        setResultadoVisao(`❌ ${result.erro ?? "Falha ao testar a visão."}`)
      } else if (esperado && lidos.includes(esperado)) {
        setResultadoVisao(`✅ Visão OK — o modelo leu ${esperado} na imagem de teste.`)
      } else {
        setResultadoVisao(
          `⚠️ O modelo ${result.modelo} aceitou a imagem, mas leu "${
            result.resposta?.trim() || "(vazio)"
          }" (esperado ${esperado}). Tente outro modelo multimodal da lista.`,
        )
      }
    } catch (err) {
      setResultadoVisao(`❌ ${err instanceof Error ? err.message : "Falha ao testar a visão."}`)
    } finally {
      setTestandoVisao(false)
    }
  }

  const salvar = async () => {
    if (ativo && !apiKey && !config?.hasApiKey) {
      toast.error(`Informe a ${provedorInfo?.apiKeyLabel ?? "API Key"} antes de ativar o bot.`)
      return
    }
    if (ativo && !modelo.trim()) {
      toast.error("Informe o modelo de texto antes de ativar o bot.")
      return
    }
    if (provedorInfo?.customBaseUrl && !baseUrl.trim()) {
      toast.error("Informe a URL base do endpoint compatível com a OpenAI.")
      return
    }
    if (ativo && !telegramToken && !config?.hasTelegramToken) {
      toast.error("Informe o token do Telegram antes de ativar o bot.")
      return
    }
    setSalvando(true)
    try {
      const salvo = await updateConfig({
        api_key: apiKey,
        provider,
        base_url: baseUrl,
        telegram_token: telegramToken,
        admin_id: adminId,
        modelo,
        modelo_visao: modeloVisao,
        ativo,
        system_prompt: systemPrompt,
      })
      // O banco pode ser anterior a alguma coluna nova: aí a API salva o resto e
      // devolve um aviso (em vez de estourar "Unknown column").
      if (salvo?.aviso) toast.warning(salvo.aviso)
      else toast.success("Configurações do bot salvas!")
      // As chaves ficam mascaradas no servidor — limpa os campos após salvar.
      setApiKey("")
      setTelegramToken("")
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar as configurações.")
    } finally {
      setSalvando(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="size-5 text-primary" />
            🤖 Bot Ping IA
          </DialogTitle>
          <DialogDescription>
            Agente administrativo no Telegram. O bot lê esta configuração e usa o provedor de IA
            escolhido (NVIDIA, OpenAI, Google, Anthropic…) para responder e executar ações nos
            chamados.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Ativar bot */}
          <div className="space-y-2">
            <div className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Ativar bot</span>
              </div>
              <Switch checked={ativo} onCheckedChange={setAtivo} />
            </div>
            <p className="text-[11px] text-muted-foreground/70">
              Desligado, o agente fica fora do ar no Telegram — mesmo com as chaves salvas. Ligue o
              switch e clique em Salvar para ele entrar no ar (o processo do bot relê esta
              configuração a cada 15s).
            </p>
          </div>

          {/* Provedor de IA */}
          <div className="space-y-2">
            <Label>Provedor de IA</Label>
            <Select value={provider} onValueChange={trocarProvedor}>
              <SelectTrigger>
                <SelectValue placeholder="Selecione o provedor" />
              </SelectTrigger>
              <SelectContent>
                {(modelsResult?.providers ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
                {/* Antes do catálogo chegar, mostra pelo menos o provedor salvo. */}
                {provider && !(modelsResult?.providers ?? []).length && (
                  <SelectItem value={provider}>{config?.providerLabel ?? provider}</SelectItem>
                )}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground/70">
              {provedorInfo?.hint ||
                "Todos usam a mesma API (compatível com a OpenAI) — só a chave e o endpoint mudam. NVIDIA é o padrão."}
            </p>
          </div>

          {/* API Key do provedor */}
          <div className="space-y-2">
            <Label htmlFor="bot-api-key">{provedorInfo?.apiKeyLabel ?? "API Key"}</Label>
            <Input
              id="bot-api-key"
              type="password"
              autoComplete="off"
              placeholder={
                config?.hasApiKey
                  ? "•••••• (já configurada)"
                  : provedorInfo?.apiKeyHint || "cole a chave do provedor"
              }
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground/70">
              {provedorInfo?.docsUrl ? `Obtenha em ${provedorInfo.docsUrl}. ` : ""}
              Deixe vazio para manter a chave salva. Trocar de provedor exige colar a chave do novo
              provedor.
            </p>
          </div>

          {/* URL base própria (servidor/Azure/provedor "Outro") */}
          {(provedorInfo?.customBaseUrl || baseUrl) && (
            <div className="space-y-2">
              <Label htmlFor="bot-base-url">URL base do endpoint</Label>
              <Input
                id="bot-base-url"
                autoComplete="off"
                placeholder="https://meu-servidor/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
              <p className="text-[11px] text-muted-foreground/70">
                Só para endpoints próprios compatíveis com a OpenAI (<code>/chat/completions</code>
                ). Vazio usa a URL padrão do provedor
                {provedorInfo?.baseUrl ? ` (${provedorInfo.baseUrl})` : ""}.
              </p>
            </div>
          )}

          {/* Modelo de texto */}
          <ModeloSelect
            rotulo="Modelo"
            opcoes={modelos}
            valor={modelo}
            onChange={setModelo}
            placeholder="ex.: gpt-4o-mini"
            testando={testando}
            onTestar={testarConexao}
            teste={resultado}
          />
          <p className="-mt-2 text-[11px] text-muted-foreground/70">
            A lista vem do catálogo da sua conta no provedor. Se um modelo for aposentado (a API
            responde 410 Gone), o Testar acusa e você escolhe outro — ou digite o ID exato na opção
            “Outro”.
          </p>

          {/* Modelo de visão (fotos de O.S.) */}
          {permiteVisao ? (
            <>
              <ModeloSelect
                rotulo="Modelo de visão (fotos de O.S.)"
                opcoes={modelosVisao}
                valor={modeloVisao}
                onChange={setModeloVisao}
                placeholder="ex.: gpt-4o-mini"
                testando={testandoVisao}
                onTestar={testarVisao}
                teste={resultadoVisao}
              />
              <p className="-mt-2 text-[11px] text-muted-foreground/70">
                Usado só quando alguém manda a <b>foto de uma O.S.</b> no Telegram: o bot lê a
                imagem, cria o chamado e responde com o resumo. O Testar desenha dígitos numa imagem
                de verdade e confere se o modelo escolhido consegue lê-los — modelos sem visão
                recusam a foto.
              </p>
            </>
          ) : (
            <div className="space-y-2">
              <Label>Modelo de visão (fotos de O.S.)</Label>
              <p className="rounded-md bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
                O provedor {provedorInfo?.label ?? provider} não lê imagens, então a leitura das
                fotos de O.S. fica indisponível. O agente continua funcionando por texto — escolha
                um provedor multimodal (NVIDIA, OpenAI, Gemini…) para ter a leitura de fotos.
              </p>
            </div>
          )}

          {/* Telegram Bot Token */}
          <div className="space-y-2">
            <Label htmlFor="bot-telegram-token">Telegram Bot Token</Label>
            <Input
              id="bot-telegram-token"
              type="password"
              autoComplete="off"
              placeholder={
                config?.hasTelegramToken ? "•••••• (já configurado)" : "7123456789:AAH..."
              }
              value={telegramToken}
              onChange={(e) => setTelegramToken(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground/70">
              Crie o bot com o @BotFather (/newbot) e cole o token aqui.
            </p>
          </div>

          {/* Id do administrador no Telegram */}
          <div className="space-y-2">
            <Label htmlFor="bot-admin-id">Seu Id no Telegram</Label>
            <Input
              id="bot-admin-id"
              inputMode="numeric"
              autoComplete="off"
              placeholder="ex.: 987654321"
              value={adminId}
              onChange={(e) => setAdminId(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground/70">
              Só este Id conversa com o agente. Fale com o <b>@userinfobot</b> no Telegram para
              descobrir o seu — ou mande qualquer mensagem para o bot: sem Id configurado, ele
              responde justamente com esse número.
            </p>
          </div>

          {/* System prompt (base do agente) */}
          <div className="space-y-2">
            <Label htmlFor="bot-system-prompt">System Prompt</Label>
            <Textarea
              id="bot-system-prompt"
              rows={4}
              placeholder="Deixe vazio para usar padrão"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground/70">
              Instruções base do agente (regras gerais). Usado quando
              <b>nenhuma</b> personalidade está ativa — se houver uma, o prompt dela manda.
            </p>
          </div>

          {/* Personalidades do bot */}
          <div className="space-y-3 border-t border-border/60 pt-4">
            <div>
              <Label className="text-sm">Personalidades</Label>
              <p className="text-[11px] text-muted-foreground/70">
                Quatro estilos de atendimento; apenas um fica ativo por vez. O slot Padrão é fixo —
                ative-o para voltar ao comportamento padrão do agente.
              </p>
            </div>
            <BotPersonalidades />
          </div>

          <Button type="button" className="w-full gap-1.5" onClick={salvar} disabled={salvando}>
            {salvando ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {salvando ? "Salvando..." : "Salvar Configurações"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
