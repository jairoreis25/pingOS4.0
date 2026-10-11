/**
 * Coluna do Kanban (+ o card do chamado usado dentro dela).
 *
 * Estavam declarados dentro de `pages/Dashboard.tsx`; foram movidos para cá sem
 * mudança de comportamento (mesmos props, mesma memoização).
 *
 * O visual segue uma hierarquia clara: a coluna é um cartão branco com uma barra
 * colorida por status; o card destaca a prioridade pela borda lateral esquerda e
 * pela pill, com avatar/nome, título, descrição, valor, data e ações preservados.
 */
import { memo, useRef, useState } from "react"
import {
  AlertTriangle,
  ChevronDown,
  Clock,
  CopyPlus,
  GripVertical,
  MoreVertical,
  Ticket,
} from "lucide-react"
import type { Id } from "@/lib/backend/types"
import type { TicketPriority } from "@/lib/ticket-utils"
import { usePermissions } from "@/hooks/use-permissions"
import { ScrollArea } from "@/components/ui/scroll-area"
import StatusChangeConfirmDialog from "@/components/StatusChangeConfirmDialog"
import CloneTicketDialog from "@/components/CloneTicketDialog"
import { formatBRL, resolveItemsTotal } from "@/lib/currency"
import { isSlaOverdue, isUnseenTicket, slaLabel, slaOverdueLabel } from "@/lib/sla"
import {
  COLUMNS,
  DRAG_TICKET_MIME,
  PRIORITY_CONFIG,
  getInitials,
  sameTicketList,
  statusLabel,
  type DraggedTicketInfo,
  type TicketStatus,
} from "@/lib/ticket-ui"

/**
 * Borda lateral do card nas cores do iOS (a paleta do redesign). Fica separada do
 * `PRIORITY_CONFIG` de propósito: aquele objeto é a fonte semântica usada em
 * vários componentes (pill, dot, relatórios) e não deve mudar por causa do card.
 */
const PRIORITY_IOS_BORDER: Record<TicketPriority, string> = {
  critica: "border-l-[#FF3B30]",
  alta: "border-l-[#FF9500]",
  media: "border-l-[#FFCC00]",
  baixa: "border-l-[#34C759]",
}

export const KanbanCard = memo(
  function KanbanCard({
    ticket,
    onDragStart,
    onTicketClick,
    canDrag = true,
    canClone = false,
  }: {
    ticket: {
      _id: Id<"tickets">
      number: number
      title?: string
      description?: string
      solucao?: string
      orcamento?: string
      obs?: string
      statusEquipamento?: string
      /** Categoria (Impressoras, Rede, ...) — classificacao interna do chamado. */
      categoria?: string
      valorTotal?: number
      priority: TicketPriority
      guestName?: string
      guestContact?: string
      location?: string
      os?: string
      creatorName: string
      creatorImage?: string
      createdAt: number
      /** Necessário para o cálculo de atraso (resolvido/fechado nunca atrasa). */
      status?: TicketStatus
      /** `false` enquanto ninguém abriu o chamado → destaque "NOVO". */
      visualizado?: boolean
    }
    onDragStart: (e: React.DragEvent, ticketId: Id<"tickets">) => void
    onTicketClick: (ticketId: Id<"tickets">) => void
    canDrag?: boolean
    /** Quem pode abrir chamado pode clonar este card. */
    canClone?: boolean
  }) {
    const priorityConfig = PRIORITY_CONFIG[ticket.priority]
    // Cópia do chamado aberta a partir deste card (reuso em um próximo atendimento).
    const [cloneOpen, setCloneOpen] = useState(false)
    // Valor do chamado: o total gravado ou, quando nunca foi salvo, os itens da
    // Solução (mesma regra do diálogo do chamado).
    const savedTotal = ticket.valorTotal ?? null
    const items = savedTotal == null ? resolveItemsTotal(ticket.solucao, ticket.orcamento) : null
    const itemsSum = items?.value ?? 0
    const cardValorTotal = savedTotal ?? (itemsSum !== 0 ? itemsSum : null)
    const valorDerivado = savedTotal == null && cardValorTotal != null

    const createdAt = new Date(ticket.createdAt)

    // Regras visuais derivadas do dado (src/lib/sla.ts): nada é calculado no JSX.
    const novo = isUnseenTicket(ticket)
    const atrasado = isSlaOverdue(ticket)
    const atrasoLabel = slaOverdueLabel(ticket)
    const prazoLabel = slaLabel(ticket)

    return (
      <div
        draggable={canDrag}
        onDragStart={
          canDrag
            ? (e) => {
                // Publica o chamado arrastado para que a coluna de destino monte a
                // mensagem de confirmação antes de mover.
                const dragged: DraggedTicketInfo = {
                  id: ticket._id,
                  number: ticket.number,
                  title: ticket.title,
                  requesterName: ticket.creatorName,
                }
                e.dataTransfer.setData(DRAG_TICKET_MIME, JSON.stringify(dragged))
                onDragStart(e, ticket._id)
              }
            : undefined
        }
        role="button"
        tabIndex={0}
        aria-label={`Abrir chamado #${ticket.number}`}
        onKeyDown={(e) => {
          // Teclado: Enter/Espaço abrem o chamado, onde o status pode ser
          // alterado pelos botões do diálogo (o arraste não é acessível).
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            onTicketClick(ticket._id)
          }
        }}
        onClick={() => onTicketClick(ticket._id)}
        className={`group press lift ios-card relative w-full min-w-0 cursor-pointer border-l-4 p-4 focus-visible:ring-2 focus-visible:ring-ios-blue focus-visible:outline-none ${
          PRIORITY_IOS_BORDER[ticket.priority]
        } ${atrasado ? "card-atrasado" : novo ? "card-novo" : ""} ${
          novo ? "border-ios-blue/40" : "hover:border-ios-blue/30"
        }`}
      >
        {/* Selos do topo: atraso (tremor leve) e chamado ainda não aberto. */}
        {(novo || atrasado) && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {atrasado && (
              <span className="badge-atrasado bg-ios-red inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide text-white uppercase">
                <AlertTriangle className="size-3" strokeWidth={2.5} aria-hidden="true" />
                Atrasado
              </span>
            )}
            {novo && (
              <span
                className="animate-pop-in bg-ios-blue inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold tracking-wide text-white uppercase"
                title="Ninguém abriu este chamado ainda"
              >
                <span className="size-1.5 animate-pulse rounded-full bg-white" aria-hidden="true" />
                Novo
              </span>
            )}
          </div>
        )}
        {/* Cabeçalho: solicitante + ações (clonar, menu e alça de arraste). */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="bg-ios-bg text-ios-gray flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold">
              {getInitials(ticket.creatorName)}
            </span>
            <span className="text-ios-gray min-w-0 flex-1 truncate text-xs font-medium uppercase">
              {ticket.creatorName}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {canClone && (
              <button
                type="button"
                aria-label={`Clonar chamado #${ticket.number}`}
                title="Clonar chamado (reusar em um próximo atendimento)"
                className="flex size-6 items-center justify-center rounded-md text-slate-400 transition-all duration-150 hover:bg-slate-100 hover:text-slate-600 focus-visible:opacity-100 active:bg-slate-100 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-slate-800 dark:hover:text-slate-200 touch-manipulation"
                onClick={(e) => {
                  // O clique no card abre o chamado: o botão não pode deixar o
                  // evento passar (nem iniciar um arraste).
                  e.stopPropagation()
                  setCloneOpen(true)
                }}
                onMouseDown={(e) => e.stopPropagation()}
                onDragStart={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
              >
                <CopyPlus className="size-3.5" />
              </button>
            )}
            {/* Menu ⋮ abre o detalhe do chamado (mesma ação do clique no card).
              No desktop aparece só no hover; no toque fica sempre visível. */}
            <button
              type="button"
              aria-label={`Abrir chamado #${ticket.number}`}
              title="Abrir chamado"
              className="flex size-6 items-center justify-center rounded-md text-slate-400 transition-all duration-150 hover:bg-slate-100 hover:text-slate-600 focus-visible:opacity-100 active:bg-slate-100 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-slate-800 dark:hover:text-slate-200"
              onClick={(e) => {
                e.stopPropagation()
                onTicketClick(ticket._id)
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onDragStart={(e) => {
                e.preventDefault()
                e.stopPropagation()
              }}
            >
              <MoreVertical className="size-3.5" />
            </button>
            {canDrag && (
              <GripVertical
                className="hidden size-4 shrink-0 text-slate-300 transition-colors group-hover:text-slate-400 sm:block dark:text-slate-600 dark:group-hover:text-slate-500"
                aria-hidden="true"
              />
            )}
          </div>
        </div>

        {ticket.title && (
          <h4 className="text-ios-label mb-1 mt-2 line-clamp-2 text-[15px] font-semibold break-words tracking-[-0.01em]">
            {ticket.title}
          </h4>
        )}
        {ticket.description && (
          <p className="text-ios-gray mb-3 line-clamp-2 text-[13px] leading-relaxed break-words">
            {ticket.description}
          </p>
        )}

        {/* Linha de meta: prioridade (pill), valor, data. Quebra a linha em vez de
          estourar o card quando o valor/a data não caibam lado a lado. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold ${priorityConfig.className}`}
          >
            <span className={`size-1.5 rounded-full ${priorityConfig.dot}`} />
            {priorityConfig.label}
          </span>
          {cardValorTotal != null && (
            <span
              title={
                valorDerivado
                  ? `Soma dos itens ${items?.source === "orcamento" ? "do Orçamento" : "da Solução"} (ainda não salva no chamado)`
                  : "Valor total do chamado"
              }
              className={`shrink-0 tabular-nums ${
                valorDerivado
                  ? "border-b border-dashed border-slate-300 text-slate-400 dark:border-slate-600 dark:text-slate-500"
                  : "text-slate-400 dark:text-slate-500"
              }`}
            >
              {formatBRL(cardValorTotal)}
            </span>
          )}
          <span className="text-ios-gray ml-auto flex shrink-0 items-center gap-1 tabular-nums">
            {atrasado && (
              <Clock className="text-ios-red size-3" strokeWidth={2.5} aria-hidden="true" />
            )}
            {createdAt.toLocaleDateString("pt-BR", {
              day: "2-digit",
              month: "2-digit",
            })}{" "}
            {createdAt.toLocaleTimeString("pt-BR", {
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          {prazoLabel && (
            <span
              className={`shrink-0 font-medium ${atrasado ? "text-ios-red" : "text-ios-gray"}`}
              title={
                atrasado ? `${atrasoLabel ?? ""} — prazo por prioridade` : "Prazo por prioridade"
              }
            >
              {prazoLabel}
            </span>
          )}
        </div>

        {/* O diálogo é portado para o body, então não ocupa espaço no card. */}
        {cloneOpen && (
          <CloneTicketDialog
            source={{
              number: ticket.number,
              title: ticket.title,
              description: ticket.description,
              solucao: ticket.solucao,
              orcamento: ticket.orcamento,
              obs: ticket.obs,
              statusEquipamento: ticket.statusEquipamento,
              categoria: ticket.categoria,
              priority: ticket.priority,
              guestName: ticket.guestName,
              guestContact: ticket.guestContact,
              location: ticket.location,
              os: ticket.os,
              valorTotal: ticket.valorTotal,
            }}
            onOpenChange={(open) => {
              if (!open) setCloneOpen(false)
            }}
          />
        )}
      </div>
    )
  },
  /**
   * Só redesenha quando o chamado em si (ou a permissão de arrastar/clonar) muda.
   * `onTicketClick`/`onDragStart` ficam de fora de propósito: eles apenas fecham
   * sobre setters e callbacks estáveis, então um closure "antigo" continua
   * correto — e comparar funções aqui anularia a memoização, porque o painel
   * recria esses callbacks a cada render.
   */
  (prev, next) =>
    prev.ticket === next.ticket && prev.canDrag === next.canDrag && prev.canClone === next.canClone,
)

export const KanbanColumn = memo(
  function KanbanColumn({
    column,
    tickets,
    onDragStart,
    onDrop,
    onDragOver,
    onDragLeave,
    isDragOver,
    onTicketClick,
    canDrag = true,
  }: {
    column: (typeof COLUMNS)[number]
    tickets: Array<{
      _id: Id<"tickets">
      number: number
      title?: string
      description?: string
      solucao?: string
      orcamento?: string
      obs?: string
      statusEquipamento?: string
      /** Categoria (Impressoras, Rede, ...) — classificacao interna do chamado. */
      categoria?: string
      valorTotal?: number
      priority: TicketPriority
      guestName?: string
      guestContact?: string
      location?: string
      os?: string
      creatorName: string
      creatorImage?: string
      createdAt: number
      /** Status do chamado (a coluna já é um status, mas o card precisa dele
       * para o cálculo de atraso: resolvido/fechado nunca atrasa). */
      status?: TicketStatus
      /** `false` enquanto ninguém abriu o chamado → destaque "NOVO". */
      visualizado?: boolean
    }>
    onDragStart: (e: React.DragEvent, ticketId: Id<"tickets">) => void
    onDrop: (e: React.DragEvent, status: TicketStatus) => void
    onDragOver: (e: React.DragEvent, status: TicketStatus) => void
    onDragLeave: (e: React.DragEvent) => void
    isDragOver: boolean
    onTicketClick: (id: Id<"tickets">) => void
    canDrag?: boolean
  }) {
    // Clonar é abrir chamado: a permissão decide se o botão aparece no card.
    const { can } = usePermissions()
    const canClone = can("tickets.create")

    // Chamados que ninguém abriu ainda: o ponto do cabeçalho pulsa e o contador
    // azul aparece. É o mesmo dado que faz o card ganhar o selo "NOVO".
    const naoVistos = tickets.filter(isUnseenTicket).length

    // Movimento aguardando a confirmação do usuário.
    const [pendingMove, setPendingMove] = useState<{
      status: TicketStatus
      ticketLabel: string
      requesterName?: string
    } | null>(null)
    const pendingDropEvent = useRef<React.DragEvent | null>(null)

    /**
     * Botão do cabeçalho que esconde os chamados da coluna (só o título e a
     * contagem ficam visíveis). O estado é por coluna e persiste no navegador.
     */
    const storageKey = `pingos-kanban-collapsed-${column.id}`
    const [collapsed, setCollapsed] = useState(() => {
      try {
        return localStorage.getItem(storageKey) === "1"
      } catch {
        return false
      }
    })
    const toggleCollapsed = () => {
      setCollapsed((prev) => {
        const next = !prev
        try {
          localStorage.setItem(storageKey, next ? "1" : "0")
        } catch {
          /* localStorage bloqueado: só não persiste a escolha */
        }
        return next
      })
    }

    /**
     * Pede confirmação antes de entregar o evento ao painel.
     * Soltar na própria coluna (ou sem os dados do card) segue direto, como antes,
     * para não interromper um arraste que não muda nada.
     */
    const handleDropRequest = (e: React.DragEvent, status: TicketStatus) => {
      e.preventDefault()
      const raw = e.dataTransfer.getData(DRAG_TICKET_MIME)
      let dragged: DraggedTicketInfo | null = null
      try {
        dragged = raw ? (JSON.parse(raw) as DraggedTicketInfo) : null
      } catch {
        dragged = null
      }
      const droppedOnOwnColumn = dragged?.id ? tickets.some((t) => t._id === dragged?.id) : false
      if (!dragged || droppedOnOwnColumn) {
        onDrop(e, status)
        return
      }
      // Some o destaque de destino enquanto a confirmação está aberta.
      onDragLeave(e)
      pendingDropEvent.current = e
      setPendingMove({
        status,
        ticketLabel: `chamado #${dragged.number ?? ""}${
          dragged.title ? ` · ${dragged.title}` : ""
        }`,
        requesterName: dragged.requesterName,
      })
    }

    return (
      <div
        onDragOver={(e) => onDragOver(e, column.id)}
        onDragLeave={onDragLeave}
        onDrop={(e) => handleDropRequest(e, column.id)}
        className={`ios-column flex min-w-[260px] flex-1 flex-col overflow-hidden ${
          collapsed ? "self-start" : ""
        } ${isDragOver ? `${column.borderColor} ${column.bgColor} shadow-ios-lift` : ""}`}
      >
        <StatusChangeConfirmDialog
          open={pendingMove !== null}
          onOpenChange={(open) => {
            if (!open) {
              pendingDropEvent.current = null
              setPendingMove(null)
            }
          }}
          ticketLabel={pendingMove?.ticketLabel}
          requesterName={pendingMove?.requesterName}
          toLabel={statusLabel(pendingMove?.status)}
          onConfirm={() => {
            const move = pendingMove
            const event = pendingDropEvent.current
            pendingDropEvent.current = null
            setPendingMove(null)
            if (move && event) onDrop(event, move.status)
          }}
        />
        {/* Barra colorida de 4px identifica o status da coluna. */}
        <div className={`h-1 w-full shrink-0 ${column.barColor}`} />
        <div className="flex items-center justify-between border-b border-[rgb(60_60_67_/_0.08)] px-4 py-3 dark:border-white/10">
          <div className="flex items-center gap-2">
            {/* Ponto do status; pulsa quando há chamado que ninguém abriu. */}
            <span
              className={`size-2 rounded-full ${naoVistos > 0 ? "bg-ios-blue animate-pulse" : column.barColor}`}
              aria-hidden="true"
            />
            <h3 className="text-ios-label text-[15px] font-semibold tracking-[-0.01em]">
              {column.label}
            </h3>
          </div>
          <div className="flex items-center gap-1">
            {naoVistos > 0 && (
              <span
                className="bg-ios-blue/10 text-ios-blue inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
                title={`${naoVistos} chamado(s) que ninguém abriu ainda`}
              >
                {naoVistos} novo{naoVistos > 1 ? "s" : ""}
              </span>
            )}
            <span className="bg-ios-bg text-ios-gray rounded-full px-2 py-0.5 text-xs font-medium tabular-nums">
              {tickets.length}
            </span>
            <button
              type="button"
              aria-label={`${collapsed ? "Mostrar" : "Ocultar"} chamados de ${column.label}`}
              aria-expanded={!collapsed}
              title={collapsed ? "Mostrar chamados" : "Ocultar chamados"}
              onClick={toggleCollapsed}
              className="flex size-6 items-center justify-center rounded-md text-slate-400 transition-all duration-150 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800 dark:hover:text-slate-200"
            >
              <ChevronDown
                className={`size-3.5 transition-transform duration-150 ${
                  collapsed ? "-rotate-90" : ""
                }`}
              />
            </button>
          </div>
        </div>
        {/* `data-scroll-fit` cancela o `display: table` que o Radix aplica ao
          conteúdo do ScrollArea (ver `index.css`), para os cards respeitarem a
          largura da coluna em vez de crescerem até o tamanho do texto. */}
        <ScrollArea data-scroll-fit className={collapsed ? "hidden" : "flex-1"}>
          <div className="stagger space-y-2.5 p-4">
            {tickets.length === 0 ? (
              <div className="flex min-h-[200px] flex-col items-center justify-center text-slate-400 dark:text-slate-600">
                <Ticket className="mb-1 size-5" />
                <span className="text-xs">Nenhum chamado</span>
              </div>
            ) : (
              tickets.map((ticket) => (
                <KanbanCard
                  key={ticket._id}
                  ticket={ticket}
                  onDragStart={onDragStart}
                  onTicketClick={onTicketClick}
                  canDrag={canDrag}
                  canClone={canClone}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>
    )
  },
  /**
   * Redesenha a coluna quando os chamados dela, o destaque de arraste ou o
   * estado dos cards mudam. Digitar na busca ou abrir um modal não mexe em
   * nenhum dos dois, então as 5 colunas ficam paradas nessas horas.
   */
  (prev, next) =>
    prev.isDragOver === next.isDragOver &&
    prev.canDrag === next.canDrag &&
    prev.onDrop === next.onDrop &&
    prev.column === next.column &&
    sameTicketList(prev.tickets, next.tickets),
)
