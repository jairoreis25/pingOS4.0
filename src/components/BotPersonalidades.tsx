/**
 * Configurações → Bot Ping IA → Personalidades (somente administrador).
 *
 * São 4 slots fixos do bot "Ping IA". O **slot 1 (Padrão)** é fixo: nome, emoji
 * e system prompt vêm do código e não podem ser editados — ele só pode ser
 * ativado/desativado, para voltar ao comportamento padrão. Os slots 2, 3 e 4 são
 * totalmente editáveis (nome até 50, emoji até 10, prompt até 8000 caracteres).
 *
 * Apenas uma personalidade fica ativa por vez; a ativação roda no servidor numa
 * transação que desliga as outras. O processo `hermes/bot-ia.ts` lê a ativa.
 *
 * O bloqueio do slot fixo é do backend (o `PUT` responde 403): esta tela apenas
 * reflete a mesma regra.
 */

import { useEffect, useState } from "react"
import { api, type BotPersonalidade } from "@/lib/backend/api"
import { useMutation, useQuery } from "@/lib/backend/react"
import { Loader2 } from "lucide-react"

export function BotPersonalidades() {
  const slots = useQuery<BotPersonalidade[]>(api.botPersonalidades.list, {})
  const update = useMutation<BotPersonalidade, Record<string, unknown>>(
    api.botPersonalidades.update,
  )
  const ativarRef = useMutation<BotPersonalidade[]>(api.botPersonalidades.ativar)

  // Cópia local editável: os inputs mudam na hora e o "Salvar" envia ao servidor.
  const [rascunho, setRascunho] = useState<BotPersonalidade[]>([])
  const [salvando, setSalvando] = useState<number | null>(null)
  const [ativando, setAtivando] = useState<number | null>(null)
  const [feedback, setFeedback] = useState("")
  const [carregado, setCarregado] = useState(false)

  useEffect(() => {
    if (!slots || carregado) return
    setRascunho(slots)
    setCarregado(true)
  }, [slots, carregado])

  function atualizarSlot(slot: number, campo: keyof BotPersonalidade, valor: string) {
    setRascunho((atual) => atual.map((s) => (s.slot === slot ? { ...s, [campo]: valor } : s)))
  }

  function avisar(mensagem: string) {
    setFeedback(mensagem)
    setTimeout(() => setFeedback(""), 3000)
  }

  async function salvar(slot: number) {
    const s = rascunho.find((x) => x.slot === slot)
    if (!s) return
    setSalvando(slot)
    try {
      const salva = await update({
        slot,
        nome: s.nome,
        emoji: s.emoji,
        system_prompt: s.system_prompt,
      })
      setRascunho((atual) => atual.map((x) => (x.slot === slot ? salva : x)))
      avisar(`✅ Personalidade "${salva.nome}" salva.`)
    } catch (err) {
      avisar(`❌ ${err instanceof Error ? err.message : "Falha ao salvar."}`)
    } finally {
      setSalvando(null)
    }
  }

  async function ativar(slot: number) {
    setAtivando(slot)
    try {
      const atualizados = await ativarRef({ slot })
      setRascunho(atualizados)
      const s = atualizados.find((x) => x.slot === slot)
      avisar(`🔄 Personalidade "${s?.nome ?? ""}" ativada.`)
    } catch (err) {
      avisar(`❌ ${err instanceof Error ? err.message : "Falha ao ativar."}`)
    } finally {
      setAtivando(null)
    }
  }

  if (!slots || rascunho.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Carregando personalidades…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {feedback && (
        <div className="rounded-lg bg-muted px-4 py-2 text-sm text-foreground">{feedback}</div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {rascunho.map((s) => {
          const ehFixo = s.fixo === 1
          return (
            <div
              key={s.slot}
              className={`space-y-3 rounded-xl border-2 bg-card p-4 transition-colors ${
                s.ativo === 1
                  ? "border-primary shadow-sm"
                  : ehFixo
                    ? "border-border/40"
                    : "border-border"
              }`}
            >
              {/* Header */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-1 items-center gap-2">
                  {ehFixo ? (
                    <>
                      <div className="flex size-12 items-center justify-center rounded-lg border border-border bg-muted/40 text-2xl">
                        {s.emoji}
                      </div>
                      <div className="flex-1 px-1 py-1 font-semibold text-foreground">
                        {s.nome}
                        <span className="ml-2 text-[10px] font-normal text-muted-foreground">
                          (fixo)
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <input
                        value={s.emoji || ""}
                        onChange={(e) => atualizarSlot(s.slot, "emoji", e.target.value)}
                        maxLength={10}
                        aria-label={`Emoji do slot ${s.slot}`}
                        className="size-12 rounded-lg border border-border bg-muted/40 text-center text-2xl focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                        placeholder="🤖"
                      />
                      <input
                        value={s.nome || ""}
                        onChange={(e) => atualizarSlot(s.slot, "nome", e.target.value)}
                        maxLength={50}
                        aria-label={`Nome do slot ${s.slot}`}
                        className="flex-1 border-b border-transparent bg-transparent px-1 py-1 font-semibold text-foreground hover:border-border focus:border-primary focus:outline-none"
                        placeholder="Nome da personalidade"
                      />
                    </>
                  )}
                </div>
                {s.ativo === 1 && (
                  <span className="whitespace-nowrap rounded-full bg-primary/10 px-2 py-1 text-xs font-medium text-primary">
                    ● Ativo
                  </span>
                )}
              </div>

              {/* System prompt */}
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">
                  System Prompt
                </label>
                {ehFixo ? (
                  <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs italic text-muted-foreground">
                    Definido pelo sistema (não editável). Usado quando nenhuma personalidade está
                    ativa.
                  </div>
                ) : (
                  <>
                    <textarea
                      value={s.system_prompt || ""}
                      onChange={(e) => atualizarSlot(s.slot, "system_prompt", e.target.value)}
                      placeholder="Deixe vazio para usar o prompt padrão"
                      rows={6}
                      maxLength={8000}
                      className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                    />
                    <div className="text-right text-[10px] text-muted-foreground">
                      {(s.system_prompt || "").length}/8000
                    </div>
                  </>
                )}
              </div>

              {/* Ações */}
              <div className="flex gap-2 pt-1">
                {!ehFixo && (
                  <button
                    type="button"
                    onClick={() => salvar(s.slot)}
                    disabled={salvando === s.slot}
                    className="flex-1 rounded-lg bg-muted py-2 text-sm text-foreground transition-colors hover:bg-muted/70 disabled:opacity-50"
                  >
                    {salvando === s.slot ? "Salvando..." : "💾 Salvar"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => ativar(s.slot)}
                  disabled={s.ativo === 1 || ativando === s.slot}
                  className={`${ehFixo ? "w-full" : "flex-1"} rounded-lg py-2 text-sm font-medium transition-colors ${
                    s.ativo === 1
                      ? "cursor-not-allowed bg-muted text-muted-foreground"
                      : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  }`}
                >
                  {s.ativo === 1
                    ? "✅ Ativa"
                    : ativando === s.slot
                      ? "Ativando..."
                      : ehFixo
                        ? "Usar padrão"
                        : "Ativar esta"}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
