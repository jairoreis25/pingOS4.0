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

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { apiFetch, setToken } from "@/lib/mysql-api";
import type { MutationRef, QueryRef } from "./api";
import {
  clearSession,
  ensureSessionLoaded,
  getCachedQuery,
  getSession,
  handleAuthError,
  markAuthenticated,
  notifyChange,
  setCachedQuery,
  subscribeChange,
  subscribeSession,
} from "./session";

/** Argumentos no formato do Convex: um objeto único, opcional. */
type Args = Record<string, unknown> | "skip" | undefined;

/**
 * Compara dois resultados de query estruturalmente.
 *
 * O poll devolve um objeto NOVO a cada resposta (o `JSON.parse` não reaproveita
 * referências). Sem esta checagem, cada ciclo de 10s re-renderizava a árvore
 * inteira mesmo quando nada tinha mudado. O fast path por referência cobre o
 * caso comum e só o comparamos de verdade quando as referências divergem.
 */
function samePayload(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

// ── Queries ─────────────────────────────────────────────────────────────────
/**
 * Executa uma query do backend. Devolve `undefined` enquanto a primeira resposta
 * não chega (igual ao Convex) e `T` depois disso.
 */
export function useQuery<T = any>(
  ref: QueryRef<T> | null | undefined,
  args?: Args,
): T | undefined {
  const skip = args === "skip";
  const path = ref && !skip ? ref.path(args ?? {}) : null;

  // Já entrega o último resultado conhecido (quando houver) em vez de piscar
  // "carregando" a cada remontagem do mesmo recurso.
  const [data, setData] = useState<T | undefined>(() =>
    path ? (getCachedQuery(path) as T | undefined) : undefined,
  );

  const fetchNow = useCallback(async () => {
    if (!path) return;
    try {
      const result = await apiFetch<T>(path);
      setCachedQuery(path, result);
      // Só re-renderiza se o conteúdo realmente mudou.
      setData((prev) => (samePayload(prev, result) ? prev : result));
    } catch (error) {
      handleAuthError(error);
      // Query que falha não derruba a tela: o componente segue com o último dado
      // (ou `undefined`, que ele já trata como "carregando").
      console.warn(
        "[backend] falha na query",
        path,
        error instanceof Error ? error.message : error,
      );
    }
  }, [path]);

  useEffect(() => {
    if (!path) {
      setData(undefined);
      return;
    }

    let cancelled = false;
    // Trocar de recurso (ex.: abrir outro chamado) volta ao estado "carregando"
    // — ou direto ao valor em cache, se esse recurso já foi lido antes.
    setData(getCachedQuery(path) as T | undefined);

    const run = async () => {
      if (cancelled) return;
      await fetchNow();
    };

    void run();

    // O poll em segundo plano é global (ver src/lib/backend/session.ts):
    // assinar o barramento de mudanças já liga o timer compartilhado.
    const offChange = subscribeChange(() => void run());

    return () => {
      cancelled = true;
      offChange();
    };
  }, [path, fetchNow]);

  return data;
}

// ── Mutations / actions ─────────────────────────────────────────────────────
async function runMutation<R>(ref: MutationRef, args: unknown): Promise<R> {
  const payload = (args ?? {}) as Record<string, unknown>;
  const body = ref.body ? ref.body(payload) : undefined;
  const result = await apiFetch<R>(ref.path(payload), {
    method: ref.method,
    ...(body === undefined ? {} : { body }),
  });
  // Toda escrita invalida as queries montadas (o lugar do websocket do Convex).
  notifyChange();
  return result;
}

/** Devolve a função que executa a mutation (chamada com um objeto único). */
export function useMutation<R = any, A extends Record<string, unknown> = any>(
  ref: MutationRef | undefined | null,
): (args?: A) => Promise<R> {
  return useCallback(
    async (args?: A): Promise<R> => {
      if (!ref) throw new Error("[backend] mutation inválida");
      try {
        return await runMutation<R>(ref, args);
      } catch (error) {
        handleAuthError(error);
        throw error;
      }
    },
    [ref],
  );
}

/**
 * Ações (operações longas, como gerar/restaurar backup). No backend HTTP a
 * única diferença para `useMutation` é a expectativa de demora — as duas são
 * requisições normais, então compartilham a implementação.
 */
export const useAction = useMutation;

/** Executa uma operação imperativamente (fora de componente). */
export async function executeRef<R = any>(ref: MutationRef, args?: unknown): Promise<R> {
  return runMutation<R>(ref, args);
}

// ── Sessão ──────────────────────────────────────────────────────────────────
/** Espelha `useConvexAuth()`: `{ isLoading, isAuthenticated }`. */
export function useConvexAuth(): { isLoading: boolean; isAuthenticated: boolean } {
  const session = useSyncExternalStore(subscribeSession, getSession, getSession);

  useEffect(() => {
    void ensureSessionLoaded();
  }, []);

  return { isLoading: session.loading, isAuthenticated: session.authenticated };
}

/** Espelha `useAuthActions()` do `@convex-dev/auth/react`. */
export function useAuthActions(): {
  signIn: (provider: string, params: Record<string, unknown>) => Promise<void>;
  signOut: () => Promise<void>;
} {
  return useMemo(
    () => ({
      signIn: async (_provider: string, params: Record<string, unknown>) => {
        const username = String(params?.email ?? params?.username ?? "").trim();
        const password = String(params?.password ?? "");
        const result = await apiFetch<{ token: string; user?: { _id?: string } }>(
          "/api/auth/login",
          { method: "POST", body: { username, password }, auth: false },
        );
        setToken(result.token);
        markAuthenticated(result.user?._id ?? null);
        notifyChange();
      },
      signOut: async () => {
        await clearSession();
      },
    }),
    [],
  );
}

export type { MutationRef, QueryRef };
