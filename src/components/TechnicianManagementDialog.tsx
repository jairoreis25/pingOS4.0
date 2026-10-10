import { useState } from "react";
import { useQuery, useMutation } from "@/lib/backend/react";
import { api } from "@/lib/backend/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Loader2 } from "lucide-react";
import type { Id } from "@/lib/backend/types";

export default function TechnicianManagementDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const technicians = useQuery(api.technicians.list, open ? {} : "skip");
  const createTech = useMutation(api.technicians.create);
  const renameTech = useMutation(api.technicians.rename);
  const toggleActive = useMutation(api.technicians.toggleActive);
  const removeTech = useMutation(api.technicians.remove);

  const [name, setName] = useState("");
  const [funcao, setFuncao] = useState("");
  const [contato, setContato] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<Id<"technicians"> | null>(null);
  const [editName, setEditName] = useState("");
  const [editFuncao, setEditFuncao] = useState("");
  const [editContato, setEditContato] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Id<"technicians"> | null>(null);
  const [deleting, setDeleting] = useState(false);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setAdding(true);
    try {
      await createTech({
        name: name.trim(),
        funcao: funcao.trim() || undefined,
        contato: contato.trim() || undefined,
      });
      toast.success("Técnico cadastrado!");
      setName("");
      setFuncao("");
      setContato("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao cadastrar técnico.");
    } finally {
      setAdding(false);
    }
  };

  const startEdit = (t: {
    _id: Id<"technicians">;
    name: string;
    funcao?: string;
    contato?: string;
  }) => {
    setEditingId(t._id);
    setEditName(t.name);
    setEditFuncao(t.funcao ?? "");
    setEditContato(t.contato ?? "");
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editName.trim()) return;
    setSavingEdit(true);
    try {
      await renameTech({
        id: editingId,
        name: editName.trim(),
        funcao: editFuncao.trim() || undefined,
        contato: editContato.trim() || undefined,
      });
      toast.success("Técnico atualizado!");
      setEditingId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao atualizar.");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleToggle = async (id: Id<"technicians">) => {
    try {
      await toggleActive({ id });
    } catch {
      toast.error("Erro ao alterar status.");
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await removeTech({ id: deleteTarget });
      toast.success("Técnico excluído.");
      setDeleteTarget(null);
    } catch {
      toast.error("Erro ao excluir técnico.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Técnicos</DialogTitle>
          <DialogDescription>
            Cadastre os técnicos que podem ser atribuídos aos chamados no campo "Atribuído a".
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleAdd} className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="tech-name" className="text-xs text-muted-foreground">Nome</Label>
              <Input
                id="tech-name"
                placeholder="Ex: João Silva"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tech-funcao" className="text-xs text-muted-foreground">Função (opcional)</Label>
              <Input
                id="tech-funcao"
                placeholder="Ex: Suporte técnico"
                value={funcao}
                onChange={(e) => setFuncao(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tech-contato" className="text-xs text-muted-foreground">
              Contato (WhatsApp) — opcional
            </Label>
            <Input
              id="tech-contato"
              placeholder="(91) 99999-9999"
              value={contato}
              onChange={(e) => setContato(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Usado para enviar alertas de inatividade por WhatsApp ao
              responsável pelo chamado.
            </p>
          </div>
          <Button type="submit" size="sm" className="w-full gap-1.5" disabled={adding || !name.trim()}>
            {adding ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            Cadastrar técnico
          </Button>
        </form>

        <div className="max-h-72 overflow-y-auto space-y-1.5 -mx-1 px-1">
          {technicians === undefined && (
            <p className="text-sm text-muted-foreground py-4 text-center">Carregando…</p>
          )}
          {technicians?.length === 0 && (
            <p className="text-sm text-muted-foreground py-4 text-center">
              Nenhum técnico cadastrado ainda.
            </p>
          )}
          {technicians?.map((t) => (
            <div
              key={t._id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2"
            >
              {editingId === t._id ? (
                <>
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="h-8 text-sm min-w-[110px] flex-1"
                    placeholder="Nome"
                  />
                  <Input
                    value={editFuncao}
                    onChange={(e) => setEditFuncao(e.target.value)}
                    className="h-8 text-sm min-w-[110px] flex-1"
                    placeholder="Função"
                  />
                  <Input
                    value={editContato}
                    onChange={(e) => setEditContato(e.target.value)}
                    className="h-8 text-sm min-w-[110px] flex-1"
                    placeholder="Contato (WhatsApp)"
                  />
                  <Button size="sm" className="h-8" onClick={handleSaveEdit} disabled={savingEdit || !editName.trim()}>
                    {savingEdit ? <Loader2 className="size-3.5 animate-spin" /> : "Salvar"}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8" onClick={() => setEditingId(null)}>
                    Cancelar
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{t.name}</p>
                    {t.funcao && (
                      <p className="text-xs text-muted-foreground truncate">{t.funcao}</p>
                    )}
                    {t.contato && (
                      <p className="text-xs text-muted-foreground truncate">📱 {t.contato}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground mr-1 hidden sm:inline">
                      {t.active ? "Ativo" : "Inativo"}
                    </span>
                    <Switch
                      checked={t.active}
                      onCheckedChange={() => handleToggle(t._id)}
                      aria-label={t.active ? "Desativar" : "Ativar"}
                    />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={() => startEdit(t)}
                      title="Editar"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-destructive"
                      onClick={() => setDeleteTarget(t._id)}
                      title="Excluir"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </DialogContent>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir técnico?</AlertDialogTitle>
            <AlertDialogDescription>
              O técnico será removido da lista. Chamados que estiverem atribuídos a ele continuarão
              existindo, mas ficarão sem responsável atribuído.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleDelete();
              }}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting ? "Excluindo…" : "Excluir"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
