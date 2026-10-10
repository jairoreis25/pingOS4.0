/**
 * Upload de imagens dos chamados.
 *
 * O corpo da requisição são os bytes crus do arquivo (sem multipart):
 *
 *   await fetch(`${API_URL}/api/uploads`, {
 *     method: "POST",
 *     headers: { Authorization: `Bearer ${token}` },
 *     body: file,                        // o próprio File/Blob
 *   });
 *
 * Regras de segurança (ver AGENTS.md §5):
 * - **exige sessão** no POST e no GET — antes o POST era anônimo (enchia o
 *   disco) e o arquivo era servido por `express.static` sem autorização;
 * - o tipo é decidido pelos **magic bytes**, nunca pelo `Content-Type` que o
 *   cliente declara;
 * - o nome é **gerado** (UUID v4) — o cliente não influencia o caminho;
 * - a leitura também passa por `GET /api/uploads/:filename`, com validação
 *   estrita do nome e `nosniff`.
 */

import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { Router } from "express"
import { asyncHandler, badRequest, notFound } from "../errors"
import { requireAuth } from "../permissions"

export const uploadsRouter = Router()

type ImageType = { ext: string; mime: string; matches: (buffer: Buffer) => boolean }

const IMAGE_TYPES: ImageType[] = [
  {
    ext: "png",
    mime: "image/png",
    matches: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: "jpg",
    mime: "image/jpeg",
    matches: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: "gif",
    mime: "image/gif",
    matches: (b) => {
      const header = b.subarray(0, 6).toString("ascii")
      return header === "GIF87a" || header === "GIF89a"
    },
  },
  {
    ext: "webp",
    mime: "image/webp",
    matches: (b) =>
      b.length > 12 &&
      b.subarray(0, 4).toString("ascii") === "RIFF" &&
      b.subarray(8, 12).toString("ascii") === "WEBP",
  },
]

/** Nome aceito na leitura: UUID v4 + extensão de imagem conhecida. */
const FILENAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
}

export function uploadDir(): string {
  return path.resolve(process.env.UPLOAD_DIR ?? path.join(process.cwd(), "uploads"))
}

function maxUploadBytes(): number {
  const parsed = Number.parseInt(process.env.UPLOAD_MAX_BYTES ?? "", 10)
  const fallback = 15 * 1024 * 1024
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function detectImageType(buffer: Buffer): ImageType | null {
  return IMAGE_TYPES.find((type) => type.matches(buffer)) ?? null
}

// ── POST /api/uploads — grava a imagem (somente usuário autenticado) ─────────
uploadsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    requireAuth(req)

    const chunks: Buffer[] = []
    let size = 0
    const limit = maxUploadBytes()

    await new Promise<void>((resolve, reject) => {
      req.on("data", (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) {
          reject(badRequest(`Arquivo muito grande (máximo ${Math.floor(limit / 1024 / 1024)} MB).`))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on("end", () => resolve())
      req.on("error", (error) => reject(error))
    })

    const buffer = Buffer.concat(chunks)
    if (buffer.length === 0) throw badRequest("Nenhum arquivo recebido.")

    const type = detectImageType(buffer)
    if (!type) {
      throw badRequest("O arquivo não é uma imagem PNG, JPG, WEBP ou GIF válida.")
    }

    const dir = uploadDir()
    fs.mkdirSync(dir, { recursive: true })
    const filename = `${randomUUID()}.${type.ext}`
    fs.writeFileSync(path.join(dir, filename), buffer)

    res.status(201).json({
      url: `/api/uploads/${filename}`,
      filename,
      size: buffer.length,
      contentType: type.mime,
    })
  }),
)

// ── GET /api/uploads/:filename — devolve a imagem (somente autenticado) ─────
uploadsRouter.get(
  "/:filename",
  asyncHandler(async (req, res) => {
    requireAuth(req)

    const filename = String(req.params.filename ?? "")
    if (!FILENAME_PATTERN.test(filename)) throw badRequest("Nome de arquivo inválido.")

    const dir = uploadDir()
    const absolute = path.resolve(dir, filename)
    // Defesa extra contra traversal: o arquivo resolvido precisa estar em dir.
    if (path.dirname(absolute) !== dir || !fs.existsSync(absolute)) {
      throw notFound("Imagem não encontrada.")
    }

    const extension = path.extname(filename).slice(1)
    res.setHeader("Content-Type", MIME_BY_EXT[extension] ?? "application/octet-stream")
    res.setHeader("X-Content-Type-Options", "nosniff")
    res.setHeader("Cache-Control", "private, max-age=604800")
    res.sendFile(absolute)
  }),
)
