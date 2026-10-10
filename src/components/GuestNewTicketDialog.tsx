/**
 * Novo chamado em nome de um cliente (convidado).
 *
 * Estava dentro de `pages/Dashboard.tsx`; foi movido para cá sem mudança de
 * comportamento.
 */
import { useEffect, useRef, useState } from "react"
import { ImagePlus, X } from "lucide-react"
import { toast } from "sonner"
import { useMutation } from "@/lib/backend/react"
import { api } from "@/lib/backend/api"
import { compressImage, type TicketPriority } from "@/lib/ticket-utils"
import { sendWhatsAppWebNotification } from "@/lib/whatsapp-notify"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
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

export default function GuestNewTicketDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const createAsGuest = useMutation(api.tickets.createAsGuest)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState<TicketPriority>("media")
  const [guestName, setGuestName] = useState("")
  const [guestContact, setGuestContact] = useState("")
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [valorTotal, setValorTotal] = useState("")
  const [os, setOs] = useState("")
  const [location, setLocation] = useState("")
  const [loading, setLoading] = useState(false)

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
    setImageUrl(undefined)
    setImagePreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ""
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!guestName.trim() || !guestContact.trim()) return
    setLoading(true)
    try {
      await createAsGuest({
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        priority,
        guestName: guestName.trim(),
        guestContact: guestContact.trim(),
        valorTotal: valorTotal ? parseFloat(valorTotal.replace(",", ".")) : undefined,
        os: os.trim() || undefined,
        imageUrl,
        location: location.trim() || undefined,
      })
      toast.success("Chamado convidado criado com sucesso!")
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
          os: os.trim() || undefined,
          valorTotal: valorTotal ? parseFloat(valorTotal) : undefined,
          imageUrl,
        },
        "created",
      )
      setTitle("")
      setDescription("")
      setPriority("media")
      setGuestName("")
      setGuestContact("")
      setImageUrl(undefined)
      setValorTotal("")
      setOs("")
      setLocation("")
      setImagePreview(null)
      onOpenChange(false)
    } catch {
      toast.error("Erro ao criar chamado. Tente novamente.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Novo Chamado (Convidado)</DialogTitle>
          <DialogDescription>Abra um chamado em nome de um cliente.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="gn-name">Nome do cliente *</Label>
              <Input
                id="gn-name"
                placeholder="João Silva"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gn-contact">Contato *</Label>
              <Input
                id="gn-contact"
                placeholder="Email, telefone ou WhatsApp"
                value={guestContact}
                onChange={(e) => setGuestContact(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="h-px bg-border/40" />
          <div className="space-y-2">
            <Label htmlFor="gn-title">Título</Label>
            <Input
              id="gn-title"
              placeholder="Ex: Impressora não imprime"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gn-location">Localização</Label>
            <Input
              id="gn-location"
              placeholder="Ex: Rua Bahia, 446 Centro - Rondon do Pará"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gn-desc">Descrição</Label>
            <Textarea
              id="gn-desc"
              placeholder="Descreva o problema com detalhes..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
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
                  className="rounded-xl border border-border/40 max-h-40 object-cover"
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
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>O.S (Ordem de Serviço)</Label>
              <Input
                placeholder="Ex: OS-2026-001"
                value={os}
                onChange={(e) => setOs(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Valor Total (R$)</Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="0,00"
                value={valorTotal}
                onChange={(e) => setValorTotal(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Prioridade</Label>
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
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={loading}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={loading || !guestName.trim() || !guestContact.trim()}>
              {loading ? "Criando..." : "Criar chamado"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
