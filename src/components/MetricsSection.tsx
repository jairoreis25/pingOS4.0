import { useState } from "react";
import { useQuery } from "@/lib/backend/react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { api } from "@/lib/backend/api";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Ticket,
  TrendingUp,
  Wrench,
  XCircle,
} from "lucide-react";

const STATUS_META: { key: string; label: string; color: string }[] = [
  { key: "aberto", label: "Abertos", color: "bg-emerald-500" },
  { key: "em_andamento", label: "Em Andamento", color: "bg-blue-500" },
  { key: "aguardando", label: "Aguardando", color: "bg-amber-500" },
  { key: "resolvido", label: "Resolvidos", color: "bg-violet-500" },
  { key: "fechado", label: "Fechados", color: "bg-zinc-400" },
];

const PRIORITY_META: { key: string; label: string; color: string }[] = [
  { key: "baixa", label: "Baixa", color: "bg-emerald-500" },
  { key: "media", label: "Média", color: "bg-amber-500" },
  { key: "alta", label: "Alta", color: "bg-orange-500" },
  { key: "critica", label: "Crítica", color: "bg-red-500" },
];

const fmtBRL = (v: number) =>
  `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`;

function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0;
}

function DistBar({
  items,
  counts,
  total,
}: {
  items: { key: string; label: string; color: string }[];
  counts: Record<string, number> | undefined;
  total: number;
}) {
  return (
    <div className="space-y-2.5">
      {items.map((it) => {
        const n = counts?.[it.key] ?? 0;
        return (
          <div key={it.key} className="flex items-center gap-3">
            <span className="w-24 shrink-0 text-xs text-muted-foreground">
              {it.label}
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full ${it.color} transition-all`}
                style={{ width: `${pct(n, total)}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums">
              {n}
              <span className="ml-1 font-normal text-muted-foreground">
                {pct(n, total)}%
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function MetricsSection() {
  const metrics = useQuery(api.tickets.dashboardMetrics);
  const [showDetails, setShowDetails] = useState(false);
  const [chartMode, setChartMode] = useState<"count" | "valor">("count");

  if (!metrics) return null;

  const trend =
    metrics.resolvedPrevMonth.count > 0
      ? ((metrics.resolvedThisMonth.count - metrics.resolvedPrevMonth.count) /
          metrics.resolvedPrevMonth.count) *
        100
      : null;

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 px-4 pt-6 sm:px-6">
      {/* KPI row */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {/* Total + open */}
        <div className="rounded-xl border border-border/50 bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Total de Chamados
            </span>
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10">
              <Ticket className="size-4 text-primary" />
            </span>
          </div>
          <div className="text-2xl font-bold tracking-tight">
            {metrics.total}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">{metrics.open}</span>{" "}
            em aberto ·{" "}
            <span className="font-semibold text-red-500">
              {metrics.criticalOpen}
            </span>{" "}
            crítico(s)
          </div>
        </div>

        {/* Created last 30 days */}
        <div className="rounded-xl border border-border/50 bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Últimos 30 Dias
            </span>
            <span className="flex size-8 items-center justify-center rounded-lg bg-blue-50 dark:bg-blue-950/40">
              <TrendingUp className="size-4 text-blue-600 dark:text-blue-400" />
            </span>
          </div>
          <div className="text-2xl font-bold tracking-tight">
            {metrics.createdLast30}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {metrics.createdLast90} nos últimos 90 dias
          </div>
        </div>

        {/* Resolved this month */}
        <div className="rounded-xl border border-border/50 bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Resolvidos (Mês)
            </span>
            <span className="flex size-8 items-center justify-center rounded-lg bg-emerald-50 dark:bg-emerald-950/40">
              <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" />
            </span>
          </div>
          <div className="text-2xl font-bold tracking-tight">
            {metrics.resolvedThisMonth.count}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {fmtBRL(metrics.resolvedThisMonth.total)}
            {trend !== null && (
              <>
                {" · "}
                <span
                  className={
                    trend >= 0
                      ? "font-semibold text-emerald-600 dark:text-emerald-400"
                      : "font-semibold text-red-500 dark:text-red-400"
                  }
                >
                  {trend >= 0 ? "+" : ""}
                  {trend.toFixed(0)}%
                </span>{" "}
                vs. anterior
              </>
            )}
          </div>
        </div>

        {/* Avg resolution time */}
        <div className="rounded-xl border border-border/50 bg-card p-5">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Tempo Médio Resolução
            </span>
            <span className="flex size-8 items-center justify-center rounded-lg bg-amber-50 dark:bg-amber-950/40">
              <Clock className="size-4 text-amber-600 dark:text-amber-400" />
            </span>
          </div>
          <div className="text-2xl font-bold tracking-tight">
            {metrics.avgResolutionHours >= 24
              ? `${Math.floor(metrics.avgResolutionHours / 24)}d`
              : `${metrics.avgResolutionHours.toFixed(1)}h`}
            {metrics.avgResolutionHours >= 24 && (
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                {Math.round(metrics.avgResolutionHours % 24)}h
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {fmtBRL(metrics.valorLast30)} faturados em 30 dias
          </div>
        </div>
      </div>

      {/* Toggle + Chart */}
      <div className="rounded-xl border border-border/50 bg-card p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Evolução — Últimos 12 Meses</h3>
          <div className="flex overflow-hidden rounded-lg border border-border/50 text-xs">
            <button
              onClick={() => setChartMode("count")}
              className={`px-3 py-1.5 transition-colors ${
                chartMode === "count"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
            >
              Chamados
            </button>
            <button
              onClick={() => setChartMode("valor")}
              className={`px-3 py-1.5 transition-colors ${
                chartMode === "valor"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted/50"
              }`}
            >
              Valor
            </button>
          </div>
        </div>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={metrics.breakdown}
              margin={{ top: 5, right: 10, left: 10, bottom: 0 }}
            >
              <XAxis
                dataKey="month"
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                axisLine={false}
                tickLine={false}
                width={chartMode === "valor" ? 55 : 30}
                tickFormatter={(v: number) =>
                  chartMode === "valor" ? `R$${(v / 1000).toFixed(0)}k` : `${v}`
                }
              />
              <Tooltip
                formatter={(value: number, name) =>
                  name === "total"
                    ? [fmtBRL(value), "Valor"]
                    : [
                        value,
                        name === "created" ? "Criados" : "Resolvidos",
                      ]
                }
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid hsl(var(--border))",
                  background: "hsl(var(--card))",
                  fontSize: 12,
                }}
                cursor={{ fill: "hsl(var(--muted) / 0.5)" }}
              />
              {chartMode === "count" ? (
                <Bar dataKey="created" fill="hsl(var(--primary) / 0.35)" radius={[4, 4, 0, 0]} maxBarSize={22} />
              ) : (
                <Bar dataKey="total" radius={[6, 6, 0, 0]} maxBarSize={36}>
                  {metrics.breakdown.map((_, index) => (
                    <Cell
                      key={index}
                      fill={
                        index === metrics.breakdown.length - 1
                          ? "hsl(var(--primary))"
                          : "hsl(var(--primary) / 0.3)"
                      }
                    />
                  ))}
                </Bar>
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Distributions + ranking */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* By status */}
        <div className="rounded-xl border border-border/50 bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <Ticket className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Por Situação no Kanban</h3>
          </div>
          <DistBar
            items={STATUS_META}
            counts={metrics.byStatus}
            total={metrics.total}
          />
        </div>

        {/* By priority */}
        <div className="rounded-xl border border-border/50 bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <AlertTriangle className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Por Prioridade</h3>
          </div>
          <DistBar
            items={PRIORITY_META}
            counts={metrics.byPriority}
            total={metrics.total}
          />
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-200/60 bg-red-50/60 px-3 py-2.5 dark:border-red-900/40 dark:bg-red-950/30">
            <XCircle className="size-4 shrink-0 text-red-500" />
            <p className="text-xs text-muted-foreground">
              <span className="font-bold text-red-600 dark:text-red-400">
                {metrics.criticalOpen}
              </span>{" "}
              chamado(s) crítico(s) ainda sem resolução
            </p>
          </div>
        </div>

        {/* Technician ranking */}
        <div className="rounded-xl border border-border/50 bg-card p-5">
          <div className="mb-4 flex items-center gap-2">
            <Wrench className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Por Técnico (Atribuídos)</h3>
          </div>
          {metrics.techniciansRanking.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nenhum chamado atribuído a técnicos ainda.
            </p>
          ) : (
            <div className="space-y-2">
              {metrics.techniciansRanking.map((t, i) => (
                <div
                  key={t.name}
                  className="flex items-center gap-3 rounded-lg border border-border/40 bg-muted/20 px-3 py-2"
                >
                  <span
                    className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold ${
                      i === 0
                        ? "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300"
                        : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{t.name}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {t.total} chamado(s) · {t.resolved} resolvido(s)
                    </p>
                  </div>
                  <span className="shrink-0 text-xs font-semibold">
                    {fmtBRL(t.valor)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Monthly table */}
      <div className="rounded-xl border border-border/50 bg-card p-5">
        <h3 className="mb-4 text-sm font-semibold">Detalhamento Mensal</h3>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          {metrics.breakdown.map((m) => (
            <div
              key={m.month}
              className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2.5"
            >
              <p className="text-xs font-medium capitalize text-muted-foreground">
                {m.month}
              </p>
              <p className="mt-0.5 text-sm font-semibold">
                {m.created} criado{m.created !== 1 ? "s" : ""}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {m.resolved} resolvido{m.resolved !== 1 ? "s" : ""} ·{" "}
                {m.total > 0 ? fmtBRL(m.total) : "—"}
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
