/**
 * Backup e restauração (painel do Administrador).
 *
 *   GET  /api/backups                  → histórico de backups + auditoria
 *   POST /api/backups                  → gera um backup agora (arquivo em BACKUP_DIR)
 *   GET  /api/backups/:id/download     → baixa o arquivo do backup
 *   POST /api/backups/:id/restore      → restaura o banco a partir do arquivo
 *   POST /api/backups/upload           → recebe um .json do computador e restaura
 *
 * Todas as rotas exigem o papel de **Administrador** (`requireAdmin`).
 *
 * A restauração é destrutiva: antes de tocar no banco o servidor gera um
 * **backup de segurança** automático do estado atual (desligue com
 * `BACKUP_SAFETY=false`). O painel já mostra o modal de confirmação antes de
 * chamar esta rota.
 *
 * Formato do arquivo, transação e auditoria: veja `server/api/backup.ts`.
 */

import fs from "node:fs";
import multer from "multer";
import { Router, type NextFunction, type Request, type Response } from "express";
import { query } from "../../mysql/pool";
import { asyncHandler, badRequest, notFound } from "../errors";
import { requireAdmin } from "../permissions";
import {
  actorName,
  backupFilePath,
  createBackup,
  ensureBackupDir,
  findBackup,
  logBackup,
  markRestored,
  maxBackupBytes,
  readBackupFile,
  registerUploadedBackup,
  restoreBackupFile,
  safeBackupFileName,
  type BackupRow,
} from "../backup";

export const backupsRouter = Router();

interface BackupLogRow {
  id: string;
  action: string;
  filename: string | null;
  detail: string | null;
  user_name: string | null;
  created_at: number;
}

/** Upload do arquivo de backup (memória → o disco só na validação da rota). */
const uploadBackupFile = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, done) => {
      try {
        done(null, ensureBackupDir());
      } catch (error) {
        done(error as Error, "");
      }
    },
    filename: (_req, file, done) => done(null, safeBackupFileName(file.originalname)),
  }),
  limits: { fileSize: maxBackupBytes(), files: 1 },
}).single("file");

/** Converte os erros do multer em mensagens claras para o painel. */
function receiveUpload(req: Request, res: Response, next: NextFunction): void {
  uploadBackupFile(req, res, (error: unknown) => {
    if (!error) {
      next();
      return;
    }
    if (error instanceof multer.MulterError) {
      next(
        badRequest(
          error.code === "LIMIT_FILE_SIZE"
            ? `Arquivo maior que o limite (${Math.floor(maxBackupBytes() / 1024 / 1024)} MB).`
            : `Falha no upload: ${error.message}`,
        ),
      );
      return;
    }
    next(badRequest(error instanceof Error ? error.message : "Falha no upload do backup."));
  });
}

// ── GET /api/backups ────────────────────────────────────────────────────────
// Devolve `{ backups, logs }` — o mesmo formato que o painel já consumia.
backupsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    requireAdmin(req);
    const [rows, logRows] = await Promise.all([
      query<BackupRow>("SELECT * FROM `backups` ORDER BY `created_at` DESC LIMIT 100"),
      query<BackupLogRow>("SELECT * FROM `backup_logs` ORDER BY `created_at` DESC LIMIT 50"),
    ]);

    res.json({
      backups: rows.map((row) => ({
        _id: row.id,
        _creationTime: row.created_at,
        filename: row.filename,
        size: Number(row.size ?? 0),
        createdAt: row.created_at,
        createdBy: row.created_by ?? null,
        restoredAt: row.restored_at ?? null,
        restoredBy: row.restored_by ?? null,
        // Avisa o painel quando o arquivo sumiu do servidor.
        missing: !fs.existsSync(backupFilePath(row)),
      })),
      logs: logRows.map((row) => ({
        _id: row.id,
        action: row.action,
        filename: row.filename ?? null,
        detail: row.detail ?? null,
        user: row.user_name ?? null,
        createdAt: row.created_at,
      })),
    });
  }),
);

// ── POST /api/backups — gerar backup agora ──────────────────────────────────
backupsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const ctx = requireAdmin(req);
    const actor = actorName(ctx.user);
    try {
      const result = await createBackup({ createdBy: actor });
      console.log(
        `[backup] ${actor} gerou ${result.filename} (${result.entries} registros, ${result.size} bytes)`,
      );
      res.status(201).json({
        success: true,
        backupId: result.id,
        filename: result.filename,
        size: result.size,
        tables: result.tables,
        entries: result.entries,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logBackup("error", null, `falha ao gerar backup: ${message}`, actor);
      throw error;
    }
  }),
);

// ── POST /api/backups/upload — arquivo do computador ────────────────────────
// Só guarda o arquivo e registra no histórico; a restauração é uma chamada
// separada (`POST /api/backups/:id/restore`), como o painel já faz.
backupsRouter.post(
  "/upload",
  receiveUpload,
  asyncHandler(async (req, res) => {
    const ctx = requireAdmin(req);
    const actor = actorName(ctx.user);
    const file = req.file;

    if (!file) throw badRequest("Selecione um arquivo de backup.");

    try {
      // Valida o conteúdo antes de registrar (arquivo errado não entra na lista).
      readBackupFile(file.path);
      const registered = await registerUploadedBackup({
        filename: safeBackupFileName(file.originalname),
        filePath: file.path,
        createdBy: actor,
      });
      // `backupId` é o que o painel usa para chamar a restauração em seguida.
      res.status(201).json({
        success: true,
        backupId: registered.id,
        filename: registered.filename,
        size: registered.size,
      });
    } catch (error) {
      // Remove o arquivo inválido para não sujar a pasta de backups.
      fs.rm(file.path, { force: true }, () => {});
      const message = error instanceof Error ? error.message : String(error);
      await logBackup("error", file.originalname ?? null, `upload rejeitado: ${message}`, actor);
      throw error;
    }
  }),
);

// ── GET /api/backups/:id/download ───────────────────────────────────────────
backupsRouter.get(
  "/:id/download",
  asyncHandler(async (req, res) => {
    const ctx = requireAdmin(req);
    const row = await findBackup(String(req.params.id));
    if (!row) throw notFound("Backup não encontrado.");

    const filePath = backupFilePath(row);
    if (!fs.existsSync(filePath)) {
      throw notFound("O arquivo deste backup não está mais no servidor.");
    }

    await logBackup("download", row.filename, null, actorName(ctx.user));
    res.download(filePath, row.filename);
  }),
);

// ── POST /api/backups/:id/restore ───────────────────────────────────────────
backupsRouter.post(
  "/:id/restore",
  asyncHandler(async (req, res) => {
    const ctx = requireAdmin(req);
    const actor = actorName(ctx.user);

    const row = await findBackup(String(req.params.id));
    if (!row) throw notFound("Backup não encontrado.");

    const filePath = backupFilePath(row);
    if (!fs.existsSync(filePath)) {
      throw notFound("O arquivo deste backup não está mais no servidor.");
    }

    try {
      // Backup de segurança do estado atual (recomendado antes de sobrescrever).
      if (process.env.BACKUP_SAFETY !== "false") {
        const safety = await createBackup({
          createdBy: actor,
          logDetail: `backup de segurança automático antes de restaurar ${row.filename}`,
        });
        console.log(`[backup] backup de segurança criado: ${safety.filename}`);
      }

      const result = await restoreBackupFile(filePath, actor);
      await markRestored(row.id, actor);
      await logBackup(
        "restore",
        row.filename,
        `${result.entries} registros em ${result.tables} tabelas`,
        actor,
      );
      console.log(
        `[backup] ${actor} restaurou ${row.filename} (${result.entries} registros em ${result.tables} tabelas)`,
      );

      res.json({ success: true, tables: result.tables, entries: result.entries });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await logBackup("error", row.filename, `falha na restauração: ${message}`, actor);
      throw error;
    }
  }),
);
