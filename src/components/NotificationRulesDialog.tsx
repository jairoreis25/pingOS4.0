import { useState } from "react"
import { useMutation, useQuery } from "@/lib/backend/react"
import { api } from "@/lib/backend/api"
import type { Id } from "@/lib/backend/types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import {
  ArrowLeft,
  BellRing,
  Clock,
  Mail,
  MessageCircle,
  Pencil,
  Play,
  Plus,
  Save,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

type Rule = {
  _id: Id<"notificationRules">
  name: string
  statuses: string[]
  days: number
  recipient: "cliente" | "responsavel" | "ambos"
  channels: string[]
  active: boolean
  createdAt: number
  updatedAt: number
}

const STATUS_OPTIONS = [
  { value: "aberto", label: "Aberto" },
  { value: "em_andamento", label: "Em Andamento" },
  { value: "aguardando", label: "Aguardando" },
]

const CHANNEL_OPTIONS = [
  { value: "inapp", label: "In-app (sino)" },
  { value: "email", label: "E-mail" },
  { value: "whatsapp", label: "WhatsApp" },
]

const CHANNEL_ICONS: Record<string, typeof Mail> = {
  inapp: BellRing,
  email: Mail,
  whatsapp: MessageCircle,
}

const RECIPIENT_OPTIONS = [
  {
    value: "cliente",
    label: "Cliente (solicitante)",
    desc: "Avisa quem abriu o chamado",
  },
  {
    value: "responsavel",
    label: "Responsável",
    desc: "Avisa o técnico atribuído ao chamado",
  },
  {
    value: "ambos",
    label: "Cliente e Responsável",
    desc: "Avisa as duas partes",
  },
]

function toggleIn(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value]
}

export default function NotificationRulesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const rules = useQuery(api.notificationRules.list)
  const create = useMutation(api.notificationRules.create)
  const update = useMutation(api.notificationRules.update)
  const remove = useMutation(api.notificationRules.remove)
  const runNow = useMutation(api.inactivityCheck.runNow)

  const [view, setView] = useState<"list" | "form">("list")
  const [editing, setEditing] = useState<Rule | null>(null)
  const [deletingId, setDeletingId] = useState<Id<"notificationRules"> | null>(null)
  const [running, setRunning] = useState(false)

  // ---- form state ----
  const [name, setName] = useState("")
  const [statuses, setStatuses] = useState<string[]>(["aguardando"])
  const [days, setDays] = useState(3)
  const [recipient, setRecipient] = useState("ambos")
  const [channels, setChannels] = useState<string[]>(["inapp", "email"])
  const [active, setActive] = useState(true)

  const openNew = () => {
    setEditing(null)
    setName("")
    setStatuses(["aguardando"])
    setDays(3)
    setRecipient("ambos")
    setChannels(["inapp", "email"])
    setActive(true)
    setView("form")
  }

  const openEdit = (rule: Rule) => {
    setEditing(rule)
    setName(rule.name)
    setStatuses(rule.statuses)
    setDays(rule.days)
    setRecipient(rule.recipient)
    setChannels(rule.channels)
    setActive(rule.active)
    setView("form")
  }

  const handleSave = async () => {
    try {
      if (editing) {
        await update({
          ruleId: editing._id,
          name,
          statuses,
          days,
          recipient,
          channels,
          active,
        })
        toast.success("Regra atualizada!")
      } else {
        await create({ name, statuses, days, recipient, channels, active })
        toast.success("Regra criada!")
      }
      setView("list")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar a regra.")
    }
  }

  const handleDelete = async (ruleId: Id<"notificationRules">) => {
    try {
      await remove({ ruleId })
      toast.success("Regra excluída.")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao excluir a regra.")
    } finally {
      setDeletingId(null)
    }
  }

  const handleToggleActive = async (rule: Rule, value: boolean) => {
    try {
      await update({ ruleId: rule._id, active: value })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao atualizar a regra.")
    }
  }

  const handleRunNow = async () => {
    setRunning(true)
    try {
      const result = await runNow({})
      if (result.rulesChecked === 0) {
        toast.info("Nenhuma regra ativa configurada.")
      } else {
        toast.success(
          `Verificação concluída: ${result.ticketsNotified} chamado(s) notificado(s) · ${result.inAppCreated} no sino · ${result.emailsScheduled} e-mail(s) · ${result.whatsappScheduled} WhatsApp.`,
        )
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao executar a verificação.")
    } finally {
      setRunning(false)
    }
  }

  const close = (next: boolean) => {
    if (!next) setView("list")
    onOpenChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl h-[92vh] max-h-[92vh] supports-[height:100dvh]:h-[92dvh] supports-[height:100dvh]:max-h-[92dvh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Regras de inatividade</DialogTitle>
          <DialogDescription>
            Notifica cliente e/ou responsável quando um chamado fica parado sem atualizações. O
            contador zera a cada atualização do chamado.
          </DialogDescription>
        </DialogHeader>

        {view === "form" ? (
          <ScrollArea className="min-h-0 flex-1 pr-2">
            <div className="space-y-5">
              <div className="grid gap-2">
                <Label htmlFor="rule-name">Nome da regra</Label>
                <Input
                  id="rule-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ex.: Cliente esperando aprovação"
                />
              </div>

              <div className="grid gap-2">
                <Label>Status do chamado</Label>
                <p className="text-xs text-muted-foreground">
                  O alerta dispara quando o chamado fica em um destes status sem atualização.
                </p>
                <div className="grid gap-2 sm:grid-cols-3">
                  {STATUS_OPTIONS.map((s) => (
                    <label
                      key={s.value}
                      className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-2.5 text-sm transition-colors hover:bg-muted/50"
                    >
                      <Checkbox
                        checked={statuses.includes(s.value)}
                        onCheckedChange={() => setStatuses((prev) => toggleIn(prev, s.value))}
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="rule-days">Inatividade (dias)</Label>
                  <Input
                    id="rule-days"
                    type="number"
                    min={1}
                    max={365}
                    value={days}
                    onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 1))}
                  />
                </div>
                <div className="grid gap-2">
                  <Label>Regra ativa</Label>
                  <div className="flex h-10 items-center gap-2 rounded-lg border border-border/60 bg-card px-3">
                    <Switch checked={active} onCheckedChange={setActive} aria-label="Regra ativa" />
                    <span className="text-sm text-muted-foreground">
                      {active ? "Ativa" : "Inativa"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="grid gap-2">
                <Label>Destinatário</Label>
                <div className="grid gap-2">
                  {RECIPIENT_OPTIONS.map((r) => (
                    <label
                      key={r.value}
                      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors ${
                        recipient === r.value
                          ? "border-primary/50 bg-primary/5"
                          : "border-border/60 bg-card hover:bg-muted/50"
                      }`}
                    >
                      <input
                        type="radio"
                        name="recipient"
                        value={r.value}
                        checked={recipient === r.value}
                        onChange={() => setRecipient(r.value)}
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-col sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                          <span className="text-sm font-medium">{r.label}</span>
                          <span className="text-xs text-muted-foreground sm:text-right">
                            {r.desc}
                          </span>
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="grid gap-2">
                <Label>Canais de envio</Label>
                <div className="grid gap-2 sm:grid-cols-3">
                  {CHANNEL_OPTIONS.map((c) => {
                    const Icon = CHANNEL_ICONS[c.value]
                    return (
                      <label
                        key={c.value}
                        className="flex cursor-pointer items-center gap-2 rounded-lg border border-border/60 bg-card px-3 py-2.5 text-sm transition-colors hover:bg-muted/50"
                      >
                        <Checkbox
                          checked={channels.includes(c.value)}
                          onCheckedChange={() => setChannels((prev) => toggleIn(prev, c.value))}
                        />
                        <Icon className="size-4 text-muted-foreground" />
                        {c.label}
                      </label>
                    )
                  })}
                </div>
                {channels.length === 0 && (
                  <p className="text-xs text-red-500">Selecione pelo menos um canal.</p>
                )}
              </div>

              <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-end gap-2 pb-1">
                <Button
                  variant="outline"
                  onClick={() => setView("list")}
                  className="w-full gap-1.5 sm:w-auto"
                >
                  <ArrowLeft className="size-4" />
                  Voltar
                </Button>
                <Button onClick={handleSave} className="w-full gap-1.5 sm:w-auto">
                  <Save className="size-4" />
                  {editing ? "Salvar alterações" : "Criar regra"}
                </Button>
              </div>
            </div>
          </ScrollArea>
        ) : (
          <>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 border-b pb-3">
              <Button onClick={openNew} size="sm" className="w-full gap-1.5 sm:w-auto">
                <Plus className="size-4" />
                Adicionar nova regra
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full gap-1.5 sm:w-auto"
                onClick={handleRunNow}
                disabled={running}
              >
                <Play className="size-3.5" />
                {running ? "Verificando..." : "Testar agora"}
              </Button>
            </div>

            <ScrollArea className="min-h-0 flex-1 pr-2">
              {rules === undefined ? (
                <div className="space-y-2 pt-2">
                  {[0, 1].map((i) => (
                    <div key={i} className="h-24 animate-pulse rounded-xl border bg-muted/40" />
                  ))}
                </div>
              ) : rules.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
                  <BellRing className="size-8 text-muted-foreground/50" />
                  <p className="text-sm font-medium">Nenhuma regra configurada</p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    Crie uma regra para ser avisado quando chamados ficarem parados sem atualização.
                    Exemplo: notificar o cliente quando um chamado ficar em &quot;Aguardando&quot;
                    por 3 dias.
                  </p>
                </div>
              ) : (
                <div className="space-y-3 pt-3">
                  {rules.map((rule) => {
                    return (
                      <div
                        key={rule._id}
                        className="rounded-xl border border-border/60 bg-card p-4 transition-shadow hover:shadow-sm"
                      >
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{rule.name}</p>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {rule.statuses.map((s) => (
                                <Badge key={s} variant="secondary" className="gap-1 text-[11px]">
                                  <span className="flex size-1.5 rounded-full bg-primary/60" />
                                  {STATUS_OPTIONS.find((o) => o.value === s)?.label ?? s}
                                </Badge>
                              ))}
                              <Badge
                                variant="outline"
                                className="gap-1 text-[11px] text-muted-foreground"
                              >
                                <Clock className="size-3" />
                                {rule.days} {rule.days === 1 ? "dia" : "dias"}
                              </Badge>
                              <Badge
                                variant="outline"
                                className="gap-1 text-[11px] text-muted-foreground"
                              >
                                {rule.recipient === "cliente"
                                  ? "Cliente"
                                  : rule.recipient === "responsavel"
                                    ? "Responsável"
                                    : "Cliente e responsável"}
                              </Badge>
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                              {rule.channels.length === 0 ? (
                                <span>Sem canais</span>
                              ) : (
                                rule.channels.map((c) => {
                                  const ChannelIcon = CHANNEL_ICONS[c] ?? Mail
                                  return (
                                    <span
                                      key={c}
                                      className="flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-medium"
                                    >
                                      <ChannelIcon className="size-3" />
                                      {CHANNEL_OPTIONS.find((o) => o.value === c)?.label}
                                    </span>
                                  )
                                })
                              )}
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
                            <Switch
                              checked={rule.active}
                              onCheckedChange={(value) => handleToggleActive(rule, value)}
                              aria-label="Regra ativa"
                            />
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8"
                              title="Editar"
                              aria-label="Editar regra"
                              onClick={() => openEdit(rule)}
                            >
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-8 text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300"
                              title="Excluir"
                              aria-label="Excluir regra"
                              onClick={() => setDeletingId(rule._id)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </div>
                        </div>
                        {deletingId === rule._id && (
                          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 dark:border-red-900/60 dark:bg-red-950/40">
                            <p className="text-xs font-medium text-red-700 dark:text-red-300">
                              Excluir a regra <strong>{rule.name}</strong>? Os alertas dela deixarão
                              de ser enviados.
                            </p>
                            <div className="flex gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => setDeletingId(null)}
                              >
                                Cancelar
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                className="h-7 text-xs"
                                onClick={() => handleDelete(rule._id)}
                              >
                                Excluir
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </ScrollArea>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
