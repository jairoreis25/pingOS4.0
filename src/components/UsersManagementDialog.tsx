import { useCallback, useEffect, useMemo, useState } from "react"
import { useMutation, useQuery } from "@/lib/backend/react"
import { api } from "@/lib/backend/api"
import type { Id } from "@/lib/backend/types"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { toast } from "sonner"
import { usePermissions } from "@/hooks/use-permissions"
import {
  PERMISSION_GROUPS,
  TICKET_STATUSES,
  DEFAULT_USER_PERMISSIONS,
  ADMIN_ROLE,
  DEFAULT_ROLE,
  ALL_PERMISSIONS,
  hasStatusViewRestriction,
  hasStatusEditRestriction,
  hasEditAssignmentRestriction,
  hasViewAssignmentRestriction,
} from "@/lib/permissions"
import {
  Plus,
  Search,
  KeyRound,
  Trash2,
  Pencil,
  Shield,
  ShieldCheck,
  Users,
  UserCog,
  ArrowLeft,
  Lock,
  UserPlus,
  Check,
} from "lucide-react"

function getInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("")
}

/** Resumo amigável das permissões de um papel para exibição em cards. */
type RoleSummary = { chips: string[]; notes: string[] }

const STATUS_LABELS: Record<string, string> = {
  aberto: "Aberto",
  em_andamento: "Em Andamento",
  aguardando: "Aguardando",
  resolvido: "Resolvido",
  fechado: "Fechado",
}

const ROLE_AVATAR_STYLES = [
  "bg-primary/10 text-primary border-primary/20",
  "bg-sky-100 text-sky-700 border-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:border-sky-900/60",
  "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-900/60",
  "bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-900/60",
  "bg-violet-100 text-violet-700 border-violet-200 dark:bg-violet-950/50 dark:text-violet-300 dark:border-violet-900/60",
  "bg-rose-100 text-rose-700 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-900/60",
]

/** Cor estável por nome do papel (admin sempre usa a cor de destaque). */
function roleAvatarStyle(roleName: string, isAdminRole: boolean): string {
  if (isAdminRole) return ROLE_AVATAR_STYLES[0]
  let hash = 0
  for (const ch of roleName) hash = (hash * 31 + ch.charCodeAt(0)) % 997
  return ROLE_AVATAR_STYLES[1 + (hash % (ROLE_AVATAR_STYLES.length - 1))]
}

/** Converte a lista crua de permissões em capacidades e escopos legíveis. */
function summarizeRole(permissions: string[]): RoleSummary {
  const set = new Set(permissions)
  const has = (k: string) => set.has(k)
  const hasAny = (prefix: string) => [...set].some((k) => k.startsWith(prefix))
  const chips: string[] = []
  const notes: string[] = []

  if (has("tickets.view") || has("tickets.view.all") || hasAny("tickets.view.")) {
    chips.push("Ver chamados")
  }
  if (has("tickets.create")) chips.push("Criar chamados")
  if (has("tickets.edit") || has("tickets.edit.all") || hasAny("tickets.edit.")) {
    chips.push("Editar chamados")
  }
  if (has("tickets.assign")) chips.push("Atribuir responsável")
  if (has("tickets.move") || hasAny("tickets.move.")) {
    chips.push("Mover no Kanban")
  }
  if (has("tickets.delete")) chips.push("Excluir chamados")
  if (has("metrics.view")) chips.push("Ver métricas")
  if (has("settings.manage")) chips.push("Configurações")
  if (has("users.manage")) chips.push("Gerenciar usuários")

  // Escopos restritos por coluna (espelham o que o backend aplica de fato).
  if (!has("tickets.view.all") && hasStatusViewRestriction(permissions)) {
    const cols = TICKET_STATUSES.filter((s) => has(`tickets.view.${s}`)).map(
      (s) => STATUS_LABELS[s],
    )
    notes.push(`Visível: ${cols.join(", ")}`)
  }
  if (!has("tickets.edit.all") && hasStatusEditRestriction(permissions)) {
    const cols = TICKET_STATUSES.filter((s) => has(`tickets.edit.${s}`)).map(
      (s) => STATUS_LABELS[s],
    )
    notes.push(`Edição: ${cols.join(", ")}`)
  }
  if (!has("tickets.move") && hasAny("tickets.move.")) {
    const cols = TICKET_STATUSES.filter((s) => has(`tickets.move.${s}`)).map(
      (s) => STATUS_LABELS[s],
    )
    notes.push(`Mover para: ${cols.join(", ")}`)
  }
  if (hasEditAssignmentRestriction(permissions)) {
    const bits: string[] = []
    if (has("tickets.edit.own")) bits.push("apenas os próprios chamados")
    if (has("tickets.edit.unassigned")) bits.push("também sem responsável")
    notes.push(`Edição: ${bits.join(" · ")}`)
  }
  if (hasViewAssignmentRestriction(permissions)) {
    const bits: string[] = []
    if (has("tickets.view.own")) bits.push("apenas os próprios chamados")
    if (has("tickets.view.unassigned")) bits.push("também sem responsável")
    notes.push(`Visualização: ${bits.join(" · ")}`)
  }
  return { chips, notes }
}

type ManagedUser = {
  _id: Id<"users">
  name: string
  email: string
  username: string
  role: string | null
  active: boolean
  setor: string
  contato: string
  permissions: string[] | null
  createdAt?: number
  hasPassword: boolean
}

type RoleDoc = {
  _id: Id<"roles">
  name: string
  permissions: string[]
  createdAt: number
}

export default function UsersManagementDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { isAdmin } = usePermissions()
  const users = useQuery(api.users.listManaged) as ManagedUser[] | undefined
  const roles = useQuery(api.roles.list) as RoleDoc[] | undefined

  const ensureBootstrap = useMutation(api.users.ensureBootstrap)
  const createManaged = useMutation(api.users.createManaged)
  const updateManaged = useMutation(api.users.updateManaged)
  const resetPassword = useMutation(api.users.resetPassword)
  const deleteManaged = useMutation(api.users.deleteManaged)
  const createRole = useMutation(api.roles.create)
  const updateRole = useMutation(api.roles.update)
  const removeRole = useMutation(api.roles.remove)

  const [bootstrapped, setBootstrapped] = useState(false)
  const [tab, setTab] = useState<"usuarios" | "papeis" | "permissoes">("usuarios")

  // ---- busca / filtros ----
  const [search, setSearch] = useState("")
  const [roleFilter, setRoleFilter] = useState("all")

  // ---- formulário criar/editar ----
  const [formMode, setFormMode] = useState<"create" | "edit" | null>(null)
  const [editingId, setEditingId] = useState<Id<"users"> | null>(null)
  const [fName, setFName] = useState("")
  const [fUsername, setFUsername] = useState("")
  const [fPassword, setFPassword] = useState("")
  const [fSetor, setFSetor] = useState("")
  const [fContato, setFContato] = useState("")
  const [fRole, setFRole] = useState(DEFAULT_ROLE)
  const [saving, setSaving] = useState(false)

  // ---- redefinir senha ----
  const [resetUserId, setResetUserId] = useState<Id<"users"> | null>(null)
  const [resetPw, setResetPw] = useState("")
  const [resetPw2, setResetPw2] = useState("")

  // ---- excluir usuário ----
  const [deleteUserId, setDeleteUserId] = useState<Id<"users"> | null>(null)
  const [deleting, setDeleting] = useState(false)

  // ---- papéis ----
  const [newRoleName, setNewRoleName] = useState("")
  const [creatingRole, setCreatingRole] = useState(false)
  const [renamingRole, setRenamingRole] = useState<Id<"roles"> | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [deleteRoleId, setDeleteRoleId] = useState<Id<"roles"> | null>(null)

  // ---- painel de permissões ----
  const [permMode, setPermMode] = useState<"role" | "user">("role")
  const [permRoleId, setPermRoleId] = useState<string>("")
  const [permUserId, setPermUserId] = useState<string>("")
  const [permLocal, setPermLocal] = useState<string[]>([])
  const [permInherit, setPermInherit] = useState(true)

  // Bootstrap: primeiro admin + papéis padrão
  useEffect(() => {
    if (open && !bootstrapped) {
      ensureBootstrap()
        .then(() => setBootstrapped(true))
        .catch((e) => {
          setBootstrapped(true)
          toast.error(e instanceof Error ? e.message : "Erro ao inicializar usuários.")
        })
    }
  }, [open, bootstrapped, ensureBootstrap])

  const roleById = useMemo(() => {
    const m = new Map<string, RoleDoc>()
    for (const r of roles ?? []) m.set(r._id, r)
    return m
  }, [roles])

  const effectiveFor = useCallback(
    (u: ManagedUser): string[] => {
      if (u.role === ADMIN_ROLE) return [...ALL_PERMISSIONS]
      if (Array.isArray(u.permissions)) return u.permissions
      const roleDoc = [...roleById.values()].find((r) => r.name === u.role)
      return roleDoc ? roleDoc.permissions : [...DEFAULT_USER_PERMISSIONS]
    },
    [roleById],
  )

  // ---- usuários filtrados ----
  const filteredUsers = useMemo(() => {
    let list = users ?? []
    if (roleFilter !== "all") {
      list = list.filter((u) => u.role === roleFilter)
    }
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter(
        (u) =>
          u.name.toLowerCase().includes(q) ||
          u.username.toLowerCase().includes(q) ||
          u.setor.toLowerCase().includes(q),
      )
    }
    return list
  }, [users, roleFilter, search])

  // ---- sincroniza o painel de permissões com a seleção ----
  useEffect(() => {
    if (permMode === "role") {
      const role = roleById.get(permRoleId)
      setPermLocal(role ? [...role.permissions] : [])
      setPermInherit(false)
    } else {
      const u = users?.find((x) => x._id === permUserId)
      setPermLocal(u ? effectiveFor(u) : [])
      setPermInherit(u ? !Array.isArray(u.permissions) : true)
    }
  }, [permMode, permRoleId, permUserId, users, roleById, effectiveFor])

  const selectedRole = roleById.get(permRoleId)
  const selectedUser = users?.find((x) => x._id === permUserId)
  const selectionLocked =
    (permMode === "role" && selectedRole?.name === ADMIN_ROLE) ||
    (permMode === "user" && selectedUser?.role === ADMIN_ROLE)

  const handleCreateUser = async () => {
    if (!fName.trim()) return toast.error("Informe o nome completo.")
    if (!fUsername.trim()) return toast.error("Informe o nome de usuário.")
    if (fPassword.length < 8) return toast.error("A senha deve ter pelo menos 8 caracteres.")
    if (!fRole) return toast.error("Selecione o papel.")
    setSaving(true)
    try {
      await createManaged({
        name: fName.trim(),
        username: fUsername.trim(),
        password: fPassword,
        setor: fSetor.trim() || undefined,
        contato: fContato.trim() || undefined,
        role: fRole,
      })
      toast.success("Usuário criado com sucesso!")
      setFormMode(null)
      setFPassword("")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao criar usuário.")
    } finally {
      setSaving(false)
    }
  }

  const handleSaveUser = async () => {
    if (!editingId) return
    setSaving(true)
    try {
      await updateManaged({
        userId: editingId,
        name: fName.trim() || undefined,
        username: fUsername.trim() || undefined,
        role: fRole || undefined,
        setor: fSetor.trim() || undefined,
        contato: fContato.trim() || undefined,
      })
      toast.success("Usuário atualizado!")
      setFormMode(null)
      setEditingId(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao atualizar usuário.")
    } finally {
      setSaving(false)
    }
  }

  const openEdit = (u: ManagedUser) => {
    setEditingId(u._id)
    setFName(u.name)
    setFUsername(u.username)
    setFSetor(u.setor)
    setFContato(u.contato ?? "")
    setFRole(u.role ?? DEFAULT_ROLE)
    setFormMode("edit")
  }

  const handleToggleActive = async (u: ManagedUser, active: boolean) => {
    try {
      await updateManaged({ userId: u._id, active })
      toast.success(active ? "Usuário ativado." : "Usuário desativado.")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao atualizar usuário.")
    }
  }

  const handleResetPassword = async () => {
    if (!resetUserId) return
    if (resetPw.length < 8) return toast.error("A senha deve ter pelo menos 8 caracteres.")
    if (resetPw !== resetPw2) return toast.error("As senhas não conferem.")
    setSaving(true)
    try {
      await resetPassword({ userId: resetUserId, password: resetPw })
      toast.success("Senha redefinida! O usuário precisará entrar novamente.")
      setResetUserId(null)
      setResetPw("")
      setResetPw2("")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao redefinir senha.")
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteUser = async () => {
    if (!deleteUserId) return
    setDeleting(true)
    try {
      await deleteManaged({ userId: deleteUserId })
      toast.success("Usuário excluído.")
      setDeleteUserId(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao excluir usuário.")
    } finally {
      setDeleting(false)
    }
  }

  const handleCreateRole = async () => {
    const name = newRoleName.trim()
    if (!name) return toast.error("Informe o nome do papel.")
    setCreatingRole(true)
    try {
      await createRole({
        name,
        permissions: [...DEFAULT_USER_PERMISSIONS],
      })
      toast.success("Papel criado! Defina as permissões na aba Permissões.")
      setNewRoleName("")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao criar papel.")
    } finally {
      setCreatingRole(false)
    }
  }

  const handleRenameRole = async () => {
    if (!renamingRole) return
    const name = renameValue.trim()
    if (!name) return toast.error("Informe o nome do papel.")
    try {
      await updateRole({ roleId: renamingRole, name })
      toast.success("Papel renomeado.")
      setRenamingRole(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao renomear papel.")
    }
  }

  const handleDeleteRole = async () => {
    if (!deleteRoleId) return
    try {
      await removeRole({ roleId: deleteRoleId })
      toast.success("Papel excluído. Usuários voltaram ao papel padrão.")
      setDeleteRoleId(null)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao excluir papel.")
    }
  }

  const togglePermission = async (key: string) => {
    const next = permLocal.includes(key) ? permLocal.filter((k) => k !== key) : [...permLocal, key]
    setPermLocal(next)
    try {
      if (permMode === "role") {
        await updateRole({
          roleId: permRoleId as Id<"roles">,
          permissions: next,
        })
      } else {
        await updateManaged({
          userId: permUserId as Id<"users">,
          permissions: next,
        })
        setPermInherit(false)
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar permissão.")
      setPermLocal((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
    }
  }

  const toggleInherit = async (inherit: boolean) => {
    if (!selectedUser) return
    setPermInherit(inherit)
    try {
      await updateManaged({
        userId: selectedUser._id,
        permissions: inherit ? null : [...permLocal],
      })
      toast.success(
        inherit
          ? "Usuário voltou a herdar as permissões do papel."
          : "Permissões individuais ativadas para este usuário.",
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Erro ao salvar.")
      setPermInherit(!inherit)
    }
  }

  if (!isAdmin) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sem permissão</DialogTitle>
            <DialogDescription>Apenas administradores podem gerenciar usuários.</DialogDescription>
          </DialogHeader>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl h-[92dvh] max-h-[92dvh] grid grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0">
        <DialogHeader className="px-4 sm:px-6 pt-4 sm:pt-5 pb-2 border-b">
          <DialogTitle className="flex items-center gap-2">
            <Shield className="size-5 text-primary" />
            Usuários e Permissões
          </DialogTitle>
          <DialogDescription>
            Crie contas de acesso, defina papéis e controle o que cada usuário pode fazer no
            sistema.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as typeof tab)}
          className="flex-1 min-h-0 flex flex-col px-4 sm:px-6"
        >
          <TabsList className="mt-4 w-full sm:w-auto grid grid-cols-3">
            <TabsTrigger
              value="usuarios"
              className="gap-1 px-1 text-xs sm:gap-1.5 sm:px-2 sm:text-sm"
            >
              <Users className="hidden sm:block size-3.5" /> Usuários
            </TabsTrigger>
            <TabsTrigger
              value="papeis"
              className="gap-1 px-1 text-xs sm:gap-1.5 sm:px-2 sm:text-sm"
            >
              <UserCog className="hidden sm:block size-3.5" /> Papéis
            </TabsTrigger>
            <TabsTrigger
              value="permissoes"
              className="gap-1 px-1 text-xs sm:gap-1.5 sm:px-2 sm:text-sm"
            >
              <Shield className="hidden sm:block size-3.5" /> Permissões
            </TabsTrigger>
          </TabsList>

          {/* ---------------- USUÁRIOS ---------------- */}
          <TabsContent value="usuarios" className="flex-1 min-h-0 flex flex-col mt-3">
            {formMode ? (
              <div className="space-y-4 py-2">
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setFormMode(null)
                      setEditingId(null)
                      setFPassword("")
                    }}
                  >
                    <ArrowLeft className="size-4" /> Voltar
                  </Button>
                  <span className="text-sm font-medium">
                    {formMode === "create" ? "Novo usuário" : "Editar usuário"}
                  </span>
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Nome completo *</Label>
                    <Input
                      value={fName}
                      onChange={(e) => setFName(e.target.value)}
                      placeholder="João da Silva"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      Nome de usuário (login) *
                    </Label>
                    <Input
                      value={fUsername}
                      onChange={(e) => setFUsername(e.target.value)}
                      placeholder="joao.silva"
                      autoComplete="off"
                    />
                  </div>
                  {formMode === "create" && (
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">
                        Senha inicial * (mín. 8 caracteres)
                      </Label>
                      <Input
                        type="password"
                        value={fPassword}
                        onChange={(e) => setFPassword(e.target.value)}
                        placeholder="••••••••"
                        autoComplete="new-password"
                      />
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Setor</Label>
                    <Input
                      value={fSetor}
                      onChange={(e) => setFSetor(e.target.value)}
                      placeholder="TI / Financeiro / ..."
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Contato (WhatsApp)</Label>
                    <Input
                      value={fContato}
                      onChange={(e) => setFContato(e.target.value)}
                      placeholder="(91) 99999-9999"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      Usado para enviar alertas de inatividade por WhatsApp ao responsável pelo
                      chamado.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Papel *</Label>
                    <Select value={fRole} onValueChange={setFRole}>
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione o papel" />
                      </SelectTrigger>
                      <SelectContent>
                        {(roles ?? []).map((r) => (
                          <SelectItem key={r._id} value={r.name}>
                            {r.name === ADMIN_ROLE
                              ? "Administrador"
                              : r.name === DEFAULT_ROLE
                                ? "Usuário Padrão"
                                : r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    onClick={() => {
                      setFormMode(null)
                      setEditingId(null)
                      setFPassword("")
                    }}
                    disabled={saving}
                  >
                    Cancelar
                  </Button>
                  <Button
                    onClick={formMode === "create" ? handleCreateUser : handleSaveUser}
                    disabled={saving}
                  >
                    {saving ? "Salvando..." : "Salvar"}
                  </Button>
                </div>
              </div>
            ) : (
              <>
                <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2">
                  <div className="relative w-full sm:flex-1 sm:min-w-[180px]">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                    <Input
                      placeholder="Buscar por nome, usuário ou setor..."
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="pl-9 h-9"
                    />
                  </div>
                  <Select value={roleFilter} onValueChange={setRoleFilter}>
                    <SelectTrigger className="w-full sm:w-[170px] h-9">
                      <SelectValue placeholder="Todos os papéis" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Todos os papéis</SelectItem>
                      {(roles ?? []).map((r) => (
                        <SelectItem key={r._id} value={r.name}>
                          {r.name === ADMIN_ROLE
                            ? "Administrador"
                            : r.name === DEFAULT_ROLE
                              ? "Usuário Padrão"
                              : r.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={() => {
                      setFormMode("create")
                      setFRole(DEFAULT_ROLE)
                      setFName("")
                      setFUsername("")
                      setFSetor("")
                      setFContato("")
                    }}
                  >
                    <UserPlus className="size-3.5" /> Novo usuário
                  </Button>
                </div>

                <ScrollArea className="flex-1 min-h-0 mt-3 -mx-1 px-1">
                  <div className="space-y-2 pb-4">
                    {filteredUsers.map((u) => (
                      <div
                        key={u._id}
                        className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2.5"
                      >
                        <div className="flex items-center gap-3 flex-wrap">
                          <Avatar className="size-8">
                            <AvatarFallback className="text-[10px]">
                              {getInitials(u.name)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium">{u.name}</span>
                              {u.role === ADMIN_ROLE && (
                                <Badge className="bg-primary/10 text-primary border-primary/20">
                                  Admin
                                </Badge>
                              )}
                              {!u.hasPassword && (
                                <Badge
                                  variant="outline"
                                  className="text-amber-600 border-amber-300/50 dark:text-amber-400 dark:border-amber-800/60"
                                >
                                  sem senha
                                </Badge>
                              )}
                            </div>
                            <div className="text-xs text-muted-foreground truncate">
                              @{u.username}
                              {u.setor ? ` · ${u.setor}` : ""}
                              {u.contato ? ` · ${u.contato}` : ""}
                            </div>
                          </div>
                          <div className="flex w-full items-center gap-1.5 sm:w-auto">
                            <Switch
                              checked={u.active}
                              onCheckedChange={(v) => handleToggleActive(u, v)}
                              aria-label={`Ativar/desativar ${u.name}`}
                              className="ml-auto sm:ml-0"
                            />
                            <div className="flex items-center gap-1 ml-auto sm:ml-0">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                title="Editar usuário"
                                aria-label="Editar usuário"
                                onClick={() => openEdit(u)}
                              >
                                <Pencil className="size-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8"
                                title="Redefinir senha"
                                aria-label="Redefinir senha"
                                onClick={() => {
                                  setResetUserId(u._id)
                                  setResetPw("")
                                  setResetPw2("")
                                }}
                              >
                                <KeyRound className="size-3.5" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-8 text-destructive hover:text-destructive"
                                title="Excluir usuário"
                                aria-label="Excluir usuário"
                                onClick={() => setDeleteUserId(u._id)}
                              >
                                <Trash2 className="size-3.5" />
                              </Button>
                            </div>
                          </div>
                        </div>

                        {resetUserId === u._id && (
                          <div className="mt-3 rounded-lg border border-border/60 bg-background p-3 space-y-3">
                            <div className="flex items-center gap-2">
                              <Lock className="size-4 text-muted-foreground" />
                              <span className="text-sm font-medium">Nova senha para {u.name}</span>
                            </div>
                            <div className="grid sm:grid-cols-2 gap-3">
                              <Input
                                type="password"
                                placeholder="Nova senha (mín. 8)"
                                value={resetPw}
                                onChange={(e) => setResetPw(e.target.value)}
                              />
                              <Input
                                type="password"
                                placeholder="Confirmar senha"
                                value={resetPw2}
                                onChange={(e) => setResetPw2(e.target.value)}
                              />
                            </div>
                            <div className="flex justify-end gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setResetUserId(null)}
                              >
                                Cancelar
                              </Button>
                              <Button size="sm" onClick={handleResetPassword} disabled={saving}>
                                {saving ? "Salvando..." : "Definir nova senha"}
                              </Button>
                            </div>
                          </div>
                        )}

                        {deleteUserId === u._id && (
                          <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 flex items-center justify-between gap-3 flex-wrap">
                            <p className="text-sm">
                              Excluir <strong>{u.name}</strong>? Ele não poderá mais acessar o
                              sistema.
                            </p>
                            <div className="flex gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setDeleteUserId(null)}
                                disabled={deleting}
                              >
                                Cancelar
                              </Button>
                              <Button
                                variant="destructive"
                                size="sm"
                                onClick={handleDeleteUser}
                                disabled={deleting}
                              >
                                {deleting ? "Excluindo..." : "Excluir"}
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                    {filteredUsers.length === 0 && (
                      <p className="text-sm text-muted-foreground text-center py-8">
                        Nenhum usuário encontrado.
                      </p>
                    )}
                  </div>
                </ScrollArea>
              </>
            )}
          </TabsContent>

          {/* ---------------- PAPÉIS ---------------- */}
          <TabsContent value="papeis" className="flex-1 min-h-0 flex flex-col mt-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2">
              <Input
                placeholder="Nome do novo papel (ex: Técnico Nível 1)"
                value={newRoleName}
                onChange={(e) => setNewRoleName(e.target.value)}
                className="w-full sm:flex-1 sm:min-w-[200px] h-9"
              />
              <Button
                size="sm"
                className="w-full sm:w-auto"
                onClick={handleCreateRole}
                disabled={creatingRole}
              >
                <Plus className="size-3.5" /> Criar papel
              </Button>
              {roles && (
                <span className="text-center text-xs text-muted-foreground sm:ml-auto sm:text-left">
                  {roles.length} {roles.length === 1 ? "papel cadastrado" : "papéis cadastrados"}
                </span>
              )}
            </div>
            <ScrollArea className="flex-1 min-h-0 mt-3 -mx-1 px-1">
              <div className="grid content-start gap-2 sm:grid-cols-2 pb-4">
                {(roles ?? []).map((r) => {
                  const userCount = (users ?? []).filter((u) => u.role === r.name).length
                  const isAdminRole = r.name === ADMIN_ROLE
                  const displayName =
                    r.name === ADMIN_ROLE
                      ? "Administrador"
                      : r.name === DEFAULT_ROLE
                        ? "Usuário Padrão"
                        : r.name
                  const summary = summarizeRole(r.permissions)
                  const chips = summary.chips.slice(0, 6)
                  const hiddenChips = summary.chips.length - chips.length
                  return (
                    <div
                      key={r._id}
                      className="flex flex-col rounded-xl border border-border/70 bg-card p-3.5 shadow-sm transition-shadow hover:border-border hover:shadow-md"
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className={`flex size-10 shrink-0 items-center justify-center rounded-xl border text-[11px] font-bold ${roleAvatarStyle(r.name, isAdminRole)}`}
                        >
                          {getInitials(displayName)}
                        </div>
                        <div className="min-w-0 flex-1">
                          {renamingRole === r._id ? (
                            <Input
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              className="h-7 w-full sm:w-52 text-sm"
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void handleRenameRole()
                                if (e.key === "Escape") setRenamingRole(null)
                              }}
                            />
                          ) : (
                            <p className="text-sm font-semibold leading-tight truncate">
                              {displayName}
                            </p>
                          )}
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {r.permissions.length}{" "}
                            {r.permissions.length === 1 ? "permissão" : "permissões"} ·{" "}
                            {userCount === 0
                              ? "nenhum usuário"
                              : `${userCount} usuário${userCount === 1 ? "" : "s"}`}
                          </p>
                        </div>
                        {!isAdminRole && (
                          <div className="flex shrink-0 items-center gap-0.5">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="Renomear papel"
                              aria-label="Renomear papel"
                              onClick={() => {
                                setRenamingRole(r._id)
                                setRenameValue(r.name)
                              }}
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7 text-destructive hover:text-destructive"
                              title="Excluir papel"
                              aria-label="Excluir papel"
                              onClick={() => setDeleteRoleId(r._id)}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>

                      {!isAdminRole && chips.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {chips.map((c) => (
                            <span
                              key={c}
                              className="rounded-md border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                            >
                              {c}
                            </span>
                          ))}
                          {hiddenChips > 0 && (
                            <span className="px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground/70">
                              +{hiddenChips} mais
                            </span>
                          )}
                        </div>
                      )}

                      {!isAdminRole && summary.notes.length > 0 && (
                        <ul className="mt-2.5 space-y-1">
                          {summary.notes.map((n) => (
                            <li
                              key={n}
                              className="flex items-start gap-1.5 text-[11px] text-muted-foreground"
                            >
                              <span className="mt-[5px] size-1.5 shrink-0 rounded-full bg-primary/50" />
                              {n}
                            </li>
                          ))}
                        </ul>
                      )}

                      {!isAdminRole && r.permissions.length === 0 && (
                        <p className="mt-2.5 text-[11px] text-muted-foreground">
                          Nenhuma permissão definida ainda.
                        </p>
                      )}

                      <div className="mt-auto flex items-center justify-between gap-2 pt-2.5 border-t border-border/50">
                        {isAdminRole ? (
                          <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                            <ShieldCheck className="size-3.5 text-primary" />
                            Acesso total ao sistema
                          </span>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1"
                            onClick={() => {
                              setTab("permissoes")
                              setPermMode("role")
                              setPermRoleId(r._id)
                            }}
                          >
                            <Shield className="size-3.5" /> Definir permissões
                          </Button>
                        )}
                      </div>

                      {deleteRoleId === r._id && (
                        <div className="mt-3 rounded-lg border border-destructive/40 bg-destructive/5 p-3 flex items-center justify-between gap-3 flex-wrap">
                          <p className="text-sm">
                            Excluir o papel <strong>{r.name}</strong>? Os usuários voltarão ao papel
                            padrão.
                          </p>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setDeleteRoleId(null)}
                            >
                              Cancelar
                            </Button>
                            <Button variant="destructive" size="sm" onClick={handleDeleteRole}>
                              Excluir
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })}
                {roles && roles.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    Nenhum papel criado ainda.
                  </p>
                )}
              </div>
            </ScrollArea>
          </TabsContent>

          {/* ---------------- PERMISSÕES ---------------- */}
          <TabsContent value="permissoes" className="flex-1 min-h-0 flex flex-col mt-3">
            <div className="flex items-center gap-2 flex-wrap">
              <Select value={permMode} onValueChange={(v) => setPermMode(v as "role" | "user")}>
                <SelectTrigger className="w-full sm:w-[150px] h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="role">Papel</SelectItem>
                  <SelectItem value="user">Usuário</SelectItem>
                </SelectContent>
              </Select>
              {permMode === "role" ? (
                <Select value={permRoleId} onValueChange={setPermRoleId}>
                  <SelectTrigger className="w-full sm:flex-1 sm:min-w-[180px] h-9">
                    <SelectValue placeholder="Selecione um papel" />
                  </SelectTrigger>
                  <SelectContent>
                    {(roles ?? []).map((r) => (
                      <SelectItem key={r._id} value={r._id}>
                        {r.name === ADMIN_ROLE
                          ? "Administrador"
                          : r.name === DEFAULT_ROLE
                            ? "Usuário Padrão"
                            : r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Select value={permUserId} onValueChange={setPermUserId}>
                  <SelectTrigger className="w-full sm:flex-1 sm:min-w-[180px] h-9">
                    <SelectValue placeholder="Selecione um usuário" />
                  </SelectTrigger>
                  <SelectContent>
                    {(users ?? []).map((u) => (
                      <SelectItem key={u._id} value={u._id}>
                        {u.name} (@{u.username})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>

            {permMode === "user" && selectedUser && (
              <div className="mt-3 flex items-center justify-between rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                <div>
                  <p className="text-sm font-medium">Herdar permissões do papel</p>
                  <p className="text-xs text-muted-foreground">
                    {permInherit
                      ? "Usuário segue as permissões do papel selecionado."
                      : "Perfil personalizado — desative para voltar ao padrão."}
                  </p>
                </div>
                <Switch checked={permInherit} onCheckedChange={(v) => void toggleInherit(v)} />
              </div>
            )}

            {!permRoleId && !permUserId ? (
              <p className="text-sm text-muted-foreground text-center py-10">
                Selecione um papel ou usuário para ver as permissões.
              </p>
            ) : selectionLocked ? (
              <p className="text-sm text-muted-foreground text-center py-10">
                Administradores possuem acesso total ao sistema e não precisam de permissões
                individuais.
              </p>
            ) : (
              <ScrollArea className="flex-1 min-h-0 mt-3 -mx-1 px-1">
                <div className="space-y-4 pb-4">
                  {PERMISSION_GROUPS.map((group) => (
                    <div key={group.id}>
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {group.label}
                      </p>
                      {group.description && (
                        <p className="text-[11px] text-muted-foreground/70 mb-2">
                          {group.description}
                        </p>
                      )}
                      <div className="mt-1.5 space-y-1.5">
                        {group.permissions.map((p) => (
                          <div
                            key={p.key}
                            className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-card px-3 py-2"
                          >
                            <div>
                              <p className="text-sm font-medium">{p.label}</p>
                              <p className="text-[11px] text-muted-foreground">{p.description}</p>
                            </div>
                            <Switch
                              checked={permLocal.includes(p.key)}
                              onCheckedChange={() => void togglePermission(p.key)}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                  <Separator />
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-muted-foreground">
                      {permLocal.length} de {ALL_PERMISSIONS.length} permissões
                      {permMode === "user" && permInherit ? " (herdadas do papel)" : ""}
                    </p>
                    {permMode === "user" && !permInherit && (
                      <Button variant="outline" size="sm" onClick={() => void toggleInherit(true)}>
                        <Check className="size-3.5" /> Usar padrão do papel
                      </Button>
                    )}
                  </div>
                </div>
              </ScrollArea>
            )}
          </TabsContent>
        </Tabs>

        <div className="px-4 sm:px-6 py-3 border-t flex justify-end">
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            onClick={() => onOpenChange(false)}
          >
            Fechar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
