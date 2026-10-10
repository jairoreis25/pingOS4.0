/**
 * Upload de imagens dos chamados — substitui o Convex storage.
 *
 * O frontend envia os bytes crus no corpo da requisição:
 *
 *   await fetch(`${API_URL}/uploads?filename=foto.jpg`, {
 *     method: "POST",
 *     headers: { "Content-Type": file.type, Authorization: `Bearer ${token}` },
 *     body: file,                       // o próprio File/Blob
 *   });
 *
 * O arquivo é gravado em UPLOAD_DIR e servido em <API_URL>/uploads/<nome>.
 * Aceita apenas imagens, com limite de tamanho (UPLOAD_MAX_BYTES, padrão 15 MB).
 * Não exige login porque o formulário público de abertura de chamado também
 * anexa imagem (mesmo comportamento de hoje).
 */

import fs from "node:fs";
import path from "node:path";
import { Router } from "express";
import { asyncHandler, badRequest } from "../errors";
import { newId } from "../../mysql/pool";

export const uploadsRouter = Router();

const EXTENSION_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

export function uploadDir(): string {
  return path.resolve(process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads"));
}

function maxUploadBytes(): number {
  const parsed = Number.parseInt(process.env.UPLOAD_MAX_BYTES ?? "", 10);
  const fallback = 15 * 1024 * 1024;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Nome de arquivo seguro (sem barra, sem ".."). */
function safeName(input: string | undefined): string {
  const base = path.basename(String(input ?? "")).replace(/[^a-zA-Z0-9._-]/g, "");
  return base.slice(0, 80);
}

// express.raw é montado aqui com o limite configurado.
uploadsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const limit = maxUploadBytes();

    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) {
          reject(badRequest(`Arquivo muito grande (máximo ${Math.floor(limit / 1024 / 1024)} MB).`));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => resolve());
      req.on("error", (error) => reject(error));
    });

    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) throw badRequest("Nenhum arquivo recebido.");

    const contentType = String(req.headers["content-type"] ?? "").split(";")[0].trim();
    const extension = EXTENSION_BY_TYPE[contentType];
    if (!extension) {
      throw badRequest("Envie uma imagem PNG, JPG, WEBP ou GIF.");
    }

    const dir = uploadDir();
    fs.mkdirSync(dir, { recursive: true });
    const requested = safeName(String(req.query.filename ?? ""));
    const filename = `${newId()}${requested ? `-${requested}` : ""}`.replace(
      new RegExp(`\\.${extension}$`, "i"),
      "",
    ) + `.${extension}`;

    fs.writeFileSync(path.join(dir, filename), buffer);

    res.status(201).json({
      url: `/uploads/${filename}`,
      filename,
      size: buffer.length,
      contentType,
    });
  }),
);
