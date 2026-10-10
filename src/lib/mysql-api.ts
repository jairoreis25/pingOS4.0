/**
 * Camada de transporte HTTP do backend MySQL.
 *
 * É a base do adaptador `src/lib/backend/*`: cuida de URL base, token de sessão,
 * JSON e erros. Os componentes NÃO chamam isto direto — usam
 * `useQuery`/`useMutation` de `@/lib/backend/react` com as referências de
 * `@/lib/backend/api`.
 *
 * URL base:
 *   - runtime: `/config.js` gerado pelo container (ver src/lib/runtime-config.ts)
 *   - build:   `VITE_API_URL` (`.env.local` no dev, build arg no Docker)
 *   - vazio:   mesma origem (`/api/...`) — é o modo recomendado em produção,
 *              com o nginx repassando para o container `api`
 *   - dev:     `http://localhost:4000` quando nada está definido
 */

import { runtimeConfig } from "./runtime-config"

/** Chave do token de sessão no localStorage. */
export const TOKEN_KEY = "pingos.mysql.token"

const configuredUrl = (runtimeConfig.apiUrl ?? "").trim()
const devFallback = import.meta.env.DEV ? "http://localhost:4000" : ""

/** Base da API. Vazio = mesma origem (caminhos relativos `/api/...`). */
export const API_URL = (configuredUrl || devFallback).replace(/\/$/, "")

export class ApiClientError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiClientError"
    this.status = status
  }
}

/** Token da sessão (guardado no navegador). */
export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token)
    else window.localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* localStorage indisponível — sessão só dura a aba */
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  body?: unknown
  /** Envia os bytes crus (upload de arquivo) em vez de JSON. */
  raw?: BodyInit
  contentType?: string
  /** `false` desliga o header Authorization (rotas públicas). */
  auth?: boolean
  signal?: AbortSignal
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function messageFrom(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "message" in payload) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return fallback
}

/**
 * Requisições GET idênticas já em andamento são compartilhadas.
 *
 * Vários componentes montam no mesmo instante as mesmas rotas (o painel chega a
 * abrir 14 queries, e `tickets.list` / `auth/me` aparecem em mais de um lugar),
 * o que antes disparava uma requisição por assinante. Aqui a segunda chamada
 * recebe a MESMA promessa. O mapa é limpo assim que a requisição termina, então
 * o próximo poll continua indo ao servidor normalmente.
 */
const inflightGets = new Map<string, Promise<unknown>>()

/** Requisição à API. Lança `ApiClientError` em resposta de erro. */
export function apiFetch<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const method = options.method ?? "GET"
  // Só GET sem `signal` (cancelar um compartilhado cancelaria os outros) e sem
  // corpo cru pode ser dedupicado.
  if (method !== "GET" || options.signal || options.raw !== undefined) {
    return doFetch<T>(path, options)
  }

  const key = `${options.auth === false ? "public:" : "auth:"}${path}`
  const running = inflightGets.get(key)
  if (running) return running as Promise<T>

  const request = doFetch<T>(path, options).finally(() => {
    inflightGets.delete(key)
  })
  inflightGets.set(key, request)
  return request
}

/** Executa a requisição de fato (sem dedupe). */
async function doFetch<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {}
  if (options.auth !== false) {
    const token = getToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }

  let body: BodyInit | undefined
  if (options.raw !== undefined) {
    body = options.raw
    if (options.contentType) headers["Content-Type"] = options.contentType
  } else if (options.body !== undefined) {
    headers["Content-Type"] = "application/json"
    body = JSON.stringify(options.body)
  }

  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: options.method ?? "GET",
      headers,
      body,
      signal: options.signal,
    })
  } catch (error) {
    // Falha de rede (API fora do ar, URL errada, CORS): mensagem utilizável em
    // vez do "Failed to fetch" do navegador.
    throw new ApiClientError(
      0,
      `Não foi possível falar com a API (${API_URL || "mesma origem"}). ` +
        (error instanceof Error ? error.message : ""),
    )
  }

  const payload = await parseBody(response)
  if (!response.ok) {
    throw new ApiClientError(response.status, messageFrom(payload, `Erro ${response.status}`))
  }
  return payload as T
}
