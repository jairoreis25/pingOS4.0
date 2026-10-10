import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react"
import { useMutation } from "@/lib/backend/react"
import { api } from "@/lib/backend/api"
import { Button } from "@/components/ui/button"
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
import { ImagePlus, X } from "lucide-react"
import { toast } from "sonner"
import { compressImage, type TicketPriority } from "@/lib/ticket-utils"

export default function NewTicketDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const createTicket = useMutation(api.tickets.create)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [priority, setPriority] = useState<TicketPriority>("media")
  const [imageUrl, setImageUrl] = useState<string | undefined>(undefined)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [valorTotal, setValorTotal] = useState("")
  const [os, setOs] = useState("")
  const [guestName, setGuestName] = useState("")
  const [guestContact, setGuestContact] = useState("")
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

  const handleImageChange = async (e: ChangeEvent<HTMLInputElement>) => {
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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      await createTicket({
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        priority,
        imageUrl,
        valorTotal: valorTotal ? parseFloat(valorTotal.replace(",", ".")) : undefined,
        os: os.trim() || undefined,
        guestName: guestName.trim() || undefined,
        guestContact: guestContact.trim() || undefined,
        location: location.trim() || undefined,
      })
      toast.success("Chamado criado com sucesso!")
      // O WhatsApp só é disparado quando o contato do cliente é informado
      setTitle("")
      setDescription("")
      setPriority("media")
      setImageUrl(undefined)
      setImagePreview(null)
      setValorTotal("")
      setOs("")
      setGuestName("")
      setGuestContact("")
      setLocation("")
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
          <DialogTitle>Novo Chamado</DialogTitle>
          <DialogDescription>Descreva o problema para a equipe de TI.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="ticket-guest-name">Nome do cliente</Label>
              <Input
                id="ticket-guest-name"
                placeholder="Ex: João Silva"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="ticket-guest-contact">Contato</Label>
              <Input
                id="ticket-guest-contact"
                placeholder="Ex: (91) 99999-9999 ou e-mail"
                value={guestContact}
                onChange={(e) => setGuestContact(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="ticket-title">Título</Label>
            <Input
              id="ticket-title"
              placeholder="Ex: Impressora não imprime"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ticket-location-new">Localização</Label>
            <Input
              id="ticket-location-new"
              placeholder="Ex: Rua Bahia, 446 Centro - Rondon do Pará"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="ticket-desc">Descrição</Label>
            <Textarea
              id="ticket-desc"
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
            <Button type="submit" disabled={loading}>
              {loading ? "Criando..." : "Criar chamado"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
