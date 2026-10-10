/**
 * Produtos e Serviços — catálogo simples (nome + valor) da tela de Configurações.
 *
 *   GET    /api/products         lista o catálogo
 *   POST   /api/products         cadastra
 *   PATCH  /api/products/:id     edita nome/tipo/valor
 *   DELETE /api/products/:id     exclui
 *
 * A leitura é liberada para qualquer usuário logado: o catálogo alimenta o menu
 * "/" do campo Solução do chamado, usado por quem tem `tickets.edit`. Já a
 * escrita exige `settings.manage` (a permissão que libera as Configurações).
 *
 * Cada item é um **produto** (peça/equipamento) ou um **serviço** (mão de obra);
 * o tipo é validado pelo normalizador compartilhado de `src/lib/products`.
 */

import { Router } from "express";
import {
  DEFAULT_PRODUCT_SERVICE_TYPE,
  normalizeProductServiceType,
  type ProductServiceType,
} from "../../../src/lib/products";
import { execute, newId, query, queryOne } from "../../mysql/pool";
import { asyncHandler, badRequest, notFound } from "../errors";
import { requireAuth, requirePermission } from "../permissions";
import { toPublicProductService, type ProductServiceRow } from "../types";

export const productsRouter = Router();

/** Tipo do item: aceita "produto"/"serviço" (com ou sem acento) e recusa o resto. */
function parseItemType(value: unknown): ProductServiceType {
  const type = normalizeProductServiceType(value, null);
  if (!type) {
    throw badRequest('Tipo inválido. Use "produto" ou "servico".');
  }
  return type;
}

/** Valor em reais: aceita `12,5`, `12.50` ou `1234`. Nunca negativo. */
function parsePrice(value: unknown): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(n) || n < 0) {
    throw badRequest("Valor inválido. Informe um número maior ou igual a zero.");
  }
  // Duas casas (a coluna é DECIMAL(12,2)).
  return Math.round(n * 100) / 100;
}

// ── GET /api/products ───────────────────────────────────────────────────────
productsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    requireAuth(req);
    const rows = await query<ProductServiceRow>(
      "SELECT * FROM `products_services` ORDER BY `name` ASC",
    );
    res.json(rows.map(toPublicProductService));
  }),
);

// ── POST /api/products ──────────────────────────────────────────────────────
productsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = String(body.name ?? "").trim();
    if (!name) throw badRequest("Nome obrigatório");
    const price = parsePrice(body.price ?? body.valor);
    const itemType = parseItemType(body.itemType ?? body.type);

    const existing = await queryOne<{ id: string }>(
      "SELECT `id` FROM `products_services` WHERE `name` = ? LIMIT 1",
      [name],
    );
    if (existing) throw badRequest("Já existe um produto/serviço com esse nome");

    const id = newId();
    const now = Date.now();
    await execute(
      "INSERT INTO `products_services` (`id`, `name`, `item_type`, `price`, `active`, `created_at`, `updated_at`) VALUES (?, ?, ?, ?, 1, ?, ?)",
      [id, name, itemType, price, now, now],
    );
    const created = await queryOne<ProductServiceRow>(
      "SELECT * FROM `products_services` WHERE `id` = ?",
      [id],
    );
    res.status(201).json(created ? toPublicProductService(created) : null);
  }),
);

// ── PATCH /api/products/:id ─────────────────────────────────────────────────
productsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const item = await queryOne<ProductServiceRow>(
      "SELECT * FROM `products_services` WHERE `id` = ?",
      [req.params.id],
    );
    if (!item) throw notFound("Produto/serviço não encontrado");

    const name = String(body.name ?? item.name).trim();
    if (!name) throw badRequest("Nome obrigatório");

    const duplicated = await queryOne<{ id: string }>(
      "SELECT `id` FROM `products_services` WHERE `name` = ? AND `id` <> ? LIMIT 1",
      [name, item.id],
    );
    if (duplicated) throw badRequest("Já existe um produto/serviço com esse nome");

    const price =
      body.price !== undefined || body.valor !== undefined
        ? parsePrice(body.price ?? body.valor)
        : toPublicProductService(item).price;

    // Sem tipo no corpo, o item mantém o que já tem (o menu "/" só manda o valor).
    const itemType =
      body.itemType === undefined && body.type === undefined
        ? (normalizeProductServiceType(item.item_type) ??
          DEFAULT_PRODUCT_SERVICE_TYPE)
        : parseItemType(body.itemType ?? body.type);

    await execute(
      "UPDATE `products_services` SET `name` = ?, `item_type` = ?, `price` = ?, `updated_at` = ? WHERE `id` = ?",
      [name, itemType, price, Date.now(), item.id],
    );
    res.json({ success: true });
  }),
);

// ── DELETE /api/products/:id ────────────────────────────────────────────────
productsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage");
    const result = await execute("DELETE FROM `products_services` WHERE `id` = ?", [
      req.params.id,
    ]);
    if (result.affectedRows === 0) throw notFound("Produto/serviço não encontrado");
    res.json({ success: true });
  }),
);
