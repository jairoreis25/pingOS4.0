/**
 * Impressão do chamado (impressora térmica 80 mm).
 *
 * O HTML estava embutido no `Dashboard` (60+ linhas de template literal no meio
 * do componente). Aqui ele vira uma função pura, testável, e — diferença
 * importante em relação ao original — o texto do usuário é **escapado**: uma
 * descrição com `<script>` rodaria na janela de impressão, que abre com a mesma
 * origem do sistema.
 */

/** Escapa texto para interpolar em HTML (`&`, `<`, `>`, `"`, `'`). */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export type PrintableTicket = {
  number: number | string
  title?: string | null
  description?: string | null
  solucao?: string | null
  orcamento?: string | null
  obs?: string | null
  statusEquipamento?: string | null
  os?: string | null
  guestContact?: string | null
  location?: string | null
  creatorName?: string | null
  assigneeName?: string | null
  imageUrl?: string | null
  createdAt?: number | string | null
}

const PRINT_STYLE = `
  @page { size: 80mm auto; margin: 2mm; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 76mm; font-family: 'Courier New', monospace; font-size: 11px; color: #000; padding: 2mm; }
  .center { text-align: center; }
  .bold { font-weight: bold; }
  .line { border-top: 1px dashed #000; margin: 3mm 0; }
  .label { font-size: 9px; color: #555; text-transform: uppercase; letter-spacing: 0.5px; }
  .value { font-size: 11px; margin-top: 1mm; }
  .big { font-size: 16px; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; }
  td { padding: 1mm 0; vertical-align: top; }
  .desc { white-space: pre-wrap; word-break: break-word; line-height: 1.4; }
  img { max-width: 100%; margin-top: 2mm; }
  .footer { margin-top: 4mm; text-align: center; font-size: 8px; color: #888; }
`

function bloco(label: string, valor: string | null | undefined): string {
  if (!valor) return ""
  return `<div class="line"></div><div class="label">${escapeHtml(label)}</div><div class="value desc">${escapeHtml(valor)}</div>`
}

function linhaTabela(label: string, valor: string | null | undefined, classe = "value"): string {
  if (!valor) return ""
  return `<tr><td class="label">${escapeHtml(label)}</td><td class="${classe}">${escapeHtml(valor)}</td></tr>`
}

/**
 * Monta o HTML completo da via do chamado (o `<script>` final dispara a
 * impressão assim que a janela carrega).
 */
export function buildTicketPrintHtml(
  ticket: PrintableTicket,
  labels: { statusLabel: string; priorityLabel: string; valorTotal?: string | null },
  hoje: Date = new Date(),
): string {
  const criadoEm = ticket.createdAt ? new Date(ticket.createdAt).toLocaleString("pt-BR") : ""

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Chamado #${escapeHtml(ticket.number)}</title>
<style>${PRINT_STYLE}</style></head><body>
  <div class="center">
    <div class="big">PINGOS</div>
    <div class="label">Sistema de Chamados de TI</div>
  </div>
  <div class="line"></div>
  <div class="center"><span class="big">#${escapeHtml(ticket.number)}</span></div>
  <div class="line"></div>
  <table>
    ${linhaTabela("Status", labels.statusLabel, "value bold")}
    ${linhaTabela("Prioridade", labels.priorityLabel, "value bold")}
    ${linhaTabela("O.S", ticket.os, "value bold")}
    ${linhaTabela("Valor", labels.valorTotal ?? null, "value bold")}
    ${linhaTabela("Título", ticket.title ?? "Sem título", "value bold")}
  </table>
  <div class="line"></div>
  <div class="label">Descrição</div>
  <div class="value desc">${escapeHtml(ticket.description ?? "Sem descrição.")}</div>
  ${bloco("Solução", ticket.solucao)}
  ${bloco("Orçamento", ticket.orcamento)}
  ${bloco("Obs", ticket.obs)}
  ${bloco("Situação", ticket.statusEquipamento)}
  <div class="line"></div>
  <table>
    ${linhaTabela("Solicitante", ticket.creatorName)}
    ${linhaTabela("Contato", ticket.guestContact)}
    ${linhaTabela("Local", ticket.location)}
    ${linhaTabela("Responsável", ticket.assigneeName)}
  </table>
  <div class="line"></div>
  <div class="center" style="margin-top:2mm;">
    <div class="label">Aberto em</div>
    <div class="value">${escapeHtml(criadoEm)}</div>
  </div>
  ${ticket.imageUrl ? `<div class="line"></div><div class="label">Imagem</div><img src="${escapeHtml(ticket.imageUrl)}" />` : ""}
  <div class="footer">PingOS • ${escapeHtml(hoje.toLocaleDateString("pt-BR"))}</div>
  <script>window.onload = () => { window.print(); }</script>
</body></html>`
}
