/**
 * Módulo de Relatórios — dados, formatação e exportação.
 *
 * Este arquivo é a ponte entre a API (`/api/reports/*`) e a página
 * (`src/pages/Reports.tsx`). Ele concentra três coisas que precisam ser as
 * MESMAS na tela, no XLS e no PDF:
 *
 *   1. **tipos** de cada relatório (o formato que a API devolve);
 *   2. **tabelas** — colunas, rótulos e formatação de cada linha;
 *   3. **totalizadores** — os números do rodapé.
 *
 * Assim a planilha e o PDF nunca divergem do que o usuário está vendo: os três
 * consomem a mesma `ReportTable`.
 *
 * As bibliotecas de exportação são carregadas **sob demanda** (`import()`
 * dinâmico) — SheetJS e jsPDF somam algumas centenas de KB e não têm por que
 * fazer parte do bundle inicial do app.
 */

import { apiFetch } from "@/lib/mysql-api"

/* -------------------------------------------------------------------------- */
/* Tipos da API                                                                */
/* -------------------------------------------------------------------------- */

export type ReportId = "tickets" | "technicians" | "sectors" | "users" | "notifications"

export type ReportFormat = "tela" | "xls" | "pdf"

export interface Period {
  start: number
  end: number
}

export interface PageInfo {
  limit: number
  offset: number
  count: number
  hasMore: boolean
  maxLimit: number
}

/** Filtros aceitos por todas as rotas de relatório. */
export interface ReportFilters {
  start: number
  end: number
  status?: string
  priority?: string
  assigneeId?: string
  client?: string
  setor?: string
  categoria?: string
  q?: string
}

export interface TicketReportRow {
  id: string
  number: number
  /** Número da O.S (ordem de serviço) — vazio quando o chamado não tem. */
  os: string
  /** Valor lançado no chamado; `null` = sem valor. */
  valorTotal: number | null
  title: string
  status: string
  priority: string
  assignee: string
  assigneeType: "user" | "technician" | null
  client: string
  setor: string
  createdAt: number
  updatedAt: number
  createdAtLabel: string | null
  updatedAtLabel: string | null
  totalDays: number
  resolutionDays: number | null
}

export interface TicketsReport {
  period: Period
  rows: TicketReportRow[]
  totals: {
    total: number
    resolved: number
    open: number
    avgResolutionDays: number
    /** Soma do valor de todos os chamados do período (filtro aplicado). */
    valorTotal: number
    byStatus: Record<string, number>
    byPriority: Record<string, number>
  }
  page: PageInfo
}

export interface TechnicianReportRow {
  id: string
  name: string
  type: "user" | "technician" | null
  total: number
  resolved: number
  inProgress: number
  avgResolutionDays: number
  reopenRate: number
  reopened: number
  reopenTracked: boolean
}

export interface TechniciansReport {
  period: Period
  rows: TechnicianReportRow[]
  totals: {
    assignees: number
    total: number
    resolved: number
    inProgress: number
    reopened: number
    avgResolutionDays: number
  }
}

export interface SectorReportRow {
  setor: string
  total: number
  resolved: number
  pending: number
  avgResolutionDays: number
  avgResponseDays: number | null
}

export interface SectorsReport {
  period: Period
  rows: SectorReportRow[]
  totals: { sectors: number; total: number; resolved: number; pending: number }
}

export interface UserReportRow {
  id: string
  name: string
  username: string
  email: string
  role: string
  setor: string
  contato: string
  active: boolean
  hasPassword: boolean
  permissionOverrides: number
  createdAt: number | null
  createdAtLabel: string | null
}

export interface UsersReport {
  period: null
  rows: UserReportRow[]
  totals: {
    total: number
    active: number
    inactive: number
    byRole: Record<string, number>
  }
  page: PageInfo
}

export interface NotificationReportRow {
  id: string
  sentAt: number
  sentAtLabel: string | null
  ticket: string
  ticketTitle: string
  rule: string
  recipient: string
  channel: string
  status: string
  error: string
}

export interface NotificationsReport {
  period: Period
  rows: NotificationReportRow[]
  totals: {
    total: number
    sent: number
    failed: number
    byChannel: Record<string, number>
  }
  page: PageInfo
}

export interface ReportFilterOptions {
  assignees: { id: string; name: string; type: "user" | "technician" }[]
  setores: string[]
  statuses: string[]
  priorities: string[]
}

/* -------------------------------------------------------------------------- */
/* Rótulos                                                                     */
/* -------------------------------------------------------------------------- */

export const STATUS_LABELS: Record<string, string> = {
  aberto: "Aberto",
  em_andamento: "Em Andamento",
  aguardando: "Aguardando",
  resolvido: "Resolvido",
  fechado: "Fechado",
}

export const PRIORITY_LABELS: Record<string, string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
  critica: "Crítica",
}

export const CHANNEL_LABELS: Record<string, string> = {
  email: "E-mail",
  telegram: "Telegram",
  whatsapp: "WhatsApp",
}

export const NOTIFICATION_STATUS_LABELS: Record<string, string> = {
  sent: "Enviado",
  failed: "Falhou",
  pending: "Pendente",
}

/** Metadados de cada relatório (a página usa para as abas e a exportação). */
export const REPORT_META: {
  id: ReportId
  label: string
  description: string
  sheet: string
}[] = [
  {
    id: "tickets",
    label: "Chamados",
    description: "Todos os chamados do período, com tempo total e de resolução.",
    sheet: "Chamados",
  },
  {
    id: "technicians",
    label: "Desempenho por Técnico",
    description: "Resolvidos, em andamento, tempo médio e taxa de reabertura.",
    sheet: "Técnicos",
  },
  {
    id: "sectors",
    label: "Produtividade por Setor",
    description: "Abertos, resolvidos, pendentes e tempo médio por setor.",
    sheet: "Setores",
  },
  {
    id: "users",
    label: "Usuários e Permissões",
    description: "Cadastro, papel e situação de acesso (apenas administrador).",
    sheet: "Usuários",
  },
  {
    id: "notifications",
    label: "Notificações Enviadas",
    description: "Auditoria dos envios por canal, com destinatário e regra.",
    sheet: "Notificações",
  },
]

/* -------------------------------------------------------------------------- */
/* Tabelas (tela = XLS = PDF)                                                  */
/* -------------------------------------------------------------------------- */

export interface ReportColumn {
  key: string
  label: string
  align?: "left" | "right" | "center"
  /** Largura da coluna no XLS (em caracteres). */
  width?: number
  /**
   * Formato do valor. Vale para a tela (que formata moeda em pt-BR) e para o
   * XLS (que aplica o formato numérico correspondente na célula).
   */
  format?: "integer" | "decimal" | "percent" | "currency"
}

export type ReportRow = Record<string, string | number | null>

export interface ReportTable {
  columns: ReportColumn[]
  rows: ReportRow[]
}

const days = (value: number | null | undefined): string =>
  value === null || value === undefined
    ? "—"
    : `${value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} d`

/** Dinheiro em pt-BR — `R$ 1.234,50`. Usado na tela, no XLS e no PDF. */
export const money = (value: number): string =>
  value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

/**
 * Como um valor da tabela aparece **na tela**. A planilha e o PDF formatam
 * sozinhos (número + formato da célula), então isto é só para o `<td>`.
 */
export function cellText(column: ReportColumn, value: ReportRow[string]): string {
  if (value === null || value === undefined || value === "") return "—"
  if (column.format === "currency" && typeof value === "number") return money(value)
  if (column.format === "decimal" && typeof value === "number") {
    return value.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })
  }
  if (column.format === "integer" && typeof value === "number") {
    return value.toLocaleString("pt-BR")
  }
  return String(value)
}

const orDash = (value: string | null | undefined): string => (value && value.trim() ? value : "—")

/** Monta a tabela de um relatório no formato que a tela/exportação consomem. */
export function toTable(id: ReportId, data: unknown): ReportTable {
  switch (id) {
    case "tickets": {
      const report = data as TicketsReport
      return {
        columns: [
          { key: "number", label: "Nº", align: "right", width: 8, format: "integer" },
          { key: "os", label: "O.S", width: 14 },
          { key: "title", label: "Título", width: 38 },
          { key: "status", label: "Status", width: 14 },
          { key: "priority", label: "Prioridade", width: 12 },
          { key: "assignee", label: "Responsável", width: 20 },
          { key: "client", label: "Cliente", width: 22 },
          { key: "setor", label: "Setor", width: 18 },
          { key: "createdAtLabel", label: "Abertura", width: 18 },
          { key: "updatedAtLabel", label: "Última Atualização", width: 18 },
          {
            key: "totalDays",
            label: "Tempo total (dias)",
            align: "right",
            width: 16,
            format: "decimal",
          },
          {
            key: "valorTotal",
            label: "Valor total (R$)",
            align: "right",
            width: 16,
            format: "currency",
          },
        ],
        rows: report.rows.map((row) => ({
          number: row.number,
          os: orDash(row.os),
          title: row.title,
          status: STATUS_LABELS[row.status] ?? row.status,
          priority: PRIORITY_LABELS[row.priority] ?? row.priority,
          assignee: orDash(row.assignee),
          client: row.client,
          setor: row.setor,
          createdAtLabel: orDash(row.createdAtLabel),
          updatedAtLabel: orDash(row.updatedAtLabel),
          totalDays: row.totalDays,
          valorTotal: row.valorTotal,
        })),
      }
    }
    case "technicians": {
      const report = data as TechniciansReport
      return {
        columns: [
          { key: "name", label: "Técnico / Responsável", width: 30 },
          { key: "total", label: "Total", align: "right", width: 10, format: "integer" },
          { key: "resolved", label: "Resolvidos", align: "right", width: 12, format: "integer" },
          {
            key: "inProgress",
            label: "Em andamento",
            align: "right",
            width: 14,
            format: "integer",
          },
          {
            key: "avgResolutionDays",
            label: "Tempo médio (dias)",
            align: "right",
            width: 18,
            format: "decimal",
          },
          {
            key: "reopenRate",
            label: "Taxa de reabertura (%)",
            align: "right",
            width: 20,
            format: "percent",
          },
        ],
        rows: report.rows.map((row) => ({
          name: row.name,
          total: row.total,
          resolved: row.resolved,
          inProgress: row.inProgress,
          avgResolutionDays: row.avgResolutionDays,
          // Sem histórico de status para o período, o número não é confiável.
          reopenRate: row.reopenTracked ? row.reopenRate : "sem histórico",
        })),
      }
    }
    case "sectors": {
      const report = data as SectorsReport
      return {
        columns: [
          { key: "setor", label: "Setor", width: 28 },
          { key: "total", label: "Abertos", align: "right", width: 10, format: "integer" },
          { key: "resolved", label: "Resolvidos", align: "right", width: 12, format: "integer" },
          { key: "pending", label: "Pendentes", align: "right", width: 12, format: "integer" },
          {
            key: "avgResponseDays",
            label: "Tempo médio de resposta",
            align: "right",
            width: 24,
            format: "decimal",
          },
          {
            key: "avgResolutionDays",
            label: "Tempo médio de resolução",
            align: "right",
            width: 24,
            format: "decimal",
          },
        ],
        rows: report.rows.map((row) => ({
          setor: row.setor,
          total: row.total,
          resolved: row.resolved,
          pending: row.pending,
          avgResponseDays: days(row.avgResponseDays),
          avgResolutionDays: days(row.avgResolutionDays),
        })),
      }
    }
    case "users": {
      const report = data as UsersReport
      return {
        columns: [
          { key: "name", label: "Nome", width: 26 },
          { key: "username", label: "Usuário", width: 20 },
          { key: "email", label: "E-mail", width: 26 },
          { key: "role", label: "Papel", width: 14 },
          { key: "setor", label: "Setor", width: 18 },
          { key: "active", label: "Situação", width: 12 },
          {
            key: "overrides",
            label: "Permissões próprias",
            align: "right",
            width: 18,
            format: "integer",
          },
          { key: "createdAtLabel", label: "Cadastro", width: 18 },
        ],
        rows: report.rows.map((row) => ({
          name: row.name,
          username: orDash(row.username),
          email: orDash(row.email),
          role: row.role,
          setor: row.setor,
          active: row.active ? "Ativo" : "Inativo",
          overrides: row.permissionOverrides,
          createdAtLabel: orDash(row.createdAtLabel),
        })),
      }
    }
    case "notifications": {
      const report = data as NotificationsReport
      return {
        columns: [
          { key: "sentAtLabel", label: "Data", width: 18 },
          { key: "ticket", label: "Chamado", width: 12 },
          { key: "ticketTitle", label: "Título do chamado", width: 30 },
          { key: "rule", label: "Regra aplicada", width: 24 },
          { key: "recipient", label: "Destinatário", width: 26 },
          { key: "channel", label: "Canal", width: 12 },
          { key: "status", label: "Status do envio", width: 16 },
        ],
        rows: report.rows.map((row) => ({
          sentAtLabel: orDash(row.sentAtLabel),
          ticket: orDash(row.ticket),
          ticketTitle: orDash(row.ticketTitle),
          rule: row.rule,
          recipient: row.recipient,
          channel: CHANNEL_LABELS[row.channel] ?? row.channel,
          status: NOTIFICATION_STATUS_LABELS[row.status] ?? row.status,
        })),
      }
    }
  }
}

/** Totalizadores do relatório — usados na tela, no rodapé do PDF e do XLS. */
export function summarize(id: ReportId, data: unknown): { label: string; value: string }[] {
  switch (id) {
    case "tickets": {
      const { totals } = data as TicketsReport
      return [
        { label: "Quantidade total", value: String(totals.total) },
        { label: "Resolvidos/Fechados", value: String(totals.resolved) },
        { label: "Ainda abertos", value: String(totals.open) },
        { label: "Tempo médio de resolução", value: days(totals.avgResolutionDays) },
        { label: "Valor total dos chamados", value: money(totals.valorTotal ?? 0) },
        ...Object.entries(STATUS_LABELS).map(([key, label]) => ({
          label: `Status: ${label}`,
          value: String(totals.byStatus?.[key] ?? 0),
        })),
      ]
    }
    case "technicians": {
      const { totals } = data as TechniciansReport
      return [
        { label: "Responsáveis no período", value: String(totals.assignees) },
        { label: "Chamados atribuídos", value: String(totals.total) },
        { label: "Resolvidos", value: String(totals.resolved) },
        { label: "Em andamento", value: String(totals.inProgress) },
        { label: "Reabertos", value: String(totals.reopened) },
        { label: "Tempo médio (média simples)", value: days(totals.avgResolutionDays) },
      ]
    }
    case "sectors": {
      const { totals } = data as SectorsReport
      return [
        { label: "Setores", value: String(totals.sectors) },
        { label: "Chamados abertos", value: String(totals.total) },
        { label: "Resolvidos", value: String(totals.resolved) },
        { label: "Pendentes", value: String(totals.pending) },
      ]
    }
    case "users": {
      const { totals } = data as UsersReport
      return [
        { label: "Usuários", value: String(totals.total) },
        { label: "Ativos", value: String(totals.active) },
        { label: "Inativos", value: String(totals.inactive) },
        // `?? {}`: uma resposta sem o mapa (ex.: API antiga no servidor) mostra o
        // relatório sem os totalizadores por papel, em vez de derrubar a página.
        ...Object.entries(totals.byRole ?? {}).map(([role, qty]) => ({
          label: `Papel: ${role}`,
          value: String(qty),
        })),
      ]
    }
    case "notifications": {
      const { totals } = data as NotificationsReport
      return [
        { label: "Envios no período", value: String(totals.total) },
        { label: "Enviados", value: String(totals.sent) },
        { label: "Falhas", value: String(totals.failed) },
        ...Object.entries(CHANNEL_LABELS).map(([key, label]) => ({
          label: `Canal: ${label}`,
          value: String(totals.byChannel?.[key] ?? 0),
        })),
      ]
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Chamadas à API                                                              */
/* -------------------------------------------------------------------------- */

function toQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue
    search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ""
}

/** Busca um relatório com os filtros aplicados (e a página pedida). */
export function fetchReport<T>(
  id: ReportId,
  filters: ReportFilters,
  page?: { limit?: number; offset?: number },
): Promise<T> {
  return apiFetch<T>(`/api/reports/${id}${toQuery({ ...filters, ...(page ?? {}) })}`)
}

export function fetchReportFilterOptions(): Promise<ReportFilterOptions> {
  return apiFetch<ReportFilterOptions>("/api/reports/filters")
}

/**
 * Registra na auditoria (`report_logs`) quem gerou/exportou e com quais
 * filtros. Falha em silêncio de propósito: um problema no log não pode impedir
 * o usuário de ver o relatório que ele pediu.
 */
export async function logReport(entry: {
  report: ReportId
  format: ReportFormat
  filters: ReportFilters
  rowCount: number
}): Promise<void> {
  try {
    await apiFetch("/api/reports/log", {
      method: "POST",
      body: {
        report: entry.report,
        format: entry.format,
        rowCount: entry.rowCount,
        filters: {
          start: new Date(entry.filters.start).toISOString(),
          end: new Date(entry.filters.end).toISOString(),
          status: entry.filters.status ?? null,
          priority: entry.filters.priority ?? null,
          assigneeId: entry.filters.assigneeId ?? null,
          client: entry.filters.client ?? null,
          setor: entry.filters.setor ?? null,
          categoria: entry.filters.categoria ?? null,
          q: entry.filters.q ?? null,
        },
      },
    })
  } catch (error) {
    console.warn(
      "[reports] não foi possível registrar a auditoria do relatório:",
      error instanceof Error ? error.message : error,
    )
  }
}

/* -------------------------------------------------------------------------- */
/* Exportação — XLS                                                            */
/* -------------------------------------------------------------------------- */

export interface ExportSheet {
  name: string
  table: ReportTable
}

interface ExportOptions {
  filename: string
  title: string
  periodLabel: string
  userLabel: string
  summary: { label: string; value: string }[]
}

const HEADER_FILL = "1E293B"

/**
 * Gera um .xlsx com **uma aba por relatório** + uma aba "Resumo" com os
 * totalizadores. Cabeçalhos em negrito e números formatados (pt-BR).
 */
export async function exportXls(opts: ExportOptions & { sheets: ExportSheet[] }): Promise<void> {
  const mod = await import("xlsx-js-style")
  // O pacote é UMD: dependendo do interop do bundler o namespace vem direto ou
  // dentro de `default`. Resolver os dois formatos evita um export quebrado.
  const XLSX = (
    (mod as unknown as { utils?: unknown; default?: unknown }).utils
      ? mod
      : (mod as unknown as { default: typeof mod }).default
  ) as typeof mod

  const workbook = XLSX.utils.book_new()

  // ── Aba de resumo (cabeçalho + totalizadores do relatório ativo) ──────────
  const summaryRows: (string | number)[][] = [
    ["PingOS — Sistema de Chamados de TI"],
    [opts.title],
    [`Período: ${opts.periodLabel}`],
    [`Gerado em: ${new Date().toLocaleString("pt-BR")}`],
    [`Gerado por: ${opts.userLabel}`],
    [],
    ["Totalizadores", ""],
    ...opts.summary.map((item) => [item.label, item.value] as (string | number)[]),
  ]
  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows)
  summarySheet["!cols"] = [{ wch: 42 }, { wch: 24 }]
  const bold = (row: number, size = 11) => {
    const cell = summarySheet[XLSX.utils.encode_cell({ r: row, c: 0 })]
    if (cell) cell.s = { font: { bold: true, sz: size } }
  }
  bold(0, 14)
  bold(1, 12)
  bold(6, 12)
  XLSX.utils.book_append_sheet(workbook, summarySheet, "Resumo")

  // ── Uma aba por relatório ────────────────────────────────────────────────
  for (const sheet of opts.sheets) {
    const header = sheet.table.columns.map((column) => column.label)
    const body = sheet.table.rows.map((row) =>
      sheet.table.columns.map((column) => row[column.key] ?? ""),
    )
    const worksheet = XLSX.utils.aoa_to_sheet([header, ...body])

    worksheet["!cols"] = sheet.table.columns.map((column) => ({
      wch: column.width ?? 18,
    }))
    worksheet["!freeze"] = { xSplit: 0, ySplit: 1 }

    // Cabeçalho: negrito, branco sobre fundo escuro, centralizado.
    sheet.table.columns.forEach((column, index) => {
      const cell = worksheet[XLSX.utils.encode_cell({ r: 0, c: index })]
      if (!cell) return
      cell.s = {
        font: { bold: true, color: { rgb: "FFFFFF" } },
        fill: { patternType: "solid", fgColor: { rgb: HEADER_FILL } },
        alignment: { horizontal: "center", vertical: "center", wrapText: true },
      }
      if (column.align === "right") {
        cell.s.alignment = { horizontal: "right", vertical: "center", wrapText: true }
      }
    })

    // Corpo: números alinhados à direita com formato pt-BR.
    sheet.table.columns.forEach((column, index) => {
      const format =
        column.format === "decimal"
          ? "#,##0.0"
          : column.format === "currency"
            ? "#,##0.00"
            : column.format === "percent"
              ? "0.0"
              : column.format === "integer"
                ? "#,##0"
                : undefined
      for (let rowIndex = 1; rowIndex <= sheet.table.rows.length; rowIndex++) {
        const cell = worksheet[XLSX.utils.encode_cell({ r: rowIndex, c: index })]
        if (!cell) continue
        const style: Record<string, unknown> = {}
        if (column.align === "right") style.alignment = { horizontal: "right" }
        if (format && typeof cell.v === "number") style.z = format
        if (Object.keys(style).length > 0) cell.s = style
      }
    })

    // O Excel limita o nome da aba a 31 caracteres e proíbe alguns símbolos.
    const safeName = sheet.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Relatório"
    XLSX.utils.book_append_sheet(workbook, worksheet, safeName)
  }

  XLSX.writeFile(workbook, opts.filename)
}

/* -------------------------------------------------------------------------- */
/* Exportação — PDF                                                            */
/* -------------------------------------------------------------------------- */

/**
 * PDF do relatório ativo: cabeçalho com a marca, período, data e usuário;
 * tabela com repetição de cabeçalho; totalizadores ao final; rodapé com
 * paginação ("Página X de Y").
 */
export async function exportPdf(
  opts: ExportOptions & { table: ReportTable; landscape?: boolean },
): Promise<void> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import("jspdf"), import("jspdf-autotable")])

  const landscape = opts.landscape ?? opts.table.columns.length > 6
  const doc = new jsPDF({
    orientation: landscape ? "landscape" : "portrait",
    unit: "mm",
    format: "a4",
  })

  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const margin = 12

  /** Cabeçalho desenhado em toda página (a tabela pode ocupar várias). */
  const drawHeader = () => {
    doc.setFillColor(30, 41, 59)
    doc.rect(0, 0, pageWidth, 20, "F")
    doc.setTextColor(255, 255, 255)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(13)
    doc.text("PingOS", margin, 9)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(9)
    doc.text("Relatórios", margin + 20, 9)
    doc.setFontSize(10)
    doc.text(opts.title, margin, 16)
    doc.setFontSize(7.5)
    doc.text(`Período: ${opts.periodLabel}`, pageWidth - margin, 9, { align: "right" })
    doc.text(`${new Date().toLocaleString("pt-BR")} · ${opts.userLabel}`, pageWidth - margin, 14, {
      align: "right",
    })
    doc.setTextColor(0, 0, 0)
  }

  drawHeader()

  const columnStyles: Record<number, { halign: "right" }> = {}
  opts.table.columns.forEach((column, index) => {
    if (column.align === "right") columnStyles[index] = { halign: "right" }
  })

  autoTable(doc, {
    head: [opts.table.columns.map((column) => column.label)],
    body: opts.table.rows.map((row) =>
      opts.table.columns.map((column) => {
        const value = row[column.key]
        return value === null || value === undefined ? "" : String(value)
      }),
    ),
    startY: 24,
    margin: { left: margin, right: margin, bottom: 18 },
    styles: { fontSize: 7.5, cellPadding: 1.4, overflow: "linebreak" },
    headStyles: {
      fillColor: [30, 41, 59],
      textColor: [255, 255, 255],
      fontStyle: "bold",
      halign: "center",
    },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    columnStyles,
    // Só o cabeçalho é redesenhado; o resto da página fica com a tabela.
    didDrawPage: () => drawHeader(),
  })

  // ── Totalizadores ao final ────────────────────────────────────────────────
  const tableEnd =
    (doc as unknown as { lastAutoTable?: { finalY?: number } }).lastAutoTable?.finalY ?? 24
  if (opts.summary.length > 0) {
    autoTable(doc, {
      head: [["Totalizadores", ""]],
      body: opts.summary.map((item) => [item.label, item.value]),
      startY: tableEnd + 8,
      margin: { left: margin, right: margin, bottom: 18 },
      styles: { fontSize: 8, cellPadding: 1.6 },
      headStyles: {
        fillColor: [226, 232, 240],
        textColor: [30, 41, 59],
        fontStyle: "bold",
      },
      tableWidth: landscape ? 150 : 110,
      columnStyles: { 1: { halign: "right" } },
    })
  }

  // ── Rodapé com paginação ─────────────────────────────────────────────────
  const totalPages = doc.getNumberOfPages()
  for (let page = 1; page <= totalPages; page++) {
    doc.setPage(page)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(7.5)
    doc.setTextColor(120, 130, 145)
    doc.text("PingOS · Relatórios", margin, pageHeight - 8)
    doc.text(`Página ${page} de ${totalPages}`, pageWidth - margin, pageHeight - 8, {
      align: "right",
    })
    doc.setTextColor(0, 0, 0)
  }

  doc.save(opts.filename)
}

/* -------------------------------------------------------------------------- */
/* Utilitários de período                                                      */
/* -------------------------------------------------------------------------- */

export const DAY_MS = 86_400_000

export type PeriodPreset = "hoje" | "7d" | "30d" | "mes" | "mes_anterior" | "ano" | "personalizado"

export const PERIOD_PRESETS: { id: PeriodPreset; label: string }[] = [
  { id: "hoje", label: "Hoje" },
  { id: "7d", label: "7 dias" },
  { id: "30d", label: "30 dias" },
  { id: "mes", label: "Este mês" },
  { id: "mes_anterior", label: "Mês anterior" },
  { id: "ano", label: "Este ano" },
  { id: "personalizado", label: "Personalizado" },
]

/**
 * Converte o preset em timestamps.
 *
 * O cálculo é feito **no navegador**, com o fuso do usuário — é o que garante
 * que "hoje" e "este mês" signifiquem a mesma coisa na tela e no banco (o
 * servidor pode estar em UTC dentro do container).
 */
export function presetRange(preset: PeriodPreset): { start: number; end: number } {
  const now = new Date()
  const endOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  ).getTime()

  switch (preset) {
    case "hoje":
      return { start: endOfToday - DAY_MS + 1, end: endOfToday }
    case "7d":
      return { start: endOfToday - 6 * DAY_MS, end: endOfToday }
    case "30d":
      return { start: endOfToday - 29 * DAY_MS, end: endOfToday }
    case "mes": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
      return { start, end: endOfToday }
    }
    case "mes_anterior": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime()
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999).getTime()
      return { start, end }
    }
    case "ano": {
      const start = new Date(now.getFullYear(), 0, 1).getTime()
      return { start, end: endOfToday }
    }
    default:
      return { start: endOfToday - 29 * DAY_MS, end: endOfToday }
  }
}

/** `YYYY-MM-DD` no fuso do navegador (valor de `<input type="date">`). */
export function toDateInput(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** Lê `YYYY-MM-DD` como o dia inteiro, no fuso do navegador. */
export function fromDateInput(value: string, edge: "start" | "end"): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split("-").map(Number)
  const date =
    edge === "start"
      ? new Date(year, month - 1, day, 0, 0, 0, 0)
      : new Date(year, month - 1, day, 23, 59, 59, 999)
  return Number.isNaN(date.getTime()) ? null : date.getTime()
}

export function formatPeriodLabel(range: { start: number; end: number }): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    })
  return `${fmt(range.start)} a ${fmt(range.end)}`
}
