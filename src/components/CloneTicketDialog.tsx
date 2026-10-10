/**
 * Clonar um chamado para reutilizar os dados em um próximo atendimento.
 *
 * Abre com tudo o que o chamado de origem tem (cliente, contato, título,
 * descrição, solução, orçamento, observações, O.S, valor e prioridade) já
 * preenchido — o usuário ajusta o que mudou e cria a cópia. A cópia nasce como
 * um chamado novo em **Aberto**, com o usuário logado como autor.
 *
 * A imagem do chamado de origem **não** é copiada de propósito: a listagem do
 * Kanban não carrega imagens, e uma foto antiga do equipamento raramente serve
 * para o próximo atendimento.
 */
import { useState, type FormEvent } from "react"
import { CopyPlus } from "lucide-react"
import { toast } from "sonner"
import { useMutation } from "@/lib/backend/react"
import { api } from "@/lib/backend/api"
import { resolveItemsTotal } from "@/lib/currency"
import type { TicketPriority } from "@/lib/ticket-utils"
import { TICKET_CATEGORIES, TICKET_CATEGORY_EMPTY } from "@/lib/ticket-categories"
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
import SlashProductsTextarea from "@/components/SlashProductsTextarea"

/** Campos do chamado de origem que a cópia reaproveita. */
export interface CloneTicketSource {
  number: number
  title?: string
  description?: string
  solucao?: string
  orcamento?: string
  obs?: string
  statusEquipamento?: string
  /** Categoria do chamado de origem (Impressoras, Rede, ...). */
  categoria?: string
  priority: TicketPriority
  guestName?: string
  guestContact?: string
  location?: string
  os?: string
  valorTotal?: number
}

export default function CloneTicketDialog({
  onOpenChange,
  source,
}: {
  onOpenChange: (open: boolean) => void
  source: CloneTicketSource
}) {
  const createTicket = useMutation(api.tickets.create)

  const [title, setTitle] = useState(source.title ?? "")
  const [description, setDescription] = useState(source.description ?? "")
  const [priority, setPriority] = useState<TicketPriority>(source.priority)
  const [guestName, setGuestName] = useState(source.guestName ?? "")
  const [guestContact, setGuestContact] = useState(source.guestContact ?? "")
  const [location, setLocation] = useState(source.location ?? "")
  const [os, setOs] = useState(source.os ?? "")
  const [solucao, setSolucao] = useState(source.solucao ?? "")
  const [orcamento, setOrcamento] = useState(source.orcamento ?? "")
  const [obs, setObs] = useState(source.obs ?? "")
  const [statusEquipamento, setStatusEquipamento] = useState(source.statusEquipamento ?? "")
  const [categoria, setCategoria] = useState(source.categoria ?? "")
  // Valor do chamado de origem: o total salvo ou, quando nunca foi salvo, a soma
  // dos itens (Solução → Orçamento), igual ao resto do app.
  const itemsTotal = resolveItemsTotal(source.solucao, source.orcamento).value
  const sourceTotal = source.valorTotal ?? (itemsTotal !== 0 ? itemsTotal : null)
  const [valorTotal, setValorTotal] = useState(sourceTotal == null ? "" : String(sourceTotal))
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const parsedTotal = valorTotal.trim() ? parseFloat(valorTotal.replace(",", ".")) : undefined
      await createTicket({
        title: title.trim() || undefined,
        description: description.trim() || undefined,
        priority,
        guestName: guestName.trim() || undefined,
        guestContact: guestContact.trim() || undefined,
        location: location.trim() || undefined,
        os: os.trim() || undefined,
        valorTotal:
          parsedTotal !== undefined && Number.isFinite(parsedTotal) ? parsedTotal : undefined,
        solucao: solucao.trim() || undefined,
        orcamento: orcamento.trim() || undefined,
        obs: obs.trim() || undefined,
        statusEquipamento: statusEquipamento.trim() || undefined,
        categoria: categoria || undefined,
      })
      toast.success(`Chamado clonado a partir do #${source.number}`)
      onOpenChange(false)
    } catch {
      toast.error("Erro ao clonar o chamado. Tente novamente.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CopyPlus className="size-5 text-primary" />
            Clonar chamado #{source.number}
          </DialogTitle>
          <DialogDescription>
            Os dados do chamado #{source.number} já vêm preenchidos — ajuste o que mudou e crie a
            cópia como um novo chamado em Aberto.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="clone-guest-name">Nome do cliente</Label>
              <Input
                id="clone-guest-name"
                placeholder="Ex: João Silva"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="clone-guest-contact">Contato</Label>
              <Input
                id="clone-guest-contact"
                placeholder="Ex: (91) 99999-9999 ou e-mail"
                value={guestContact}
                onChange={(e) => setGuestContact(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="clone-title">Título</Label>
            <Input
              id="clone-title"
              placeholder="Ex: Impressora não imprime"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="clone-location">Localização</Label>
            <Input
              id="clone-location"
              placeholder="Ex: Rua Bahia, 446 Centro - Rondon do Pará"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="clone-desc">Descrição</Label>
            <Textarea
              id="clone-desc"
              placeholder="Descreva o problema com detalhes..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="clone-solucao">
              Solução
              <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                Digite / para inserir um produto ou serviço
              </span>
            </Label>
            <SlashProductsTextarea
              id="clone-solucao"
              value={solucao}
              onValueChange={setSolucao}
              placeholder="O que foi feito no atendimento anterior..."
              rows={3}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="clone-orcamento">
              Orçamento
              <span className="ml-2 text-[11px] font-normal text-muted-foreground">
                Digite / para inserir um produto ou serviço
              </span>
            </Label>
            <SlashProductsTextarea
              id="clone-orcamento"
              value={orcamento}
              onValueChange={setOrcamento}
              placeholder="Peças e valores previstos..."
              rows={3}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="clone-os">O.S (Ordem de Serviço)</Label>
              <Input
                id="clone-os"
                placeholder="Ex: OS-2026-001"
                value={os}
                onChange={(e) => setOs(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="clone-valor">Valor Total (R$)</Label>
              <Input
                id="clone-valor"
                type="number"
                step="0.01"
                placeholder="0,00"
                value={valorTotal}
                onChange={(e) => setValorTotal(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label>Categoria</Label>
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
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="clone-equip">Status do equipamento</Label>
              <Input
                id="clone-equip"
                placeholder="Ex: Testado e aprovado"
                value={statusEquipamento}
                onChange={(e) => setStatusEquipamento(e.target.value)}
              />
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
          </div>
          <div className="space-y-2">
            <Label htmlFor="clone-obs">Observações</Label>
            <Textarea
              id="clone-obs"
              placeholder="Anotações internas..."
              value={obs}
              onChange={(e) => setObs(e.target.value)}
              rows={2}
            />
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
            <Button type="submit" disabled={loading} className="gap-1.5">
              <CopyPlus className="size-3.5" />
              {loading ? "Clonando..." : "Clonar chamado"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
