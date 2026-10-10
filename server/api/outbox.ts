/**
 * Outbox de notificações.
 *
 * Antes, criar ou mover um chamado enviava e-mail/Telegram/WhatsApp **dentro da
 * requisição**: a resposta ficava presa até `NOTIFY_TIMEOUT_MS` (10 s por canal,
 * em paralelo) e uma falha de terceiro atrasava o usuário. Agora a requisição só
 * grava a intenção na tabela `notification_outbox` (rápido e durável) e um
 * worker em segundo plano entrega, com tentativas e backoff.
 *
 * Garantias:
 * - **durável**: a intenção é uma linha no banco; reiniciar o processo não perde
 *   o aviso;
 * - **uma entrega por vez**: a linha é "reivindicada" com `UPDATE ... WHERE
 *   status = 'pending'`, então duas instâncias não enviam a mesma notificação;
 * - **com teto**: até `MAX_ATTEMPTS` tentativas e depois `failed` (com o motivo
 *   em `last_error`), para um canal quebrado não virar laço infinito;
 * - **recuperação**: linha presa em `sending` (processo morto no meio do envio)
 *   volta para `pending` depois de `STUCK_MS`.
 */

import { query, execute } from "../mysql/pool"

/**
 * O que vai na fila: um envio externo já montado (assunto, corpo e
 * destinatários). O sino in-app continua sendo gravado na própria requisição
 * (é um INSERT local e barato) — assim uma nova tentativa não duplica o aviso no
 * app, e o domínio de falha da fila é exatamente o canal externo.
 *
 * A imagem do chamado **não** entra no payload: o worker recarrega o chamado
 * pelo id na hora de enviar (imagens são data URLs de centenas de KB).
 */
export type OutboxPayload = {
  kind: "external_dispatch"
  ticketId: string
  subject: string
  body: string
  emailRecipients?: string[]
  whatsappRecipients?: string[]
  ruleId?: string | null
}

export const MAX_ATTEMPTS = 5

/** Intervalo do worker (ms) — e o atraso do "empurrão" após enfileirar. */
const WORKER_INTERVAL_MS = 10_000
const KICK_DELAY_MS = 250

/** Tempo máximo que uma linha pode ficar em `sending` antes de voltar à fila. */
const STUCK_MS = 120_000

/**
 * Espera antes da próxima tentativa: 5 s, 10 s, 20 s, 40 s… com teto de 5 min.
 */
export function backoffMs(attempts: number): number {
  const safe = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 1
  const delay = 5_000 * 2 ** (safe - 1)
  return Math.min(delay, 5 * 60_000)
}

/** Serializa o payload para a coluna `payload`. */
export function encodeJob(payload: OutboxPayload): string {
  return JSON.stringify(payload)
}

/**
 * Lê o payload gravado. Devolve `null` quando a linha está corrompida ou tem um
 * formato que este código não sabe entregar — o worker marca como `failed`.
 */
export function decodeJob(raw: unknown): OutboxPayload | null {
  if (typeof raw !== "string" || raw === "") return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    const job = parsed as Record<string, unknown>
    if (job.kind !== "external_dispatch") return null
    if (typeof job.ticketId !== "string" || job.ticketId === "") return null
    if (typeof job.subject !== "string" || typeof job.body !== "string") return null

    const listaDeTexto = (value: unknown): string[] | undefined =>
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : undefined

    return {
      kind: "external_dispatch",
      ticketId: job.ticketId,
      subject: job.subject,
      body: job.body,
      emailRecipients: listaDeTexto(job.emailRecipients),
      whatsappRecipients: listaDeTexto(job.whatsappRecipients),
      ruleId: typeof job.ruleId === "string" ? job.ruleId : null,
    }
  } catch {
    return null
  }
}

/** Grava a intenção na fila (a entrega fica para o worker). */
export async function enqueueNotification(payload: OutboxPayload): Promise<void> {
  const now = Date.now()
  await execute(
    "INSERT INTO `notification_outbox` (`kind`, `payload`, `status`, `attempts`, `available_at`, `created_at`, `updated_at`) " +
      "VALUES (?, ?, 'pending', 0, ?, ?, ?)",
    [payload.kind, encodeJob(payload), now, now, now],
  )
  kickWorker()
}

/** Devolve à fila as linhas que ficaram presas em `sending`. */
export async function resetStuckOutbox(): Promise<number> {
  const result = await execute(
    "UPDATE `notification_outbox` SET `status` = 'pending', `updated_at` = ? WHERE `status` = 'sending' AND `updated_at` < ?",
    [Date.now(), Date.now() - STUCK_MS],
  )
  return result.affectedRows ?? 0
}

type ClaimedJob = { id: number; payload: string; attempts: number }

/**
 * Entrega até `limit` notificações pendentes.
 *
 * Cada linha é reivindicada com um `UPDATE` condicional: se outra instância
 * chegou antes, `affectedRows` é 0 e o job é pulado — é o que garante uma
 * entrega por notificação mesmo com várias réplicas da API.
 */
export async function drainOutbox(
  handler: (payload: OutboxPayload) => Promise<void>,
  limit = 10,
): Promise<{ sent: number; failed: number }> {
  const now = Date.now()
  const rows = await query<ClaimedJob>(
    "SELECT `id`, `payload`, `attempts` FROM `notification_outbox` " +
      "WHERE `status` = 'pending' AND `available_at` <= ? ORDER BY `id` ASC LIMIT ?",
    [now, Math.max(1, Math.floor(limit))],
  )

  let sent = 0
  let failed = 0

  for (const row of rows) {
    const claimed = await execute(
      "UPDATE `notification_outbox` SET `status` = 'sending', `attempts` = `attempts` + 1, `updated_at` = ? WHERE `id` = ? AND `status` = 'pending'",
      [Date.now(), row.id],
    )
    if ((claimed.affectedRows ?? 0) !== 1) continue

    const attempts = Number(row.attempts ?? 0) + 1
    const payload = decodeJob(row.payload)
    if (!payload) {
      await markFailed(row.id, attempts, "payload inválido")
      failed++
      continue
    }

    try {
      await handler(payload)
      await execute(
        "UPDATE `notification_outbox` SET `status` = 'sent', `updated_at` = ?, `last_error` = NULL WHERE `id` = ?",
        [Date.now(), row.id],
      )
      sent++
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await markFailed(row.id, attempts, message.slice(0, 255))
      failed++
    }
  }

  return { sent, failed }
}

async function markFailed(id: number, attempts: number, reason: string): Promise<void> {
  const now = Date.now()
  if (attempts >= MAX_ATTEMPTS) {
    await execute(
      "UPDATE `notification_outbox` SET `status` = 'failed', `updated_at` = ?, `last_error` = ? WHERE `id` = ?",
      [now, reason, id],
    )
    return
  }
  await execute(
    "UPDATE `notification_outbox` SET `status` = 'pending', `available_at` = ?, `updated_at` = ?, `last_error` = ? WHERE `id` = ?",
    [now + backoffMs(attempts), now, reason, id],
  )
}

// ── Worker ──────────────────────────────────────────────────────────────────
let handlerRef: ((payload: OutboxPayload) => Promise<void>) | null = null
let intervalTimer: ReturnType<typeof setInterval> | null = null
let kickTimer: ReturnType<typeof setTimeout> | null = null
let draining = false

async function runCycle(): Promise<void> {
  if (!handlerRef || draining) return
  draining = true
  try {
    await resetStuckOutbox()
    // Um ciclo pode ter mais pendências que o limite: drena até esvaziar.
    for (let i = 0; i < 5; i++) {
      const { sent, failed } = await drainOutbox(handlerRef, 10)
      if (sent + failed === 0) break
    }
  } catch (error) {
    console.error("[outbox] falha no ciclo do worker:", error)
  } finally {
    draining = false
  }
}

/** Drena logo após enfileirar (sem bloquear quem chamou). */
function kickWorker(): void {
  if (!handlerRef || kickTimer) return
  kickTimer = setTimeout(() => {
    kickTimer = null
    void runCycle()
  }, KICK_DELAY_MS)
}

/** Sobe o worker (idempotente). O handler entrega um job por vez. */
export function startOutboxWorker(handler: (payload: OutboxPayload) => Promise<void>): void {
  handlerRef = handler
  if (intervalTimer) return
  intervalTimer = setInterval(() => void runCycle(), WORKER_INTERVAL_MS)
  void runCycle()
}

/** Para o worker (usado no shutdown). */
export function stopOutboxWorker(): void {
  if (intervalTimer) clearInterval(intervalTimer)
  if (kickTimer) clearTimeout(kickTimer)
  intervalTimer = null
  kickTimer = null
  handlerRef = null
}
