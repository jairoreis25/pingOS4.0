/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Estado de sessão do frontend no backend MySQL.
 *
 * O Convex carregava o token/usuário sozinho; aqui a sessão é um pequeno store
 * observável (token no localStorage + usuário atual em memória), consumido pelos
 * hooks de `./react` via `useSyncExternalStore`.
 *
 * Também é o barramento de mudanças: toda mutation chama `notifyChange()`, o que
 * faz as queries montadas se atualizarem — é o que imita a reatividade do Convex.
 */

import { API_URL, ApiClientError, apiFetch, getToken, setToken } from "@/lib/mysql-api"

export interface SessionState {
  /** true enquanto a sessão inicial ainda não foi resolvida. */
  loading: boolean
  authenticated: boolean
  userId: string | null
}

let state: SessionState = { loading: true, authenticated: false, userId: null }
let bootstrapped = false

const sessionListeners = new Set<() => void>()
const changeListeners = new Set<() => void>()

/**
 * Revalidação de segurança (ms) quando o tempo real não ajuda.
 *
 * Antes eram 10 s rebaixando a base inteira de chamados em todo navegador. Agora
 * o servidor avisa pela conexão SSE (`GET /api/events`) e este timer fica só
 * como rede de segurança — cobre SSE bloqueado por proxy, queda de rede e
 * eventos perdidos quando há mais de uma réplica da API.
 */
const POLL_FALLBACK_MS = 60_000

/** Espera antes de tentar reabrir o SSE (ms). */
const SSE_RECONNECT_MS = 5_000

/**
 * Um ÚNICO timer para todas as queries montadas. Antes cada `useQuery` criava o
 * próprio `setInterval` (o painel chega a montar ~14), o que multiplicava os
 * disparos do navegador e revalidava a mesma tela várias vezes por ciclo. Agora
 * o timer só existe enquanto houver alguém inscrito e acorda todo mundo de uma
 * vez pelo mesmo barramento usado pelas mutations.
 */
let pollTimer: number | null = null
let eventAbort: AbortController | null = null
let reconnectTimer: number | null = null

function startPollLoop(): void {
  if (POLL_FALLBACK_MS <= 0 || pollTimer !== null) return
  if (typeof window === "undefined") return
  pollTimer = window.setInterval(() => {
    // Aba em segundo plano não precisa revalidar: economiza rede e CPU.
    if (document.visibilityState === "visible") notifyChange()
  }, POLL_FALLBACK_MS)
}

function stopPollLoop(): void {
  if (pollTimer === null) return
  window.clearInterval(pollTimer)
  pollTimer = null
}

/**
 * Abre o stream de eventos e chama `notifyChange()` a cada `changed`.
 *
 * Usa `fetch` em vez de `EventSource` porque o token vai no cabeçalho
 * `Authorization` (EventSource não permite cabeçalhos, e token em query string
 * acabaria nos logs do servidor).
 */
function startEventStream(): void {
  if (typeof window === "undefined" || eventAbort) return
  const token = getToken()
  if (!token) return

  const controller = new AbortController()
  eventAbort = controller

  void (async () => {
    try {
      const response = await fetch(`${API_URL}/api/events`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
        signal: controller.signal,
      })
      if (!response.ok || !response.body) throw new Error(`SSE indisponível (${response.status})`)

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        // Cada bloco SSE é separado por uma linha em branco.
        let boundary = buffer.indexOf("\n\n")
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          if (block.includes("event: changed")) notifyChange()
          boundary = buffer.indexOf("\n\n")
        }
      }
    } catch {
      // Sem tempo real (proxy, offline, sessão expirada): o poll de segurança
      // continua revalidando enquanto a aba estiver visível.
    } finally {
      eventAbort = null
      if (changeListeners.size > 0) {
        reconnectTimer = window.setTimeout(() => startEventStream(), SSE_RECONNECT_MS)
      }
    }
  })()
}

function stopEventStream(): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  eventAbort?.abort()
  eventAbort = null
}

/**
 * Cache de respostas por caminho de query. Serve para dois casos:
 *   - remontar um recurso (abrir/fechar um modal, trocar de chamado) mostra o
 *     último valor conhecido em vez de piscar "carregando";
 *   - duas telas que leem a mesma rota recebem o mesmo dado sem piscar.
 * É descartado ao encerrar a sessão, para nunca vazar dado de um usuário para o
 * próximo que entrar no mesmo navegador.
 */
const queryCache = new Map<string, unknown>()

export function getCachedQuery(key: string): unknown {
  return queryCache.get(key)
}

export function setCachedQuery(key: string, value: unknown): void {
  queryCache.set(key, value)
}

function clearQueryCache(): void {
  queryCache.clear()
}

/** Estado atual (referência estável até haver mudança). */
export function getSession(): SessionState {
  return state
}

export function subscribeSession(listener: () => void): () => void {
  sessionListeners.add(listener)
  return () => sessionListeners.delete(listener)
}

function emitSession(next: Partial<SessionState>): void {
  state = { ...state, ...next }
  for (const listener of sessionListeners) listener()
}

/** Marca a sessão como autenticada (usado no login). */
export function markAuthenticated(userId: string | null = null): void {
  emitSession({ loading: false, authenticated: true, userId })
  // Acabou de existir token: liga o tempo real para as queries já montadas.
  if (changeListeners.size > 0) startEventStream()
}

/** Marca a sessão como encerrada (logout ou 401). */
export function markSignedOut(): void {
  clearQueryCache()
  stopEventStream()
  emitSession({ loading: false, authenticated: false, userId: null })
}

/** Notifica as queries montadas (chamado após cada mutation). */
export function notifyChange(): void {
  for (const listener of changeListeners) listener()
}

export function subscribeChange(listener: () => void): () => void {
  changeListeners.add(listener)
  startPollLoop()
  startEventStream()
  return () => {
    changeListeners.delete(listener)
    if (changeListeners.size === 0) {
      stopPollLoop()
      stopEventStream()
    }
  }
}

/** Detecta 401 em qualquer requisição e derruba a sessão. */
export function handleAuthError(error: unknown): void {
  if (error instanceof ApiClientError && error.status === 401) {
    setToken(null)
    markSignedOut()
  }
}

/**
 * Resolve a sessão na primeira renderização: se existe token salvo, confirma
 * com o backend que ele ainda vale (`GET /api/auth/me`).
 */
export async function ensureSessionLoaded(): Promise<void> {
  if (bootstrapped) return
  bootstrapped = true

  const token = getToken()
  if (!token) {
    markSignedOut()
    return
  }

  try {
    // `auth` fica ligado de propósito: é o token salvo que está sendo validado.
    const me = await apiFetch<{ userId: string } | null>("/api/auth/me")
    if (me?.userId) markAuthenticated(me.userId)
    else {
      setToken(null)
      markSignedOut()
    }
  } catch (error) {
    handleAuthError(error)
    markSignedOut()
  }
}

/** Usado pelo logout: limpa token e sessão, mesmo se a API falhar. */
export async function clearSession(): Promise<void> {
  try {
    await apiFetch("/api/auth/logout", { method: "POST" })
  } catch {
    /* a sessão local é encerrada de qualquer forma */
  } finally {
    setToken(null)
    markSignedOut()
    notifyChange()
  }
}
