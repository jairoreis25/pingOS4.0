/**
 * Ping IA — agente administrativo do PingOS via Telegram.
 *
 * Roda como um processo separado da API:
 *
 *   bun run bot-ia      (= bun run hermes/bot-ia.ts)
 *
 * Fluxo:
 *   1. lê `bot_config` (Configurações → Bot Ping IA, salvo pelo dashboard);
 *   2. enquanto estiver desativado ou sem chave/token, apenas espera — relendo
 *      a configuração a cada 15s — em vez de encerrar o processo;
 *   3. com tudo pronto, conecta ao Telegram (grammy) e à API da NVIDIA
 *      (compatível com OpenAI);
 *   4. responde apenas ao Id do administrador — vindo do dashboard
 *      (`bot_config.admin_id`) ou, como alternativa, da variável ADMIN_ID — e
 *      executa ferramentas no MySQL. Sem nenhum Id salvo, o bot sobe e usa a
 *      primeira mensagem para revelar o Id de quem escreveu.
 *
 * Acesso total com filtros poderosos: o administrador pode listar, buscar,
 * relatar, criar, editar, fechar e reabrir qualquer coisa combinando filtros.
 * Todas as leituras são imediatas. **Só a exclusão** passa pelo sistema de
 * `acoes_pendentes` (resumo + Sim/Não). Toda mutação é registrada em
 * `audit_log`.
 *
 * Foto de O.S. impressa: quando chega uma foto, o bot baixa a imagem, manda
 * para o modelo de **visão** (`bot_config.modelo_visao`, separado do modelo de
 * texto) com um prompt que pede só JSON, e cria o chamado — o campo
 * "Descrição:" da O.S. vira o **título** e o "PROBLEMAS:" vira a **descrição**
 * do chamado. O.S. repetida (ou campo ilegível) pede confirmação antes.
 *
 * Como o supervisor relê a configuração, **ligar/desligar o switch no dashboard
 * (ou trocar modelo/chave/prompt) passa a valer sem reiniciar o processo**.
 *
 * Sem webhook, sem MCP, sem systemd: é um processo simples com long polling.
 * A configuração do banco usa as MESMAS variáveis MYSQL_* da API (o pool e o
 * carregador de env são reaproveitados de `server/`).
 */

import { Bot, type Context } from "grammy";
import OpenAI from "openai";
import { loadEnvFile } from "../server/api/env";
import {
  closePool,
  execute,
  newId,
  query,
  queryOne,
  withTransaction,
} from "../server/mysql/pool";
import { ensureSchema } from "../server/mysql/migrate";
import {
  notifyTicketCreated, notifyTicketStatusChanged } from "../server/api/notify";
// Catálogo de provedores de IA (NVIDIA, OpenAI, Gemini, Anthropic...): o bot
// fala com qual estiver configurado em `bot_config.provider`.
import {
  aiChat,
  createAiClient,
  missingBaseUrl,
  providerLabel,
  resolveModelFor,
  resolveProvider,
  resolveVisionModelFor,
} from "../server/api/ai-providers";
import { extractText } from "../server/api/nvidia";
import { normalizeTicketCategory } from "../src/lib/ticket-categories";

/** De quanto em quanto tempo a configuração do banco é relida. */
const CHECK_INTERVAL_MS = 15_000;

const DAY_MS = 86_400_000;

/** Regra de SLA vigente no PingOS: Aberto/Em Andamento parado há 3 dias. */
const SLA_DIAS = 3;

/**
 * Tempo máximo que o processo fica esperando a resposta da API de visão ao ler
 * uma foto de O.S. (o modelo é multimodal e, na primeira chamada, demora).
 */
const VISAO_TIMEOUT_MS = 120_000;

/** Teto da imagem aceita para OCR (o Telegram comprime fotos bem abaixo disso). */
const LIMITE_IMAGEM_BYTES = 5 * 1024 * 1024;

/** Paginação das listagens. */
const LIMITE_PADRAO = 20;
const LIMITE_MAXIMO = 200;

/** Tempo que uma ação de exclusão fica aguardando o "Sim". */
const PENDENTE_VALIDADE_MS = 30 * 60 * 1000;

/* -------------------------------------------------------------------------- */
/* Rótulos e normalizadores (a spec usa "Aberto"; o banco usa 'aberto')        */
/* -------------------------------------------------------------------------- */

const STATUS_LABEL: Record<string, string> = {
  aberto: "Aberto",
  em_andamento: "Em Andamento",
  aguardando: "Aguardando",
  resolvido: "Resolvido",
  fechado: "Fechado",
};

const PRIORITY_LABEL: Record<string, string> = {
  baixa: "Baixa",
  media: "Média",
  alta: "Alta",
  critica: "Crítica",
};

/** Aceita "Aberto", "aberto", "Em Andamento", "em_andamento", "Aguardando"... */
function normalizeStatus(value: unknown): string | null {
  const key = String(value ?? "").trim().toLowerCase().replace(/\s+/g, "_");
  const table: Record<string, string> = {
    aberto: "aberto",
    open: "aberto",
    em_andamento: "em_andamento",
    andamento: "em_andamento",
    aguardando: "aguardando",
    waiting: "aguardando",
    resolvido: "resolvido",
    resolved: "resolvido",
    fechado: "fechado",
    closed: "fechado",
  };
  return table[key] ?? null;
}

/** Aceita "Crítica", "critica", "Média", "Alta", "Baixa" (e variações). */
function normalizePriority(value: unknown): string | null {
  const key = String(value ?? "").trim().toLowerCase();
  const table: Record<string, string> = {
    baixa: "baixa",
    baixo: "baixa",
    low: "baixa",
    media: "media",
    "média": "media",
    medio: "media",
    "médio": "media",
    normal: "media",
    alta: "alta",
    alto: "alta",
    high: "alta",
    critica: "critica",
    "crítica": "critica",
    critico: "critica",
    "crítico": "critica",
    urgente: "critica",
  };
  return table[key] ?? null;
}

/* -------------------------------------------------------------------------- */
/* Utilidades                                                                  */
/* -------------------------------------------------------------------------- */

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function str(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

/** Converte um valor (único ou array) numa lista de strings não vazias. */
function toArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map(str).filter((item) => item.length > 0);
}

/**
 * Como `toArray`, mas também separa por vírgula — o modelo às vezes manda
 * `"Aberto, Em Andamento"` em vez de um array. Usado em campos de enumeração
 * (status, prioridade, categoria, setor...), nunca em nomes.
 */
function toValues(value: unknown): string[] {
  const out: string[] = [];
  for (const item of toArray(value)) {
    for (const part of item.split(",")) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function clampLimite(value: unknown): number {
  const parsed = Math.floor(toNumber(value));
  if (!Number.isFinite(parsed) || parsed <= 0) return LIMITE_PADRAO;
  return Math.min(parsed, LIMITE_MAXIMO);
}

function clampOffset(value: unknown): number {
  const parsed = Math.floor(toNumber(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function safeJson(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || !text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Data legível em pt-BR (dd/mm/aaaa hh:mm). */
function fmtData(ms: unknown): string {
  const value = toNumber(ms);
  if (!value) return "—";
  const date = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function labelStatus(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

function labelPrioridade(priority: string): string {
  return PRIORITY_LABEL[priority] ?? priority;
}

/* -------------------------------------------------------------------------- */
/* Datas relativas — "hoje", "ontem", "7d", "mes passado", ISO...             */
/* -------------------------------------------------------------------------- */

/**
 * Traduz uma expressão de data (ISO, epoch em ms ou relativa em pt-BR) para
 * milissegundos. As datas do PingOS são BIGINT em ms, então tudo vira número.
 *
 * `edge` decide se expressões de dia inteiro pegam o começo ou o fim do período
 * — `_apos` usa "start", `_antes` usa "end".
 */
function parseDataRelativa(value: unknown, edge: "start" | "end" = "start"): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;

  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;

  const now = new Date();
  const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime();
  const dayEnd = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
  const pick = (d: Date) => (edge === "start" ? dayStart(d) : dayEnd(d));

  // ISO com hora: 2026-09-30T10:00 / 2026-09-30 10:00
  if (/^\d{4}-\d{2}-\d{2}[t ]\d{2}/.test(raw)) {
    const parsed = new Date(raw.replace(" ", "T"));
    return Number.isNaN(parsed.getTime()) ? null : parsed.getTime();
  }
  // ISO só data: 2026-09-30
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [year, month, day] = raw.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : pick(date);
  }
  // Epoch em milissegundos
  if (/^\d{10,}$/.test(raw)) return Number(raw);

  const key = raw.replace(/\s+/g, "_");

  // "7d", "30d", "ultimos_7_dias", "ultimos_30_dias" → janela móvel
  const rolling = key.match(/^(?:ultimos?_)?(\d+)d(?:ias)?$/);
  if (rolling) {
    const days = Number(rolling[1]);
    return edge === "start" ? Date.now() - days * DAY_MS : Date.now();
  }

  if (key === "hoje") return pick(now);
  if (key === "ontem") {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return pick(d);
  }
  if (key === "anteontem") {
    const d = new Date(now);
    d.setDate(d.getDate() - 2);
    return pick(d);
  }
  if (key === "esta_semana" || key === "semana" || key === "essa_semana") {
    const start = new Date(now);
    start.setDate(start.getDate() - start.getDay());
    return edge === "start" ? dayStart(start) : dayEnd(now);
  }
  if (key === "semana_passada") {
    const end = new Date(now);
    end.setDate(end.getDate() - end.getDay() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - 6);
    return edge === "start" ? dayStart(start) : dayEnd(end);
  }
  if (key === "este_mes" || key === "mes" || key === "esse_mes") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return edge === "start" ? dayStart(start) : dayEnd(now);
  }
  if (key === "mes_passado") {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 0);
    return edge === "start" ? dayStart(start) : dayEnd(end);
  }
  if (key === "este_ano" || key === "ano" || key === "esse_ano") {
    const start = new Date(now.getFullYear(), 0, 1);
    return edge === "start" ? dayStart(start) : dayEnd(now);
  }
  if (key === "ano_passado") {
    const start = new Date(now.getFullYear() - 1, 0, 1);
    const end = new Date(now.getFullYear() - 1, 11, 31);
    return edge === "start" ? dayStart(start) : dayEnd(end);
  }
  return null;
}

/** Período (início/fim) a partir de uma expressão; sem expressão, últimos 30 dias. */
function parsePeriodo(termo: unknown): { start: number; end: number } {
  const start = parseDataRelativa(termo, "start") ?? Date.now() - 30 * DAY_MS;
  const end = parseDataRelativa(termo, "end") ?? Date.now();
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

/* -------------------------------------------------------------------------- */
/* Busca textual — operadores especiais                                        */
/* -------------------------------------------------------------------------- */

/** Colunas onde a busca textual procura (case-insensitive via collation). */
const BUSCA_COLUNAS = [
  "t.title",
  "t.description",
  "t.solucao",
  "t.guest_name",
  "t.creator_name",
  "cu.name",
  "u.name",
  "te.name",
  "CAST(t.number AS CHAR)",
  "t.os",
];

interface BuscaTermo {
  term: string;
  negate: boolean;
}

/**
 * Quebra a busca nos operadores especiais:
 *   - `"frase exata"` agrupa;
 *   - `-termo` nega;
 *   - termos separados por espaço = E;
 *   - `termo1 | termo2` = OU (grupos combinados por OR).
 */
function tokenizeBusca(text: string): BuscaTermo[][] {
  const grupos: BuscaTermo[][] = [];
  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  for (const ch of text) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "|" && !inQuotes) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);

  const re = /"([^"]+)"|(\S+)/g;
  for (const part of parts) {
    const termos: BuscaTermo[] = [];
    let match: RegExpExecArray | null;
    while ((match = re.exec(part)) !== null) {
      if (match[1] !== undefined) {
        termos.push({ term: match[1], negate: false });
        continue;
      }
      let token = match[2];
      let negate = false;
      if (token.startsWith("-")) {
        negate = true;
        token = token.slice(1);
      }
      if (token) termos.push({ term: token, negate });
    }
    if (termos.length > 0) grupos.push(termos);
  }
  return grupos;
}

/** Monta a condição SQL da busca textual (um ou vários grupos). */
function buildBuscaTexto(texto: string): { sql: string; params: unknown[] } | null {
  const grupos = tokenizeBusca(texto);
  if (grupos.length === 0) return null;

  const params: unknown[] = [];
  const orParts: string[] = [];

  for (const grupo of grupos) {
    const andParts: string[] = [];
    for (const { term, negate } of grupo) {
      const like = `%${term}%`;
      const cols = BUSCA_COLUNAS.map((col) => `COALESCE(${col}, '') LIKE ?`).join(" OR ");
      const clause = `(${cols})`;
      andParts.push(negate ? `NOT ${clause}` : clause);
      for (let i = 0; i < BUSCA_COLUNAS.length; i += 1) params.push(like);
    }
    if (andParts.length > 0) orParts.push(`(${andParts.join(" AND ")})`);
  }

  if (orParts.length === 0) return null;
  return { sql: `(${orParts.join(" OR ")})`, params };
}

/* -------------------------------------------------------------------------- */
/* Query base de chamados e build_where                                        */
/* -------------------------------------------------------------------------- */

/**
 * FROM com os JOINs reais do PingOS.
 * O "cliente" é o solicitante: `guest_name`/`guest_contact` (formulário) ou o
 * usuário `creator_id`. `assignee_id` aponta para users OU technicians, por
 * isso os dois LEFT JOINs.
 */
const TICKET_FROM = `
  FROM tickets t
  LEFT JOIN users cu ON cu.id = t.creator_id
  LEFT JOIN users u ON u.id = t.assignee_id
  LEFT JOIN technicians te ON te.id = t.assignee_id`;

const RESPONSAVEL_EXPR = "COALESCE(u.name, te.name)";
const CLIENTE_EXPR = "COALESCE(NULLIF(t.guest_name, ''), t.creator_name, cu.name, 'Cliente')";

interface Where {
  conditions: string[];
  params: unknown[];
}

function whereSql(where: Where): string {
  return where.conditions.length > 0 ? `WHERE ${where.conditions.join(" AND ")}` : "";
}

function buildOrLike(expr: string, values: string[]): { sql: string; params: unknown[] } {
  const parts = values.map(() => `${expr} LIKE ?`);
  return { sql: `(${parts.join(" OR ")})`, params: values.map((v) => `%${v}%`) };
}

/**
 * Constrói dinamicamente o WHERE dos chamados com prepared statements.
 * Todos os filtros são opcionais e combinados com AND; arrays = OR no campo.
 */
function buildTicketWhere(f: Record<string, unknown>): Where {
  const conditions: string[] = [];
  const params: unknown[] = [];

  const pushIn = (column: string, values: unknown[]) => {
    if (values.length === 0) return;
    conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
    params.push(...values);
  };

  // ── Identificadores ──────────────────────────────────────────────────────
  pushIn("t.id", toArray(f.id));

  const numerosOs = toArray(f.numero_os);
  if (numerosOs.length > 0) {
    const numeros: number[] = [];
    const outros: string[] = [];
    for (const value of numerosOs) {
      const clean = value.replace(/^#/, "").trim();
      if (/^\d+$/.test(clean)) numeros.push(Number(clean));
      else outros.push(value);
    }
    const parts: string[] = [];
    if (numeros.length > 0) {
      parts.push(`t.number IN (${numeros.map(() => "?").join(", ")})`);
      params.push(...numeros);
    }
    if (outros.length > 0) {
      const os = buildOrLike("COALESCE(t.os, '')", outros);
      parts.push(os.sql);
      params.push(...os.params);
    }
    if (parts.length > 0) conditions.push(`(${parts.join(" OR ")})`);
  }

  if (str(f.busca_texto)) {
    const busca = buildBuscaTexto(str(f.busca_texto));
    if (busca) {
      conditions.push(busca.sql);
      params.push(...busca.params);
    }
  }

  // ── Status e prioridade ──────────────────────────────────────────────────
  const status = toValues(f.status).map(normalizeStatus).filter((v): v is string => v !== null);
  pushIn("t.status", status);

  const prioridade = toValues(f.prioridade).map(normalizePriority).filter((v): v is string => v !== null);
  pushIn("t.priority", prioridade);

  const excluirStatus = toValues(f.excluir_status).map(normalizeStatus).filter((v): v is string => v !== null);
  if (excluirStatus.length > 0) {
    conditions.push(`t.status NOT IN (${excluirStatus.map(() => "?").join(", ")})`);
    params.push(...excluirStatus);
  }

  // ── Relacionamentos ──────────────────────────────────────────────────────
  pushIn("t.creator_id", toArray(f.cliente_id));

  const clienteNome = toArray(f.cliente_nome);
  for (const value of clienteNome) {
    conditions.push(
      `(COALESCE(t.guest_name, '') LIKE ? OR COALESCE(t.creator_name, '') LIKE ? OR COALESCE(cu.name, '') LIKE ?)`,
    );
    const like = `%${value}%`;
    params.push(like, like, like);
  }

  const clienteTelefone = toArray(f.cliente_telefone);
  if (clienteTelefone.length > 0) {
    const tel = buildOrLike("COALESCE(t.guest_contact, '')", clienteTelefone);
    conditions.push(tel.sql);
    params.push(...tel.params);
  }

  const clienteSetor = toValues(f.cliente_setor);
  if (clienteSetor.length > 0) {
    conditions.push(`TRIM(COALESCE(cu.setor, '')) IN (${clienteSetor.map(() => "?").join(", ")})`);
    params.push(...clienteSetor);
  }

  pushIn("t.assignee_id", toArray(f.responsavel_id));

  const responsavelNome = toArray(f.responsavel_nome);
  if (responsavelNome.length > 0) {
    const parts = responsavelNome.map(() => `${RESPONSAVEL_EXPR} LIKE ?`);
    conditions.push(`(${parts.join(" OR ")})`);
    params.push(...responsavelNome.map((v) => `%${v}%`));
  }

  if (bool(f.sem_responsavel)) conditions.push("t.assignee_id IS NULL");
  else if (f.sem_responsavel === false || str(f.sem_responsavel) === "false") {
    conditions.push("t.assignee_id IS NOT NULL");
  }

  const categorias = toValues(f.categoria);
  if (categorias.length > 0) {
    const validas: string[] = [];
    let semCategoria = false;
    for (const value of categorias) {
      const lower = value.toLowerCase();
      if (["sem_categoria", "sem categoria", "—", "-", "nenhuma", "vazia"].includes(lower)) {
        semCategoria = true;
        continue;
      }
      const normalized = normalizeTicketCategory(value);
      if (normalized) validas.push(normalized);
    }
    const parts: string[] = [];
    if (validas.length > 0) {
      parts.push(`t.categoria IN (${validas.map(() => "?").join(", ")})`);
      params.push(...validas);
    }
    if (semCategoria) parts.push("(t.categoria IS NULL OR t.categoria = '')");
    if (parts.length > 0) conditions.push(`(${parts.join(" OR ")})`);
  }

  // ── Datas ────────────────────────────────────────────────────────────────
  const criadoApos = parseDataRelativa(f.criado_apos, "start");
  if (criadoApos !== null) {
    conditions.push("t.created_at >= ?");
    params.push(criadoApos);
  }
  const criadoAntes = parseDataRelativa(f.criado_antes, "end");
  if (criadoAntes !== null) {
    conditions.push("t.created_at <= ?");
    params.push(criadoAntes);
  }
  const atualizadoApos = parseDataRelativa(f.atualizado_apos, "start");
  if (atualizadoApos !== null) {
    conditions.push("t.updated_at >= ?");
    params.push(atualizadoApos);
  }
  const atualizadoAntes = parseDataRelativa(f.atualizado_antes, "end");
  if (atualizadoAntes !== null) {
    conditions.push("t.updated_at <= ?");
    params.push(atualizadoAntes);
  }

  // "Fechado" não tem coluna própria: usa o histórico de status.
  const fechadoApos = parseDataRelativa(f.fechado_apos, "start");
  if (fechadoApos !== null) {
    conditions.push(
      `EXISTS (SELECT 1 FROM ticket_status_events e
                WHERE e.ticket_id = t.id AND e.to_status IN ('resolvido','fechado') AND e.created_at >= ?)`,
    );
    params.push(fechadoApos);
  }
  const fechadoAntes = parseDataRelativa(f.fechado_antes, "end");
  if (fechadoAntes !== null) {
    conditions.push(
      `EXISTS (SELECT 1 FROM ticket_status_events e
                WHERE e.ticket_id = t.id AND e.to_status IN ('resolvido','fechado') AND e.created_at <= ?)`,
    );
    params.push(fechadoAntes);
  }

  const semAtualizacao = Math.floor(toNumber(f.sem_atualizacao_dias));
  if (semAtualizacao > 0) {
    conditions.push("t.updated_at < ?");
    params.push(Date.now() - semAtualizacao * DAY_MS);
  }

  // ── SLA (mesma regra vigente: Aberto/Em Andamento parado há 3 dias) ───────
  if (bool(f.sla_estourando)) {
    conditions.push("t.status IN ('aberto','em_andamento','aguardando') AND t.created_at < ?");
    params.push(Date.now() - SLA_DIAS * DAY_MS);
  }
  if (bool(f.sla_a_estourar)) {
    conditions.push("t.status IN ('aberto','em_andamento','aguardando') AND t.created_at BETWEEN ? AND ?");
    params.push(Date.now() - SLA_DIAS * DAY_MS, Date.now() - (SLA_DIAS - 1) * DAY_MS);
  }
  if (bool(f.sla_cumprido)) {
    conditions.push(
      "t.status IN ('resolvido','fechado') AND (t.updated_at - t.created_at) <= ?",
    );
    params.push(SLA_DIAS * DAY_MS);
  }

  // ── Métricas ─────────────────────────────────────────────────────────────
  const resolucaoMin = Math.floor(toNumber(f.tempo_resolucao_min_dias));
  if (resolucaoMin > 0) {
    conditions.push("(t.updated_at - t.created_at) >= ?");
    params.push(resolucaoMin * DAY_MS);
  }
  const resolucaoMax = Math.floor(toNumber(f.tempo_resolucao_max_dias));
  if (resolucaoMax > 0) {
    conditions.push("(t.updated_at - t.created_at) <= ?");
    params.push(resolucaoMax * DAY_MS);
  }

  // O PingOS não tem tabela de comentários/anexos: comentários = campo `obs`,
  // anexos = `image_url` (a imagem do chamado).
  if (f.tem_comentarios !== undefined) {
    conditions.push(bool(f.tem_comentarios) ? "COALESCE(t.obs, '') <> ''" : "COALESCE(t.obs, '') = ''");
  }
  if (f.tem_anexos !== undefined) {
    conditions.push(bool(f.tem_anexos) ? "COALESCE(t.image_url, '') <> ''" : "COALESCE(t.image_url, '') = ''");
  }

  return { conditions, params };
}

/* -------------------------------------------------------------------------- */
/* Ordenação (whitelist) e paginação                                           */
/* -------------------------------------------------------------------------- */

/**
 * Whitelist de campos de ordenação. Nada vindo do modelo entra cru no SQL.
 * `prioridade`/`urgencia` usam FIELD invertido para que o padrão `desc` mostre
 * Crítica primeiro.
 */
const ORDER_TICKETS: Record<string, string> = {
  created_at: "t.created_at",
  criado_em: "t.created_at",
  updated_at: "t.updated_at",
  atualizado_em: "t.updated_at",
  prioridade: "FIELD(t.priority, 'baixa','media','alta','critica')",
  urgencia: "FIELD(t.priority, 'baixa','media','alta','critica')",
  status: "FIELD(t.status, 'aberto','em_andamento','aguardando','resolvido','fechado')",
  cliente_nome: CLIENTE_EXPR,
  responsavel_nome: RESPONSAVEL_EXPR,
  tempo_resolucao: "(t.updated_at - t.created_at)",
  parado: "(t.updated_at - t.created_at)",
};

function buildOrder(f: Record<string, unknown>): string {
  const key = str(f.ordenar_por).toLowerCase();
  const dir = str(f.direcao).toLowerCase() === "asc" ? "ASC" : "DESC";
  const expr = ORDER_TICKETS[key];
  if (!expr) return "ORDER BY t.created_at DESC, t.number DESC";
  return `ORDER BY ${expr} ${dir}, t.created_at DESC, t.number DESC`;
}

/* -------------------------------------------------------------------------- */
/* Ações pendentes (confirmação de exclusão) e audit log                       */
/* -------------------------------------------------------------------------- */

interface PendingRow {
  id: string;
  admin_id: string | null;
  chat_id: string | null;
  tipo: string;
  payload: string | null;
  resumo: string | null;
  status: string;
  created_at: number;
  expires_at: number;
}

async function buscarAcaoPendente(chatId: number, adminId: number): Promise<PendingRow | null> {
  try {
    return await queryOne<PendingRow>(
      `SELECT * FROM acoes_pendentes
        WHERE chat_id = ? AND admin_id = ? AND status = 'pendente' AND expires_at > ?
        ORDER BY created_at DESC LIMIT 1`,
      [String(chatId), String(adminId), Date.now()],
    );
  } catch (error) {
    // Tabela ainda não migrada (a API cria no boot): sem ação pendente.
    console.warn("[bot-ia] não deu para ler acoes_pendentes:", error);
    return null;
  }
}

async function criarAcaoPendente(params: {
  adminId: number;
  chatId: number;
  tipo: string;
  resumo: string;
  payload: Record<string, unknown>;
}): Promise<PendingRow> {
  const now = Date.now();
  const pending: PendingRow = {
    id: newId(),
    admin_id: String(params.adminId),
    chat_id: String(params.chatId),
    tipo: params.tipo,
    // `payload` e `resumo` são TEXT (64 KB): o corte existe só como rede de
    // segurança, e fica baixo o bastante para a codificação utf8mb4 não estourar
    // o limite de bytes de um payload cheio de acentos.
    payload: JSON.stringify(params.payload).slice(0, 15000),
    resumo: params.resumo.slice(0, 4000),
    status: "pendente",
    created_at: now,
    expires_at: now + PENDENTE_VALIDADE_MS,
  };
  await execute(
    `INSERT INTO acoes_pendentes (id, admin_id, chat_id, tipo, payload, resumo, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`,
    [pending.id, pending.admin_id, pending.chat_id, pending.tipo, pending.payload, pending.resumo, now, pending.expires_at],
  );
  return pending;
}

async function resolverAcaoPendente(id: string, status: string): Promise<void> {
  await execute("UPDATE acoes_pendentes SET status = ? WHERE id = ?", [status, id]);
}

/** Registra uma mutação feita pelo bot (auditoria). Nunca lança. */
async function auditar(params: {
  adminId: number | null;
  tipo: string;
  tabela: string;
  registroId?: string | null;
  detalhes?: Record<string, unknown>;
}): Promise<void> {
  try {
    await execute(
      `INSERT INTO audit_log (id, admin_id, usuario_id, tipo_acao, tabela, registro_id, detalhes, created_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
      [
        newId(),
        params.adminId !== null ? String(params.adminId) : null,
        params.tipo,
        params.tabela,
        params.registroId ?? null,
        JSON.stringify(params.detalhes ?? {}).slice(0, 4000),
        Date.now(),
      ],
    );
  } catch (error) {
    console.warn("[bot-ia] não deu para gravar a auditoria:", error);
  }
}

/* -------------------------------------------------------------------------- */
/* Ferramentas                                                                 */
/* -------------------------------------------------------------------------- */

const PRIORITIES = ["baixa", "media", "alta", "critica"] as const;

type Schema = Record<string, unknown>;

const S = {
  str: (description: string): Schema => ({ type: "string", description }),
  num: (description: string): Schema => ({ type: "number", description }),
  bool: (description: string): Schema => ({ type: "boolean", description }),
  strOrArr: (description: string): Schema => ({
    description,
    anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
  }),
  numOrArr: (description: string): Schema => ({
    description,
    anyOf: [{ type: "number" }, { type: "array", items: { type: "number" } }],
  }),
  obj: (properties: Schema, required: string[] = []): Schema => ({
    type: "object",
    properties,
    required,
  }),
};

/** Filtros de chamados reutilizados em listagens e relatórios. */
const FILTROS_CHAMADOS: Schema = {
  id: S.numOrArr("Id interno (32 caracteres) — único, lista ou array."),
  numero_os: S.strOrArr("Número da O.S. (ex.: 1042) ou o campo `os`."),
  busca_texto: S.str(
    "Busca em título, descrição, solução, cliente, responsável e número. " +
      'Suporta: "frase exata", -termo (negar), termos juntos (E) e "a | b" (OU).',
  ),
  status: S.strOrArr("Aberto, Em Andamento, Aguardando, Resolvido, Fechado (ou vários)."),
  prioridade: S.strOrArr("Baixa, Média, Alta, Crítica (ou várias)."),
  excluir_status: S.strOrArr("Retorna tudo EXCETO esses status."),
  cliente_id: S.strOrArr("Id do usuário solicitante (creator_id)."),
  cliente_nome: S.str("Parte do nome do cliente/solicitante."),
  cliente_telefone: S.str("Parte do contato do cliente."),
  cliente_setor: S.strOrArr("Setor do solicitante (users.setor)."),
  responsavel_id: S.strOrArr("Id do responsável (usuário ou técnico)."),
  responsavel_nome: S.str("Parte do nome do responsável."),
  sem_responsavel: S.bool("true = só chamados sem responsável."),
  categoria: S.strOrArr(
    "Impressoras, Computadores, Notebooks, Softwares, Rede, Suporte, Outros, ou \"sem_categoria\".",
  ),
  criado_apos: S.str("ISO (2026-09-30) ou relativo: hoje, ontem, 7d, esta semana, este mes, mes passado..."),
  criado_antes: S.str("Limite superior da criação (mesmos formatos)."),
  atualizado_apos: S.str("Última atualização a partir de (ISO ou relativo)."),
  atualizado_antes: S.str("Última atualização até (ISO ou relativo)."),
  fechado_apos: S.str("Resolvido/fechado a partir de (ISO ou relativo)."),
  fechado_antes: S.str("Resolvido/fechado até (ISO ou relativo)."),
  sem_atualizacao_dias: S.num("Sem atualização há X dias ou mais (ex.: chamados parados)."),
  sla_estourando: S.bool("true = Aberto/Em Andamento há mais de 3 dias."),
  sla_a_estourar: S.bool("true = prestes a estourar o SLA (2 a 3 dias)."),
  sla_cumprido: S.bool("true = resolvidos dentro do SLA (até 3 dias)."),
  tempo_resolucao_min_dias: S.num("Tempo de resolução mínimo, em dias."),
  tempo_resolucao_max_dias: S.num("Tempo de resolução máximo, em dias."),
  tem_comentarios: S.bool("true/false conforme o chamado tenha observações."),
  tem_anexos: S.bool("true/false conforme o chamado tenha imagem/anexo."),
  ordenar_por: S.str(
    "created_at | updated_at | prioridade | urgencia | status | cliente_nome | responsavel_nome | tempo_resolucao.",
  ),
  direcao: S.str("asc ou desc (padrão desc)."),
  limite: S.num(`Máximo de itens (padrão ${LIMITE_PADRAO}, máximo ${LIMITE_MAXIMO}).`),
  offset: S.num("Deslocamento para paginação."),
};

interface ToolContext {
  adminId: number;
  chatId: number;
}

const tools: OpenAI.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "listar_chamados",
      description:
        "Lista/busca chamados com filtros poderosos e combináveis. Todos os filtros são " +
        "opcionais (AND). Retorna itens + total, já formatado em `resumo`.",
      parameters: S.obj(FILTROS_CHAMADOS) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "listar_clientes",
      description:
        "Lista clientes/solicitantes (derivados dos chamados) com totais e filtros.",
      parameters: S.obj({
        id: S.strOrArr("Id do usuário solicitante (creator_id)."),
        busca_texto: S.str("Parte do nome, contato ou setor."),
        nome: S.str("Parte do nome do cliente."),
        telefone: S.str("Parte do contato."),
        setor: S.strOrArr("Setor do solicitante."),
        tem_chamados_abertos: S.bool("true = só quem tem chamados em aberto."),
        total_chamados_min: S.num("Mínimo de chamados."),
        total_chamados_max: S.num("Máximo de chamados."),
        criado_apos: S.str("ISO ou relativo."),
        criado_antes: S.str("ISO ou relativo."),
        ordenar_por: S.str("nome | total_chamados | criado_em."),
        direcao: S.str("asc ou desc."),
        limite: S.num(`Padrão ${LIMITE_PADRAO}, máximo ${LIMITE_MAXIMO}.`),
        offset: S.num("Deslocamento."),
      }) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "listar_usuarios",
      description: "Lista usuários do sistema com filtros (papel, setor, atividade...).",
      parameters: S.obj({
        id: S.strOrArr("Id do usuário."),
        nome: S.str("Parte do nome."),
        username: S.str("Parte do usuário/login."),
        email: S.str("Parte do e-mail/username."),
        role: S.strOrArr('Papel: "admin", "user" ou o nome do papel.'),
        setor: S.strOrArr("Setor."),
        ativo: S.bool("true = apenas ativos."),
        criado_apos: S.str("ISO ou relativo."),
        criado_antes: S.str("ISO ou relativo."),
        ultimo_acesso_apos: S.str("Último acesso a partir de (ISO ou relativo)."),
        ultimo_acesso_antes: S.str("Último acesso até (ISO ou relativo)."),
        tem_chamados_atribuidos: S.bool("true = só quem tem chamados atribuídos."),
        chamados_abertos_min: S.num("Mínimo de chamados em aberto como responsável."),
        chamados_abertos_max: S.num("Máximo de chamados em aberto como responsável."),
        ordenar_por: S.str("nome | criado_em | ultimo_acesso | chamados_abertos."),
        direcao: S.str("asc ou desc."),
        limite: S.num(`Padrão ${LIMITE_PADRAO}, máximo ${LIMITE_MAXIMO}.`),
        offset: S.num("Deslocamento."),
      }) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_chamado_por_numero",
      description: "Retorna o chamado completo pelo número da O.S. (ex.: 1042).",
      parameters: S.obj({ numero_os: S.num("Número do chamado.") }, ["numero_os"]) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_chamado_por_id",
      description: "Retorna o chamado completo pelo id interno.",
      parameters: S.obj({ id: S.str("Id interno do chamado.") }, ["id"]) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "buscar_cliente",
      description: "Busca cliente/solicitante por nome, contato ou setor (parcial).",
      parameters: S.obj({ termo: S.str("Termo da busca.") }, ["termo"]) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "criar_chamado",
      description: "Abre um novo chamado em Aberto. Execução imediata.",
      parameters: S.obj(
        {
          titulo: S.str("Título/resumo do chamado."),
          descricao: S.str("Descrição do problema."),
          prioridade: S.str("Baixa, Média, Alta ou Crítica (padrão Média)."),
          categoria: S.str("Impressoras, Computadores, Notebooks, Softwares, Rede, Suporte, Outros."),
          cliente_nome: S.str("Nome do solicitante."),
          cliente_contato: S.str("Telefone/e-mail do solicitante."),
          responsavel_id: S.str("Id do responsável (usuário ou técnico)."),
        },
        ["titulo"],
      ) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "atualizar_chamado",
      description:
        "Edita um chamado existente (título, descrição, status, prioridade, categoria, " +
        "responsável, cliente). Informe apenas os campos que devem mudar. Execução imediata.",
      parameters: S.obj(
        {
          numero_os: S.num("Número da O.S."),
          titulo: S.str("Novo título."),
          descricao: S.str("Nova descrição."),
          status: S.str("Novo status: Aberto, Em Andamento, Aguardando, Resolvido, Fechado."),
          prioridade: S.str("Nova prioridade."),
          categoria: S.str("Nova categoria."),
          responsavel_id: S.str("Novo responsável (id). Use vazio para remover."),
          cliente_nome: S.str("Novo nome do solicitante."),
          cliente_contato: S.str("Novo contato do solicitante."),
        },
        ["numero_os"],
      ) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "fechar_chamado",
      description: "Marca um chamado como Resolvido. Execução imediata.",
      parameters: S.obj(
        { numero_os: S.num("Número da O.S."), motivo: S.str("Motivo/observação (opcional).") },
        ["numero_os"],
      ) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "reabrir_chamado",
      description: "Reabre um chamado resolvido/fechado (volta para Aberto). Execução imediata.",
      parameters: S.obj(
        { numero_os: S.num("Número da O.S."), motivo: S.str("Motivo (opcional).") },
        ["numero_os"],
      ) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "excluir_chamado",
      description:
        "Solicita excluir um chamado. NÃO exclui na hora: cria uma ação pendente e devolve " +
        "um resumo para o administrador confirmar com Sim/Não.",
      parameters: S.obj({ numero_os: S.num("Número da O.S.") }, ["numero_os"]) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "relatorio_chamados",
      description: "Totais de chamados por status e prioridade no período, com filtros.",
      parameters: S.obj({
        periodo: S.str("hoje, ontem, 7d, esta semana, mes passado, este ano, ISO..."),
        filtros: S.obj(FILTROS_CHAMADOS),
      }) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "relatorio_produtividade",
      description: "Produtividade por responsável no período (totais, resolvidos, tempo médio).",
      parameters: S.obj({
        periodo: S.str("Expressão de período ou ISO."),
        tecnico_id: S.str("Id do responsável (opcional)."),
        setor: S.str("Setor do solicitante (opcional)."),
        limite: S.num("Máximo de responsáveis."),
      }) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "relatorio_sla",
      description: "Situação do SLA no período: estourando, a estourar e cumprido.",
      parameters: S.obj({
        periodo: S.str("Expressão de período ou ISO."),
        filtros: S.obj(FILTROS_CHAMADOS),
      }) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "relatorio_clientes_top",
      description: "Clientes que mais abriram chamados no período.",
      parameters: S.obj({
        periodo: S.str("Expressão de período ou ISO."),
        limite: S.num("Quantos clientes (padrão 10)."),
        setor: S.str("Filtrar por setor."),
      }) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "relatorio_categorias",
      description: "Distribuição dos chamados por categoria no período.",
      parameters: S.obj({
        periodo: S.str("Expressão de período ou ISO."),
        filtros: S.obj(FILTROS_CHAMADOS),
      }) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "dashboard_geral",
      description: "Visão geral: totais por status/prioridade, abertos, críticos e tempo médio.",
      parameters: S.obj({
        periodo: S.str("Período (opcional; padrão: geral)."),
        setor: S.str("Filtrar por setor (opcional)."),
      }) as OpenAI.FunctionParameters,
    },
  },
  {
    type: "function",
    function: {
      name: "consultar_audit_log",
      description: "Consulta a auditoria das ações feitas pelo bot/sistema.",
      parameters: S.obj({
        admin_id: S.strOrArr("Id do administrador (Telegram)."),
        usuario_id: S.strOrArr("Id do usuário do sistema."),
        tipo_acao: S.strOrArr("criar, editar, fechar, reabrir, excluir..."),
        tabela: S.strOrArr("tickets, users..."),
        registro_id: S.str("Id do registro afetado."),
        data_inicio: S.str("ISO ou relativo."),
        data_fim: S.str("ISO ou relativo."),
        ordenar_por: S.str("created_at (padrão)."),
        direcao: S.str("asc ou desc."),
        limite: S.num(`Padrão ${LIMITE_PADRAO}, máximo ${LIMITE_MAXIMO}.`),
        offset: S.num("Deslocamento."),
      }) as OpenAI.FunctionParameters,
    },
  },
];

/* -------------------------------------------------------------------------- */
/* Implementação das ferramentas                                              */
/* -------------------------------------------------------------------------- */

interface TicketListRow {
  id: string;
  number: number;
  title: string | null;
  status: string;
  priority: string;
  categoria: string | null;
  assignee_id: string | null;
  responsavel: string | null;
  cliente: string | null;
  setor: string | null;
  created_at: number;
  updated_at: number;
  resolucao_ms: number | null;
}

interface TicketItem {
  id: string;
  numero: number;
  titulo: string;
  status: string;
  prioridade: string;
  categoria: string;
  cliente: string;
  setor: string;
  responsavel: string | null;
  aberto_em: string;
  atualizado_em: string;
  resolucao_dias: number | null;
}

function mapTicket(row: TicketListRow): TicketItem {
  return {
    id: row.id,
    numero: toNumber(row.number),
    titulo: row.title ?? "(sem título)",
    status: labelStatus(row.status),
    prioridade: labelPrioridade(row.priority),
    categoria: row.categoria?.trim() || "Sem categoria",
    cliente: row.cliente?.trim() || "Cliente",
    setor: row.setor?.trim() || "Sem setor",
    responsavel: row.responsavel?.trim() || null,
    aberto_em: fmtData(row.created_at),
    atualizado_em: fmtData(row.updated_at),
    resolucao_dias:
      row.resolucao_ms === null ? null : Math.round((toNumber(row.resolucao_ms) / DAY_MS) * 10) / 10,
  };
}

function resumoLista(
  itens: TicketItem[],
  total: number,
  limite: number,
  offset: number,
  busca?: string,
): string {
  if (total === 0) return "Nenhum chamado encontrado com esses filtros.";
  const cabecalho = busca
    ? `🔍 ${itens.length} de ${total} chamados com "${busca}":`
    : `📋 ${itens.length} de ${total} chamados encontrados:`;
  const linhas: string[] = [];
  for (const item of itens) {
    linhas.push(
      `#${item.numero} - ${item.titulo}\n` +
        `  Status: ${item.status} | Prioridade: ${item.prioridade} | Responsável: ${item.responsavel ?? "—"}\n` +
        `  Aberto em: ${item.aberto_em}`,
    );
  }
  const rodape =
    offset + itens.length < total
      ? `\n\nMostrando ${itens.length} de ${total}. Use "próximos ${limite}" para ver mais.`
      : "";
  return [cabecalho, "", ...linhas].join("\n") + rodape;
}

async function listarChamados(args: Record<string, unknown>): Promise<unknown> {
  const where = buildTicketWhere(args);
  const limite = clampLimite(args.limite);
  const offset = clampOffset(args.offset);
  const order = buildOrder(args);
  const whereClause = whereSql(where);

  const [rows, totalRow] = await Promise.all([
    query<TicketListRow>(
      `SELECT t.id, t.number, t.title, t.status, t.priority, t.categoria, t.assignee_id,
              ${RESPONSAVEL_EXPR} AS responsavel,
              ${CLIENTE_EXPR} AS cliente,
              TRIM(cu.setor) AS setor,
              t.created_at, t.updated_at,
              (t.updated_at - t.created_at) AS resolucao_ms
       ${TICKET_FROM}
       ${whereClause}
       ${order}
       LIMIT ? OFFSET ?`,
      [...where.params, limite, offset],
    ),
    queryOne<{ total: number | string }>(
      `SELECT COUNT(*) AS total ${TICKET_FROM} ${whereClause}`,
      where.params,
    ),
  ]);

  const total = toNumber(totalRow?.total);
  const itens = rows.map(mapTicket);
  return {
    total,
    limite,
    offset,
    itens,
    resumo: resumoLista(itens, total, limite, offset, str(args.busca_texto) || undefined),
  };
}

async function listarClientes(args: Record<string, unknown>): Promise<unknown> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const having: string[] = [];
  const havingParams: unknown[] = [];

  pushInList(conditions, params, "t.creator_id", toArray(args.id));

  const nome = str(args.nome);
  if (nome) {
    conditions.push(`${CLIENTE_EXPR} LIKE ?`);
    params.push(`%${nome}%`);
  }
  const telefone = str(args.telefone);
  if (telefone) {
    conditions.push("COALESCE(t.guest_contact, '') LIKE ?");
    params.push(`%${telefone}%`);
  }
  const setor = toValues(args.setor);
  if (setor.length > 0) {
    conditions.push(`TRIM(COALESCE(cu.setor, '')) IN (${setor.map(() => "?").join(", ")})`);
    params.push(...setor);
  }
  const busca = str(args.busca_texto);
  if (busca) {
    conditions.push(`(${CLIENTE_EXPR} LIKE ? OR COALESCE(t.guest_contact, '') LIKE ? OR COALESCE(cu.setor, '') LIKE ?)`);
    const like = `%${busca}%`;
    params.push(like, like, like);
  }
  const criadoApos = parseDataRelativa(args.criado_apos, "start");
  if (criadoApos !== null) {
    conditions.push("t.created_at >= ?");
    params.push(criadoApos);
  }
  const criadoAntes = parseDataRelativa(args.criado_antes, "end");
  if (criadoAntes !== null) {
    conditions.push("t.created_at <= ?");
    params.push(criadoAntes);
  }

  if (bool(args.tem_chamados_abertos)) {
    having.push("SUM(CASE WHEN t.status IN ('aberto','em_andamento','aguardando') THEN 1 ELSE 0 END) >= 1");
  }
  const min = Math.floor(toNumber(args.total_chamados_min));
  if (min > 0) {
    having.push("COUNT(*) >= ?");
    havingParams.push(min);
  }
  const max = Math.floor(toNumber(args.total_chamados_max));
  if (max > 0) {
    having.push("COUNT(*) <= ?");
    havingParams.push(max);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderMap: Record<string, string> = {
    nome: "nome",
    total_chamados: "total_chamados",
    criado_em: "primeiro",
  };
  const orderExpr = orderMap[str(args.ordenar_por).toLowerCase()] ?? "total_chamados";
  const dir = str(args.direcao).toLowerCase() === "asc" ? "ASC" : "DESC";
  const limite = clampLimite(args.limite ?? 50);
  const offset = clampOffset(args.offset);

  const rows = await query<{
    nome: string;
    contato: string | null;
    setor: string | null;
    total_chamados: number | string;
    abertos: number | string;
    primeiro: number | null;
    ultimo: number | null;
  }>(
    `SELECT ${CLIENTE_EXPR} AS nome,
            MAX(t.guest_contact) AS contato,
            TRIM(MAX(cu.setor)) AS setor,
            COUNT(*) AS total_chamados,
            SUM(CASE WHEN t.status IN ('aberto','em_andamento','aguardando') THEN 1 ELSE 0 END) AS abertos,
            MIN(t.created_at) AS primeiro,
            MAX(t.updated_at) AS ultimo
       ${TICKET_FROM}
       ${whereClause}
      GROUP BY nome
      ${having.length > 0 ? `HAVING ${having.join(" AND ")}` : ""}
      ORDER BY ${orderExpr} ${dir}
      LIMIT ? OFFSET ?`,
    [...params, ...havingParams, limite, offset],
  );

  return {
    total: rows.length,
    clientes: rows.map((row) => ({
      nome: row.nome,
      contato: row.contato?.trim() || null,
      setor: row.setor?.trim() || "Sem setor",
      total_chamados: toNumber(row.total_chamados),
      abertos: toNumber(row.abertos),
      primeiro_chamado: fmtData(row.primeiro),
      ultimo_chamado: fmtData(row.ultimo),
    })),
  };
}

function pushInList(conditions: string[], params: unknown[], column: string, values: unknown[]): void {
  if (values.length === 0) return;
  conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  params.push(...values);
}

async function listarUsuarios(args: Record<string, unknown>): Promise<unknown> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  pushInList(conditions, params, "u.id", toArray(args.id));
  for (const [field, column] of [
    ["nome", "u.name"],
    ["username", "u.username"],
    ["email", "u.email"],
  ] as const) {
    const value = str(args[field]);
    if (value) {
      conditions.push(`COALESCE(${column}, '') LIKE ?`);
      params.push(`%${value}%`);
    }
  }
  pushInList(conditions, params, "u.role", toValues(args.role));
  const setor = toValues(args.setor);
  if (setor.length > 0) {
    conditions.push(`TRIM(COALESCE(u.setor, '')) IN (${setor.map(() => "?").join(", ")})`);
    params.push(...setor);
  }
  if (args.ativo !== undefined) {
    conditions.push("u.active = ?");
    params.push(bool(args.ativo) ? 1 : 0);
  }
  const criadoApos = parseDataRelativa(args.criado_apos, "start");
  if (criadoApos !== null) {
    conditions.push("u.created_at >= ?");
    params.push(criadoApos);
  }
  const criadoAntes = parseDataRelativa(args.criado_antes, "end");
  if (criadoAntes !== null) {
    conditions.push("u.created_at <= ?");
    params.push(criadoAntes);
  }
  const acessoApos = parseDataRelativa(args.ultimo_acesso_apos, "start");
  if (acessoApos !== null) {
    conditions.push("EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.created_at >= ?)");
    params.push(acessoApos);
  }
  const acessoAntes = parseDataRelativa(args.ultimo_acesso_antes, "end");
  if (acessoAntes !== null) {
    conditions.push("EXISTS (SELECT 1 FROM sessions s WHERE s.user_id = u.id AND s.created_at <= ?)");
    params.push(acessoAntes);
  }
  if (bool(args.tem_chamados_atribuidos)) {
    conditions.push("EXISTS (SELECT 1 FROM tickets t WHERE t.assignee_id = u.id)");
  }
  const abertosMin = Math.floor(toNumber(args.chamados_abertos_min));
  if (abertosMin > 0) {
    conditions.push(
      `(SELECT COUNT(*) FROM tickets t WHERE t.assignee_id = u.id AND t.status IN ('aberto','em_andamento','aguardando')) >= ?`,
    );
    params.push(abertosMin);
  }
  const abertosMax = Math.floor(toNumber(args.chamados_abertos_max));
  if (abertosMax > 0) {
    conditions.push(
      `(SELECT COUNT(*) FROM tickets t WHERE t.assignee_id = u.id AND t.status IN ('aberto','em_andamento','aguardando')) <= ?`,
    );
    params.push(abertosMax);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const orderMap: Record<string, string> = {
    nome: "u.name",
    criado_em: "u.created_at",
    ultimo_acesso: "ultimo_acesso",
    chamados_abertos: "chamados_abertos",
  };
  const orderExpr = orderMap[str(args.ordenar_por).toLowerCase()] ?? "u.name";
  const dir = str(args.direcao).toLowerCase() === "desc" ? "DESC" : "ASC";
  const limite = clampLimite(args.limite);
  const offset = clampOffset(args.offset);

  const rows = await query<{
    id: string;
    nome: string | null;
    username: string | null;
    email: string | null;
    role: string | null;
    setor: string | null;
    contato: string | null;
    active: number | string;
    created_at: number | null;
    ultimo_acesso: number | null;
    chamados_abertos: number | string;
  }>(
    `SELECT u.id, u.name AS nome, u.username, u.email, u.role, u.setor, u.contato, u.active,
            u.created_at,
            (SELECT MAX(s.created_at) FROM sessions s WHERE s.user_id = u.id) AS ultimo_acesso,
            (SELECT COUNT(*) FROM tickets t WHERE t.assignee_id = u.id
               AND t.status IN ('aberto','em_andamento','aguardando')) AS chamados_abertos
       FROM users u
       ${whereClause}
      ORDER BY ${orderExpr} ${dir}
      LIMIT ? OFFSET ?`,
    [...params, limite, offset],
  );

  return {
    total: rows.length,
    usuarios: rows.map((row) => ({
      id: row.id,
      nome: row.nome ?? "(sem nome)",
      username: row.username ?? row.email ?? "",
      email: row.email ?? "",
      role: row.role ?? "(sem papel)",
      setor: row.setor?.trim() || "Sem setor",
      contato: row.contato?.trim() || null,
      ativo: toNumber(row.active) === 1,
      criado_em: fmtData(row.created_at),
      ultimo_acesso: fmtData(row.ultimo_acesso),
      chamados_abertos: toNumber(row.chamados_abertos),
    })),
  };
}

interface FullTicketRow {
  id: string;
  number: number;
  title: string | null;
  description: string | null;
  solucao: string | null;
  obs: string | null;
  os: string | null;
  status: string;
  priority: string;
  categoria: string | null;
  cliente: string | null;
  cliente_contato: string | null;
  setor: string | null;
  responsavel: string | null;
  created_at: number;
  updated_at: number;
  resolucao_ms: number | null;
  tem_anexo: number | string;
}

async function buscarChamadoCompleto(coluna: "number" | "id", valor: unknown): Promise<unknown> {
  const query1 = `SELECT t.id, t.number, t.title, t.description, t.solucao, t.obs, t.os,
                         t.status, t.priority, t.categoria,
                         ${CLIENTE_EXPR} AS cliente,
                         t.guest_contact AS cliente_contato,
                         TRIM(cu.setor) AS setor,
                         ${RESPONSAVEL_EXPR} AS responsavel,
                         t.created_at, t.updated_at,
                         (t.updated_at - t.created_at) AS resolucao_ms,
                         (COALESCE(t.image_url, '') <> '') AS tem_anexo
                    ${TICKET_FROM}
                   WHERE t.${coluna} = ? LIMIT 1`;
  const parametro = coluna === "number" ? Math.floor(toNumber(valor)) : str(valor);
  const row = await queryOne<FullTicketRow>(query1, [parametro]);
  if (!row) return { erro: "Chamado não encontrado." };

  const eventos = await query<{ from_status: string | null; to_status: string; user_name: string | null; created_at: number }>(
    "SELECT from_status, to_status, user_name, created_at FROM ticket_status_events WHERE ticket_id = ? ORDER BY created_at ASC LIMIT 30",
    [row.id],
  );

  return {
    id: row.id,
    numero: toNumber(row.number),
    titulo: row.title ?? "(sem título)",
    descricao: row.description ?? "",
    solucao: row.solucao ?? "",
    observacoes: row.obs ?? "",
    os: row.os ?? "",
    status: labelStatus(row.status),
    prioridade: labelPrioridade(row.priority),
    categoria: row.categoria?.trim() || "Sem categoria",
    cliente: row.cliente?.trim() || "Cliente",
    cliente_contato: row.cliente_contato?.trim() || null,
    setor: row.setor?.trim() || "Sem setor",
    responsavel: row.responsavel?.trim() || null,
    tem_anexo: toNumber(row.tem_anexo) === 1,
    aberto_em: fmtData(row.created_at),
    atualizado_em: fmtData(row.updated_at),
    resolucao_dias: row.resolucao_ms === null ? null : Math.round((toNumber(row.resolucao_ms) / DAY_MS) * 10) / 10,
    historico: eventos.map((e) => ({
      de: e.from_status ? labelStatus(e.from_status) : null,
      para: labelStatus(e.to_status),
      por: e.user_name ?? "—",
      em: fmtData(e.created_at),
    })),
  };
}

async function buscarCliente(termo: string): Promise<unknown> {
  const like = `%${termo}%`;
  const rows = await query<{
    nome: string;
    contato: string | null;
    setor: string | null;
    total_chamados: number | string;
    abertos: number | string;
    ultimo: number | null;
  }>(
    `SELECT ${CLIENTE_EXPR} AS nome,
            MAX(t.guest_contact) AS contato,
            TRIM(MAX(cu.setor)) AS setor,
            COUNT(*) AS total_chamados,
            SUM(CASE WHEN t.status IN ('aberto','em_andamento','aguardando') THEN 1 ELSE 0 END) AS abertos,
            MAX(t.updated_at) AS ultimo
       ${TICKET_FROM}
      WHERE ${CLIENTE_EXPR} LIKE ? OR COALESCE(t.guest_contact, '') LIKE ? OR COALESCE(cu.setor, '') LIKE ?
      GROUP BY nome
      ORDER BY total_chamados DESC
      LIMIT 10`,
    [like, like, like],
  );
  return {
    total: rows.length,
    clientes: rows.map((row) => ({
      nome: row.nome,
      contato: row.contato?.trim() || null,
      setor: row.setor?.trim() || "Sem setor",
      total_chamados: toNumber(row.total_chamados),
      abertos: toNumber(row.abertos),
      ultimo_chamado: fmtData(row.ultimo),
    })),
  };
}

/** Próximo número de chamado (mesma lógica atômica da API). */
async function nextTicketNumber(): Promise<number> {
  return withTransaction(async (conn) => {
    await conn.query(
      "INSERT IGNORE INTO `counters` (`name`, `value`) SELECT 'ticket_number', COALESCE(MAX(`number`), 0) FROM `tickets`",
    );
    await conn.query(
      "UPDATE `counters` SET `value` = LAST_INSERT_ID(`value` + 1) WHERE `name` = 'ticket_number'",
    );
    const [rows] = await conn.query("SELECT LAST_INSERT_ID() AS value");
    const first = (rows as Array<{ value: number | string }>)[0];
    const parsed = Number(first?.value);
    return Number.isFinite(parsed) ? parsed : 1;
  });
}

async function buscarTicketPorNumero(numero: number): Promise<{ id: string; number: number; status: string } | null> {
  return queryOne<{ id: string; number: number; status: string }>(
    "SELECT id, number, status FROM tickets WHERE number = ? LIMIT 1",
    [numero],
  );
}

async function notificarMudanca(ticketId: string, anterior: string): Promise<void> {
  const updated = await queryOne<Parameters<typeof notifyTicketStatusChanged>[0]>(
    "SELECT * FROM tickets WHERE id = ?",
    [ticketId],
  );
  if (updated) void notifyTicketStatusChanged(updated, anterior, null);
}

async function criarChamado(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const titulo = str(args.titulo);
  if (!titulo) return { erro: "Informe o título do chamado." };
  const prioridade = normalizePriority(args.prioridade) ?? "media";
  const categoria = normalizeTicketCategory(args.categoria);
  const responsavelId = str(args.responsavel_id) || null;

  const number = await nextTicketNumber();
  const id = newId();
  const now = Date.now();
  await execute(
    `INSERT INTO tickets
       (id, number, title, description, status, priority, categoria,
        guest_name, guest_contact, assignee_id, assignee_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'aberto', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      number,
      titulo.slice(0, 200),
      str(args.descricao).slice(0, 5000) || null,
      prioridade,
      categoria,
      str(args.cliente_nome).slice(0, 120) || null,
      str(args.cliente_contato).slice(0, 160) || null,
      responsavelId,
      responsavelId ? (await resolveAssigneeType(responsavelId)) : null,
      now,
      now,
    ],
  );

  const created = await queryOne<Parameters<typeof notifyTicketCreated>[0]>(
    "SELECT * FROM tickets WHERE id = ?",
    [id],
  );
  if (created) void notifyTicketCreated(created, null);

  await auditar({
    adminId: ctx.adminId,
    tipo: "criar",
    tabela: "tickets",
    registroId: id,
    detalhes: { numero: number, titulo, prioridade },
  });

  return { ok: true, numero: number, titulo, prioridade: labelPrioridade(prioridade) };
}

/** users.id ou technicians.id — o mesmo critério da API. */
async function resolveAssigneeType(assigneeId: string): Promise<"user" | "technician" | null> {
  const user = await queryOne<{ id: string }>("SELECT id FROM users WHERE id = ? LIMIT 1", [assigneeId]);
  if (user) return "user";
  const tech = await queryOne<{ id: string }>("SELECT id FROM technicians WHERE id = ? LIMIT 1", [assigneeId]);
  if (tech) return "technician";
  return null;
}

async function atualizarChamado(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const numero = Math.floor(toNumber(args.numero_os));
  if (!Number.isFinite(numero) || numero <= 0) return { erro: "Informe o número do chamado." };
  const ticket = await buscarTicketPorNumero(numero);
  if (!ticket) return { erro: `Chamado #${numero} não encontrado.` };

  const sets: string[] = [];
  const params: unknown[] = [];
  const alteracoes: Record<string, unknown> = {};

  const titulo = str(args.titulo);
  if (titulo) {
    sets.push("title = ?");
    params.push(titulo.slice(0, 200));
    alteracoes.titulo = titulo;
  }
  if (args.descricao !== undefined) {
    sets.push("description = ?");
    params.push(str(args.descricao).slice(0, 5000) || null);
    alteracoes.descricao = true;
  }
  let novoStatus: string | null = null;
  if (args.status !== undefined) {
    novoStatus = normalizeStatus(args.status);
    if (!novoStatus) return { erro: `Status inválido: ${str(args.status)}` };
    sets.push("status = ?");
    params.push(novoStatus);
    alteracoes.status = labelStatus(novoStatus);
  }
  if (args.prioridade !== undefined) {
    const prioridade = normalizePriority(args.prioridade);
    if (!prioridade) return { erro: `Prioridade inválida: ${str(args.prioridade)}` };
    sets.push("priority = ?");
    params.push(prioridade);
    alteracoes.prioridade = labelPrioridade(prioridade);
  }
  if (args.categoria !== undefined) {
    const categoria = normalizeTicketCategory(args.categoria);
    sets.push("categoria = ?");
    params.push(categoria);
    alteracoes.categoria = categoria ?? "Sem categoria";
  }
  if (args.responsavel_id !== undefined) {
    const responsavelId = str(args.responsavel_id) || null;
    sets.push("assignee_id = ?", "assignee_type = ?");
    params.push(responsavelId, responsavelId ? await resolveAssigneeType(responsavelId) : null);
    alteracoes.responsavel_id = responsavelId;
  }
  if (args.cliente_nome !== undefined) {
    sets.push("guest_name = ?");
    params.push(str(args.cliente_nome).slice(0, 160) || null);
  }
  if (args.cliente_contato !== undefined) {
    sets.push("guest_contact = ?");
    params.push(str(args.cliente_contato).slice(0, 200) || null);
  }

  if (sets.length === 0) return { erro: "Nenhum campo para atualizar foi informado." };

  const now = Date.now();
  sets.push("updated_at = ?");
  params.push(now, ticket.id);
  await execute(`UPDATE tickets SET ${sets.join(", ")} WHERE id = ?`, params);

  if (novoStatus && novoStatus !== ticket.status) {
    await execute(
      `INSERT INTO ticket_status_events (id, ticket_id, from_status, to_status, user_id, user_name, created_at)
       VALUES (?, ?, ?, ?, NULL, 'Ping IA', ?)`,
      [newId(), ticket.id, ticket.status, novoStatus, now],
    );
    await notificarMudanca(ticket.id, ticket.status);
  }

  await auditar({
    adminId: ctx.adminId,
    tipo: "editar",
    tabela: "tickets",
    registroId: ticket.id,
    detalhes: { numero, alteracoes },
  });

  return { ok: true, numero, alteracoes };
}

async function fecharChamado(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const numero = Math.floor(toNumber(args.numero_os));
  if (!Number.isFinite(numero) || numero <= 0) return { erro: "Número de chamado inválido." };
  const ticket = await buscarTicketPorNumero(numero);
  if (!ticket) return { erro: `Chamado #${numero} não encontrado.` };
  if (ticket.status === "resolvido" || ticket.status === "fechado") {
    return { ok: true, numero, status: labelStatus(ticket.status), aviso: "Já estava fechado." };
  }

  const motivo = str(args.motivo);
  const now = Date.now();
  await execute(
    `UPDATE tickets SET status = 'resolvido', obs = CONCAT(COALESCE(obs, ''), ?), updated_at = ? WHERE id = ?`,
    [motivo ? `\n[Ping IA] ${motivo}` : "", now, ticket.id],
  );
  await execute(
    `INSERT INTO ticket_status_events (id, ticket_id, from_status, to_status, user_id, user_name, created_at)
     VALUES (?, ?, ?, 'resolvido', NULL, 'Ping IA', ?)`,
    [newId(), ticket.id, ticket.status, now],
  );
  await notificarMudanca(ticket.id, ticket.status);
  await auditar({
    adminId: ctx.adminId,
    tipo: "fechar",
    tabela: "tickets",
    registroId: ticket.id,
    detalhes: { numero, motivo: motivo || null },
  });

  return { ok: true, numero, status: "Resolvido", motivo: motivo || undefined };
}

async function reabrirChamado(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const numero = Math.floor(toNumber(args.numero_os));
  if (!Number.isFinite(numero) || numero <= 0) return { erro: "Número de chamado inválido." };
  const ticket = await buscarTicketPorNumero(numero);
  if (!ticket) return { erro: `Chamado #${numero} não encontrado.` };
  if (ticket.status === "aberto" || ticket.status === "em_andamento") {
    return { ok: true, numero, status: labelStatus(ticket.status), aviso: "Já estava em aberto." };
  }

  const motivo = str(args.motivo);
  const now = Date.now();
  await execute(
    `UPDATE tickets SET status = 'aberto', obs = CONCAT(COALESCE(obs, ''), ?), updated_at = ? WHERE id = ?`,
    [motivo ? `\n[Ping IA] reaberto — ${motivo}` : "\n[Ping IA] reaberto", now, ticket.id],
  );
  await execute(
    `INSERT INTO ticket_status_events (id, ticket_id, from_status, to_status, user_id, user_name, created_at)
     VALUES (?, ?, ?, 'aberto', NULL, 'Ping IA', ?)`,
    [newId(), ticket.id, ticket.status, now],
  );
  await notificarMudanca(ticket.id, ticket.status);
  await auditar({
    adminId: ctx.adminId,
    tipo: "reabrir",
    tabela: "tickets",
    registroId: ticket.id,
    detalhes: { numero, motivo: motivo || null },
  });

  return { ok: true, numero, status: "Aberto" };
}

async function excluirChamado(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
  const numero = Math.floor(toNumber(args.numero_os));
  if (!Number.isFinite(numero) || numero <= 0) return { erro: "Número de chamado inválido." };
  const ticket = await buscarTicketPorNumero(numero);
  if (!ticket) return { erro: `Chamado #${numero} não encontrado.` };

  const detalhe = await queryOne<{ title: string | null; status: string; priority: string }>(
    "SELECT title, status, priority FROM tickets WHERE id = ?",
    [ticket.id],
  );
  const resumo =
    `⚠️ Confirmar EXCLUSÃO do chamado #${numero}?\n` +
    `   Título: ${detalhe?.title ?? "(sem título)"}\n` +
    `   Status: ${labelStatus(detalhe?.status ?? ticket.status)} | ` +
    `Prioridade: ${labelPrioridade(detalhe?.priority ?? "media")}\n\n` +
    "Esta ação é permanente. Responda *Sim* para excluir ou *Não* para cancelar.";

  await criarAcaoPendente({
    adminId: ctx.adminId,
    chatId: ctx.chatId,
    tipo: "excluir_chamado",
    resumo,
    payload: { ticketId: ticket.id, numero },
  });

  return { pendente: true, numero, mensagem: "Aguardando confirmação do administrador.", resumo };
}

/** Executa a ação pendente já confirmada (hoje só existe a exclusão). */
async function executarAcaoPendente(pending: PendingRow): Promise<string> {
  const payload = safeJson(pending.payload);
  const adminId = Number(pending.admin_id) || null;

  if (pending.tipo === "excluir_chamado") {
    const ticketId = str(payload.ticketId);
    const ticket = await queryOne<{ id: string; number: number; title: string | null }>(
      "SELECT id, number, title FROM tickets WHERE id = ? LIMIT 1",
      [ticketId],
    );
    if (!ticket) {
      await resolverAcaoPendente(pending.id, "expirada");
      return "⚠️ O chamado já não existe. Nada foi excluído.";
    }
    await execute("DELETE FROM tickets WHERE id = ?", [ticket.id]);
    await resolverAcaoPendente(pending.id, "confirmada");
    await auditar({
      adminId,
      tipo: "excluir",
      tabela: "tickets",
      registroId: ticket.id,
      detalhes: { numero: toNumber(ticket.number), titulo: ticket.title },
    });
    return `🗑️ Chamado #${toNumber(ticket.number)} excluído com sucesso.`;
  }

  // Cadastro de O.S. que precisou de confirmação (O.S. repetida ou campo que
  // não deu para ler). A foto NÃO entra no payload: `acoes_pendentes.payload` é
  // TEXT (64 KB) e um JPEG em base64 não caberia — o chamado sai sem anexo.
  if (pending.tipo === "criar_chamado_os") {
    const os = (payload.dados ?? {}) as Record<string, unknown>;
    const dados: DadosOs = {
      numero_os: normalizarNumeroOs(os.numero_os),
      solicitante: limparTexto(os.solicitante, 160),
      fone: normalizarFone(os.fone),
      descricao: limparTexto(os.descricao, 200),
      problemas: limparTexto(os.problemas, 5000),
    };
    if (!osTemConteudo(dados)) {
      await resolverAcaoPendente(pending.id, "expirada");
      return "⚠️ Não há mais dados da O.S. para cadastrar. Envie a foto novamente.";
    }
    const criado = await criarChamadoViaOs({
      dados,
      imageUrl: null,
      adminId,
      origem: "telegram",
    });
    await resolverAcaoPendente(pending.id, "confirmada");
    return `${mensagemChamadoCriado(dados, criado)}\n\n(a foto não fica anexada quando o cadastro precisa de confirmação)`;
  }

  await resolverAcaoPendente(pending.id, "cancelada");
  return "⚠️ Ação desconhecida. Nada foi alterado.";
}

/** Intercepta Sim/Não quando há uma ação pendente. Devolve a resposta, ou null. */
async function tryConfirmacao(chatId: number, adminId: number, text: string): Promise<string | null> {
  const pending = await buscarAcaoPendente(chatId, adminId);
  if (!pending) return null;

  const normalized = text.trim().toLowerCase();
  const sim = /^(sim|s|yes|y|ok|okay|confirmo|confirmar|pode|manda|isso|claro|beleza|excluir|exclua)$/.test(normalized);
  const nao = /^(n[aã]o|nao|n|no|cancelar|cancela|cancel|deixa|deixa_pra_l[aá]|abortar|aborta)$/.test(normalized);

  if (sim) return executarAcaoPendente(pending);
  if (nao) {
    await resolverAcaoPendente(pending.id, "cancelada");
    return "👍 Ação cancelada. Nada foi alterado.";
  }
  return `⏳ Há uma ação aguardando confirmação:\n\n${pending.resumo ?? ""}\n\nResponda *Sim* para confirmar ou *Não* para cancelar.`;
}

/* -------------------------------------------------------------------------- */
/* O.S. impressa — leitura de foto (modelo de visão)                           */
/* -------------------------------------------------------------------------- */

/**
 * Prompt de extração enviado junto com a foto. Pede **só JSON** e lista os
 * cinco campos que interessam — tudo o mais que aparece no cupom (CNPJ, IE,
 * endereço, atendente, datas, número de série, serviços, preços, OBS e
 * assinaturas) é descartado de propósito.
 */
const PROMPT_EXTRACAO_OS = [
  "Você é um extrator de dados de Ordens de Serviço (O.S.) impressas.",
  "",
  "Analise a imagem e extraia APENAS estes 5 campos. Retorne um JSON válido,",
  "SEM markdown, SEM explicação:",
  "",
  "{",
  '  "numero_os": "número da O.S. (apenas dígitos, sem zeros à esquerda)",',
  '  "solicitante": "nome completo em MAIÚSCULAS",',
  '  "fone": "telefone apenas com dígitos (sem parênteses, traços ou espaços)",',
  '  "descricao": "conteúdo do campo Descrição (ex: NOTEBOOK PRETO C/ FONTE)",',
  '  "problemas": "conteúdo do campo PROBLEMAS (ex: REPARO NA CARCAÇA / NÃO ENTRA NO WINDOWS.)"',
  "}",
  "",
  "REGRAS CRÍTICAS:",
  "- Retorne SOMENTE o JSON, nada mais.",
  "- NÃO invente informações. Se um campo não for encontrado, retorne null.",
  "- NÃO inclua CNPJ, endereço, atendente, datas, preços, assinaturas, OBS.",
  '- O campo "descricao" é o que aparece ao lado de "Descrição:" (geralmente o',
  "  modelo do equipamento).",
  '- O campo "problemas" é o que aparece ao lado de "PROBLEMAS:" (o defeito',
  "  relatado).",
  "- Mantenha MAIÚSCULAS como no original.",
  "- Preserve barras, traços e pontuação nos campos descricao e problemas.",
].join("\n");

/** Os cinco campos da O.S. Tudo o mais da imagem é ignorado. */
interface DadosOs {
  numero_os: string | null;
  solicitante: string | null;
  fone: string | null;
  /** Campo "Descrição:" da O.S. — vira o TÍTULO do chamado. */
  descricao: string | null;
  /** Campo "PROBLEMAS:" da O.S. — vira a DESCRIÇÃO do chamado. */
  problemas: string | null;
}

const OS_VAZIA: DadosOs = {
  numero_os: null,
  solicitante: null,
  fone: null,
  descricao: null,
  problemas: null,
};

function limparTexto(value: unknown, limite: number): string | null {
  const texto = str(value).replace(/\s+/g, " ").trim();
  return texto ? texto.slice(0, limite) : null;
}

/** Número da O.S.: só dígitos, sem zeros à esquerda (o modelo às vezes solta "#"). */
function normalizarNumeroOs(value: unknown): string | null {
  const digitos = str(value).replace(/\D/g, "").replace(/^0+/, "");
  return digitos || null;
}

/** Telefone só com dígitos. */
function normalizarFone(value: unknown): string | null {
  const digitos = str(value).replace(/\D/g, "");
  return digitos || null;
}

/**
 * Extrai o primeiro objeto JSON do texto devolvido pelo modelo, ignorando
 * cercas ```json e qualquer comentário em volta. Devolve `null` se não houver
 * JSON válido.
 */
function extrairJson(texto: string): Record<string, unknown> | null {
  const limpo = texto.replace(/```[a-z]*/gi, "").trim();
  const inicio = limpo.indexOf("{");
  const fim = limpo.lastIndexOf("}");
  if (inicio === -1 || fim <= inicio) return null;
  try {
    const parsed = JSON.parse(limpo.slice(inicio, fim + 1));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Manda a foto para o modelo de visão e devolve os cinco campos da O.S.
 *
 * Nunca lança por conteúdo inesperado: o que não for JSON válido vira
 * `OS_VAZIA` (e o administrador recebe o pedido de foto mais nítida). Só erros
 * de rede/chave sobem para quem chamou, que mostra uma mensagem diferente.
 */
async function extrairOsDaImagem(
  ai: OpenAI,
  model: string,
  dataUrl: string,
  provider: string,
): Promise<DadosOs> {
  const completion = await aiChat(
    ai,
    {
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PROMPT_EXTRACAO_OS },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.1,
      max_tokens: 2048,
    },
    { provider, timeoutMs: VISAO_TIMEOUT_MS },
  );

  const message = completion.choices[0]?.message;
  const texto = message ? extractText(message) : "";
  const dados = extrairJson(texto);
  if (!dados) {
    console.warn("[bot-ia] a leitura da O.S. não devolveu JSON:", texto.slice(0, 400));
    return OS_VAZIA;
  }

  return {
    numero_os: normalizarNumeroOs(dados.numero_os),
    solicitante: limparTexto(dados.solicitante, 160),
    fone: normalizarFone(dados.fone),
    descricao: limparTexto(dados.descricao, 200),
    problemas: limparTexto(dados.problemas, 5000),
  };
}

/** `true` se a leitura trouxe algo útil (usada para não criar chamado vazio). */
function osTemConteudo(dados: DadosOs): boolean {
  return Boolean(
    dados.numero_os || dados.solicitante || dados.descricao || dados.problemas,
  );
}

/** Chamado já cadastrado com esta O.S. (a foto pode ter chegado duas vezes). */
async function buscarChamadoPorOs(
  numeroOs: string,
): Promise<{ id: string; number: number } | null> {
  return queryOne<{ id: string; number: number }>(
    "SELECT id, number FROM tickets WHERE os = ? ORDER BY created_at DESC LIMIT 1",
    [numeroOs],
  );
}

/**
 * Categoria do chamado a partir do texto da O.S. (Descrição + Problemas).
 *
 * A ordem importa: "NOTEBOOK" antes de "COMPUTADOR" (o defeito costuma citar
 * Windows, que sozinho jogaria tudo para Softwares). O que não casar vira
 * "Suporte", o mesmo padrão da equipe.
 */
function detectarCategoriaOs(...textos: (string | null)[]): string {
  const texto = textos.filter(Boolean).join(" ").toUpperCase();
  const regras: [RegExp, string][] = [
    [/NOTEBOOK|LAPTOP|ULTRABOOK/, "Notebooks"],
    [/IMPRESSORA|MULTIFUNCIONAL|TONER|TINTA|EPSON|CANON|BROTHER|LEXMARK|ZEBRA/, "Impressoras"],
    [/COMPUTADOR|DESKTOP|GABINETE|MONITOR|TECLADO|MOUSE|\bPC\b|\bCPU\b/, "Computadores"],
    [/REDE|ROTEADOR|WI-?FI|INTERNET|SWITCH|CABO|SERVIDOR|MODEM/, "Rede"],
    [/WINDOWS|OFFICE|EXCEL|WORD|SISTEMA|PROGRAMA|SOFTWARE|DRIVER|FORMAT|BACKUP|E-?MAIL|SENHA/, "Softwares"],
  ];
  for (const [padrao, categoria] of regras) {
    if (padrao.test(texto)) return categoria;
  }
  return "Suporte";
}

/**
 * "Cliente" da O.S.
 *
 * O PingOS **não tem tabela de clientes**: o cliente mora no próprio chamado
 * (`guest_name` + `guest_contact`). Então aqui não se cria cadastro nenhum —
 * usa-se o nome e o telefone da O.S. e, quando a O.S. não traz algum deles,
 * reaproveita-se o que apareceu no último chamado daquele mesmo telefone/nome.
 */
async function resolverClienteOs(
  dados: DadosOs,
): Promise<{ nome: string | null; contato: string | null }> {
  let nome = dados.solicitante;
  let contato = dados.fone;
  if (nome && contato) return { nome, contato };

  const anterior = dados.fone
    ? await queryOne<{ guest_name: string | null; guest_contact: string | null }>(
        `SELECT guest_name, guest_contact FROM tickets
          WHERE REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(guest_contact, ''), '(', ''), ')', ''), '-', ''), ' ', '') LIKE ?
          ORDER BY created_at DESC LIMIT 1`,
        [`%${dados.fone}%`],
      )
    : nome
      ? await queryOne<{ guest_name: string | null; guest_contact: string | null }>(
          `SELECT guest_name, guest_contact FROM tickets
            WHERE guest_name LIKE ? ORDER BY created_at DESC LIMIT 1`,
          [`%${nome}%`],
        )
      : null;

  if (anterior) {
    nome = nome ?? anterior.guest_name;
    contato = contato ?? anterior.guest_contact;
  }
  return { nome, contato };
}

/**
 * Cria o chamado a partir da O.S. — aqui vale o MAPEAMENTO:
 *
 *   Descrição: da O.S.  ->  `title` do chamado
 *   PROBLEMAS: da O.S.  ->  `description` do chamado
 *   número da O.S.      ->  `os`
 *   solicitante / fone  ->  `guest_name` / `guest_contact`
 */
async function criarChamadoViaOs(params: {
  dados: DadosOs;
  imageUrl: string | null;
  adminId: number | null;
  origem: string;
}): Promise<{ id: string; number: number; categoria: string; cliente: { nome: string | null; contato: string | null } }> {
  const { dados } = params;
  const titulo = dados.descricao || "Chamado via O.S. (foto)";
  const descricao = dados.problemas || "Sem descrição de problemas na O.S.";
  const categoria =
    normalizeTicketCategory(detectarCategoriaOs(dados.descricao, dados.problemas)) ??
    "Suporte";
  const cliente = await resolverClienteOs(dados);

  const number = await nextTicketNumber();
  const id = newId();
  const now = Date.now();
  await execute(
    `INSERT INTO tickets
       (id, number, title, description, status, priority, categoria, os,
        guest_name, guest_contact, image_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'aberto', 'media', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      number,
      titulo.slice(0, 200),
      descricao.slice(0, 5000),
      categoria,
      dados.numero_os ? dados.numero_os.slice(0, 60) : null,
      cliente.nome ? cliente.nome.slice(0, 120) : null,
      cliente.contato ? cliente.contato.slice(0, 160) : null,
      params.imageUrl,
      now,
      now,
    ],
  );

  const created = await queryOne<Parameters<typeof notifyTicketCreated>[0]>(
    "SELECT * FROM tickets WHERE id = ?",
    [id],
  );
  if (created) void notifyTicketCreated(created, null);

  await auditar({
    adminId: params.adminId,
    tipo: "criar_via_os",
    tabela: "tickets",
    registroId: id,
    detalhes: {
      numero: number,
      origem: params.origem,
      os: dados.numero_os,
      cliente: cliente.nome,
      categoria,
      extraido: dados,
    },
  });

  return { id, number, categoria, cliente };
}

/** Corta um texto para exibição em resumo (não altera o que vai para o banco). */
function previa(texto: string | null, limite = 300): string {
  if (!texto) return "—";
  return texto.length > limite ? `${texto.slice(0, limite)}…` : texto;
}

/**
 * Resumo da O.S. lida — usado nas respostas e nas confirmações. Os campos
 * longos vêm recortados (`previa`): isto é só a prévia do que o administrador
 * vai confirmar, e o chamado guarda o texto completo.
 */
function resumoOsLida(dados: DadosOs): string {
  return [
    `O.S.: ${dados.numero_os ?? "—"}`,
    `Solicitante: ${dados.solicitante ?? "—"}`,
    `Fone: ${dados.fone ?? "—"}`,
    `Título (Descrição): ${previa(dados.descricao, 120)}`,
    `Descrição (PROBLEMAS): ${previa(dados.problemas, 400)}`,
  ].join("\n");
}

/** Mensagem final do cadastro feito a partir da foto. */
function mensagemChamadoCriado(
  dados: DadosOs,
  criado: { number: number; categoria: string; cliente: { nome: string | null } },
): string {
  return [
    `✅ Chamado #${criado.number} criado!`,
    "",
    `O.S.: ${dados.numero_os ?? "—"}`,
    `Cliente: ${criado.cliente.nome ?? "—"}`,
    `Fone: ${dados.fone ?? "—"}`,
    `Título: ${dados.descricao ?? "—"}`,
    `Descrição: ${dados.problemas ?? "—"}`,
    `Categoria: ${criado.categoria}`,
    "",
    "Quer ajustar prioridade, categoria ou responsável?",
  ].join("\n");
}

/* ------------------------------ Relatórios -------------------------------- */

function mergePeriodo(filtros: Record<string, unknown>, periodo: unknown): Record<string, unknown> {
  const { start, end } = parsePeriodo(periodo);
  return { ...filtros, criado_apos: start, criado_antes: end };
}

async function relatorioChamados(args: Record<string, unknown>): Promise<unknown> {
  const filtros = (args.filtros as Record<string, unknown>) ?? {};
  const where = buildTicketWhere(mergePeriodo(filtros, args.periodo));
  const whereClause = whereSql(where);

  const rows = await query<{ status: string; priority: string; qty: number | string; valor: number | string | null }>(
    `SELECT t.status, t.priority, COUNT(*) AS qty, COALESCE(SUM(t.valor_total), 0) AS valor
       ${TICKET_FROM} ${whereClause}
      GROUP BY t.status, t.priority`,
    where.params,
  );

  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  let total = 0;
  let valor = 0;
  for (const row of rows) {
    const qty = toNumber(row.qty);
    byStatus[labelStatus(row.status)] = (byStatus[labelStatus(row.status)] ?? 0) + qty;
    byPriority[labelPrioridade(row.priority)] = (byPriority[labelPrioridade(row.priority)] ?? 0) + qty;
    total += qty;
    valor += toNumber(row.valor);
  }

  return { total, valor_total: Math.round(valor * 100) / 100, por_status: byStatus, por_prioridade: byPriority };
}

async function relatorioProdutividade(args: Record<string, unknown>): Promise<unknown> {
  const filtros: Record<string, unknown> = mergePeriodo({}, args.periodo);
  if (str(args.tecnico_id)) filtros.responsavel_id = str(args.tecnico_id);
  if (str(args.setor)) filtros.cliente_setor = str(args.setor);
  const where = buildTicketWhere(filtros);
  where.conditions.push("t.assignee_id IS NOT NULL");
  const whereClause = whereSql(where);

  const rows = await query<{
    assignee_id: string;
    nome: string | null;
    total: number | string;
    resolvidos: number | string;
    em_aberto: number | string;
    avg_ms: number | string | null;
  }>(
    `SELECT t.assignee_id,
            ${RESPONSAVEL_EXPR} AS nome,
            COUNT(*) AS total,
            SUM(CASE WHEN t.status IN ('resolvido','fechado') THEN 1 ELSE 0 END) AS resolvidos,
            SUM(CASE WHEN t.status IN ('aberto','em_andamento','aguardando') THEN 1 ELSE 0 END) AS em_aberto,
            AVG(CASE WHEN t.status IN ('resolvido','fechado') THEN (t.updated_at - t.created_at) END) AS avg_ms
       ${TICKET_FROM} ${whereClause}
      GROUP BY t.assignee_id
      ORDER BY resolvidos DESC, total DESC
      LIMIT ?`,
    [...where.params, clampLimite(args.limite ?? 50)],
  );

  return {
    responsaveis: rows.map((row) => ({
      responsavel: row.nome?.trim() || "(removido)",
      total: toNumber(row.total),
      resolvidos: toNumber(row.resolvidos),
      em_aberto: toNumber(row.em_aberto),
      tempo_medio_resolucao_dias: row.avg_ms === null ? null : Math.round((toNumber(row.avg_ms) / DAY_MS) * 10) / 10,
    })),
  };
}

async function relatorioSla(args: Record<string, unknown>): Promise<unknown> {
  const filtros = (args.filtros as Record<string, unknown>) ?? {};
  const where = buildTicketWhere(mergePeriodo(filtros, args.periodo));
  const whereClause = whereSql(where);
  const now = Date.now();

  const row = await queryOne<{
    total: number | string;
    estourando: number | string;
    a_estourar: number | string;
    cumprido: number | string;
    aberto: number | string;
  }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN t.status IN ('aberto','em_andamento','aguardando') AND t.created_at < ? THEN 1 ELSE 0 END) AS estourando,
            SUM(CASE WHEN t.status IN ('aberto','em_andamento','aguardando') AND t.created_at BETWEEN ? AND ? THEN 1 ELSE 0 END) AS a_estourar,
            SUM(CASE WHEN t.status IN ('resolvido','fechado') AND (t.updated_at - t.created_at) <= ? THEN 1 ELSE 0 END) AS cumprido,
            SUM(CASE WHEN t.status IN ('aberto','em_andamento','aguardando') THEN 1 ELSE 0 END) AS aberto
       ${TICKET_FROM} ${whereClause}`,
    [
      now - SLA_DIAS * DAY_MS,
      now - SLA_DIAS * DAY_MS,
      now - (SLA_DIAS - 1) * DAY_MS,
      SLA_DIAS * DAY_MS,
      ...where.params,
    ],
  );

  return {
    sla_dias: SLA_DIAS,
    total: toNumber(row?.total),
    em_aberto: toNumber(row?.aberto),
    estourando: toNumber(row?.estourando),
    a_estourar: toNumber(row?.a_estourar),
    cumprido: toNumber(row?.cumprido),
  };
}

async function relatorioClientesTop(args: Record<string, unknown>): Promise<unknown> {
  const { start, end } = parsePeriodo(args.periodo);
  const conditions = ["t.created_at BETWEEN ? AND ?"];
  const params: unknown[] = [start, end];
  if (str(args.setor)) {
    conditions.push("TRIM(COALESCE(cu.setor, '')) = ?");
    params.push(str(args.setor));
  }
  const rows = await query<{
    nome: string;
    total: number | string;
    abertos: number | string;
    valor: number | string | null;
  }>(
    `SELECT ${CLIENTE_EXPR} AS nome,
            COUNT(*) AS total,
            SUM(CASE WHEN t.status IN ('aberto','em_andamento','aguardando') THEN 1 ELSE 0 END) AS abertos,
            COALESCE(SUM(t.valor_total), 0) AS valor
       ${TICKET_FROM}
      WHERE ${conditions.join(" AND ")}
      GROUP BY nome
      ORDER BY total DESC
      LIMIT ?`,
    [...params, clampLimite(args.limite ?? 10)],
  );
  return {
    clientes: rows.map((row) => ({
      nome: row.nome,
      total: toNumber(row.total),
      abertos: toNumber(row.abertos),
      valor_total: Math.round(toNumber(row.valor) * 100) / 100,
    })),
  };
}

async function relatorioCategorias(args: Record<string, unknown>): Promise<unknown> {
  const filtros = (args.filtros as Record<string, unknown>) ?? {};
  const where = buildTicketWhere(mergePeriodo(filtros, args.periodo));
  const whereClause = whereSql(where);
  const rows = await query<{
    categoria: string | null;
    total: number | string;
    resolvidos: number | string;
    avg_ms: number | string | null;
  }>(
    `SELECT COALESCE(NULLIF(TRIM(t.categoria), ''), 'Sem categoria') AS categoria,
            COUNT(*) AS total,
            SUM(CASE WHEN t.status IN ('resolvido','fechado') THEN 1 ELSE 0 END) AS resolvidos,
            AVG(CASE WHEN t.status IN ('resolvido','fechado') THEN (t.updated_at - t.created_at) END) AS avg_ms
       ${TICKET_FROM} ${whereClause}
      GROUP BY categoria
      ORDER BY total DESC`,
    where.params,
  );
  return {
    categorias: rows.map((row) => ({
      categoria: row.categoria ?? "Sem categoria",
      total: toNumber(row.total),
      resolvidos: toNumber(row.resolvidos),
      tempo_medio_resolucao_dias: row.avg_ms === null ? null : Math.round((toNumber(row.avg_ms) / DAY_MS) * 10) / 10,
    })),
  };
}

async function dashboardGeral(args: Record<string, unknown>): Promise<unknown> {
  const filtros: Record<string, unknown> = {};
  if (str(args.periodo)) Object.assign(filtros, mergePeriodo({}, args.periodo));
  if (str(args.setor)) filtros.cliente_setor = str(args.setor);
  const where = buildTicketWhere(filtros);
  const whereClause = whereSql(where);

  const rows = await query<{
    status: string;
    priority: string;
    qty: number | string;
    valor: number | string | null;
    avg_ms: number | string | null;
  }>(
    `SELECT t.status, t.priority, COUNT(*) AS qty,
            COALESCE(SUM(t.valor_total), 0) AS valor,
            AVG(CASE WHEN t.status IN ('resolvido','fechado') THEN (t.updated_at - t.created_at) END) AS avg_ms
       ${TICKET_FROM} ${whereClause}
      GROUP BY t.status, t.priority`,
    where.params,
  );

  const byStatus: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  let total = 0;
  let valor = 0;
  let avgAccum = 0;
  let avgCount = 0;
  let criticosAbertos = 0;
  for (const row of rows) {
    const qty = toNumber(row.qty);
    byStatus[labelStatus(row.status)] = (byStatus[labelStatus(row.status)] ?? 0) + qty;
    byPriority[labelPrioridade(row.priority)] = (byPriority[labelPrioridade(row.priority)] ?? 0) + qty;
    total += qty;
    valor += toNumber(row.valor);
    if (row.avg_ms !== null) {
      avgAccum += toNumber(row.avg_ms) * qty;
      avgCount += qty;
    }
    if (row.priority === "critica" && !["resolvido", "fechado"].includes(row.status)) {
      criticosAbertos += qty;
    }
  }

  return {
    total,
    em_aberto: (byStatus["Aberto"] ?? 0) + (byStatus["Em Andamento"] ?? 0) + (byStatus["Aguardando"] ?? 0),
    criticos_abertos: criticosAbertos,
    valor_total: Math.round(valor * 100) / 100,
    tempo_medio_resolucao_dias: avgCount > 0 ? Math.round((avgAccum / avgCount / DAY_MS) * 10) / 10 : 0,
    por_status: byStatus,
    por_prioridade: byPriority,
  };
}

async function consultarAuditLog(args: Record<string, unknown>): Promise<unknown> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  pushInList(conditions, params, "admin_id", toArray(args.admin_id));
  pushInList(conditions, params, "usuario_id", toArray(args.usuario_id));
  pushInList(conditions, params, "tipo_acao", toValues(args.tipo_acao));
  pushInList(conditions, params, "tabela", toValues(args.tabela));
  const registroId = str(args.registro_id);
  if (registroId) {
    conditions.push("registro_id = ?");
    params.push(registroId);
  }
  const inicio = parseDataRelativa(args.data_inicio, "start");
  if (inicio !== null) {
    conditions.push("created_at >= ?");
    params.push(inicio);
  }
  const fim = parseDataRelativa(args.data_fim, "end");
  if (fim !== null) {
    conditions.push("created_at <= ?");
    params.push(fim);
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const dir = str(args.direcao).toLowerCase() === "asc" ? "ASC" : "DESC";

  const [rows, totalRow] = await Promise.all([
    query<{
      id: string;
      admin_id: string | null;
      usuario_id: string | null;
      tipo_acao: string;
      tabela: string;
      registro_id: string | null;
      detalhes: string | null;
      created_at: number;
    }>(
      `SELECT * FROM audit_log ${whereClause} ORDER BY created_at ${dir} LIMIT ?`,
      [...params, clampLimite(args.limite)],
    ),
    queryOne<{ total: number | string }>(
      `SELECT COUNT(*) AS total FROM audit_log ${whereClause}`,
      params,
    ),
  ]);

  return {
    total: toNumber(totalRow?.total),
    registros: rows.map((row) => ({
      quando: fmtData(row.created_at),
      admin_id: row.admin_id,
      usuario_id: row.usuario_id,
      tipo_acao: row.tipo_acao,
      tabela: row.tabela,
      registro_id: row.registro_id,
      detalhes: safeJson(row.detalhes),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Despacho da ferramenta                                                      */
/* -------------------------------------------------------------------------- */

const TABLES: Record<string, string> = {
  tickets: "chamados",
};

/** Executa a ferramenta pedida pelo modelo. Nunca lança: devolve o erro no JSON. */
async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  try {
    switch (name) {
      case "listar_chamados":
        return await listarChamados(args);
      case "listar_clientes":
        return await listarClientes(args);
      case "listar_usuarios":
        return await listarUsuarios(args);
      case "buscar_chamado_por_numero":
        return await buscarChamadoCompleto("number", args.numero_os);
      case "buscar_chamado_por_id":
        return await buscarChamadoCompleto("id", args.id);
      case "buscar_cliente": {
        const termo = str(args.termo);
        if (!termo) return { erro: "Informe um termo para buscar." };
        return await buscarCliente(termo);
      }
      case "criar_chamado":
        return await criarChamado(args, ctx);
      case "atualizar_chamado":
        return await atualizarChamado(args, ctx);
      case "fechar_chamado":
        return await fecharChamado(args, ctx);
      case "reabrir_chamado":
        return await reabrirChamado(args, ctx);
      case "excluir_chamado":
        return await excluirChamado(args, ctx);
      case "relatorio_chamados":
        return await relatorioChamados(args);
      case "relatorio_produtividade":
        return await relatorioProdutividade(args);
      case "relatorio_sla":
        return await relatorioSla(args);
      case "relatorio_clientes_top":
        return await relatorioClientesTop(args);
      case "relatorio_categorias":
        return await relatorioCategorias(args);
      case "dashboard_geral":
        return await dashboardGeral(args);
      case "consultar_audit_log":
        return await consultarAuditLog(args);
      default:
        return { erro: `Ferramenta desconhecida: ${name}` };
    }
  } catch (error) {
    return {
      erro: error instanceof Error ? error.message : String(error),
      tabelas: TABLES,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* System prompt padrão                                                        */
/* -------------------------------------------------------------------------- */

const DEFAULT_SYSTEM_PROMPT = [
  'Você é o "Ping IA", assistente administrativo do PingOS (sistema de help desk).',
  "Responda SEMPRE em português do Brasil, com tom profissional, direto e organizado.",
  "Você tem ACESSO TOTAL: use as ferramentas para consultar e alterar dados reais — nunca invente chamados, clientes ou números.",
  "",
  "EXECUÇÃO:",
  "- Execute imediatamente listagens, buscas, relatórios, criação, edição, fechamento e reabertura.",
  "- APENAS a exclusão pede confirmação: chame excluir_chamado; o sistema devolve um resumo; mostre-o e peça 'Sim ou Não'.",
  "- Se o administrador mandar a FOTO de uma O.S. impressa, o sistema lê a imagem sozinho, cria o chamado e já responde o resumo: você não precisa fazer nada nesse caso. Depois, faça só o que ele pedir (ajustar prioridade, categoria ou responsável).",
  "",
  "FILTROS — traduza a linguagem natural sendo GENEROSO:",
  '- "chamados parados" -> sem_atualizacao_dias: 5',
  '- "chamados críticos" -> prioridade: ["Crítica"]',
  '- "abertos essa semana" -> status: ["Aberto"], criado_apos: "esta semana"',
  '- "sem responsável" -> sem_responsavel: true',
  '- "do João" -> cliente_nome: "João"',
  '- "de impressoras" -> categoria: "Impressoras"',
  '- "de hoje" -> criado_apos: "hoje"',
  '- "mais urgentes" -> ordenar_por: "urgencia", direcao: "desc"',
  '- "mais antigos" -> ordenar_por: "created_at", direcao: "asc"',
  '- "mais parados" -> ordenar_por: "updated_at", direcao: "asc"',
  '- "top 10 clientes" -> relatorio_clientes_top com limite 10',
  '- "SLA estourando" -> sla_estourando: true',
  "- Combine quantos filtros precisar; todos são opcionais e somam (E).",
  "",
  "BUSCA TEXTUAL (campo busca_texto):",
  '- "frase exata" busca a frase; -termo exclui; termos juntos = E; "a | b" = OU.',
  "",
  "FORMATO DAS LISTAS: use o campo `resumo` retornado quando existir. Se montar a resposta, use:",
  "📋 N de TOTAL chamados encontrados:",
  "#1042 - Título",
  "  Status: Aberto | Prioridade: Crítica | Responsável: —",
  "  Aberto em: 18/09/2026 10:56",
  'Quando houver mais itens, diga: Mostrando N de TOTAL. Peça "próximos N" para ver mais.',
  "Para listas grandes (sem rolagem), agrupe por status, categoria ou prioridade.",
].join("\n");

/**
 * System prompt do slot 1 (Padrão) — fixo, definido aqui no código e não
 * editável pelo dashboard. É o mesmo texto usado quando nenhuma personalidade
 * está ativa.
 */
const PROMPT_PADRAO_PINGOS = DEFAULT_SYSTEM_PROMPT;

interface BotPersonalidadeRow {
  slot: number;
  nome: string;
  emoji: string | null;
  system_prompt: string | null;
  fixo: number;
  ativo: number;
}

/**
 * Lê a personalidade ATIVA em `bot_personalidades` (no máximo uma).
 *
 * Devolve `null` quando nenhuma está ativa (ou quando a tabela ainda não existe
 * neste banco) — nesse caso o bot usa o prompt padrão. Quem chama decide se o
 * prompt do slot fixo vem do código. Nunca lança: as personalidades são um
 * extra, não podem derrubar o agente.
 */
async function carregar_personalidade_ativa(): Promise<BotPersonalidadeRow | null> {
  try {
    return await queryOne<BotPersonalidadeRow>(
      "SELECT `slot`, `nome`, `emoji`, `system_prompt`, `fixo`, `ativo`\n" +
        "  FROM `bot_personalidades` WHERE `ativo` = 1 ORDER BY `slot` ASC LIMIT 1",
    );
  } catch (error) {
    console.warn(
      "[bot-ia] não deu para ler as personalidades:",
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Supervisão do processo                                                     */
/* -------------------------------------------------------------------------- */

interface BotConfigRow {
  id: number;
  /** Chave do provedor escolhido em `provider` (nome antigo da coluna). */
  nvidia_api_key: string | null;
  /** Provedor de IA (nvidia, openai, google...). Ausente em banco antigo. */
  provider?: string | null;
  /** URL base alternativa; vazia usa a padrão do provedor. */
  base_url?: string | null;
  modelo: string | null;
  /** Modelo usado só para ler as fotos de O.S. (precisa aceitar imagem). */
  modelo_visao: string | null;
  telegram_token: string | null;
  ativo: number;
  system_prompt: string | null;
  admin_id: string | null;
}

/**
 * Lê uma lista de Ids do Telegram ("123", "123,456", "123 456") e ignora o
 * resto. Assim o campo do dashboard aceita mais de um administrador sem
 * precisar de outro formato.
 */
function parseAdminIds(raw: string | null | undefined): number[] {
  return (raw ?? "")
    .split(/[^0-9]+/)
    .map((part) => Number(part))
    .filter((id) => Number.isFinite(id) && id !== 0);
}

interface Runtime {
  bot: Bot;
  /** Assinatura da configuração que subiu este runtime. */
  fingerprint: string;
}

let runtime: Runtime | null = null;
let lastStatus = "";
let syncing = false;
const history = new Map<number, OpenAI.ChatCompletionMessageParam[]>();

/** Loga só quando a mensagem muda (o supervisor roda a cada 15s). */
function reportStatus(message: string): void {
  if (message === lastStatus) return;
  lastStatus = message;
  console.log(message);
}

async function stopRuntime(reason: string): Promise<void> {
  const current = runtime;
  if (!current) return;
  runtime = null;
  reportStatus(`🛑 Ping IA fora do ar — ${reason}`);
  // Libera o long polling antes de qualquer novo start (evita duas instâncias).
  await current.bot.stop().catch(() => undefined);
}

function createBot(options: {
  apiKey: string;
  provider: string;
  baseUrl: string;
  token: string;
  model: string;
  visionModel: string;
  systemPrompt: string;
  adminIds: number[];
}): Bot {
  const { apiKey, provider, baseUrl, token, model, visionModel, systemPrompt, adminIds } =
    options;
  // Um cliente só para o provedor escolhido — todos falam o dialeto da OpenAI.
  const ai = createAiClient({ provider, apiKey, baseUrl });
  // Nome curto do provedor para as mensagens que o administrador recebe.
  const provedor = providerLabel(provider);
  // Padrão multimodal do provedor ("" quando ele não lê imagem).
  const visaoPadrao = resolveVisionModelFor(provider, "");
  const bot = new Bot(token);

  // Só o administrador fala com o bot. Enquanto nenhum Id estiver salvo, o
  // agente sobe mesmo assim: a primeira mensagem recebida vira a resposta com
  // o Id de quem escreveu, que é justamente o número que falta no dashboard.
  bot.use(async (ctx, next) => {
    const senderId = ctx.from?.id;
    if (senderId !== undefined && adminIds.includes(senderId)) {
      await next();
      return;
    }
    if (!ctx.chat) return;

    if (adminIds.length === 0) {
      await ctx.reply(
        [
          "👋 Sou o Ping IA, mas ainda não sei quem é o administrador.",
          "",
          `Seu Id no Telegram é: ${senderId ?? "?"}`,
          "",
          "Cole esse número em Configurações → Bot Ping IA →",
          '"Seu Id no Telegram" e clique em Salvar (só o administrador do PingOS consegue abrir essa tela).',
        ].join("\n"),
      );
      return;
    }

    await ctx.reply("⛔ Acesso restrito ao administrador do PingOS.");
  });

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat!.id;
    const senderId = ctx.from?.id ?? chatId;
    const userText = ctx.message.text;

    try {
      // Confirmação de exclusão tem prioridade: se há uma ação pendente, o
      // Sim/Não é resolvido aqui, sem passar pelo modelo.
      const confirmacao = await tryConfirmacao(chatId, senderId, userText);
      if (confirmacao !== null) {
        await ctx.reply(confirmacao);
        return;
      }

      await ctx.replyWithChatAction("typing");

      const messages: OpenAI.ChatCompletionMessageParam[] = [
        { role: "system", content: systemPrompt },
        ...(history.get(chatId) ?? []),
        { role: "user", content: userText },
      ];

      // Nem todo modelo aceita `tools`: se o provedor recusar a chamada com
      // ferramentas, seguimos sem elas — é melhor responder sem executar ação
      // do que devolver erro para o administrador.
      let usarFerramentas = true;
      const chat = async (): Promise<OpenAI.ChatCompletion> => {
        if (!usarFerramentas) return aiChat(ai, { model, messages }, { provider });
        try {
          return await aiChat(
            ai,
            {
              model,
              messages,
              tools,
              tool_choice: "auto",
            },
            { provider },
          );
        } catch (error) {
          const status = (error as { status?: number }).status;
          if (status !== 400 && status !== 422) throw error;
          console.warn(
            `[bot-ia] o modelo ${model} recusou as ferramentas (HTTP ${status}) — seguindo sem ações.`,
          );
          usarFerramentas = false;
          return aiChat(ai, { model, messages }, { provider });
        }
      };

      // Executa a cadeia de chamadas de ferramenta (limite de segurança: 4).
      for (let step = 0; step < 4; step += 1) {
        const completion = await chat();
        const message = completion.choices[0]?.message;
        if (!message) {
          await ctx.reply("Não consegui gerar uma resposta agora. Tente de novo.");
          break;
        }

        messages.push({
          role: "assistant",
          content: message.content ?? "",
          tool_calls: message.tool_calls,
        });

        const calls = (message.tool_calls ?? []).filter(
          (call) => call.type === "function",
        );
        if (calls.length === 0) {
          const text = extractText(message);
          await ctx.reply(
            text ||
              `⚠️ O modelo ${model} não devolveu texto. Troque o modelo em ` +
                "Configurações → Bot Ping IA — o padrão do provedor é " +
                `${resolveProvider(provider).defaultModel}.`,
          );
          break;
        }

        for (const call of calls) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments || "{}");
          } catch {
            args = {};
          }
          const result = await runTool(call.function.name, args, { adminId: senderId, chatId });
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: JSON.stringify(result),
          });
        }
      }

      history.set(
        chatId,
        messages.filter((message) => message.role !== "system").slice(-12),
      );
    } catch (error) {
      console.error("[bot-ia] erro ao responder:", error);
      const status = (error as { status?: number }).status;
      // 410 Gone = a NVIDIA aposentou o modelo: nenhuma tentativa seguinte vai
      // funcionar, então o aviso já diz exatamente o que fazer.
      const detalhe =
        status === 410
          ? `A ${provedor} aposentou o modelo "${model}". Escolha outro em ` +
            `Configurações → Bot Ping IA (o padrão é ${resolveProvider(provider).defaultModel}).`
          : status === 401 || status === 403
            ? `A ${provedor} recusou a API Key. Confira a chave em Configurações → Bot Ping IA.`
            : status === 404
              ? `O modelo "${model}" não existe em ${provedor}. Escolha outro em Configurações → Bot Ping IA.`
              : "Verifique a configuração do bot e tente novamente.";
      await ctx.reply(`❌ ${detalhe}`).catch(() => undefined);
    }
  });

  // ── Foto de O.S. impressa ──────────────────────────────────────────────
  // O administrador manda a foto; o bot baixa a imagem, manda para o modelo de
  // visão, cria o chamado com o mapeamento (Descrição → título, PROBLEMAS →
  // descrição) e responde o resumo.
  //
  // Vale para foto e para **arquivo de imagem**: enviar como arquivo (sem a
  // compressão do Telegram) preserva o texto miúdo do cupom, o que ajuda muito
  // o OCR — por isso os dois caminhos usam o mesmo código.
  const tratarImagemOs = async (ctx: Context, fileId: string, mime: string) => {
    const chatId = ctx.chat!.id;
    const senderId = ctx.from?.id ?? chatId;

    // Provedor sem modelo de visão (ex.: DeepSeek): não há o que fazer com a
    // foto — melhor avisar do que mandar a imagem para um modelo que a recusa.
    if (!visionModel) {
      await ctx.reply(
        `📷 O provedor configurado (${provedor}) não lê imagens, então não consigo ` +
          "abrir a O.S. pela foto. Escolha um provedor multimodal em " +
          "Configurações → Bot Ping IA (NVIDIA, OpenAI, Gemini...).",
      );
      return;
    }

    try {
      // Uma confirmação pendente espera texto (Sim/Não): a foto não pode ser
      // interpretada como resposta.
      const pendente = await buscarAcaoPendente(chatId, senderId);
      if (pendente) {
        await ctx.reply(
          "⏳ Há uma confirmação aguardando resposta. Responda *Sim* ou *Não* " +
            "e depois mande a foto de novo.",
        );
        return;
      }

      await ctx.replyWithChatAction("typing");

      const arquivo = await ctx.api.getFile(fileId);
      if (!arquivo.file_path) throw new Error("o Telegram não devolveu o caminho da imagem");

      const resposta = await fetch(
        `https://api.telegram.org/file/bot${token}/${arquivo.file_path}`,
      );
      if (!resposta.ok) throw new Error(`download da imagem falhou (HTTP ${resposta.status})`);
      const bytes = Buffer.from(await resposta.arrayBuffer());
      // Mesmo teto do Telegram para foto: acima disso a imagem vira uma
      // requisição gigante em base64 e não compensa.
      if (bytes.byteLength > LIMITE_IMAGEM_BYTES) {
        await ctx.reply(
          "⚠️ Essa imagem é grande demais para a leitura automática. Mande como " +
            "foto (sem selecionar \"enviar sem compactação\") ou diminua a resolução.",
        );
        return;
      }
      const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;

      let dados: DadosOs;
      try {
        dados = await extrairOsDaImagem(ai, visionModel, dataUrl, provider);
      } catch (error) {
        console.error("[bot-ia] falha na leitura da O.S.:", error);
        const status = (error as { status?: number }).status;
        await ctx.reply(
          status === 401 || status === 403 || status === 404 || status === 410
            ? `❌ O modelo de visão "${visionModel}" não está disponível em ` +
                `${provedor}. Escolha outro em Configurações → Bot Ping IA → ` +
                `"Modelo de visão" e use o botão Testar` +
                (visaoPadrao ? ` (o padrão do provedor é ${visaoPadrao}).` : ".")
            : "⚠️ Não consegui processar a imagem agora. Tente novamente em alguns " +
                "segundos ou digite os dados manualmente.",
        );
        return;
      }

      if (!osTemConteudo(dados)) {
        await ctx.reply(
          "❌ Não consegui ler a O.S. Envie uma foto mais nítida, bem iluminada e " +
            "sem sombras — de preferência enquadrando o cupom inteiro.",
        );
        return;
      }

      // O.S. repetida: o mesmo cupom costuma ser fotografado duas vezes.
      const duplicado = dados.numero_os
        ? await buscarChamadoPorOs(dados.numero_os)
        : null;
      const faltando = [
        !dados.numero_os ? "o número da O.S." : null,
        !dados.solicitante ? "o solicitante" : null,
        !dados.descricao ? "a Descrição" : null,
      ].filter((item): item is string => Boolean(item));

      if (duplicado || faltando.length > 0) {
        const aviso = duplicado
          ? `⚠️ A O.S. ${dados.numero_os} já foi cadastrada como chamado ` +
            `#${duplicado.number}. Quer criar mesmo assim?`
          : `⚠️ Não identifiquei ${faltando.join(" nem ")}. Confirma que é isso?`;
        const resumo = `${aviso}\n\n${resumoOsLida(dados)}\n\n` +
          "Responda *Sim* para criar assim mesmo ou *Não* para cancelar.";

        await criarAcaoPendente({
          adminId: senderId,
          chatId,
          tipo: "criar_chamado_os",
          resumo,
          payload: { dados },
        });
        await ctx.reply(resumo);
        return;
      }

      const criado = await criarChamadoViaOs({
        dados,
        imageUrl: dataUrl,
        adminId: senderId,
        origem: "telegram",
      });

      // Guarda o cadastro no histórico: se o administrador responder algo como
      // "muda a prioridade para alta", o modelo já sabe de qual chamado é.
      const anotacao: OpenAI.ChatCompletionMessageParam[] = [
        { role: "user", content: "[foto de uma O.S. impressa]" },
        {
          role: "assistant",
          content:
            `${mensagemChamadoCriado(dados, criado)}\n\nA foto foi anexada ao ` +
            `chamado #${criado.number}.`,
        },
      ];
      history.set(
        chatId,
        [...(history.get(chatId) ?? []), ...anotacao].slice(-12),
      );

      await ctx.reply(mensagemChamadoCriado(dados, criado));
    } catch (error) {
      console.error("[bot-ia] erro ao tratar a imagem da O.S.:", error);
      await ctx
        .reply("⚠️ Erro ao processar a imagem. Tente novamente.")
        .catch(() => undefined);
    }
  };

  // A maior resolução disponível (o Telegram manda várias versões da foto).
  bot.on("message:photo", async (ctx) => {
    const fotos = ctx.message.photo;
    await tratarImagemOs(ctx, fotos[fotos.length - 1].file_id, "image/jpeg");
  });

  // Arquivo enviado como documento — vale quando for imagem.
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    if (!doc.mime_type?.startsWith("image/")) {
      await ctx.reply(
        "📎 Só consigo ler O.S. em **imagem** (foto ou arquivo .jpg/.png). " +
          "Mande a foto do cupom.",
      );
      return;
    }
    await tratarImagemOs(ctx, doc.file_id, doc.mime_type);
  });

  bot.catch((err) => {
    // 409 = outra instância está fazendo long polling com o mesmo token.
    console.error("[bot-ia] erro no Telegram:", err.error ?? err);
  });

  return bot;
}

const ADMIN_ID_HELP = [
  "   ⚠️  Sem administrador definido — o bot está no ar só para isso:",
  "       1. Mande qualquer mensagem para o bot no Telegram;",
  "       2. Ele responde com o seu Id numérico;",
  '       3. Cole em Configurações → Bot Ping IA → "Seu Id no Telegram".',
  "      (Alternativa: definir ADMIN_ID no ambiente deste serviço.)",
].join("\n");

/** Relê `bot_config` e sobe/derruba/atualiza o bot conforme a configuração. */
async function syncOnce(): Promise<void> {
  let config: BotConfigRow | null = null;
  try {
    config = await queryOne<BotConfigRow>(
      "SELECT * FROM `bot_config` WHERE `id` = 1",
    );
  } catch (error) {
    await stopRuntime("o banco de dados não respondeu");
    reportStatus(
      `⏳ Ping IA aguardando o MySQL: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  const apiKey = (config?.nvidia_api_key ?? "").trim();
  // Provedor de IA escolhido no dashboard (NVIDIA é o padrão).
  const provider = resolveProvider(config?.provider).id;
  const provedorInfo = resolveProvider(provider);
  // URL base alternativa (servidor próprio/Azure); vazia = padrão do provedor.
  const baseUrl = (config?.base_url ?? "").trim();
  const token = (config?.telegram_token ?? "").trim();
  // O Id do administrador vem do dashboard; a variável de ambiente ADMIN_ID
  // continua valendo (útil em quem já configurou por lá).
  const adminIds = parseAdminIds(config?.admin_id);
  for (const id of parseAdminIds(process.env.ADMIN_ID)) {
    if (!adminIds.includes(id)) adminIds.push(id);
  }
  const pendentes = [
    config?.ativo ? null : "Ativar bot está desligado",
    apiKey ? null : `${provedorInfo.apiKeyLabel} não preenchida`,
    missingBaseUrl(provider, baseUrl)
      ? "URL base do provedor não preenchida"
      : null,
    token ? null : "Telegram Bot Token não preenchido",
  ].filter((item): item is string => Boolean(item));

  if (pendentes.length > 0) {
    await stopRuntime("configuração incompleta");
    reportStatus(
      `⏳ Ping IA aguardando configuração — ${pendentes.join(" · ")}.\n` +
        "   Ajuste em Configurações → Bot Ping IA e clique em Salvar " +
        `(a checagem se repete a cada ${CHECK_INTERVAL_MS / 1000}s).`,
    );
    return;
  }

  // `resolveModelFor` troca o modelo por um vivo caso o banco ainda guarde um
  // ID aposentado (na NVIDIA) e cai no padrão do provedor quando o campo está
  // vazio — trocar de provedor não exige escolher modelo à mão.
  const model = resolveModelFor(provider, config?.modelo);
  // Modelo de leitura das fotos de O.S.: campo próprio, com padrão próprio.
  // "" = o provedor escolhido não lê imagem (DeepSeek, por exemplo).
  const visionModel = resolveVisionModelFor(provider, config?.modelo_visao);

  // Personalidade ativa (Configurações → Bot Ping IA → Personalidades). O slot 1
  // (Padrão) é fixo: o prompt vem do código. Nos editáveis vale o `system_prompt`
  // salvo, com o padrão como fallback. Sem personalidade ativa, o campo
  // `bot_config.system_prompt` (e por fim o prompt padrão) continua valendo.
  const personalidade = await carregar_personalidade_ativa();
  const systemPrompt =
    personalidade?.fixo === 1
      ? PROMPT_PADRAO_PINGOS
      : (personalidade?.system_prompt ?? "").trim() ||
        (config?.system_prompt ?? "").trim() ||
        PROMPT_PADRAO_PINGOS;
  const fingerprint = [
    apiKey,
    provider,
    baseUrl,
    token,
    model,
    visionModel,
    systemPrompt,
    adminIds.join(","),
  ].join("\u0000");

  if (runtime?.fingerprint === fingerprint) return;
  if (runtime) await stopRuntime("a configuração mudou");

  // Só loga a personalidade quando o runtime é (re)construído — assim o
  // supervisor de 15s não repete a linha a cada ciclo.
  reportStatus(
    personalidade
      ? `${personalidade.emoji || "🤖"} Personalidade ativa: ${personalidade.nome}`
      : "🤖 Personalidade padrão",
  );

  const bot = createBot({
    apiKey,
    provider,
    baseUrl,
    token,
    model,
    visionModel,
    systemPrompt,
    adminIds,
  });
  runtime = { bot, fingerprint };
  lastStatus = "";

  // `start()` só resolve quando o polling termina: o erro é tratado aqui para
  // que o supervisor tente de novo no próximo ciclo.
  void bot
    .start({
      onStart: (info) => {
        reportStatus(
          `🤖 Ping IA no ar como @${info.username} — provedor: ${providerLabel(provider)}` +
            `\n   Modelo: ${model}` +
            `\n   Visão (fotos de O.S.): ${visionModel || "indisponível neste provedor"}` +
            (adminIds.length > 0
              ? `\n   Restrito ao ADMIN_ID: ${adminIds.join(",")}`
              : `\n${ADMIN_ID_HELP}`),
        );
      },
    })
    .catch((error) => {
      if (runtime?.bot === bot) runtime = null;
      reportStatus(
        `❌ Ping IA não conseguiu falar com o Telegram: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const env = loadEnvFile();

  // ADMIN_ID ausente não derruba o processo (isso só poluiria o log com o
  // restart do Docker): o supervisor sobe e conta no log o que falta.
  const envAdminIds = parseAdminIds(process.env.ADMIN_ID);

  console.log(
    `\n▶️  Ping IA — supervisor iniciado` +
      (envAdminIds.length > 0
        ? ` (ADMIN_ID ${envAdminIds.join(",")})`
        : " (sem ADMIN_ID no ambiente — o Id é lido do dashboard)") +
      (env.file ? `\n   Env file: ${env.file}` : ""),
  );

  // Defesa contra reimplantação fora de ordem: o bot cria chamados e usa
  // `acoes_pendentes`/`audit_log`, que a migração da API cria. Se o serviço do
  // bot subir com o banco ainda antigo (API sem redeploy), ele garante o
  // schema aqui — melhor esforço, nunca derruba o bot. Desligue com
  // MYSQL_AUTO_MIGRATE=false, o mesmo interruptor do boot da API.
  const autoMigrate = !["0", "false", "nao", "não", "no", "off"].includes(
    (process.env.MYSQL_AUTO_MIGRATE ?? "").trim().toLowerCase(),
  );
  if (autoMigrate) await ensureSchema();

  const timer = setInterval(() => {
    if (syncing) return;
    syncing = true;
    void syncOnce().finally(() => {
      syncing = false;
    });
  }, CHECK_INTERVAL_MS);

  const shutdown = async () => {
    clearInterval(timer);
    await stopRuntime("encerrando");
    await closePool().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  syncing = true;
  try {
    await syncOnce();
  } finally {
    syncing = false;
  }
}

main().catch(async (error) => {
  console.error("[bot-ia] falha ao iniciar:", error);
  await closePool().catch(() => undefined);
  process.exit(1);
});
