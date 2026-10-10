/**
 * Métricas do painel — espelha src/convex/tickets.ts (monthlyMetrics e
 * dashboardMetrics).
 *
 * Os cálculos são feitos em memória a partir da lista de chamados, exatamente
 * como no backend Convex, para os números baterem 100% com o que o painel já
 * mostra hoje.
 */

import { Router } from "express";
import { query } from "../../mysql/pool";
import { asyncHandler } from "../errors";
import { requirePermission } from "../permissions";
import { toNumber } from "../types";

export const metricsRouter = Router();

/**
 * Linha enxuta de chamado para as métricas.
 *
 * Os relatórios só olham status, prioridade, valor e datas — antes o `SELECT *`
 * trazia a `image_url` (data URL de centenas de KB) e a descrição inteira de
 * cada chamado para jogá-las fora em memória. Numa base com anexos, isso era a
 * diferença entre alguns KB e dezenas de MB por leitura do painel.
 */
interface MetricsTicketRow {
  status: string;
  priority: string;
  valor_total: number | string | null;
  assignee_id: string | null;
  created_at: number;
  updated_at: number;
}

async function loadTickets() {
  const rows = await query<MetricsTicketRow>(
    "SELECT `status`, `priority`, `valor_total`, `assignee_id`, `created_at`, `updated_at` FROM `tickets`",
  );
  return rows.map((row) => ({
    status: row.status,
    priority: row.priority,
    valorTotal: row.valor_total === null ? undefined : toNumber(row.valor_total),
    assigneeId: row.assignee_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

async function loadTechnicians() {
  const rows = await query<{ id: string; name: string }>(
    "SELECT `id`, `name` FROM `technicians`",
  );
  return rows.map((t) => ({ id: t.id, name: t.name }));
}

// ── GET /api/metrics/monthly ────────────────────────────────────────────────
metricsRouter.get(
  "/monthly",
  asyncHandler(async (req, res) => {
    requirePermission(req, "metrics.view");
    const all = await loadTickets();
    const resolved = all.filter((t) => t.status === "resolvido");

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const inMonth = (ts: number, month: number, year: number) => {
      const d = new Date(ts);
      return d.getMonth() === month && d.getFullYear() === year;
    };
    const sum = (arr: typeof all) => arr.reduce((s, t) => s + (t.valorTotal ?? 0), 0);

    const currentMonthTickets = resolved.filter((t) => inMonth(t.updatedAt, currentMonth, currentYear));
    const prevMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const prevMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;
    const prevMonthTickets = resolved.filter((t) => inMonth(t.updatedAt, prevMonth, prevMonthYear));

    const breakdown: { month: string; count: number; total: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(currentYear, currentMonth - i, 1);
      const tickets = resolved.filter((t) =>
        inMonth(t.updatedAt, d.getMonth(), d.getFullYear()),
      );
      breakdown.push({
        month: d.toLocaleDateString("pt-BR", { month: "short", year: "numeric" }),
        count: tickets.length,
        total: sum(tickets),
      });
    }

    res.json({
      currentMonth: { count: currentMonthTickets.length, total: sum(currentMonthTickets) },
      previousMonth: { count: prevMonthTickets.length, total: sum(prevMonthTickets) },
      allTime: { count: resolved.length, total: sum(resolved) },
      breakdown,
    });
  }),
);

// ── GET /api/metrics/dashboard ──────────────────────────────────────────────
metricsRouter.get(
  "/dashboard",
  asyncHandler(async (req, res) => {
    requirePermission(req, "metrics.view");
    const [all, technicians] = await Promise.all([loadTickets(), loadTechnicians()]);

    const now = new Date();
    const thisMonth = now.getFullYear() * 12 + now.getMonth();
    const monthKey = (ts: number) => {
      const d = new Date(ts);
      return d.getFullYear() * 12 + d.getMonth();
    };

    const byStatus: Record<string, number> = {
      aberto: 0,
      em_andamento: 0,
      aguardando: 0,
      resolvido: 0,
      fechado: 0,
    };
    for (const t of all) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;

    const byPriority: Record<string, number> = { baixa: 0, media: 0, alta: 0, critica: 0 };
    for (const t of all) byPriority[t.priority] = (byPriority[t.priority] ?? 0) + 1;

    const cutoff = (monthsBack: number) => now.getTime() - monthsBack * 30 * 24 * 3600 * 1000;
    const sumValor = (arr: typeof all) => arr.reduce((s, t) => s + (t.valorTotal ?? 0), 0);

    const last30 = all.filter((t) => t.createdAt >= cutoff(1));
    const last90 = all.filter((t) => t.createdAt >= cutoff(3));

    const resolved = all.filter((t) => t.status === "resolvido");
    const resolvedThisMonth = resolved.filter((t) => monthKey(t.updatedAt) === thisMonth);
    const resolvedPrevMonth = resolved.filter((t) => monthKey(t.updatedAt) === thisMonth - 1);

    const resolutionTimes = resolved
      .map((t) => t.updatedAt - t.createdAt)
      .filter((ms) => ms >= 0);
    const avgResolutionHours =
      resolutionTimes.length > 0
        ? resolutionTimes.reduce((s, ms) => s + ms, 0) / resolutionTimes.length / 3600000
        : 0;

    const techById = new Map(technicians.map((t) => [t.id, t.name]));
    const techStats = new Map<string, { name: string; total: number; valor: number; resolved: number }>();
    for (const t of all) {
      if (!t.assigneeId) continue;
      const name = techById.get(t.assigneeId);
      if (!name) continue; // só técnicos entram no ranking
      const s = techStats.get(t.assigneeId) ?? { name, total: 0, valor: 0, resolved: 0 };
      s.total += 1;
      s.valor += t.valorTotal ?? 0;
      if (t.status === "resolvido") s.resolved += 1;
      techStats.set(t.assigneeId, s);
    }
    const techniciansRanking = [...techStats.values()]
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);

    const breakdown: { month: string; created: number; resolved: number; total: number }[] = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.getFullYear() * 12 + d.getMonth();
      const created = all.filter((t) => monthKey(t.createdAt) === key);
      const resolvedM = resolved.filter((t) => monthKey(t.updatedAt) === key);
      breakdown.push({
        month: d.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" }),
        created: created.length,
        resolved: resolvedM.length,
        total: sumValor(created),
      });
    }

    res.json({
      total: all.length,
      open: byStatus.aberto + byStatus.em_andamento + byStatus.aguardando,
      byStatus,
      byPriority,
      valorTotal: sumValor(all),
      valorLast30: sumValor(last30),
      createdLast30: last30.length,
      createdLast90: last90.length,
      criticalOpen: all.filter(
        (t) => t.priority === "critica" && t.status !== "resolvido" && t.status !== "fechado",
      ).length,
      avgResolutionHours,
      resolvedThisMonth: { count: resolvedThisMonth.length, total: sumValor(resolvedThisMonth) },
      resolvedPrevMonth: { count: resolvedPrevMonth.length, total: sumValor(resolvedPrevMonth) },
      resolvedAllTime: { count: resolved.length, total: sumValor(resolved) },
      techniciansRanking,
      breakdown,
    });
  }),
);
