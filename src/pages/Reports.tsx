/**
 * Relatórios — filtros dinâmicos, visualização em tela, gráfico e exportação.
 *
 * O fluxo é: **filtros no topo → "Gerar relatório" → totais + gráfico + tabela**.
 * As exportações usam exatamente a mesma tabela que está na tela (`toTable`),
 * então o XLS e o PDF saem idênticos ao que o usuário está vendo.
 *
 * Permissões:
 *   * `reports.view`   — abrir a página, filtrar e ver os relatórios;
 *   * `reports.export` — exportar (XLS/PDF);
 *   * o relatório de **usuários e permissões** é exclusivo do administrador.
 *
 * Toda geração/exportação é registrada em `report_logs` (quem, quando, filtros e
 * formato) pelo `logReport`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  ArrowLeft,
  BarChart3,
  Bell,
  Building2,
  FileSpreadsheet,
  FileText,
  Filter,
  Loader2,
  RefreshCw,
  Ticket,
  Users,
  Wrench,
} from "lucide-react";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { usePermissions } from "@/hooks/use-permissions";
import { ThemeToggle } from "@/components/ThemeToggle";
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_UNSET,
} from "@/lib/ticket-categories";
import { COLUMNS, PRIORITY_CONFIG } from "@/lib/ticket-ui";
import {
  CHANNEL_LABELS,
  DAY_MS,
  PERIOD_PRESETS,
  REPORT_META,
  STATUS_LABELS,
  PRIORITY_LABELS,
  cellText,
  exportPdf,
  exportXls,
  fetchReport,
  fetchReportFilterOptions,
  formatPeriodLabel,
  fromDateInput,
  logReport,
  presetRange,
  summarize,
  toDateInput,
  toTable,
  type ExportSheet,
  type NotificationsReport,
  type PeriodPreset,
  type ReportFilterOptions,
  type ReportFilters,
  type ReportId,
  type ReportTable,
  type SectorReportRow,
  type TechnicianReportRow,
  type TicketsReport,
  type UsersReport,
} from "@/lib/reports";

const PAGE_SIZE = 100;

const REPORT_ICONS: Record<ReportId, typeof Ticket> = {
  tickets: Ticket,
  technicians: Wrench,
  sectors: Building2,
  users: Users,
  notifications: Bell,
};

/** Estado dos filtros enquanto o usuário digita (ainda não aplicados). */
interface Draft {
  preset: PeriodPreset;
  start: string;
  end: string;
  status: string;
  priority: string;
  assigneeId: string;
  client: string;
  setor: string;
  categoria: string;
  q: string;
}

const ALL = "__all__";

/** Pill suave com ponto colorido para o status (mesma linguagem do Kanban). */
function StatusPill({ label }: { label: string }) {
  const config = COLUMNS.find((column) => column.label === label);
  if (!config) {
    return <span className="text-xs text-slate-400">{label}</span>;
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold ${config.pillClass}`}
    >
      <span className={`size-1.5 rounded-full ${config.barColor}`} />
      {label}
    </span>
  );
}

/** Pill suave com borda para a prioridade (mesma linguagem do Kanban). */
function PriorityPill({ label }: { label: string }) {
  const config = Object.values(PRIORITY_CONFIG).find((item) => item.label === label);
  if (!config) {
    return <span className="text-xs text-slate-400">{label}</span>;
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-semibold ${config.className}`}
    >
      <span className={`size-1.5 rounded-full ${config.dot}`} />
      {label}
    </span>
  );
}

/** Barra colorida do totalizador: usa a cor do status quando o rótulo é "Status: X". */
function summaryBarColor(label: string): string {
  const statusLabel = label.startsWith("Status: ")
    ? label.slice("Status: ".length)
    : null;
  const match = statusLabel
    ? COLUMNS.find((column) => column.label === statusLabel)
    : undefined;
  return match?.barColor ?? "bg-slate-200 dark:bg-slate-700";
}

function buildFilters(draft: Draft): ReportFilters {
  const range =
    draft.preset === "personalizado"
      ? {
          start: fromDateInput(draft.start, "start") ?? presetRange("30d").start,
          end: fromDateInput(draft.end, "end") ?? Date.now(),
        }
      : presetRange(draft.preset);

  return {
    start: range.start,
    end: range.end,
    status: draft.status || undefined,
    priority: draft.priority || undefined,
    assigneeId: draft.assigneeId || undefined,
    client: draft.client.trim() || undefined,
    setor: draft.setor || undefined,
    categoria: draft.categoria || undefined,
    q: draft.q.trim() || undefined,
  };
}

export default function Reports() {
  const navigate = useNavigate();
  const { can, isAdmin, isLoading: permissionsLoading, userName } = usePermissions();

  const allowed = can("reports.view");
  const canExport = can("reports.export");

  const initial = presetRange("30d");
  const [draft, setDraft] = useState<Draft>({
    preset: "30d",
    start: toDateInput(initial.start),
    end: toDateInput(initial.end),
    status: "",
    priority: "",
    assigneeId: "",
    client: "",
    setor: "",
    categoria: "",
    q: "",
  });
  const [applied, setApplied] = useState<ReportFilters>(() => ({
    start: initial.start,
    end: initial.end,
  }));

  // O relatório de usuários só aparece (e só é buscado) para administradores.
  const tabs = useMemo(
    () => REPORT_META.filter((meta) => meta.id !== "users" || isAdmin),
    [isAdmin],
  );

  const [active, setActive] = useState<ReportId>("tickets");
  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  // O payload carrega junto a QUAL relatório ele pertence. Ao trocar de aba, a
  // resposta antiga continua em memória até a nova chegar — sem essa marca, o
  // gráfico/tabela interpretariam o relatório anterior como se fosse o novo (era
  // isso que estourava a aba "Usuários e Permissões": `byRole` não existe no
  // relatório de chamados).
  const [data, setData] = useState<{ id: ReportId; payload: unknown } | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState<"xls" | "pdf" | null>(null);
  const requestId = useRef(0);

  // ── Opções dos filtros (responsáveis, setores) ────────────────────────────
  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    fetchReportFilterOptions()
      .then((result) => {
        if (!cancelled) setOptions(result);
      })
      .catch(() => {
        /* os filtros simplesmente ficam sem as listas — não bloqueia o relatório */
      });
    return () => {
      cancelled = true;
    };
  }, [allowed]);

  // ── Busca do relatório ativo ──────────────────────────────────────────────
  const load = useCallback(
    async (report: ReportId, filters: ReportFilters, nextPage: number) => {
      const id = ++requestId.current;
      setLoading(true);
      try {
        const result = await fetchReport<unknown>(report, filters, {
          limit: PAGE_SIZE,
          offset: nextPage * PAGE_SIZE,
        });
        // Uma resposta antiga (troca rápida de aba/filtro) é descartada.
        if (id !== requestId.current) return null;
        setData({ id: report, payload: result });
        return result;
      } catch (error) {
        if (id !== requestId.current) return null;
        setData(null);
        toast.error(
          error instanceof Error ? error.message : "Não foi possível gerar o relatório.",
        );
        return null;
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (!allowed || !tabs.some((tab) => tab.id === active)) return;
    void load(active, applied, page);
  }, [allowed, active, applied, page, load, tabs]);

  // ── Ações ─────────────────────────────────────────────────────────────────
  const handleGenerate = () => {
    const filters = buildFilters(draft);
    setPage(0);
    setApplied(filters);
    // A auditoria registra o relatório com a quantidade de linhas que ele
    // realmente devolveu (e não um zero genérico).
    void load(active, filters, 0).then((result) => {
      const rows = Array.isArray((result as { rows?: unknown[] } | null)?.rows)
        ? ((result as { rows: unknown[] }).rows.length ?? 0)
        : 0;
      void logReport({ report: active, format: "tela", filters, rowCount: rows });
    });
  };

  // Só vale o payload que é do relatório ativo (ver comentário do estado).
  const current = data && data.id === active ? data.payload : null;
  const currentTable: ReportTable | null = current ? toTable(active, current) : null;
  const currentSummary = current ? summarize(active, current) : [];
  const activeMeta = REPORT_META.find((meta) => meta.id === active);
  const userLabel = userName ?? "usuário";

  const exportSheets = useCallback(async (): Promise<ExportSheet[]> => {
    // Sempre com os filtros aplicados e no teto de linhas da API (1000/report).
    const ids = tabs.map((tab) => tab.id);
    const results = await Promise.all(
      ids.map(async (id) => ({
        id,
        result: await fetchReport<unknown>(id, applied, { limit: 1000, offset: 0 }),
      })),
    );
    return results.map(({ id, result }) => ({
      name: REPORT_META.find((meta) => meta.id === id)?.sheet ?? id,
      table: toTable(id, result),
    }));
  }, [applied, tabs]);

  const handleExportXls = async () => {
    if (!canExport) {
      toast.error("Você não tem permissão para exportar relatórios.");
      return;
    }
    setExporting("xls");
    try {
      const sheets = await exportSheets();
      const rows = sheets.reduce((sum, sheet) => sum + sheet.table.rows.length, 0);
      await exportXls({
        filename: `pingos-relatorios-${toDateInput(Date.now())}.xlsx`,
        title: "Relatórios PingOS",
        periodLabel: formatPeriodLabel(applied),
        userLabel,
        summary:
          currentSummary.length > 0
            ? currentSummary
            : summarize(active, await fetchReport(active, applied, { limit: 1 })),
        sheets,
      });
      // Auditoria: uma linha por relatório exportado.
      for (const meta of tabs) {
        void logReport({
          report: meta.id,
          format: "xls",
          filters: applied,
          rowCount: sheets.find((sheet) => sheet.name === meta.sheet)?.table.rows.length ?? 0,
        });
      }
      toast.success(`XLS gerado com ${sheets.length} aba(s) e ${rows} linha(s).`);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao gerar o XLS.",
      );
    } finally {
      setExporting(null);
    }
  };

  const handleExportPdf = async () => {
    if (!canExport) {
      toast.error("Você não tem permissão para exportar relatórios.");
      return;
    }
    setExporting("pdf");
    try {
      // Garante que a tabela do relatório ativo está carregada.
      const table = currentTable ?? toTable(active, await fetchReport(active, applied));
      await exportPdf({
        filename: `pingos-${active}-${toDateInput(Date.now())}.pdf`,
        title: activeMeta?.label ?? "Relatório",
        periodLabel: formatPeriodLabel(applied),
        userLabel,
        summary: currentSummary,
        table,
      });
      void logReport({
        report: active,
        format: "pdf",
        filters: applied,
        rowCount: table.rows.length,
      });
      toast.success("PDF gerado.");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Falha ao gerar o PDF.",
      );
    } finally {
      setExporting(null);
    }
  };

  // ── Gráfico do relatório ativo ────────────────────────────────────────────
  const chart = useMemo(() => {
    if (!data || data.id !== active) return null;
    const payload = data.payload;
    if (active === "tickets") {
      const report = payload as TicketsReport;
      return {
        title: "Chamados por status",
        data: Object.entries(STATUS_LABELS).map(([key, label]) => ({
          name: label,
          value: report.totals?.byStatus?.[key] ?? 0,
        })),
      };
    }
    if (active === "technicians") {
      const report = payload as { rows: TechnicianReportRow[] };
      return {
        title: "Resolvidos por responsável (top 8)",
        data: [...(report.rows ?? [])]
          .sort((a, b) => b.resolved - a.resolved)
          .slice(0, 8)
          .map((row) => ({ name: row.name, value: row.resolved })),
      };
    }
    if (active === "sectors") {
      const report = payload as { rows: SectorReportRow[] };
      return {
        title: "Chamados por setor",
        data: (report.rows ?? []).slice(0, 10).map((row) => ({ name: row.setor, value: row.total })),
      };
    }
    if (active === "notifications") {
      const report = payload as NotificationsReport;
      return {
        title: "Envios por canal",
        data: Object.entries(CHANNEL_LABELS).map(([key, label]) => ({
          name: label,
          value: report.totals?.byChannel?.[key] ?? 0,
        })),
      };
    }
    const report = payload as UsersReport;
    return {
      title: "Usuários por papel",
      data: Object.entries(report.totals?.byRole ?? {}).map(([role, value]) => ({
        name: role,
        value,
      })),
    };
  }, [active, data]);

  // ── Permissão ─────────────────────────────────────────────────────────────
  if (!permissionsLoading && !allowed) {
    return (
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-muted">
          <BarChart3 className="size-6 text-muted-foreground" />
        </span>
        <h1 className="text-lg font-semibold">Relatórios indisponíveis</h1>
        <p className="text-sm text-muted-foreground">
          Sua conta não tem a permissão <strong>Ver relatórios</strong>. Peça ao
          administrador para liberá-la em Configurações → Papéis e permissões.
        </p>
        <Button variant="outline" onClick={() => navigate("/dashboard")} className="gap-1.5">
          <ArrowLeft className="size-4" />
          Voltar ao painel
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-page-glow">
      {/* ── Cabeçalho ─────────────────────────────────────────────────────── */}
      <header className="border-b border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="icon"
              className="size-9 border-slate-200 text-slate-500 transition-all duration-150 hover:text-blue-600 dark:border-slate-700"
              title="Voltar ao painel"
              onClick={() => navigate("/dashboard")}
            >
              <ArrowLeft className="size-4" strokeWidth={1.5} />
            </Button>
            <div>
              <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                <span className="flex size-8 items-center justify-center rounded-lg bg-blue-600 shadow-sm">
                  <BarChart3 className="size-4 text-white" strokeWidth={1.5} />
                </span>
                Relatórios
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Período {formatPeriodLabel(applied)}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <ThemeToggle />
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 border-slate-200 text-slate-600 transition-all duration-150 hover:text-blue-600 dark:border-slate-700 dark:text-slate-300"
              disabled={exporting !== null || !canExport}
              title={canExport ? undefined : "Sua conta não pode exportar relatórios"}
              onClick={() => void handleExportXls()}
            >
              {exporting === "xls" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FileSpreadsheet className="size-3.5" />
              )}
              Exportar XLS
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 border-slate-200 text-slate-600 transition-all duration-150 hover:text-blue-600 dark:border-slate-700 dark:text-slate-300"
              disabled={exporting !== null || !canExport}
              title={canExport ? undefined : "Sua conta não pode exportar relatórios"}
              onClick={() => void handleExportPdf()}
            >
              {exporting === "pdf" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <FileText className="size-3.5" />
              )}
              Exportar PDF
            </Button>
            <Button size="sm" className="gap-1.5 rounded-lg bg-blue-600 px-4 text-sm font-medium text-white shadow-sm transition-all duration-150 hover:bg-blue-700" onClick={handleGenerate} disabled={loading}>
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
              Gerar relatório
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] space-y-4 px-4 py-6 sm:px-6">
        {/* ── Abas ────────────────────────────────────────────────────────── */}
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {tabs.map((meta) => {
            const Icon = REPORT_ICONS[meta.id];
            const isActive = meta.id === active;
            return (
              <button
                key={meta.id}
                onClick={() => {
                  setActive(meta.id);
                  setPage(0);
                }}
                className={`flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-all duration-150 ${
                  isActive
                    ? "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-400"
                    : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800"
                }`}
                title={meta.description}
              >
                <Icon className="size-3.5" />
                {meta.label}
              </button>
            );
          })}
        </div>

        {/* ── Filtros ─────────────────────────────────────────────────────── */}
        <section className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm sm:p-5 dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-4 flex items-center gap-2">
            <Filter className="size-4 text-slate-400" strokeWidth={1.5} />
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Filtros</h2>
            <span className="text-xs text-slate-500 dark:text-slate-400">— {activeMeta?.description}</span>
          </div>

          <div className="mb-4 flex flex-wrap gap-1.5">
            {PERIOD_PRESETS.map((preset) => (
              <button
                key={preset.id}
                onClick={() => {
                  const range = presetRange(preset.id);
                  setDraft((prev) => ({
                    ...prev,
                    preset: preset.id,
                    start: toDateInput(range.start),
                    end: toDateInput(range.end),
                  }));
                }}
                className={`rounded-lg border px-2.5 py-1.5 text-xs transition-all duration-150 ${
                  draft.preset === preset.id
                    ? "border-blue-200 bg-blue-50 font-medium text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-400"
                    : "border-slate-200 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500 dark:text-slate-400">Data inicial</Label>
              <Input
                type="date"
                value={draft.start}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    preset: "personalizado",
                    start: e.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500 dark:text-slate-400">Data final</Label>
              <Input
                type="date"
                value={draft.end}
                onChange={(e) =>
                  setDraft((prev) => ({ ...prev, preset: "personalizado", end: e.target.value }))
                }
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500 dark:text-slate-400">Status</Label>
              <Select
                value={draft.status || ALL}
                onValueChange={(value) =>
                  setDraft((prev) => ({ ...prev, status: value === ALL ? "" : value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todos os status</SelectItem>
                  {Object.entries(STATUS_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500 dark:text-slate-400">Prioridade</Label>
              <Select
                value={draft.priority || ALL}
                onValueChange={(value) =>
                  setDraft((prev) => ({ ...prev, priority: value === ALL ? "" : value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todas as prioridades</SelectItem>
                  {Object.entries(PRIORITY_LABELS).map(([key, label]) => (
                    <SelectItem key={key} value={key}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500 dark:text-slate-400">Responsável</Label>
              <Select
                value={draft.assigneeId || ALL}
                onValueChange={(value) =>
                  setDraft((prev) => ({ ...prev, assigneeId: value === ALL ? "" : value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todos os responsáveis</SelectItem>
                  {(options?.assignees ?? []).map((assignee) => (
                    <SelectItem key={assignee.id} value={assignee.id}>
                      {assignee.name}
                      {assignee.type === "technician" ? " (técnico)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500 dark:text-slate-400">Setor</Label>
              <Select
                value={draft.setor || ALL}
                onValueChange={(value) =>
                  setDraft((prev) => ({ ...prev, setor: value === ALL ? "" : value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todos" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todos os setores</SelectItem>
                  {(options?.setores ?? []).map((setor) => (
                    <SelectItem key={setor} value={setor}>
                      {setor}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500 dark:text-slate-400">Categoria</Label>
              <Select
                value={draft.categoria || ALL}
                onValueChange={(value) =>
                  setDraft((prev) => ({ ...prev, categoria: value === ALL ? "" : value }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Todas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>Todas as categorias</SelectItem>
                  {TICKET_CATEGORIES.map((categoria) => (
                    <SelectItem key={categoria} value={categoria}>
                      {categoria}
                    </SelectItem>
                  ))}
                  {/* Caso à parte: os chamados abertos antes da coluna existir
                      (ou que ninguém classificou ainda). */}
                  <SelectItem value={TICKET_CATEGORY_UNSET}>Sem categoria</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500 dark:text-slate-400">Cliente</Label>
              <Input
                placeholder="Nome do solicitante"
                value={draft.client}
                onChange={(e) => setDraft((prev) => ({ ...prev, client: e.target.value }))}
              />
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs text-slate-500 dark:text-slate-400">Busca</Label>
              <Input
                placeholder="Nº do chamado ou título"
                value={draft.q}
                onChange={(e) => setDraft((prev) => ({ ...prev, q: e.target.value }))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleGenerate();
                }}
              />
            </div>
          </div>
        </section>

        {/* ── Totalizadores ───────────────────────────────────────────────── */}
        {currentSummary.length > 0 && (
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {currentSummary.map((item) => (
              <div
                key={item.label}
                className="overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900"
              >
                {/* Barra colorida: usa a cor do status quando o totalizador é por status. */}
                <div className={`h-1 w-full ${summaryBarColor(item.label)}`} />
                <div className="px-4 py-3">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500 dark:text-slate-400">
                    {item.label}
                  </p>
                  <p className="mt-1 text-xl font-bold tabular-nums tracking-tight text-slate-900 dark:text-slate-100">{item.value}</p>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* ── Gráfico ─────────────────────────────────────────────────────── */}
        {chart && chart.data.some((point) => point.value > 0) && (
          <section className="rounded-xl border border-slate-300 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
            <h2 className="mb-4 text-sm font-semibold text-slate-900 dark:text-slate-100">{chart.title}</h2>
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart.data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                    interval={0}
                    height={40}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                    axisLine={false}
                    tickLine={false}
                    width={36}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: "1px solid hsl(var(--border))",
                      background: "hsl(var(--card))",
                      fontSize: 12,
                    }}
                    cursor={{ fill: "hsl(var(--muted) / 0.5)" }}
                  />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={48}>
                    {chart.data.map((_, index) => (
                      <Cell
                        key={index}
                        fill={
                          index === 0 ? "hsl(var(--primary))" : "hsl(var(--primary) / 0.35)"
                        }
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>
        )}

        {/* ── Tabela ──────────────────────────────────────────────────────── */}
        <section className="overflow-hidden rounded-xl border border-slate-300 bg-white shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-300 px-5 py-3 dark:border-slate-700">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{activeMeta?.label}</h2>
            <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
              {loading && <Loader2 className="size-3.5 animate-spin" />}
              <span>
                {currentTable
                  ? `${currentTable.rows.length} linha(s) nesta página`
                  : "Nenhum dado ainda"}
              </span>
              <Badge variant="outline" className="border-slate-200 font-normal text-slate-500 dark:border-slate-700 dark:text-slate-400">
                até {PAGE_SIZE} por página
              </Badge>
            </div>
          </div>

          {currentTable && currentTable.rows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-b border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50">
                    {currentTable.columns.map((column) => (
                      <th
                        key={column.key}
                        className={`whitespace-nowrap px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 ${
                          column.align === "right" ? "text-right" : "text-left"
                        }`}
                      >
                        {column.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {currentTable.rows.map((row, index) => (
                    <tr
                      key={index}
                      className="border-b border-slate-100 transition-colors last:border-0 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/50"
                    >
                      {currentTable.columns.map((column) => {
                        // `cellText` aplica o formato da coluna (moeda em pt-BR,
                        // milhar, uma casa decimal) — a mesma tabela que vai
                        // para o XLS e o PDF.
                        const text = cellText(column, row[column.key]);
                        // Status e prioridade ganham a mesma pill do Kanban — só
                        // no relatório de chamados, único com essas colunas.
                        const isTicketStatus = active === "tickets" && column.key === "status";
                        const isTicketPriority = active === "tickets" && column.key === "priority";
                        return (
                          <td
                            key={column.key}
                            className={`px-3 py-2 align-top text-slate-700 dark:text-slate-300 ${
                              column.align === "right"
                                ? "text-right tabular-nums"
                                : "text-left"
                            }`}
                          >
                            {isTicketStatus ? (
                              <StatusPill label={text} />
                            ) : isTicketPriority ? (
                              <PriorityPill label={text} />
                            ) : text === "—" ? (
                              <span className="text-slate-400/70">—</span>
                            ) : (
                              text
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="px-5 py-10 text-center text-sm text-slate-500 dark:text-slate-400">
              {loading
                ? "Gerando relatório…"
                : "Nenhum registro encontrado com esses filtros."}
            </div>
          )}

          {/* Paginação (a API devolve no máximo 1000 linhas por página) */}
          {currentTable && (currentTable.rows.length > 0 || page > 0) && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-300 px-5 py-3 dark:border-slate-700">
              <span className="text-xs text-slate-500 dark:text-slate-400">
                Página {page + 1} · linhas {page * PAGE_SIZE + 1}–
                {page * PAGE_SIZE + currentTable.rows.length}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0 || loading}
                  onClick={() => setPage((prev) => Math.max(0, prev - 1))}
                >
                  Anterior
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={
                    loading ||
                    !(
                      (current as { page?: { hasMore?: boolean } } | null)?.page
                        ?.hasMore ?? false
                    )
                  }
                  onClick={() => setPage((prev) => prev + 1)}
                >
                  Próxima
                </Button>
              </div>
            </div>
          )}
        </section>

        <p className="pb-4 text-center text-[11px] text-slate-500 dark:text-slate-400">
          Toda geração e exportação fica registrada na auditoria (quem, quando,
          filtros e formato). O XLS sai com uma aba por relatório; o PDF, com o
          relatório aberto na tela.
        </p>
      </main>
    </div>
  );
}
