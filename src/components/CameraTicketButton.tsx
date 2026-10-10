/**
 * "Nova OS por Foto".
 *
 * Abre a câmera traseira do smartphone (`capture="environment"`), comprime a
 * foto no próprio navegador (máx. 1200px, JPEG 70%, < 2 MB) e envia para
 * `POST /api/chamados/ocr`. A API lê a O.S. com o modelo de **visão** configurado
 * em Configurações → Bot Ping IA e abre o chamado já preenchido (título =
 * Descrição da O.S., descrição = PROBLEMAS, solicitante/telefone = cliente).
 *
 * O nome/contato do usuário logado (`user?.name` / `user?.email`, passados pelo
 * `Dashboard`) só entram como reserva quando a foto não traz o telefone.
 */
import { useRef, useState } from "react";
import { Camera } from "lucide-react";
import { toast } from "sonner";
import { ApiClientError, apiFetch } from "@/lib/mysql-api";
import { handleAuthError, notifyChange } from "@/lib/backend/session";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Lado maior permitido na imagem final. */
const MAX_DIMENSION = 1200;
/** Qualidade JPEG do primeiro passe. */
const JPEG_QUALITY = 0.7;
/** Teto do arquivo aceito pelo backend (o `MAX_UPLOAD_BYTES` da rota). */
const MAX_BYTES = 2 * 1024 * 1024;

export interface CameraTicketButtonProps {
  /** Nome do solicitante (normalmente `user?.name`) — reserva para a foto. */
  guestName?: string;
  /** Contato do solicitante (normalmente `user?.email`) — reserva para a foto. */
  guestContact?: string;
  /** Classes extras aplicadas ao botão (o Dashboard passa as dele). */
  className?: string;
  /** Chamado após o sucesso, com o número gerado pelo backend. */
  onCreated?: (number: number) => void;
}

/** Campos da O.S. que a IA devolve. */
interface DadosOs {
  numero_os: string | null;
  solicitante: string | null;
  fone: string | null;
  descricao: string | null;
  problemas: string | null;
}

/** Resposta de `POST /api/chamados/ocr`. */
interface OcrTicketResult {
  ticketId: string;
  id: string;
  number: number;
  dados_extraidos: DadosOs;
  categoria_detectada: string | null;
}

// ── Compressão (helper isolado, sem dependências) ────────────────────────────

/** Carrega o arquivo num `HTMLImageElement` (libera o object URL no fim). */
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Não foi possível ler a imagem."));
    };
    img.src = url;
  });
}

/** Redimensiona para `maxDim` no lado maior e devolve um data URL JPEG. */
function drawToDataUrl(img: HTMLImageElement, maxDim: number, quality: number): string {
  let { width, height } = img;
  if (width > maxDim || height > maxDim) {
    if (width > height) {
      height = Math.round((height / width) * maxDim);
      width = maxDim;
    } else {
      width = Math.round((width / height) * maxDim);
      height = maxDim;
    }
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas não suportado neste navegador.");
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

/** Estima os bytes do data URL a partir do tamanho do base64. */
function dataUrlBytes(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

/** Converte o data URL comprimido de volta em Blob (para o multipart). */
function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(",");
  const mime = /:(.*?);/.exec(header ?? "")?.[1] ?? "image/jpeg";
  const binary = atob(base64 ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Comprime a foto para data URL (`data:image/jpeg;base64,...`).
 *
 * O primeiro passe já é o pedido (1200px / 70%). Só se a foto ainda passar de
 * 2 MB é que os passes seguintes reduzem qualidade e resolução — o backend
 * recusa arquivos maiores que isso.
 */
export async function compressImageForUpload(file: File): Promise<string> {
  const img = await loadImage(file);
  const passes: Array<{ dim: number; quality: number }> = [
    { dim: MAX_DIMENSION, quality: JPEG_QUALITY },
    { dim: MAX_DIMENSION, quality: 0.55 },
    { dim: 1000, quality: 0.5 },
    { dim: 800, quality: 0.45 },
    { dim: 640, quality: 0.4 },
  ];

  let result = "";
  for (const pass of passes) {
    result = drawToDataUrl(img, pass.dim, pass.quality);
    if (dataUrlBytes(result) <= MAX_BYTES) return result;
  }
  throw new Error("Imagem muito grande — tente novamente com mais luz ou mais perto.");
}

// ── Componente ───────────────────────────────────────────────────────────────

export default function CameraTicketButton({
  guestName,
  guestContact,
  className,
  onCreated,
}: CameraTicketButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);

  const handleFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Permite escolher a MESMA foto novamente depois.
    if (inputRef.current) inputRef.current.value = "";
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Apenas imagens são aceitas.");
      return;
    }

    setLoading(true);
    try {
      const dataUrl = await compressImageForUpload(file);
      const form = new FormData();
      form.append("imagem", dataUrlToBlob(dataUrl), "os.jpg");
      // Reserva: só é usada se a foto não trouxer o telefone do solicitante.
      if (guestName?.trim()) form.append("guestName", guestName.trim());
      if (guestContact?.trim()) form.append("guestContact", guestContact.trim());

      const created = await apiFetch<OcrTicketResult>("/api/chamados/ocr", {
        method: "POST",
        raw: form,
      });

      // O Kanban é reativo por poll; avisa as queries montadas na hora.
      notifyChange();

      const solicitante = created.dados_extraidos?.solicitante?.trim();
      toast.success(`OS #${created.number} criada a partir da foto!`, {
        description: solicitante ? `Solicitante: ${solicitante}` : undefined,
      });
      onCreated?.(created.number);
    } catch (error) {
      handleAuthError(error);
      toast.error(
        error instanceof ApiClientError
          ? error.message
          : error instanceof Error && error.message.includes("muito grande")
            ? error.message
            : "Erro ao ler a foto. Tente novamente.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={handleFile}
      />
      <Button
        type="button"
        variant="outline"
        onClick={() => inputRef.current?.click()}
        disabled={loading}
        title="Tirar foto de uma O.S. e abrir o chamado"
        className={cn(
          "shrink-0 gap-1.5 rounded-lg border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 transition-all duration-150 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800",
          className,
        )}
      >
        <Camera className="size-4" strokeWidth={1.5} />
        <span className="hidden sm:inline">
          {loading ? "Lendo O.S...." : "Nova OS por Foto"}
        </span>
      </Button>
    </>
  );
}
