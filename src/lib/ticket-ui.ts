/**
 * Tipos e helpers de apresentação dos chamados (Kanban e cards).
 *
 * Estavam declarados dentro de `pages/Dashboard.tsx`; foram movidos para cá
 * para serem compartilhados entre a página e os componentes extraídos
 * (`KanbanColumn`, `GuestNewTicketDialog`, ...).
 */
import type { TicketPriority } from "@/lib/ticket-utils";

export type TicketStatus =
  | "aberto"
  | "em_andamento"
  | "aguardando"
  | "resolvido"
  | "fechado";

export const COLUMNS: {
  id: TicketStatus;
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
  /** Cor sólida da barra de 4px no topo da coluna (e do ponto no header). */
  barColor: string;
  /** Pill suave (fundo + texto + borda) para listagens/tabelas de relatórios. */
  pillClass: string;
}[] = [
  // Visual com hierarquia: coluna branca com barra colorida por status.
  // Toda cor fixa tem a variante `dark:` ao lado (barColor é forte o bastante
  // para os dois temas).
  {
    id: "aberto",
    label: "Aberto",
    color: "text-blue-600 dark:text-blue-400",
    bgColor: "bg-slate-100/60 dark:bg-slate-800/60",
    borderColor: "border-blue-300 dark:border-blue-800",
    barColor: "bg-blue-500",
    pillClass:
      "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-400 dark:border-blue-900",
  },
  {
    id: "em_andamento",
    label: "Em Andamento",
    color: "text-amber-600 dark:text-amber-400",
    bgColor: "bg-slate-100/60 dark:bg-slate-800/60",
    borderColor: "border-amber-300 dark:border-amber-800",
    barColor: "bg-amber-500",
    pillClass:
      "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900",
  },
  {
    id: "aguardando",
    label: "Aguardando",
    color: "text-purple-600 dark:text-purple-400",
    bgColor: "bg-slate-100/60 dark:bg-slate-800/60",
    borderColor: "border-purple-300 dark:border-purple-800",
    barColor: "bg-violet-500",
    pillClass:
      "bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-950/40 dark:text-violet-400 dark:border-violet-900",
  },
  {
    id: "resolvido",
    label: "Resolvido",
    color: "text-emerald-600 dark:text-emerald-400",
    bgColor: "bg-slate-100/60 dark:bg-slate-800/60",
    borderColor: "border-emerald-300 dark:border-emerald-800",
    barColor: "bg-emerald-500",
    pillClass:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900",
  },
  {
    id: "fechado",
    label: "Fechado",
    color: "text-muted-foreground",
    bgColor: "bg-slate-100/60 dark:bg-slate-800/60",
    borderColor: "border-border",
    barColor: "bg-slate-400",
    pillClass:
      "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700",
  },
];

export const PRIORITY_CONFIG: Record<
  TicketPriority,
  { label: string; dot: string; className: string; leftBorder: string }
> = {
  // Pill com borda + ponto, e a cor também alimenta a barra lateral do card
  // (`border-l-*`). Toda classe de cor fixa carrega a variante `dark:` ao lado.
  critica: {
    label: "Crítica",
    dot: "bg-red-500",
    className:
      "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-400 dark:border-red-900",
    leftBorder: "border-l-red-500",
  },
  alta: {
    label: "Alta",
    dot: "bg-orange-500",
    className:
      "bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-400 dark:border-orange-900",
    leftBorder: "border-l-orange-500",
  },
  media: {
    label: "Média",
    dot: "bg-amber-500",
    className:
      "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-400 dark:border-amber-900",
    leftBorder: "border-l-amber-500",
  },
  baixa: {
    label: "Baixa",
    dot: "bg-emerald-500",
    className:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-900",
    leftBorder: "border-l-emerald-500",
  },
};

export function getInitials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

export function timeAgo(timestamp: number) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "agora";
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/**
 * Compara duas listas de chamados por conteúdo.
 *
 * As colunas recebem uma lista nova a cada render do painel (`filter` cria outro
 * array), mas os ITENS são os mesmos objetos enquanto o dado não muda — então
 * comparar item a item evita redesenhar as colunas e os cards à toa.
 */
export function sameTicketList<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Rótulo legível de um status ("em_andamento" → "Em Andamento"). */
export function statusLabel(status?: TicketStatus | null): string {
  if (!status) return "";
  return COLUMNS.find((c) => c.id === status)?.label ?? status;
}

/**
 * Dados que o card arrastado publica no dataTransfer.
 * A coluna de destino lê isso para montar a mensagem de confirmação sem
 * depender do estado do componente principal.
 */
export const DRAG_TICKET_MIME = "application/x-pingos-chamado";

export interface DraggedTicketInfo {
  id: string;
  number?: number;
  title?: string;
  /** Solicitante — exibido na confirmação da mudança de status. */
  requesterName?: string;
}
