/**
 * Erros da API e utilitários de rota.
 *
 * As mensagens seguem as mesmas do backend Convex ("Sem permissão...",
 * "Chamado não encontrado."), para o frontend exibir exatamente o que já exibe.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const badRequest = (message: string) => new ApiError(400, message);
export const unauthorized = (message = "Não autenticado. Faça login para continuar.") =>
  new ApiError(401, message);
export const forbidden = (message = "Sem permissão para realizar esta ação.") =>
  new ApiError(403, message);
export const notFound = (message = "Registro não encontrado.") => new ApiError(404, message);

/** Envolve um handler async para encaminhar erros ao middleware de erro. */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Middleware de erro única — devolve sempre `{ message }` (como o Convex). */
export function errorMiddleware(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (error instanceof ApiError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  // Erros de duplicidade do MySQL viram uma mensagem amigável.
  const code = (error as { code?: string })?.code;
  if (code === "ER_DUP_ENTRY") {
    res.status(409).json({ message: "Já existe um registro com esses dados." });
    return;
  }
  const message = error instanceof Error ? error.message : "Erro interno do servidor.";
  console.error("[mysql-api] erro não tratado:", error);
  res.status(500).json({ message });
}
