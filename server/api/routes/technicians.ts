/**
 * Técnicos — espelha src/convex/technicians.ts.
 *
 * A listagem é pública no backend atual (o formulário público de abertura de
 * chamado e o seletor de responsável consultam os técnicos). Mantido igual para
 * não quebrar o fluxo existente.
 */

import { Router } from "express"
import { execute, newId, query, queryOne } from "../../mysql/pool"
import { asyncHandler, badRequest, notFound } from "../errors"
import { requirePermission } from "../permissions"
import { toPublicTechnician, type TechnicianRow } from "../types"

export const techniciansRouter = Router()

// ── GET /api/technicians ────────────────────────────────────────────────────
techniciansRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const rows = await query<TechnicianRow>("SELECT * FROM `technicians` ORDER BY `name` ASC")
    res.json(rows.map(toPublicTechnician))
  }),
)

// ── POST /api/technicians ───────────────────────────────────────────────────
techniciansRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage")
    const body = (req.body ?? {}) as Record<string, unknown>
    const name = String(body.name ?? "").trim()
    if (!name) throw badRequest("Nome obrigatório")

    const existing = await queryOne<{ id: string }>(
      "SELECT `id` FROM `technicians` WHERE `name` = ? LIMIT 1",
      [name],
    )
    if (existing) throw badRequest("Já existe um técnico com esse nome")

    const id = newId()
    await execute(
      "INSERT INTO `technicians` (`id`, `name`, `funcao`, `contato`, `active`, `created_at`) VALUES (?, ?, ?, ?, 1, ?)",
      [
        id,
        name,
        String(body.funcao ?? "").trim() || null,
        String(body.contato ?? "").trim() || null,
        Date.now(),
      ],
    )
    const created = await queryOne<TechnicianRow>("SELECT * FROM `technicians` WHERE `id` = ?", [
      id,
    ])
    res.status(201).json(created ? toPublicTechnician(created) : null)
  }),
)

// ── PATCH /api/technicians/:id — renomear / editar ──────────────────────────
techniciansRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage")
    const body = (req.body ?? {}) as Record<string, unknown>
    const tech = await queryOne<TechnicianRow>("SELECT * FROM `technicians` WHERE `id` = ?", [
      req.params.id,
    ])
    if (!tech) throw notFound("Técnico não encontrado")

    const name = String(body.name ?? tech.name).trim()
    if (!name) throw badRequest("Nome obrigatório")

    await execute(
      "UPDATE `technicians` SET `name` = ?, `funcao` = ?, `contato` = ? WHERE `id` = ?",
      [
        name,
        body.funcao !== undefined ? String(body.funcao).trim() || null : tech.funcao,
        body.contato !== undefined ? String(body.contato).trim() || null : tech.contato,
        tech.id,
      ],
    )
    res.json({ success: true })
  }),
)

// ── POST /api/technicians/:id/toggle — ativa/inativa ────────────────────────
techniciansRouter.post(
  "/:id/toggle",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage")
    const tech = await queryOne<TechnicianRow>("SELECT * FROM `technicians` WHERE `id` = ?", [
      req.params.id,
    ])
    if (!tech) throw notFound("Técnico não encontrado")
    await execute("UPDATE `technicians` SET `active` = ? WHERE `id` = ?", [
      tech.active ? 0 : 1,
      tech.id,
    ])
    res.json({ success: true, active: !tech.active })
  }),
)

// ── DELETE /api/technicians/:id ─────────────────────────────────────────────
techniciansRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    requirePermission(req, "settings.manage")
    // Desvincula dos chamados antes (o responsável deixa de existir).
    await execute(
      "UPDATE `tickets` SET `assignee_id` = NULL, `assignee_type` = NULL WHERE `assignee_id` = ?",
      [req.params.id],
    )
    const result = await execute("DELETE FROM `technicians` WHERE `id` = ?", [req.params.id])
    if (result.affectedRows === 0) throw notFound("Técnico não encontrado")
    res.json({ success: true })
  }),
)
