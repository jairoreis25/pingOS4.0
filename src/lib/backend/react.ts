/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Hooks do backend MySQL com a MESMA assinatura dos hooks do Convex.
 *
 *   import { useQuery, useMutation } from "convex/react";        // antes
 *   import { useQuery, useMutation } from "@/lib/backend/react";  // depois
 *
 * `useQuery(api.tickets.list)` devolve `undefined` enquanto carrega (os
 * componentes já tratam esse estado), `"skip"` desliga a busca e cada mutation
 * invalida todas as queries montadas — a reatividade que o Convex entregava por
 * websocket passa a ser invalidação local após escrita + poll leve em segundo
 * plano (para pegar o que outro usuário alterou).
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { apiFetch, apiFetchWithMeta, setToken } from "@/lib/mysql-api"
import type { MutationRef, QueryRef } from "./api"
import { appendPage, mergePages, nextCursorFrom } from "./paging"
import {
  clearSession,
  ensureSessionLoaded,
  getCachedQuery,
  getSession,
  handleAuthError,
  markAuthenticated,
  markTokenIssued,
  notifyChange,
  setCachedQuery,
  subscribeChange,
  subscribeSession,
} from "./session"

/** Argumentos no formato do Convex: um objeto único, opcional. */
type Args = Record<string, unknown> | "skip" | undefined

/**
 * Compara dois resultados de query estruturalmente.
 *
 * O poll devolve um objeto NOVO a cada resposta (o `JSON.parse` não reaproveita
 * referências). Sem esta checagem, cada ciclo de 10s re-renderizava a árvore
 * inteira mesmo quando nada tinha mudado. O fast path por referência cobre o
 * caso comum e só o comparamos de verdade quando as referências divergem.
 */
function samePayload(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== typeof b) return false
  if (typeof a !== "object") return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

// ── Erros das queries ───────────────────────────────────────────────────────
/**
 * Erro da última tentativa de cada query.
 *
 * Antes a falha ia só para o console e o componente continuava exibindo
 * "carregando" para sempre (tela presa quando a API estava fora do ar). O mapa
 * fica no módulo para que o erro sobreviva a remontagens e para que o `retry`
 * consiga limpá-lo. Quem quer tratar o estado usa `useQueryState`.
 */
const queryErrors = new Map<string, unknown>()
const errorListeners = new Set<() => void>()

function setQueryError(path: string, error: unknown): void {
  const previous = queryErrors.get(path)
  if (previous === error) return
  if (error === null || error === undefined) queryErrors.delete(path)
  else queryErrors.set(path, error)
  errorListeners.forEach((listener) => listener())
}

function subscribeQueryError(listener: () => void): () => void {
  errorListeners.add(listener)
  return () => {
    errorListeners.delete(listener)
  }
}

function queryErrorSnapshot(path: string | null): unknown {
  return path ? (queryErrors.get(path) ?? null) : null
}

export type QueryState<T> = {
  /** `undefined` enquanto a primeira resposta não chega. */
  data: T | undefined
  /** Último erro da query (`null` quando está tudo certo). */
  error: unknown
  /** Tenta novamente agora (limpa o erro e refaz a busca). */
  retry: () => void
}

// ── Queries ─────────────────────────────────────────────────────────────────
/**
 * Executa uma query do backend e devolve `data`, `error` e `retry`.
 *
 * Use este hook nas telas que precisam reagir à falha (mostrar aviso e botão de
 * tentar de novo). O `useQuery` abaixo continua devolvendo só os dados.
 */
export function useQueryState<T = any>(
  ref: QueryRef<T> | null | undefined,
  args?: Args,
): QueryState<T> {
  const skip = args === "skip"
  const path = ref && !skip ? ref.path(args ?? {}) : null
  const [attempt, setAttempt] = useState(0)

  // Já entrega o último resultado conhecido (quando houver) em vez de piscar
  // "carregando" a cada remontagem do mesmo recurso.
  const [data, setData] = useState<T | undefined>(() =>
    path ? (getCachedQuery(path) as T | undefined) : undefined,
  )

  const fetchNow = useCallback(async () => {
    if (!path) return
    try {
      const result = await apiFetch<T>(path)
      setCachedQuery(path, result)
      setQueryError(path, null)
      // Só re-renderiza se o conteúdo realmente mudou.
      setData((prev) => (samePayload(prev, result) ? prev : result))
    } catch (error) {
      handleAuthError(error)
      // Registra a falha para quem usa `useQueryState`; o componente segue com o
      // último dado conhecido (ou `undefined`, tratado como "carregando").
      setQueryError(path, error)
      console.warn("[backend] falha na query", path, error instanceof Error ? error.message : error)
    }
  }, [path])

  useEffect(() => {
    if (!path) {
      setData(undefined)
      return
    }

    let cancelled = false
    // Trocar de recurso (ex.: abrir outro chamado) volta ao estado "carregando"
    // — ou direto ao valor em cache, se esse recurso já foi lido antes.
    setData(getCachedQuery(path) as T | undefined)

    const run = async () => {
      if (cancelled) return
      await fetchNow()
    }

    void run()

    // O poll em segundo plano é global (ver src/lib/backend/session.ts):
    // assinar o barramento de mudanças já liga o timer compartilhado.
    const offChange = subscribeChange(() => void run())

    return () => {
      cancelled = true
      offChange()
    }
  }, [path, fetchNow, attempt])

  const error = useSyncExternalStore(
    subscribeQueryError,
    () => queryErrorSnapshot(path),
    () => queryErrorSnapshot(path),
  )

  const retry = useCallback(() => {
    if (!path) return
    setQueryError(path, null)
    setAttempt((value) => value + 1)
  }, [path])

  return { data, error, retry }
}

/**
 * Executa uma query do backend. Devolve `undefined` enquanto a primeira resposta
 * não chega (igual ao Convex) e `T` depois disso. Para tratar erro e repetir a
 * busca, use `useQueryState`.
 */
export function useQuery<T = any>(ref: QueryRef<T> | null | undefined, args?: Args): T | undefined {
  return useQueryState<T>(ref, args).data
}

// ── Queries paginadas (keyset) ──────────────────────────────────────────────
export type PagedQueryState<T> = {
  items: T[]
  error: unknown
  /** Primeira página ainda carregando. */
  loading: boolean
  /** "Carregar mais" em andamento. */
  loadingMore: boolean
  /** Existe próxima página (o servidor mandou `X-Next-Cursor`). */
  hasMore: boolean
  loadMore: () => void
  /** Recarrega a primeira página (usado no aviso de erro). */
  retry: () => void
}

/**
 * Query paginada por keyset, com acumulação das páginas.
 *
 * O servidor devolve até `pageSize` itens e o cursor da próxima página no header
 * `X-Next-Cursor` (ver `server/api/tickets-page.ts`). Aqui:
 * - a primeira página é recarregada quando o path muda ou quando o SSE avisa de
 *   mudança, e o resultado é **mesclado** com o que o usuário já carregou (sem
 *   repetir item — `mergePages`);
 * - `loadMore()` busca a página seguinte usando o cursor guardado.
 *
 * `keyOf` precisa ser **estável** (função declarada fora do componente): ela
 * entra nas dependências e uma função nova a cada render revalidaria a lista sem
 * parar. `args` pode vir inline — é comparado pelo conteúdo.
 */
export function usePagedQuery<T>(
  ref: QueryRef<T[]> | null | undefined,
  args: Args,
  pageSize: number,
  keyOf: (item: T) => string,
): PagedQueryState<T> {
  const skip = args === "skip"
  const baseKey = JSON.stringify(args && args !== "skip" ? args : {})
  const base = useMemo(() => JSON.parse(baseKey) as Record<string, unknown>, [baseKey])

  const [items, setItems] = useState<T[]>([])
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(!skip)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [reloadToken, setReloadToken] = useState(0)
  const cursorRef = useRef<string | null>(null)

  const fetchPage = useCallback(
    async (cursor: string | null): Promise<{ items: T[]; cursor: string | null } | null> => {
      if (!ref || skip) return null
      const path = ref.path({
        ...base,
        limit: pageSize,
        ...(cursor ? { cursor } : {}),
      })
      try {
        const { data, headers } = await apiFetchWithMeta<T[]>(path)
        setQueryError(path, null)
        return { items: data ?? [], cursor: nextCursorFrom(headers) }
      } catch (err) {
        handleAuthError(err)
        setQueryError(path, err)
        throw err
      }
    },
    [ref, skip, base, pageSize],
  )

  useEffect(() => {
    if (!ref || skip) {
      // Nada a assinar: o estado devolvido abaixo já é vazio (evita setState
      // sincrono no corpo do efeito).
      cursorRef.current = null
      return
    }

    let cancelled = false

    // Primeira página; em caso de mudança (SSE), mescla com o que já está na tela.
    const reload = async () => {
      setLoading(true)
      try {
        const page = await fetchPage(null)
        if (cancelled || !page) return
        cursorRef.current = page.cursor
        setHasMore(page.cursor !== null)
        setError(null)
        setItems((prev) => mergePages(prev, page.items, keyOf))
      } catch (err) {
        if (!cancelled) setError(err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void reload()
    const offChange = subscribeChange(() => void reload())

    return () => {
      cancelled = true
      offChange()
    }
  }, [ref, skip, fetchPage, keyOf, reloadToken])

  const loadMore = useCallback(() => {
    const cursor = cursorRef.current
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    void (async () => {
      try {
        const page = await fetchPage(cursor)
        if (!page) return
        cursorRef.current = page.cursor
        setHasMore(page.cursor !== null)
        setItems((prev) => appendPage(prev, page.items, keyOf))
      } catch (err) {
        setError(err)
      } finally {
        setLoadingMore(false)
      }
    })()
  }, [fetchPage, keyOf, loadingMore])

  const retry = useCallback(() => setReloadToken((value) => value + 1), [])

  if (skip) {
    return {
      items: [],
      error: null,
      loading: false,
      loadingMore: false,
      hasMore: false,
      loadMore,
      retry,
    }
  }

  return { items, error, loading, loadingMore, hasMore, loadMore, retry }
}

// ── Mutations / actions ─────────────────────────────────────────────────────
async function runMutation<R>(ref: MutationRef, args: unknown): Promise<R> {
  const payload = (args ?? {}) as Record<string, unknown>
  const body = ref.body ? ref.body(payload) : undefined
  const result = await apiFetch<R>(ref.path(payload), {
    method: ref.method,
    ...(body === undefined ? {} : { body }),
  })
  // Toda escrita invalida as queries montadas (o lugar do websocket do Convex).
  notifyChange()
  return result
}

/** Devolve a função que executa a mutation (chamada com um objeto único). */
export function useMutation<R = any, A extends Record<string, unknown> = any>(
  ref: MutationRef | undefined | null,
): (args?: A) => Promise<R> {
  return useCallback(
    async (args?: A): Promise<R> => {
      if (!ref) throw new Error("[backend] mutation inválida")
      try {
        return await runMutation<R>(ref, args)
      } catch (error) {
        handleAuthError(error)
        throw error
      }
    },
    [ref],
  )
}

/**
 * Ações (operações longas, como gerar/restaurar backup). No backend HTTP a
 * única diferença para `useMutation` é a expectativa de demora — as duas são
 * requisições normais, então compartilham a implementação.
 */
export const useAction = useMutation

/** Executa uma operação imperativamente (fora de componente). */
export async function executeRef<R = any>(ref: MutationRef, args?: unknown): Promise<R> {
  return runMutation<R>(ref, args)
}

// ── Sessão ──────────────────────────────────────────────────────────────────
/** Espelha `useConvexAuth()`: `{ isLoading, isAuthenticated }`. */
export function useConvexAuth(): { isLoading: boolean; isAuthenticated: boolean } {
  const session = useSyncExternalStore(subscribeSession, getSession, getSession)

  useEffect(() => {
    void ensureSessionLoaded()
  }, [])

  return { isLoading: session.loading, isAuthenticated: session.authenticated }
}

/** Espelha `useAuthActions()` do `@convex-dev/auth/react`. */
export function useAuthActions(): {
  signIn: (provider: string, params: Record<string, unknown>) => Promise<void>
  signOut: () => Promise<void>
} {
  return useMemo(
    () => ({
      signIn: async (_provider: string, params: Record<string, unknown>) => {
        const username = String(params?.email ?? params?.username ?? "").trim()
        const password = String(params?.password ?? "")
        const result = await apiFetch<{ token: string; user?: { _id?: string } }>(
          "/api/auth/login",
          { method: "POST", body: { username, password }, auth: false },
        )
        setToken(result.token)
        markTokenIssued()
        markAuthenticated(result.user?._id ?? null)
        notifyChange()
      },
      signOut: async () => {
        await clearSession()
      },
    }),
    [],
  )
}

export type { MutationRef, QueryRef }
