import { useState } from "react";
import { useAction, useQuery } from "@/lib/backend/react";
import { api } from "@/lib/backend/api";
import type { Id } from "@/lib/backend/types";
import { API_URL, getToken } from "@/lib/mysql-api";
import { useAuth } from "@/hooks/use-auth";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DatabaseBackup,
  Download,
  History,
  Loader2,
  RotateCcw,
  Upload,
} from "lucide-react";

/** Extrai a mensagem legível de um corpo de erro da API. */
function serverErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const message = (body as { message?: unknown }).message;
  return typeof message === "string" ? message : undefined;
}

const ACTION_LABELS: Record<string, string> = {
  create: "Backup criado",
  download: "Download",
  upload: "Upload",
  restore: "Restauração",
  error: "Erro",
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function BackupRestoreDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const data = useQuery(api.backups.list);
  const createBackup = useAction(api.backups.create);
  const restoreBackup = useAction(api.backups.restore);
  const { signOut } = useAuth();

  const [generating, setGenerating] = useState(false);
  const [downloading, setDownloading] = useState<Id<"backups"> | null>(null);
  const [restoringNow, setRestoringNow] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState<{
    id: Id<"backups">;
    filename: string;
  } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [confirmUpload, setConfirmUpload] = useState(false);

  const backups = data?.backups ?? [];
  const logs = data?.logs ?? [];

  /** Token de sessão para chamadas HTTP autenticadas (download/upload).
   *  É o mesmo token guardado pelo login (src/lib/mysql-api.ts). */
  async function authToken(): Promise<string> {
    const token = getToken();
    if (!token) throw new Error("Sessão expirada. Faça login novamente.");
    return token;
  }

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const b = await createBackup();
      toast.success(`Backup criado: ${b.filename}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao gerar backup.");
    } finally {
      setGenerating(false);
    }
  };

  const handleDownload = async (id: Id<"backups">, filename: string) => {
    setDownloading(id);
    try {
      const res = await fetch(
        `${API_URL}/api/backups/${encodeURIComponent(String(id))}/download`,
        { headers: { Authorization: `Bearer ${await authToken()}` } },
      );
      if (!res.ok) {
        throw new Error(
          serverErrorMessage(await res.json().catch(() => null)) ?? "Falha ao baixar o backup.",
        );
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Backup baixado!");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao baixar o backup.");
    } finally {
      setDownloading(null);
    }
  };

  const handleRestoreConfirm = async () => {
    if (!confirmRestore) return;
    const { id } = confirmRestore;
    setConfirmRestore(null);
    setRestoringNow(true);
    try {
      const result = await restoreBackup({ backupId: id });
      toast.success(
        `Restauração concluída! ${result.entries} registros em ${result.tables} tabelas.`,
      );
      // Sessões foram apagadas na restauração — exige novo login.
      await signOut();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao restaurar o backup.");
      setRestoringNow(false);
    }
  };

  const handleUploadRestore = async () => {
    if (!file) return;
    setConfirmUpload(false);
    setRestoringNow(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${API_URL}/api/backups/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await authToken()}` },
        body: form,
      });
      const json = (await res.json().catch(() => null)) as {
        backupId?: string;
        message?: string;
      } | null;
      if (!res.ok || !json?.backupId) {
        throw new Error(
          serverErrorMessage(json) ?? json?.message ?? "Falha no upload do backup.",
        );
      }
      toast.info("Backup enviado. Restaurando dados...");
      const result = await restoreBackup({
        backupId: json.backupId as Id<"backups">,
      });
      toast.success(
        `Restauração concluída! ${result.entries} registros em ${result.tables} tabelas.`,
      );
      setFile(null);
      // Sessões foram apagadas na restauração — exige novo login.
      await signOut();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao restaurar o backup.");
      setRestoringNow(false);
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-2xl max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Backup e Restauração</DialogTitle>
            <DialogDescription>
              Gere um backup do banco de dados, baixe para o seu computador ou
              restaure o sistema a partir de um backup salvo ou enviado.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {/* Gerar backup */}
            <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-muted/20 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">Backup completo do banco</p>
                <p className="mt-0.5 text-xs text-muted-foreground/70">
                  Exporta todas as tabelas (chamados, usuários, permissões,
                  notificações...) em um arquivo .json.
                </p>
              </div>
              <Button
                onClick={handleGenerate}
                disabled={generating}
                className="gap-1.5 sm:flex-none"
              >
                {generating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <DatabaseBackup className="size-4" />
                )}
                {generating ? "Gerando..." : "Gerar Backup Agora"}
              </Button>
            </div>

            {/* Lista de backups */}
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Backups disponíveis
              </p>
              {backups.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/60 px-4 py-6 text-center text-xs text-muted-foreground/70">
                  Nenhum backup gerado ainda. Clique em "Gerar Backup Agora"
                  para criar o primeiro.
                </p>
              ) : (
                <div className="divide-y divide-border/40 rounded-xl border border-border/60">
                  {backups.map((b) => (
                    <div
                      key={b._id}
                      className="flex flex-wrap items-center gap-2 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {b.filename}
                        </p>
                        <p className="text-[11px] text-muted-foreground/70">
                          {formatDate(b.createdAt)} · {formatBytes(b.size)}
                          {b.restoredAt
                            ? ` · restaurado em ${formatDate(b.restoredAt)}`
                            : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5"
                          onClick={() => handleDownload(b._id, b.filename)}
                          disabled={downloading === b._id}
                        >
                          {downloading === b._id ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Download className="size-3.5" />
                          )}
                          Baixar
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive"
                          onClick={() =>
                            setConfirmRestore({
                              id: b._id,
                              filename: b.filename,
                            })
                          }
                        >
                          <RotateCcw className="size-3.5" />
                          Restaurar
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Upload de backup */}
            <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
              <div className="flex items-center gap-2">
                <Upload className="size-4 text-muted-foreground" />
                <p className="text-sm font-medium">
                  Restaurar a partir de um arquivo do computador
                </p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground/70">
                Selecione um backup .json gerado pelo PingOS. O arquivo é
                enviado ao servidor e restaurado em seguida.
              </p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  type="file"
                  accept=".json,application/json"
                  className="flex-1 bg-background"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <Button
                  variant="outline"
                  className="gap-1.5 border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive sm:flex-none"
                  onClick={() =>
                    file
                      ? setConfirmUpload(true)
                      : toast.error("Selecione um arquivo de backup.")
                  }
                >
                  <RotateCcw className="size-4" />
                  Restaurar Backup Enviado
                </Button>
              </div>
            </div>

            {/* Histórico de auditoria */}
            {logs.length > 0 && (
              <div className="space-y-2">
                <p className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  <History className="size-3.5" />
                  Histórico
                </p>
                <div className="divide-y divide-border/40 rounded-xl border border-border/60">
                  {logs.map((l) => (
                    <div
                      key={l._id}
                      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-xs"
                    >
                      <span className="font-medium text-foreground">
                        {ACTION_LABELS[l.action] ?? l.action}
                      </span>
                      {l.filename && (
                        <span className="max-w-[40%] truncate text-muted-foreground">
                          {l.filename}
                        </span>
                      )}
                      {l.user && (
                        <span className="shrink-0 text-[11px] text-muted-foreground/60">
                          por {l.user}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/60">
                        {formatDate(l.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Confirmação: restaurar backup existente */}
      <AlertDialog
        open={!!confirmRestore}
        onOpenChange={(o) => !o && setConfirmRestore(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restaurar backup?</AlertDialogTitle>
            <AlertDialogDescription>
              Isto irá apagar todos os dados atuais e substituí-los pelo backup{" "}
              <span className="font-semibold text-foreground">
                {confirmRestore?.filename}
              </span>
              . Deseja continuar?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoringNow}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleRestoreConfirm}
              disabled={restoringNow}
            >
              {restoringNow ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              {restoringNow ? "Restaurando..." : "Sim, restaurar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Confirmação: restaurar backup enviado */}
      <AlertDialog
        open={confirmUpload}
        onOpenChange={(o) => !o && setConfirmUpload(false)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restaurar backup enviado?</AlertDialogTitle>
            <AlertDialogDescription>
              Isto irá apagar todos os dados atuais e substituí-los pelo backup{" "}
              <span className="font-semibold text-foreground">
                {file?.name}
              </span>
              . Deseja continuar?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoringNow}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={handleUploadRestore}
              disabled={restoringNow}
            >
              {restoringNow ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RotateCcw className="size-4" />
              )}
              {restoringNow ? "Restaurando..." : "Sim, restaurar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}