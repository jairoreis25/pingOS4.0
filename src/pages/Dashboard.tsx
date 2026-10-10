import { useCallback, useEffect, useRef, useState } from "react"
import { useMutation, useQuery } from "@/lib/backend/react"
import { api } from "@/lib/backend/api"
import { useAuth } from "@/hooks/use-auth"
import { usePermissions } from "@/hooks/use-permissions"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Plus,
  Link2,
  LogOut,
  AlertCircle,
  Headphones,
  Settings,
  BarChart3,
  MessageCircle,
  ImagePlus,
  X,
  UserX,
  Trash2,
  Printer,
  Search,
  Smartphone,
  Volume2,
  VolumeX,
  Tag,
  PieChart,
} from "lucide-react"
import { useNavigate } from "react-router"
import { toast } from "sonner"
import type { Id } from "@/lib/backend/types"
import NewTicketDialog from "@/components/NewTicketDialog"
import NotificationSettingsDialog from "@/components/NotificationSettingsDialog"
import NotificationBell from "@/components/NotificationBell"
import MetricsSection from "@/components/MetricsSection"
import StatusChangeConfirmDialog from "@/components/StatusChangeConfirmDialog"
import { ThemeToggle } from "@/components/ThemeToggle"
import SlashProductsTextarea from "@/components/SlashProductsTextarea"
import { useTicketAlerts } from "@/hooks/use-ticket-alerts"
import { isSoundEnabled, setSoundEnabled } from "@/lib/sound"
import { compressImage, type TicketPriority } from "@/lib/ticket-utils"
import { formatBRL, resolveItemsTotal } from "@/lib/currency"
import { sendWhatsAppWebNotification } from "@/lib/whatsapp-notify"
import {
  COLUMNS,
  PRIORITY_CONFIG,
  getInitials,
  statusLabel,
  timeAgo,
  type TicketStatus,
} from "@/lib/ticket-ui"
import { KanbanColumn } from "@/components/KanbanColumn"
import GuestNewTicketDialog from "@/components/GuestNewTicketDialog"
import CameraTicketButton from "@/components/CameraTicketButton"
import WhatsAppWebDialog from "@/components/WhatsAppWebDialog"
import { useMobileCompat } from "@/lib/mobile"
import {
  STATUS_EQUIPAMENTO_OPTIONS,
  STATUS_EQUIPAMENTO_EMPTY,
  buildTicketMessage,
} from "@/lib/desc-fields"
import { TICKET_CATEGORIES, TICKET_CATEGORY_EMPTY } from "@/lib/ticket-categories"

// ---- Ticket Detail Dialog ----

function TicketDetailDialog({
  ticketId,
  open,
  onOpenChange,
  onImageClick,
}: {
  ticketId: Id<"tickets"> | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onImageClick: (url: string) => void
}) {
  const ticket = useQuery(api.tickets.get, ticketId ? { ticketId } : "skip")
  const users = useQuery(api.technicians.list)
  const updateTicket = useMutation(api.tickets.update)
  const updateStatus = useMutation(api.tickets.updateStatus)
  const removeTicket = useMutation(api.tickets.remove)
  const { can, canMoveTo, canViewStatus, canEditTicket } = usePermissions()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [solucao, setSolucao] = useState("")
  const [orcamento, setOrcamento] = useState("")
  const [obs, setObs] = useState("")
  const [statusEquipamento, setStatusEquipamento] = useState("")
  // Categoria do chamado (Impressoras, Rede, ...). É só para uso interno: não
  // entra nas mensagens de WhatsApp/notificação nem no cupom impresso.
  const [categoria, setCategoria] = useState("")
  const [priority, setPriority] = useState<TicketPriority>("media")
  const [guestContact, setGuestContact] = useState("")
  const [valorTotal, setValorTotal] = useState("")
  const [os, setOs] = useState("")
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [assigneeId, setAssigneeId] = useState<string>("")
  const [creatorName, setCreatorName] = useState("")
  const [location, setLocation] = useState("")
  const [loading, setLoading] = useState(false)
  // Status aguardando a confirmação do usuário.
  const [pendingStatus, setPendingStatus] = useState<TicketStatus | null>(null)
  const initRef = useRef(false)
  // Última soma de itens aplicada automaticamente ao Valor Total.
  const itemsTotalRef = useRef(0)
  // Itens que o menu "/" escreveu: a Solução manda; sem itens nela, vale o Orçamento.
  const items = resolveItemsTotal(solucao, orcamento)
  const itemsSum = items.value
  // Itens já gravados no chamado, pela mesma regra.
  const ticketItems = resolveItemsTotal(ticket?.solucao, ticket?.orcamento)
  const ticketItemsSum = ticketItems.value
  /**
   * Valor mostrado ao visualizar: o total gravado ou, quando o chamado nunca
   * teve total salvo, a soma dos itens que já estão na Solução (ou no Orçamento,
   * quando a Solução não tem valores).
   */
  const derivedValorTotal = ticket?.valorTotal ?? (ticketItemsSum !== 0 ? ticketItemsSum : null)

  /**
   * Valor que abre no campo ao entrar em edição. Sem total gravado, começa com
   * a soma dos itens para que salvar passe a valer no chamado.
   */
  const prefillValorTotal = (saved: number | null | undefined) => {
    if (saved != null) return String(saved)
    itemsTotalRef.current = ticketItemsSum
    return ticketItemsSum !== 0 ? String(ticketItemsSum) : ""
  }

  /**
   * A Solução e o Orçamento concentram os itens do serviço (o menu "/" insere
   * "Nome — R$ valor"), então o Valor Total acompanha os itens da Solução — ou,
   * quando ela não tem nenhum valor, os do Orçamento. Um valor digitado à mão
   * continua valendo até a próxima alteração de um desses campos.
   *
   * Linhas com valor negativo ("Desconto — -R$ 50,00") são subtraídas, então a
   * soma pode ficar negativa quando o desconto passa dos itens.
   */
  const applyItemsSum = (nextSolucao: string, nextOrcamento: string) => {
    const sum = resolveItemsTotal(nextSolucao, nextOrcamento).value

    if (sum !== 0) {
      itemsTotalRef.current = sum
      setValorTotal(String(sum))
      return
    }

    // Os itens saíram e o total ainda era o que eles somavam.
    if (itemsTotalRef.current !== 0 && Number(valorTotal) === itemsTotalRef.current) {
      itemsTotalRef.current = 0
      setValorTotal("")
    }
  }

  const handleSolucaoChange = (next: string) => {
    setSolucao(next)
    applyItemsSum(next, orcamento)
  }

  const handleOrcamentoChange = (next: string) => {
    setOrcamento(next)
    applyItemsSum(solucao, next)
  }

  const handleImageFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Apenas imagens são aceitas.")
      return
    }
    try {
      const base64 = await compressImage(file)
      setImageUrl(base64)
      setImagePreview(base64)
    } catch {
      toast.error("Erro ao processar imagem.")
    }
  }

  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    await handleImageFile(file)
  }

  // Window-level paste listener so Ctrl+V works without focusing the dropzone
  useEffect(() => {
    if (!open) return
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            void handleImageFile(file)
          }
          break
        }
      }
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  })

  const removeImage = () => {
    setImageUrl(null as unknown as undefined)
    setImagePreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const handleSave = async () => {
    if (!ticketId) return
    setLoading(true)
    try {
      await updateTicket({
        ticketId,
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        solucao: solucao.trim() || undefined,
        orcamento: orcamento.trim() || undefined,
        obs: obs.trim() || undefined,
        statusEquipamento:
          statusEquipamento && statusEquipamento !== STATUS_EQUIPAMENTO_EMPTY
            ? statusEquipamento
            : "",
        categoria: categoria && categoria !== TICKET_CATEGORY_EMPTY ? categoria : "",
        priority,
        guestContact: guestContact.trim() || undefined,
        imageUrl: imageUrl === null ? "" : imageUrl,
        valorTotal: valorTotal ? parseFloat(valorTotal.replace(",", ".")) : undefined,
        os: os.trim() || undefined,
        creatorName: creatorName.trim() || undefined,
        location: location.trim() || undefined,
        assigneeId:
          assigneeId === "none" ? null : assigneeId ? (assigneeId as Id<"technicians">) : undefined,
      })
      toast.success("Chamado atualizado!")
      setEditing(false)
    } catch {
      toast.error("Erro ao atualizar.")
    } finally {
      setLoading(false)
    }
  }

  /** Pede a confirmação do usuário antes de gravar o novo status. */
  const handleStatusChange = (status: TicketStatus) => {
    if (!ticketId) return
    if (ticket?.status === status) return
    if (!canMoveTo(status)) {
      toast.error("Sem permissão para mover chamados para esta coluna.")
      return
    }
    setPendingStatus(status)
  }

  /** Grava o status já confirmado. */
  const applyStatusChange = async (status: TicketStatus) => {
    if (!ticketId) return
    try {
      const oldStatus = ticket?.status
      await updateStatus({ ticketId, status })
      // Send WhatsApp Web notification for status change
      if (ticket) {
        sendWhatsAppWebNotification(
          {
            number: ticket.number,
            title: ticket.title,
            description: ticket.description,
            solucao: ticket.solucao,
            orcamento: ticket.orcamento,
            obs: ticket.obs,
            statusEquipamento: ticket.statusEquipamento,
            priority: ticket.priority,
            status,
            guestContact: ticket.guestContact,
            creatorName: ticket.creatorName,
            location: ticket.location,
            os: ticket.os,
            valorTotal: derivedValorTotal,
            assigneeName: ticket.assigneeName,
            imageUrl: ticket.imageUrl,
          },
          "status_changed",
          oldStatus ?? undefined,
        )
      }
      toast.success(`Status alterado de "${statusLabel(oldStatus)}" para "${statusLabel(status)}".`)
    } catch {
      toast.error("Erro ao mudar status.")
    }
  }

  const handleDelete = async () => {
    if (!ticketId) return
    if (!can("tickets.delete")) {
      toast.error("Sem permissão para excluir chamados.")
      return
    }
    if (
      !window.confirm(
        "Tem certeza que deseja excluir este chamado? Esta ação não pode ser desfeita.",
      )
    )
      return
    setLoading(true)
    try {
      await removeTicket({ ticketId })
      toast.success("Chamado excluído com sucesso!")
      onOpenChange(false)
    } catch {
      toast.error("Erro ao excluir chamado.")
    } finally {
      setLoading(false)
    }
  }

  const handleShareWhatsApp = () => {
    if (!ticket) return
    const msg = buildTicketMessage(ticket, "created", { greeting: false })
    const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(msg)}`
    window.open(url, "_blank")
  }

  const handlePrint = () => {
    if (!ticket) return
    const priorityLabel = PRIORITY_CONFIG[ticket.priority]?.label ?? ticket.priority
    const statusLabel = COLUMNS.find((c) => c.id === ticket.status)?.label ?? ticket.status
    const printWindow = window.open("", "_blank", "width=320,height=600")
    if (!printWindow) {
      toast.error("Bloqueado pelo navegador. Permita pop-ups.")
      return
    }
    printWindow.document.write(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Chamado #${ticket.number}</title>
<style>
  @page { size: 80mm auto; margin: 2mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 76mm; font-family: 'Courier New', monospace; font-size: 11px; color: #000; padding: 2mm; }
  .center { text-align: center; }
  .bold { font-weight: bold; }
  .line { border-top: 1px dashed #000; margin: 3mm 0; }
  .label { font-size: 9px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
  .value { font-size: 11px; margin-top: 1mm; }
  .big { font-size: 16px; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1mm 0; vertical-align: top; }
  .desc { white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
  img { max-width: 100%; margin-top: 2mm; }
  .footer { margin-top: 4mm; text-align: center; font-size: 8px; color: #888; }
</style></head><body>
  <div class="center">
    <div class="big">PINGOS</div>
    <div class="label">Sistema de Chamados de TI</div>
  </div>
  <div class="line"></div>
  <div class="center"><span class="big">#${ticket.number}</span></div>
  <div class="line"></div>
  <table>
    <tr><td class="label">Status</td><td class="value bold">${statusLabel}</td></tr>
    <tr><td class="label">Prioridade</td><td class="value bold">${priorityLabel}</td></tr>
    ${ticket.os ? `<tr><td class="label">O.S</td><td class="value bold">${ticket.os}</td></tr>` : ""}
    ${derivedValorTotal != null ? `<tr><td class="label">Valor</td><td class="value bold">${formatBRL(derivedValorTotal)}</td></tr>` : ""}
    <tr><td class="label">Título</td><td class="value bold">${ticket.title ?? "Sem título"}</td></tr>
  </table>
  <div class="line"></div>
  <div class="label">Descrição</div>
  <div class="value desc">${ticket.description ?? "Sem descrição."}</div>
  ${ticket.solucao ? `<div class="line"></div><div class="label">Solução</div><div class="value desc">${ticket.solucao}</div>` : ""}
  ${ticket.orcamento ? `<div class="line"></div><div class="label">Orçamento</div><div class="value desc">${ticket.orcamento}</div>` : ""}
  ${ticket.obs ? `<div class="line"></div><div class="label">Obs</div><div class="value desc">${ticket.obs}</div>` : ""}
  ${ticket.statusEquipamento ? `<div class="line"></div><div class="label">Situação</div><div class="value desc">${ticket.statusEquipamento}</div>` : ""}
  <div class="line"></div>
  <table>
    <tr><td class="label">Solicitante</td><td class="value">${ticket.creatorName}</td></tr>
    ${ticket.guestContact ? `<tr><td class="label">Contato</td><td class="value">${ticket.guestContact}</td></tr>` : ""}
    ${ticket.location ? `<tr><td class="label">Local</td><td class="value">${ticket.location}</td></tr>` : ""}
    ${ticket.assigneeName ? `<tr><td class="label">Responsável</td><td class="value">${ticket.assigneeName}</td></tr>` : ""}
  </table>
  <div class="line"></div>
  <div class="center" style="margin-top:2mm;">
    <div class="label">Aberto em</div>
    <div class="value">${new Date(ticket.createdAt).toLocaleString("pt-BR")}</div>
  </div>
  ${ticket.imageUrl ? `<div class="line"></div><div class="label">Imagem</div><img src="${ticket.imageUrl}" />` : ""}
  <div class="footer">PingOS • ${new Date().toLocaleDateString("pt-BR")}</div>
  <script>window.onload = () => { window.print(); }</script>
</body></html>`)
    printWindow.document.close()
  }

  // Sync form state when ticket loads
  useEffect(() => {
    if (ticket && !editing && !initRef.current) {
      initRef.current = true
      setTitle(ticket.title ?? "")
      setDescription(ticket.description ?? "")
      setSolucao(ticket.solucao ?? "")
      setOrcamento(ticket.orcamento ?? "")
      setObs(ticket.obs ?? "")
      setStatusEquipamento(ticket.statusEquipamento ?? "")
      setCategoria(ticket.categoria ?? "")
      setGuestContact(ticket.guestContact ?? "")
      setImageUrl(ticket.imageUrl ?? undefined)
      setImagePreview(ticket.imageUrl ?? null)
      setAssigneeId(ticket.assigneeId ?? "")
      setCreatorName(ticket.creatorName ?? "")
      setValorTotal(prefillValorTotal(ticket.valorTotal))
      setOs(ticket.os ?? "")
      setLocation(ticket.location ?? "")
      setPriority(ticket.priority)
    }
  }, [ticket, editing])

  const statusMeta = COLUMNS.find((c) => c.id === ticket?.status) ?? COLUMNS[0]
  const priorityConfig = PRIORITY_CONFIG[ticket?.priority ?? "media"]

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setEditing(false)
          setTitle("")
          setDescription("")
          setSolucao("")
          setOrcamento("")
          setObs("")
          setStatusEquipamento("")
          setCategoria("")
          setImageUrl(undefined)
          setImagePreview(null)
          setGuestContact("")
          setValorTotal("")
          setOs("")
          setAssigneeId("")
          setCreatorName("")

          initRef.current = false
        }
        onOpenChange(v)
      }}
    >
      <DialogContent className="sm:max-w-xl max-h-[92vh] sm:max-h-[85vh] overflow-y-auto [&_[data-slot=dialog-close]]:top-5 [&_[data-slot=dialog-close]]:right-5 [&_[data-slot=dialog-close]]:flex [&_[data-slot=dialog-close]]:size-10 [&_[data-slot=dialog-close]]:items-center [&_[data-slot=dialog-close]]:justify-center [&_[data-slot=dialog-close]]:rounded-full [&_[data-slot=dialog-close]]:bg-muted/80 [&_[data-slot=dialog-close]]:opacity-100 [&_[data-slot=dialog-close]]:touch-manipulation">
        <StatusChangeConfirmDialog
          open={pendingStatus !== null}
          onOpenChange={(open) => {
            if (!open) setPendingStatus(null)
          }}
          ticketLabel={ticket ? `chamado #${ticket.number} · ${ticket.title}` : undefined}
          requesterName={ticket?.creatorName || ticket?.guestName || undefined}
          fromLabel={statusLabel(ticket?.status)}
          toLabel={statusLabel(pendingStatus)}
          onConfirm={() => {
            const status = pendingStatus
            setPendingStatus(null)
            if (status) void applyStatusChange(status)
          }}
        />
        {ticket ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2 mb-1">
                <Badge
                  variant="outline"
                  className={`${statusMeta.bgColor} ${statusMeta.color} ${statusMeta.borderColor} border font-medium text-xs`}
                >
                  {statusMeta.label}
                </Badge>
                <Badge
                  variant="outline"
                  className={`${priorityConfig.className} border font-medium text-xs`}
                >
                  <span className={`size-1.5 rounded-full ${priorityConfig.dot} mr-1`} />
                  {priorityConfig.label}
                </Badge>
                {ticket.categoria?.trim() && (
                  <Badge
                    variant="outline"
                    className="border-border/60 bg-muted/50 text-muted-foreground font-medium text-xs gap-1"
                  >
                    <Tag className="size-3" />
                    {ticket.categoria}
                  </Badge>
                )}
              </div>
              {editing ? (
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="text-lg font-semibold"
                />
              ) : (
                <DialogTitle>{ticket.title}</DialogTitle>
              )}
              <DialogDescription>
                Criado por {ticket.creatorName} · {timeAgo(ticket.createdAt)}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {/* Status selector */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Status
                </Label>
                <div className="flex flex-wrap gap-2">
                  {COLUMNS.map((col) => (
                    <button
                      key={col.id}
                      onClick={() => handleStatusChange(col.id)}
                      disabled={!canMoveTo(col.id) || !canViewStatus(col.id)}
                      title={
                        !canViewStatus(col.id)
                          ? "Você não tem permissão para visualizar esta coluna"
                          : canMoveTo(col.id)
                            ? `Mover para ${col.label}`
                            : "Sem permissão para mover para esta coluna"
                      }
                      className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-all disabled:cursor-not-allowed disabled:opacity-40 ${
                        ticket.status === col.id
                          ? `${col.bgColor} ${col.color} ${col.borderColor} border`
                          : "border-border/60 text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      {col.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Description + subfields */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Descrição
                </Label>
                {editing ? (
                  <>
                    <Textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      rows={4}
                    />
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label className="text-xs text-muted-foreground">Solução</Label>
                        <span className="text-[11px] text-muted-foreground/70">
                          Digite / para inserir um produto ou serviço
                        </span>
                      </div>
                      <SlashProductsTextarea
                        value={solucao}
                        onValueChange={handleSolucaoChange}
                        rows={2}
                        placeholder="Descreva a solução... (digite / para buscar)"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label className="text-xs text-muted-foreground">Orçamento</Label>
                        <span className="text-[11px] text-muted-foreground/70">
                          Digite / para inserir um produto ou serviço
                        </span>
                      </div>
                      <SlashProductsTextarea
                        value={orcamento}
                        onValueChange={handleOrcamentoChange}
                        rows={2}
                        placeholder="Descreva o orçamento... (digite / para buscar)"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Obs</Label>
                      <Textarea
                        value={obs}
                        onChange={(e) => setObs(e.target.value)}
                        rows={2}
                        placeholder="Observações..."
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs text-muted-foreground">Categoria</Label>
                      <Select
                        value={categoria || TICKET_CATEGORY_EMPTY}
                        onValueChange={(v) => setCategoria(v === TICKET_CATEGORY_EMPTY ? "" : v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Selecione a categoria" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={TICKET_CATEGORY_EMPTY}>(sem categoria)</SelectItem>
                          {TICKET_CATEGORIES.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground/70">
                        Uso interno da equipe — não é enviada ao cliente.
                      </p>
                    </div>
                    <div>
                      <Select
                        value={statusEquipamento || STATUS_EQUIPAMENTO_EMPTY}
                        onValueChange={(v) =>
                          setStatusEquipamento(v === STATUS_EQUIPAMENTO_EMPTY ? "" : v)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="(sem opção selecionada)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={STATUS_EQUIPAMENTO_EMPTY}>
                            (sem opção selecionada)
                          </SelectItem>
                          {STATUS_EQUIPAMENTO_OPTIONS.map((opt) => (
                            <SelectItem key={opt} value={opt}>
                              {opt}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap rounded-lg border border-border/40 bg-muted/30 p-3">
                      {ticket.description || "Sem descrição."}
                    </p>
                    {(ticket.solucao?.trim() ||
                      ticket.orcamento?.trim() ||
                      ticket.obs?.trim() ||
                      ticket.statusEquipamento?.trim() ||
                      ticket.categoria?.trim()) && (
                      <div className="rounded-lg border border-border/40 bg-muted/30 divide-y divide-border/40">
                        {ticket.solucao?.trim() && (
                          <div className="p-3">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Solução
                            </p>
                            <p className="mt-1 text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap">
                              {ticket.solucao}
                            </p>
                          </div>
                        )}
                        {ticket.orcamento?.trim() && (
                          <div className="p-3">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Orçamento
                            </p>
                            <p className="mt-1 text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap">
                              {ticket.orcamento}
                            </p>
                          </div>
                        )}
                        {ticket.obs?.trim() && (
                          <div className="p-3">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Obs
                            </p>
                            <p className="mt-1 text-sm leading-relaxed text-foreground/80 whitespace-pre-wrap">
                              {ticket.obs}
                            </p>
                          </div>
                        )}
                        {ticket.statusEquipamento?.trim() && (
                          <div className="p-3">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Situação
                            </p>
                            <p className="mt-1 text-sm leading-relaxed text-foreground/80">
                              {ticket.statusEquipamento}
                            </p>
                          </div>
                        )}
                        {ticket.categoria?.trim() && (
                          <div className="p-3">
                            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                              Categoria
                            </p>
                            <p className="mt-1 text-sm leading-relaxed text-foreground/80">
                              {ticket.categoria}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Priority */}
              {editing && (
                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Prioridade
                  </Label>
                  <Select value={priority} onValueChange={(v) => setPriority(v as TicketPriority)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="baixa">🟢 Baixa</SelectItem>
                      <SelectItem value="media">🟡 Média</SelectItem>
                      <SelectItem value="alta">🟠 Alta</SelectItem>
                      <SelectItem value="critica">🔴 Crítica</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Image */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Imagem
                </Label>
                {editing ? (
                  <>
                    {imagePreview ? (
                      <div className="relative inline-block">
                        <img
                          src={imagePreview}
                          alt="Preview"
                          title="Toque para ampliar"
                          className="rounded-xl border border-border/40 max-h-48 object-cover cursor-pointer transition-opacity hover:opacity-90"
                          onClick={() => imagePreview && onImageClick(imagePreview)}
                        />
                        <button
                          type="button"
                          aria-label="Remover imagem"
                          onClick={removeImage}
                          className="absolute -top-3 -right-3 flex size-9 items-center justify-center rounded-full bg-foreground text-background shadow-md transition-opacity hover:opacity-80 touch-manipulation sm:size-7"
                        >
                          <X className="size-4" />
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        onDrop={(e) => {
                          e.preventDefault()
                          const file = e.dataTransfer.files?.[0]
                          if (file) void handleImageFile(file)
                        }}
                        onDragOver={(e) => e.preventDefault()}
                        className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border/50 bg-muted/20 p-6 text-muted-foreground transition-colors hover:border-border hover:bg-muted/40"
                      >
                        <ImagePlus className="size-5" />
                        <span className="text-sm font-medium">
                          Clique, arraste ou cole (Ctrl+V) uma imagem
                        </span>
                        <span className="text-[11px] text-muted-foreground/60">
                          PNG, JPG ou WebP · Máx. 5MB
                        </span>
                      </button>
                    )}
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={handleImageChange}
                      className="hidden"
                    />
                  </>
                ) : ticket.imageUrl ? (
                  <img
                    src={ticket.imageUrl}
                    alt="Imagem do chamado"
                    className="rounded-xl border border-border/40 max-h-64 object-cover cursor-pointer transition-opacity hover:opacity-90"
                    onClick={() => onImageClick(ticket.imageUrl!)}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground/60">Nenhuma imagem anexada.</p>
                )}
              </div>

              {/* Solicitante */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Solicitante
                </Label>
                {editing ? (
                  <Input
                    placeholder="Nome do solicitante"
                    value={creatorName}
                    onChange={(e) => setCreatorName(e.target.value)}
                  />
                ) : (
                  <p className="text-sm font-medium">{ticket.creatorName}</p>
                )}
              </div>

              {/* Contact info */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Contato do solicitante
                </Label>
                {editing ? (
                  <Input
                    placeholder="Email, telefone ou WhatsApp"
                    value={guestContact}
                    onChange={(e) => setGuestContact(e.target.value)}
                  />
                ) : (
                  <p className="text-sm font-medium">{ticket.guestContact || "Não informado."}</p>
                )}
              </div>

              {/* Localização */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Localização
                </Label>
                {editing ? (
                  <Input
                    placeholder="Ex: Rua Bahia, 446 Centro - Rondon do Pará"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                  />
                ) : (
                  <p className="text-sm font-medium">{ticket.location || "Não informado."}</p>
                )}
              </div>

              {/* O.S */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  O.S (Ordem de Serviço)
                </Label>
                {editing ? (
                  <Input
                    placeholder="Ex: OS-2026-001"
                    value={os}
                    onChange={(e) => setOs(e.target.value)}
                  />
                ) : (
                  <p className="text-sm font-medium">{ticket.os || "Não informado."}</p>
                )}
              </div>

              {/* Valor Total */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Valor Total (R$)
                </Label>
                {editing ? (
                  <>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder="0,00"
                      value={valorTotal}
                      onChange={(e) => setValorTotal(e.target.value)}
                    />
                    {itemsSum !== 0 && (
                      <p className="text-[11px] text-muted-foreground">
                        Soma dos itens{" "}
                        {items.source === "orcamento" ? "do Orçamento" : "da Solução"}:{" "}
                        {formatBRL(itemsSum)} — o campo acima acompanha esse valor. Valores
                        negativos (ex.: -R$ 50,00) entram como desconto.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-sm font-medium">
                    {derivedValorTotal != null ? (
                      <>
                        {formatBRL(derivedValorTotal)}
                        {ticket.valorTotal == null && (
                          <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">
                            (soma dos itens{" "}
                            {ticketItems.source === "orcamento" ? "do Orçamento" : "da Solução"})
                          </span>
                        )}
                      </>
                    ) : (
                      "Não informado."
                    )}
                  </p>
                )}
              </div>

              {/* Assignee */}
              <div className="space-y-2">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Atribuído a
                </Label>
                {editing ? (
                  <Select
                    value={assigneeId}
                    onValueChange={setAssigneeId}
                    disabled={!can("tickets.assign")}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Ninguém atribuído" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Ninguém</SelectItem>
                      {users
                        ?.filter((t) => t.active || t._id === assigneeId)
                        .map((t) => (
                          <SelectItem key={t._id} value={t._id}>
                            {t.name}
                            {t.funcao ? ` — ${t.funcao}` : ""}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                ) : ticket.assigneeName ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Avatar className="size-5">
                      <AvatarImage src={ticket.assigneeImage ?? undefined} />
                      <AvatarFallback className="text-[9px]">
                        {getInitials(ticket.assigneeName)}
                      </AvatarFallback>
                    </Avatar>
                    <span>{ticket.assigneeName}</span>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground/60">Não atribuído.</p>
                )}
              </div>

              {/* Meta info */}
              <div className="flex items-center justify-between rounded-lg border border-border/40 bg-muted/30 p-3">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Avatar className="size-5">
                    <AvatarImage src={ticket.creatorImage} />
                    <AvatarFallback className="text-[9px]">
                      {getInitials(ticket.creatorName)}
                    </AvatarFallback>
                  </Avatar>
                  <span>{ticket.creatorName}</span>
                </div>
                {ticket.assigneeName && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span>Atribuído a</span>
                    <Avatar className="size-5">
                      <AvatarImage src={ticket.assigneeImage ?? undefined} />
                      <AvatarFallback className="text-[9px]">
                        {getInitials(ticket.assigneeName)}
                      </AvatarFallback>
                    </Avatar>
                    <span>{ticket.assigneeName}</span>
                  </div>
                )}
              </div>
            </div>

            <DialogFooter>
              {editing ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 touch-manipulation"
                    onClick={() => onOpenChange(false)}
                    disabled={loading}
                  >
                    <X className="size-4" />
                    Fechar
                  </Button>
                  <Button variant="outline" onClick={() => setEditing(false)} disabled={loading}>
                    Cancelar
                  </Button>
                  <Button onClick={handleSave} disabled={loading}>
                    {loading ? "Salvando..." : "Salvar"}
                  </Button>
                </>
              ) : (
                <div className="w-full">
                  <div className="w-full space-y-2 sm:flex sm:items-center sm:justify-between sm:gap-2 sm:space-y-0">
                    <div className="flex w-full gap-2 sm:contents">
                      <Button
                        variant="ghost"
                        className="h-10 flex-1 gap-1.5 px-2.5 touch-manipulation sm:h-9 sm:flex-none sm:px-3"
                        onClick={() => onOpenChange(false)}
                        disabled={loading}
                      >
                        <X className="size-5 sm:size-4" />
                        Fechar
                      </Button>
                      {can("tickets.delete") && (
                        <Button
                          variant="ghost"
                          className="h-10 flex-1 gap-1.5 px-2.5 text-destructive hover:text-destructive hover:bg-destructive/10 sm:h-9 sm:flex-none sm:px-3"
                          onClick={handleDelete}
                          disabled={loading}
                        >
                          <Trash2 className="size-5 sm:size-4" />
                          Excluir
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        className="h-10 flex-1 gap-1.5 px-2.5 sm:h-9 sm:flex-none sm:px-3"
                        onClick={handleShareWhatsApp}
                        title="Compartilhar via WhatsApp"
                      >
                        <MessageCircle className="size-5 text-green-600 sm:size-4 dark:text-green-400" />
                        WhatsApp
                      </Button>
                    </div>
                    <div className="flex w-full gap-2 sm:contents">
                      <Button
                        variant="ghost"
                        className="h-10 flex-1 gap-1.5 px-2.5 sm:h-9 sm:flex-none sm:px-3"
                        onClick={handlePrint}
                      >
                        <Printer className="size-5 sm:size-4" />
                        Imprimir
                      </Button>
                      {can("tickets.edit") &&
                        canEditTicket(ticket.status, ticket.assigneeId, ticket.assigneeName) && (
                          <Button
                            variant="outline"
                            className="h-10 flex-1 gap-1.5 px-2.5 sm:h-9 sm:flex-none sm:px-4"
                            onClick={() => {
                              setTitle(ticket.title ?? "")
                              setDescription(ticket.description ?? "")
                              setPriority(ticket.priority)
                              setGuestContact(ticket.guestContact ?? "")
                              setImageUrl(ticket.imageUrl ?? undefined)
                              setImagePreview(ticket.imageUrl ?? null)
                              setAssigneeId(ticket.assigneeId ?? "")
                              setValorTotal(prefillValorTotal(ticket.valorTotal))
                              setOs(ticket.os ?? "")
                              setCreatorName(ticket.creatorName ?? "")
                              setEditing(true)
                            }}
                          >
                            Editar chamado
                          </Button>
                        )}
                    </div>
                    {can("tickets.edit") &&
                      !canEditTicket(ticket.status, ticket.assigneeId, ticket.assigneeName) && (
                        <span className="block w-full text-center text-[11px] text-muted-foreground/70">
                          Você não tem permissão para editar este chamado (coluna ou responsável não
                          permitido).
                        </span>
                      )}
                  </div>
                </div>
              )}
            </DialogFooter>
          </>
        ) : ticket === undefined ? (
          <div className="flex items-center justify-center py-12">
            <div className="size-6 animate-spin rounded-full border-2 border-border border-t-foreground" />
          </div>
        ) : (
          <div className="flex items-center justify-center py-12 text-center">
            <p className="text-sm text-muted-foreground">
              Chamado não encontrado ou sem permissão de visualização.
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ---- WhatsApp Web Connection Dialog ----

// ---- Main Dashboard ----

export default function Dashboard() {
  const { user, signOut } = useAuth()
  const navigate = useNavigate()
  const { isMobile } = useMobileCompat()
  const { can, canMoveTo, canMoveAny, canViewStatus } = usePermissions()
  const canDrag = canMoveAny()
  const canViewTickets = can("tickets.view")
  // Colunas visíveis conforme a regra de visualização por status.
  const visibleColumns = COLUMNS.filter((c) => canViewStatus(c.id))
  // Sem permissão de visualização, não assina a query (que exigiria a
  // permissão e derrubaria a tela "Sem acesso").
  const tickets = useQuery(api.tickets.list, canViewTickets ? {} : "skip")
  useTicketAlerts(tickets)
  const updateStatus = useMutation(api.tickets.updateStatus)

  const [newTicketOpen, setNewTicketOpen] = useState(false)
  const [guestTicketOpen, setGuestTicketOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [soundOn, setSoundOn] = useState(isSoundEnabled)
  const [whatsappWebOpen, setWhatsappWebOpen] = useState(false)
  const [showMetrics, setShowMetrics] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [lightboxImage, setLightboxImage] = useState<string | null>(null)
  const [selectedTicketId, setSelectedTicketId] = useState<Id<"tickets"> | null>(null)
  const [dragOverColumn, setDragOverColumn] = useState<TicketStatus | null>(null)
  const [mobileColumn, setMobileColumn] = useState<TicketStatus>("aberto")
  const dragTicketRef = useRef<Id<"tickets"> | null>(null)

  // Se a coluna selecionada no mobile ficar oculta, cai para a primeira visível.
  const effectiveMobileColumn = visibleColumns.some((c) => c.id === mobileColumn)
    ? mobileColumn
    : (visibleColumns[0]?.id ?? "aberto")

  const handleSignOut = async () => {
    await signOut()
    navigate("/")
  }

  const handleDragStart = useCallback((e: React.DragEvent, ticketId: Id<"tickets">) => {
    dragTicketRef.current = ticketId
    e.dataTransfer.effectAllowed = "move"
    e.dataTransfer.setData("text/plain", ticketId)
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent, status: TicketStatus) => {
      e.preventDefault()
      setDragOverColumn(null)
      const ticketId = dragTicketRef.current
      if (ticketId) {
        dragTicketRef.current = null
        if (!canMoveTo(status)) {
          toast.error("Sem permissão para mover chamados para esta coluna.")
          return
        }
        try {
          const oldTicket = tickets?.find((t) => t._id === ticketId)
          const oldStatus = oldTicket?.status
          await updateStatus({ ticketId, status })
          if (oldTicket) {
            sendWhatsAppWebNotification(
              {
                number: oldTicket.number,
                title: oldTicket.title,
                description: oldTicket.description,
                solucao: oldTicket.solucao,
                orcamento: oldTicket.orcamento,
                obs: oldTicket.obs,
                statusEquipamento: oldTicket.statusEquipamento,
                priority: oldTicket.priority,
                status,
                guestContact: oldTicket.guestContact,
                creatorName: oldTicket.creatorName,
                location: oldTicket.location,
                os: oldTicket.os,
                valorTotal: oldTicket.valorTotal,
                assigneeName: oldTicket.assigneeName,
                imageUrl: oldTicket.imageUrl,
              },
              "status_changed",
              oldStatus ?? undefined,
            )
          }
          toast.success(`Chamado movido para "${COLUMNS.find((c) => c.id === status)?.label}"`)
        } catch {
          toast.error("Erro ao mover chamado.")
        }
      }
    },
    [updateStatus, tickets, canMoveTo],
  )

  const handleDragOver = useCallback((e: React.DragEvent, status: TicketStatus) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = "move"
    setDragOverColumn(status)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null)
  }, [])

  const filteredTickets =
    tickets?.filter((t) => {
      if (!searchQuery.trim()) return true
      const q = searchQuery.toLowerCase()
      return (
        t.title?.toLowerCase().includes(q) ||
        t.description?.toLowerCase().includes(q) ||
        String(t.number).includes(q) ||
        t.os?.toLowerCase().includes(q) ||
        t.guestContact?.toLowerCase().includes(q) ||
        t.guestName?.toLowerCase().includes(q)
      )
    }) ?? []

  const ticketsByStatus = (status: TicketStatus) =>
    filteredTickets.filter((t) => t.status === status)

  const totalTickets = tickets?.length ?? 0
  const openTickets = tickets?.filter((t) => t.status === "aberto").length ?? 0
  const inProgressTickets = tickets?.filter((t) => t.status === "em_andamento").length ?? 0

  // Sem permissão de visualização → tela bloqueada (nunca depende só do frontend).
  if (!can("tickets.view")) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background px-6">
        <div className="max-w-sm text-center space-y-4">
          <div className="mx-auto flex size-12 items-center justify-center rounded-xl bg-muted">
            <AlertCircle className="size-6 text-muted-foreground" />
          </div>
          <h1 className="text-lg font-semibold">Sem acesso ao painel</h1>
          <p className="text-sm text-muted-foreground">
            Sua conta não possui permissão para visualizar os chamados. Entre em contato com o
            administrador do sistema.
          </p>
          <Button variant="outline" onClick={handleSignOut}>
            Sair
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-page-glow">
      <header className="sticky top-0 z-40 border-b border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap sm:gap-4">
          <div className="order-2 flex w-full items-center gap-3 sm:order-1 sm:w-auto sm:flex-1">
            <div className="flex shrink-0 items-center gap-2">
              <div className="flex size-8 items-center justify-center rounded-lg bg-blue-600 shadow-sm">
                <span className="text-sm font-semibold text-white">P</span>
              </div>
              <span className="text-base font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                PingOS
              </span>
            </div>
            <div className="hidden items-center gap-2 rounded-lg bg-slate-100 px-3 py-1.5 md:flex dark:bg-slate-800">
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-slate-400" />
                <span className="font-semibold text-slate-900 tabular-nums dark:text-slate-100">
                  {String(totalTickets)}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">chamados</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-blue-500" />
                <span className="font-semibold text-slate-900 tabular-nums dark:text-slate-100">
                  {String(openTickets)}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">abertos</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full bg-amber-500" />
                <span className="font-semibold text-slate-900 tabular-nums dark:text-slate-100">
                  {String(inProgressTickets)}
                </span>
                <span className="text-xs text-slate-500 dark:text-slate-400">em andamento</span>
              </span>
            </div>
            {can("tickets.create") && (
              <Button
                onClick={() => setNewTicketOpen(true)}
                title="Abrir novo chamado"
                className="shrink-0 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all duration-150 hover:bg-blue-700"
              >
                <Plus className="size-4" strokeWidth={1.5} />
                <span className="hidden sm:inline">Novo chamado</span>
              </Button>
            )}
            {can("tickets.create") && (
              <CameraTicketButton guestName={user?.name} guestContact={user?.email} />
            )}
            <div className="relative flex-1 sm:mx-auto sm:w-72 sm:flex-none">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
              <Input
                placeholder="Buscar chamados..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-9 w-full rounded-lg border border-slate-300 bg-slate-100 pl-9 pr-8 text-sm transition-all duration-150 focus-visible:border-blue-500 focus-visible:ring-2 focus-visible:ring-blue-500/20 sm:w-72 dark:border-slate-700 dark:bg-slate-800"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          </div>
          <div className="order-1 flex items-center justify-end gap-1 sm:order-2">
            {can("settings.manage") && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-lg text-slate-500 transition-all duration-150 hover:text-blue-600"
                onClick={() => setWhatsappWebOpen(true)}
                title="WhatsApp Web"
              >
                <Smartphone
                  className="size-4 text-green-600 dark:text-green-400"
                  strokeWidth={1.5}
                />
              </Button>
            )}
            <ThemeToggle />
            <Button
              variant="ghost"
              size="icon"
              className="size-8 rounded-lg text-slate-500 transition-all duration-150 hover:text-blue-600"
              title={soundOn ? "Desativar alerta sonoro" : "Ativar alerta sonoro"}
              onClick={() => {
                const next = !soundOn
                setSoundOn(next)
                setSoundEnabled(next)
              }}
            >
              {soundOn ? (
                <Volume2 className="size-4" strokeWidth={1.5} />
              ) : (
                <VolumeX className="size-4" strokeWidth={1.5} />
              )}
            </Button>
            <NotificationBell onTicketClick={(id) => setSelectedTicketId(id)} />
            {can("settings.manage") && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-lg text-slate-500 transition-all duration-150 hover:text-blue-600"
                onClick={() => setSettingsOpen(true)}
                title="Configurações"
              >
                <Settings className="size-4" strokeWidth={1.5} />
              </Button>
            )}
            {can("metrics.view") && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-lg text-slate-500 transition-all duration-150 hover:text-blue-600"
                onClick={() => setShowMetrics(!showMetrics)}
                title={showMetrics ? "Ocultar métricas" : "Mostrar métricas"}
              >
                <BarChart3 className="size-4" strokeWidth={1.5} />
              </Button>
            )}
            {can("reports.view") && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-lg text-slate-500 transition-all duration-150 hover:text-blue-600"
                onClick={() => navigate("/reports")}
                title="Relatórios"
              >
                <PieChart className="size-4" strokeWidth={1.5} />
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="hidden sm:inline-flex size-8 rounded-lg text-slate-500 transition-all duration-150 hover:text-blue-600"
              title="Copiar link para clientes"
              onClick={() => {
                navigator.clipboard
                  .writeText(`${window.location.origin}/chamado/novo`)
                  .then(() => {
                    toast.success("Link copiado para compartilhar com clientes!")
                  })
                  .catch(() => {
                    toast.error("Não foi possível copiar o link.")
                  })
              }}
            >
              <Link2 className="size-4" strokeWidth={1.5} />
              <span className="sr-only">Link para clientes</span>
            </Button>
            {can("tickets.create") && (
              <Button
                variant="ghost"
                size="icon"
                className="hidden sm:inline-flex size-8 rounded-lg text-slate-500 transition-all duration-150 hover:text-blue-600"
                onClick={() => setGuestTicketOpen(true)}
                title="Abrir chamado convidado"
              >
                <UserX className="size-4" strokeWidth={1.5} />
                <span className="sr-only">Chamado convidado</span>
              </Button>
            )}
            <div className="hidden sm:flex items-center gap-1.5 pl-1.5">
              <Avatar className="size-8">
                <AvatarImage src={user?.image} />
                <AvatarFallback className="text-xs">
                  {user?.name
                    ? getInitials(user.name)
                    : user?.email
                      ? user.email[0].toUpperCase()
                      : "?"}
                </AvatarFallback>
              </Avatar>
              {user?.name && (
                <span className="hidden max-w-28 truncate text-sm font-medium text-slate-900 lg:inline dark:text-slate-100">
                  {user.name}
                </span>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-lg text-slate-500 transition-all duration-150 hover:text-blue-600"
                onClick={handleSignOut}
                title="Sair"
              >
                <LogOut className="size-4" strokeWidth={1.5} />
              </Button>
            </div>
          </div>
        </div>
      </header>

      {showMetrics && <MetricsSection />}

      <main className="mx-auto max-w-[1600px] px-4 sm:px-6 py-6 min-h-[60vh]">
        {isMobile ? (
          /* Mobile: one column at a time via chips — no sideways scrolling.
             Status changes are made inside the ticket detail dialog. */
          <div className="space-y-4">
            <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1">
              {visibleColumns.map((column) => {
                const count = ticketsByStatus(column.id).length
                const active = effectiveMobileColumn === column.id
                return (
                  <button
                    key={column.id}
                    onClick={() => setMobileColumn(column.id)}
                    className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border/60 bg-card text-muted-foreground"
                    }`}
                  >
                    {column.label}
                    <span
                      className={`flex size-5 items-center justify-center rounded-full text-[10px] font-semibold ${
                        active ? "bg-primary-foreground/20" : "bg-muted"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                )
              })}
            </div>
            {visibleColumns
              .filter((c) => c.id === effectiveMobileColumn)
              .map((column) => (
                <KanbanColumn
                  key={column.id}
                  column={column}
                  tickets={ticketsByStatus(column.id)}
                  onDragStart={handleDragStart}
                  onDrop={handleDrop}
                  onDragOver={(e) => handleDragOver(e, column.id)}
                  onDragLeave={handleDragLeave}
                  isDragOver={dragOverColumn === column.id}
                  onTicketClick={(id) => setSelectedTicketId(id)}
                  canDrag={canDrag}
                />
              ))}
          </div>
        ) : (
          <div className="flex gap-4 overflow-x-auto pb-4">
            {visibleColumns.map((column) => (
              <KanbanColumn
                key={column.id}
                column={column}
                tickets={ticketsByStatus(column.id)}
                onDragStart={handleDragStart}
                onDrop={handleDrop}
                onDragOver={(e) => handleDragOver(e, column.id)}
                onDragLeave={handleDragLeave}
                isDragOver={dragOverColumn === column.id}
                onTicketClick={(id) => setSelectedTicketId(id)}
                canDrag={canDrag}
              />
            ))}
          </div>
        )}
      </main>

      <footer className="border-t border-border/40 py-4">
        <div className="mx-auto max-w-[1600px] px-6 flex flex-col items-center gap-2">
          <div className="flex items-center gap-2">
            <div className="flex size-6 items-center justify-center rounded-md bg-primary">
              <Headphones className="size-3 text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground">PingOS</span>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            © {new Date().getFullYear()} PingOS. Desenvolvido por Jairo Reis.
          </p>
        </div>
      </footer>

      <NewTicketDialog open={newTicketOpen} onOpenChange={setNewTicketOpen} />
      <GuestNewTicketDialog open={guestTicketOpen} onOpenChange={setGuestTicketOpen} />
      {settingsOpen && (
        <NotificationSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      )}
      <WhatsAppWebDialog open={whatsappWebOpen} onOpenChange={setWhatsappWebOpen} />
      {selectedTicketId && (
        <TicketDetailDialog
          ticketId={selectedTicketId}
          open={true}
          onOpenChange={(open) => {
            if (!open) setSelectedTicketId(null)
          }}
          onImageClick={(url) => setLightboxImage(url)}
        />
      )}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-6 bg-black/85 p-6"
          onClick={() => setLightboxImage(null)}
          role="dialog"
          aria-modal="true"
          aria-label="Imagem ampliada"
        >
          <img
            src={lightboxImage}
            alt="Imagem ampliada"
            className="pointer-events-none max-h-[72vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
          />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              setLightboxImage(null)
            }}
            className="inline-flex items-center gap-2 rounded-full bg-white/20 px-6 py-3 text-sm font-medium text-white transition-colors hover:bg-white/30 active:scale-95 touch-manipulation"
          >
            <X className="size-4" />
            Fechar
          </button>
          <button
            type="button"
            aria-label="Fechar imagem"
            onClick={(e) => {
              e.stopPropagation()
              setLightboxImage(null)
            }}
            className="absolute right-4 top-4 z-20 flex size-11 items-center justify-center rounded-full bg-white/25 text-white transition-colors hover:bg-white/35 active:scale-95 touch-manipulation sm:size-10"
          >
            <X className="size-5" />
          </button>
        </div>
      )}
    </div>
  )
}
