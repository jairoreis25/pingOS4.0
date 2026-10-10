// Shared helpers for the ticket description subfields
// (Solução / Orçamento / Obs / Status do equipamento)
// and for formatting WhatsApp ticket messages.

import { formatBRL, resolveItemsTotal } from "./currency";

export interface DescFields {
  solucao?: string | null;
  orcamento?: string | null;
  obs?: string | null;
  statusEquipamento?: string | null;
}

/** Fixed options for the "Status" dropdown (edit-only field). */
export const STATUS_EQUIPAMENTO_OPTIONS = [
  "Aguardando retirada",
  "Aguardando aprovação do orçamento",
  "Entregue",
  "Entregue sem reparo",
] as const;

/** Sentinel value for "no option selected" in the Status dropdown. */
export const STATUS_EQUIPAMENTO_EMPTY = "—";

/** Formats the subfields as WhatsApp-style bold lines (empty fields are omitted). */
export function describeDescFields(fields: DescFields): string {
  const lines: string[] = [];
  if (fields.solucao?.trim()) lines.push(`*Solução:* ${fields.solucao.trim()}`);
  if (fields.orcamento?.trim()) lines.push(`*Orçamento:* ${fields.orcamento.trim()}`);
  if (fields.obs?.trim()) lines.push(`*Obs:* ${fields.obs.trim()}`);
  if (fields.statusEquipamento?.trim()) lines.push(`*Situação:* ${fields.statusEquipamento.trim()}`);
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* WhatsApp message formatting                                         */
/* ------------------------------------------------------------------ */

export const STATUS_LABELS: Record<string, string> = {
  aberto: "🟢 Aberto",
  em_andamento: "🔵 Em Andamento",
  aguardando: "🟡 Aguardando",
  resolvido: "✅ Resolvido",
  fechado: "⬜ Fechado",
};

export const STATUS_PLAIN: Record<string, string> = {
  aberto: "Aberto",
  em_andamento: "Em Andamento",
  aguardando: "Aguardando",
  resolvido: "Resolvido",
  fechado: "Fechado",
};

export const PRIORITY_LABELS: Record<string, string> = {
  baixa: "🟢 Baixa",
  media: "🟡 Média",
  alta: "🟠 Alta",
  critica: "🔴 Crítica",
};

const DIV = "━━━━━━━━━━━━━━";

export interface TicketMessageData {
  number?: number | null;
  title?: string | null;
  description?: string | null;
  solucao?: string | null;
  orcamento?: string | null;
  obs?: string | null;
  statusEquipamento?: string | null;
  priority?: string | null;
  status?: string | null;
  creatorName?: string | null;
  guestContact?: string | null;
  location?: string | null;
  os?: string | null;
  valorTotal?: number | null;
  assigneeName?: string | null;
  createdAt?: number | null;
}

/** Mesmo formato da tela — negativo sai como "-R$ 50,00". */
function fmtBRL(value: number): string {
  return formatBRL(value);
}

function section(label: string, text: string | null | undefined, maxLen = 600): string[] {
  const trimmed = text?.trim();
  if (!trimmed) return [];
  const body =
    trimmed.length > maxLen ? trimmed.slice(0, maxLen) + "…" : trimmed;
  return [``, label, body];
}

/**
 * Builds a clean, well-spaced WhatsApp message for a ticket.
 * type "created" → "sua Ordem de Serviço N… foi aberta no PingOS"
 * type "status_changed" → "foi atualizada" + bloco De/Para/Situação
 * opts.greeting=false → neutral header (used by "Compartilhar no WhatsApp")
 */
export function buildTicketMessage(
  ticket: TicketMessageData,
  type: "created" | "status_changed",
  opts?: { oldStatus?: string | null; newStatus?: string | null; greeting?: boolean },
): string {
  const greeting = opts?.greeting !== false;
  const name = ticket.creatorName?.trim() || "Solicitante";
  const num = ticket.number ?? ticket.os ?? "?";
  const plain = (s?: string | null) => STATUS_PLAIN[s ?? ""] ?? s ?? "—";
  const equip = ticket.statusEquipamento?.trim();

  const lines: string[] = [];

  // Header
  if (!greeting) {
    lines.push(`📋 *Ordem de Serviço #${num}*`);
  } else if (type === "created") {
    lines.push(
      `*Olá, ${name}! tudo bem?*`,
      `*Informamos que a sua Ordem de Serviço foi aberta no PingOS.*`,
    );
  } else {
    lines.push(
      `*Olá, ${name}! tudo bem?*`,
      `*Informamos que a sua Ordem de Serviço foi atualizada.*`,
    );
  }

  // Status block — De ➜ Para + Situação (equipamento), above the divider
  if (type === "status_changed") {
    lines.push(`*De: ${plain(opts?.oldStatus)}*  ➜ *${plain(opts?.newStatus ?? ticket.status)}*`);
  } else {
    lines.push(`*Status:* ${plain(ticket.status)}`);
  }
  if (equip) lines.push(`*Situação:* *${equip}*`);

  // Details block — ticket info, blank line, people
  lines.push(DIV, `📋 *DADOS DO CHAMADO*`, ``);
  if (ticket.title?.trim()) lines.push(`📌 *Título:* ${ticket.title.trim()}`);
  lines.push(`🚦 *Prioridade:* ${PRIORITY_LABELS[ticket.priority ?? ""] ?? ticket.priority ?? "—"}`);
  if (ticket.os?.trim()) lines.push(`🔢 *O.S:* ${ticket.os.trim()}`);
  // O total pode nunca ter sido gravado (chamados antigos): nesse caso valem os
  // itens já escritos na Solução (ou no Orçamento), igual ao que a tela mostra.
  const itemsSum = resolveItemsTotal(ticket.solucao, ticket.orcamento).value;
  const valorTotal = ticket.valorTotal ?? (itemsSum !== 0 ? itemsSum : null);
  if (valorTotal != null) lines.push(`💰 *Valor:* ${fmtBRL(valorTotal)}`);

  const people: string[] = [];
  if (ticket.creatorName?.trim()) people.push(`👤 *Solicitante:* ${ticket.creatorName.trim()}`);
  if (ticket.guestContact?.trim()) people.push(`📞 *Contato:* ${ticket.guestContact.trim()}`);
  if (ticket.location?.trim()) people.push(`📍 *Local:* ${ticket.location.trim()}`);
  if (ticket.assigneeName?.trim()) people.push(`🛠️ *Responsável:* ${ticket.assigneeName.trim()}`);
  if (people.length) lines.push(``, ...people);

  // Content sections
  lines.push(...section("📝 *DESCRIÇÃO*", ticket.description || "Sem descrição."));
  lines.push(...section("🔧 *SOLUÇÃO*", ticket.solucao));
  lines.push(...section("💵 *ORÇAMENTO*", ticket.orcamento));
  lines.push(...section("🗒️ *OBS*", ticket.obs));

  // Footer
  const when =
    type === "created"
      ? `Aberto em`
      : greeting
        ? `Atualizado em`
        : `Registro em`;
  const d = ticket.createdAt ? new Date(ticket.createdAt) : new Date();
  lines.push(
    DIV,
    `📅 ${when} ${d.toLocaleDateString("pt-BR")} às ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`,
  );

  return lines.join("\n");
}
