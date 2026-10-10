import { useState, useRef, useCallback, useEffect } from "react"
import { useMutation } from "@/lib/backend/react"
import { api } from "@/lib/backend/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Headphones, ArrowRight, CheckCircle2, ArrowLeft, ImagePlus, X } from "lucide-react"
import { useNavigate } from "react-router"
import { ThemeToggle } from "@/components/ThemeToggle"
import { toast } from "sonner"
import { waBridgeFetch, waBridgeUrl } from "@/lib/whatsapp-bridge"

type TicketPriority = "baixa" | "media" | "alta" | "critica"

// WhatsApp Web notification helper — sends via the local bridge server
async function sendWhatsAppWebNotification(
  ticket: {
    number?: number | null
    title?: string | null
    description?: string | null
    priority: string
    status: string
    guestContact?: string | null
    creatorName?: string | null
    location?: string | null
    os?: string | null
    valorTotal?: number | null
    assigneeName?: string | null
    imageUrl?: string | null
  },
  type: "created" | "status_changed",
  oldStatus?: string | null,
) {
  try {
    const statusRes = await waBridgeFetch(waBridgeUrl("/status"))
    const statusData = await statusRes.json()
    if (statusData.status !== "connected") return

    const contact = ticket.guestContact
    if (!contact) return

    const digits = contact.replace(/\D/g, "")
    if (digits.length < 8) return
    const phone = digits.length > 13 ? digits.slice(-13) : digits

    const SL: Record<string, string> = {
      aberto: "🟢 Aberto",
      em_andamento: "🔵 Em Andamento",
      aguardando: "🟡 Aguardando",
      resolvido: "✅ Resolvido",
      fechado: "⬜ Fechado",
    }
    const PL: Record<string, string> = {
      baixa: "🟢 Baixa",
      media: "🟡 Média",
      alta: "🟠 Alta",
      critica: "🔴 Crítica",
    }

    let msg: string
    if (type === "created") {
      msg = `📋 *Olá ${ticket.creatorName ?? "Solicitante"}, Seu chamado foi aberto no PingOS*\n\n`
      msg += `*Título:* ${ticket.title ?? "Sem título"}\n`
      msg += `*Prioridade:* ${PL[ticket.priority] ?? ticket.priority}\n`
      msg += `*Status:* ${SL[ticket.status] ?? ticket.status}\n`
      if (ticket.os) msg += `*O.S:* ${ticket.os}\n`
      if (ticket.valorTotal != null)
        msg += `*Valor Total:* R$ ${ticket.valorTotal.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}\n`
      msg += `*Solicitante:* ${ticket.creatorName}\n`
      if (ticket.location) msg += `*Localização:* ${ticket.location}\n`
      if (ticket.assigneeName) msg += `*Responsável:* ${ticket.assigneeName}\n`
      msg += `\n*Descrição:*\n${(ticket.description ?? "Sem descrição.").slice(0, 500)}`
    } else {
      const name = ticket.creatorName ?? "Solicitante"
      const osRef = ticket.os ? ` #${ticket.os}` : ` #${ticket.number ?? "?"}`
      msg = `🔄 *Olá ${name}, tudo bem?! Sua Ordem de Serviço${osRef} teve o status atualizado*\n\n`
      msg += `*Título:* ${ticket.title ?? "Sem título"}\n`
      msg += `*Status:* ${SL[oldStatus ?? ""] ?? oldStatus} → *${SL[ticket.status] ?? ticket.status}*\n`
      msg += `*Prioridade:* ${PL[ticket.priority] ?? ticket.priority}\n`
      if (ticket.os) msg += `*O.S:* ${ticket.os}\n`
      if (ticket.valorTotal != null)
        msg += `*Valor Total:* R$ ${ticket.valorTotal.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}\n`
      msg += `*Solicitante:* ${ticket.creatorName}\n`
      if (ticket.location) msg += `*Localização:* ${ticket.location}\n`
      if (ticket.assigneeName) msg += `*Responsável:* ${ticket.assigneeName}\n`
      msg += `\n*Descrição:*\n${(ticket.description ?? "Sem descrição.").slice(0, 500)}`
    }

    const payload: Record<string, unknown> = { phone, message: msg }
    if (ticket.imageUrl) {
      payload.image = ticket.imageUrl
    }
    await waBridgeFetch(waBridgeUrl("/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
  } catch {
    // Silent fail — notification is best-effort
  }
}

const PRIORITY_OPTIONS: {
  value: TicketPriority
  label: string
  emoji: string
}[] = [
  { value: "baixa", label: "Baixa", emoji: "🟢" },
  { value: "media", label: "Média", emoji: "🟡" },
  { value: "alta", label: "Alta", emoji: "🟠" },
  { value: "critica", label: "Crítica", emoji: "🔴" },
]

const MAX_DIMENSION = 1200
const JPEG_QUALITY = 0.8

function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        if (width > height) {
          height = Math.round((height / width) * MAX_DIMENSION)
          width = MAX_DIMENSION
        } else {
          width = Math.round((width / height) * MAX_DIMENSION)
          height = MAX_DIMENSION
        }
      }
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext("2d")
      if (!ctx) {
        reject(new Error("Canvas not supported"))
        return
      }
      ctx.drawImage(img, 0, 0, width, height)
      const compressed = canvas.toDataURL("image/jpeg", JPEG_QUALITY)
      resolve(compressed)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("Failed to load image"))
    }
    img.src = url
  })
}

export default function PublicTicket() {
  const createAsGuest = useMutation(api.tickets.createAsGuest)
  const navigate = useNavigate()
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [submitted, setSubmitted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState<TicketPriority>("media")
  const [guestName, setGuestName] = useState("")
  const [guestContact, setGuestContact] = useState("")
  const [location, setLocation] = useState("")
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined)
  const [imagePreview, setImagePreview] = useState<string | null>(null)

  const canSubmit = guestName.trim() && guestContact.trim() && !loading

  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith("image/")) {
      toast.error("Apenas imagens são aceitas.")
      return
    }

    try {
      toast.info("Processando imagem...")
      const base64 = await compressImage(file)
      setImageUrl(base64)
      setImagePreview(base64)
    } catch {
      toast.error("Erro ao processar imagem.")
    }
  }

  const removeImage = () => {
    setImageUrl(undefined)
    setImagePreview(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ""
    }
  }

  const processFile = useCallback(async (file: File) => {
    if (!file.type.startsWith("image/")) {
      toast.error("Apenas imagens são aceitas.")
      return
    }
    try {
      toast.info("Processando imagem...")
      const base64 = await compressImage(file)
      setImageUrl(base64)
      setImagePreview(base64)
    } catch {
      toast.error("Erro ao processar imagem.")
    }
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      const file = e.dataTransfer.files?.[0]
      if (file) processFile(file)
    },
    [processFile],
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
  }, [])

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile()
          if (file) processFile(file)
          break
        }
      }
    },
    [processFile],
  )

  // Window-level paste listener so Ctrl+V works anywhere on the page,
  // even when the dropzone button is not focused
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      // Skip if the event was already handled by a focused element
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            void processFile(file)
          }
          break
        }
      }
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [processFile])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setLoading(true)
    try {
      await createAsGuest({
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        priority,
        guestName: guestName.trim(),
        guestContact: guestContact.trim(),
        location: location.trim() || undefined,
        imageUrl: imageUrl ?? undefined,
      })
      // Send WhatsApp Web notification
      await sendWhatsAppWebNotification(
        {
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          priority,
          status: "aberto",
          guestContact: guestContact.trim(),
          creatorName: guestName.trim(),
          location: location.trim() || undefined,
          imageUrl: imageUrl ?? undefined,
        },
        "created",
      )
      setSubmitted(true)
    } catch {
      toast.error("Erro ao enviar chamado. Tente novamente.")
    } finally {
      setLoading(false)
    }
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <header className="border-b border-border/50 bg-background/80 backdrop-blur-lg">
          <div className="mx-auto flex h-14 sm:h-16 max-w-2xl items-center justify-between px-4 sm:px-6">
            <div className="flex items-center gap-2.5">
              <div className="flex size-8 items-center justify-center rounded-lg bg-foreground">
                <Headphones className="size-4 text-background" />
              </div>
              <span className="text-lg font-semibold tracking-tight">PingOS</span>
            </div>
            <ThemeToggle />
          </div>
        </header>
        <main className="flex-1 flex items-center justify-center px-4 sm:px-6 py-8 sm:py-12">
          <div className="max-w-md w-full text-center">
            <div className="mx-auto mb-6 flex size-16 items-center justify-center rounded-2xl bg-emerald-50 dark:bg-emerald-950/40">
              <CheckCircle2 className="size-8 text-emerald-600 dark:text-emerald-400" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight">Chamado enviado!</h1>
            <p className="mt-3 text-muted-foreground leading-relaxed">
              Seu chamado foi registrado com sucesso. A equipe de TI irá analisá-lo em breve.
            </p>
            <div className="mt-6 rounded-xl border border-border/50 bg-card p-4 text-left">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                Resumo
              </p>
              <p className="text-sm font-semibold">{title}</p>
              <p className="text-xs text-muted-foreground mt-1">
                Prioridade: {PRIORITY_OPTIONS.find((p) => p.value === priority)?.label} · Enviado
                por {guestName}
              </p>
              {imageUrl && (
                <div className="mt-3">
                  <img
                    src={imageUrl}
                    alt="Imagem do chamado"
                    className="rounded-lg border border-border/40 max-h-40 object-cover"
                  />
                </div>
              )}
            </div>
            <div className="mt-8 flex flex-col gap-3">
              <Button onClick={() => navigate("/")} className="gap-2">
                Voltar ao início
                <ArrowRight className="size-4" />
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setSubmitted(false)
                  setTitle("")
                  setDescription("")
                  setPriority("media")
                  setGuestName("")
                  setGuestContact("")
                  setLocation("")
                  setImageUrl(undefined)
                  setImagePreview(null)
                }}
              >
                Abrir outro chamado
              </Button>
            </div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <header className="border-b border-border/50 bg-background/80 backdrop-blur-lg">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-foreground">
              <Headphones className="size-4 text-background" />
            </div>
            <span className="text-lg font-semibold tracking-tight">PingOS</span>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <ThemeToggle />
            <button
              onClick={() => navigate("/")}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="size-3.5" />
              Início
            </button>
          </div>
        </div>
      </header>

      {/* Form */}
      <main className="flex-1 flex items-start justify-center px-4 sm:px-6 py-6 sm:py-12">
        <div className="max-w-lg w-full">
          <div className="mb-6 sm:mb-8">
            <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-3 py-1 text-xs font-medium text-muted-foreground mb-4">
              <span className="size-1.5 rounded-full bg-emerald-500" />
              Acesso público
            </div>
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Abrir chamado</h1>
            <p className="mt-2 text-muted-foreground text-sm leading-relaxed">
              Descreva seu problema e envie diretamente para a equipe de TI. Não é necessário criar
              conta.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Contact info */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="guest-name">Seu nome *</Label>
                <Input
                  id="guest-name"
                  placeholder="João Silva"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="guest-contact">Contato *</Label>
                <Input
                  id="guest-contact"
                  placeholder="Email, telefone ou WhatsApp"
                  value={guestContact}
                  onChange={(e) => setGuestContact(e.target.value)}
                  required
                />
                <p className="text-[11px] text-muted-foreground/60">
                  E-mail, telefone ou WhatsApp para contato
                </p>
              </div>
            </div>

            <div className="h-px bg-border/40" />

            {/* Location */}
            <div className="space-y-2">
              <Label htmlFor="ticket-location">Localização</Label>
              <Input
                id="ticket-location"
                placeholder="Ex: Rua Bahia, 446 Centro - Rondon do Pará"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
              />
            </div>

            {/* Ticket info */}
            <div className="space-y-2">
              <Label htmlFor="ticket-title">Título do chamado</Label>
              <Input
                id="ticket-title"
                placeholder="Ex: Impressora não imprime"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ticket-desc">Descrição do problema</Label>
              <Textarea
                id="ticket-desc"
                placeholder="Descreva o problema com detalhes: o que aconteceu, quando começou, o que já tentou..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
              />
            </div>

            {/* Image Upload */}
            <div className="space-y-2">
              <Label>Imagem (opcional)</Label>
              {imagePreview ? (
                <div className="relative inline-block">
                  <img
                    src={imagePreview}
                    alt="Preview"
                    className="rounded-xl border border-border/40 max-h-48 object-cover"
                  />
                  <button
                    type="button"
                    onClick={removeImage}
                    className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-foreground text-background shadow-sm hover:opacity-80 transition-opacity"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onPaste={handlePaste}
                  className="flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border/50 bg-muted/20 p-8 text-muted-foreground transition-colors hover:border-border hover:bg-muted/40"
                >
                  <ImagePlus className="size-6" />
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
            </div>

            <div className="space-y-2">
              <Label>Prioridade</Label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {PRIORITY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => setPriority(opt.value)}
                    className={`flex flex-col items-center gap-1 rounded-xl border px-3 py-3 text-xs font-medium transition-all ${
                      priority === opt.value
                        ? "border-foreground bg-foreground/5 text-foreground shadow-sm"
                        : "border-border/50 text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    <span className="text-base">{opt.emoji}</span>
                    <span>{opt.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <Button type="submit" className="w-full gap-2" disabled={!canSubmit}>
              {loading ? (
                <>
                  <div className="size-4 animate-spin rounded-full border-2 border-background border-t-transparent" />
                  Enviando...
                </>
              ) : (
                <>
                  Enviar chamado
                  <ArrowRight className="size-4" />
                </>
              )}
            </Button>

            <p className="text-center text-xs text-muted-foreground/60">
              A equipe entrará em contato pelo meio informado.
            </p>
          </form>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-border/40 py-4">
        <div className="mx-auto max-w-2xl px-4 sm:px-6 flex flex-col items-center gap-3">
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
    </div>
  )
}
