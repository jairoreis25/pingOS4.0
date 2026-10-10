import { useState } from "react"
import { useQuery, useMutation } from "@/lib/backend/react"
import { api } from "@/lib/backend/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import ItemTypeBadge from "@/components/ItemTypeBadge"
import { toast } from "sonner"
import { Package, Pencil, Plus, Trash2, Loader2 } from "lucide-react"
import type { Id } from "@/lib/backend/types"
import { formatBRL, maskCurrencyInput, parseCurrencyInput } from "@/lib/currency"
import {
  DEFAULT_PRODUCT_SERVICE_TYPE,
  PRODUCT_SERVICE_TYPES,
  PRODUCT_SERVICE_TYPE_LABELS,
  type ProductServiceType,
} from "@/lib/products"

export default function ProductsServicesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const products = useQuery(api.products.list, open ? {} : "skip")
  const createProduct = useMutation(api.products.create)
  const updateProduct = useMutation(api.products.update)
  const removeProduct = useMutation(api.products.remove)

  const [name, setName] = useState("")
  const [itemType, setItemType] = useState<ProductServiceType>(DEFAULT_PRODUCT_SERVICE_TYPE)
  const [price, setPrice] = useState("")
  const [adding, setAdding] = useState(false)

  const [editingId, setEditingId] = useState<Id<"products"> | null>(null)
  const [editName, setEditName] = useState("")
  const [editItemType, setEditItemType] = useState<ProductServiceType>(DEFAULT_PRODUCT_SERVICE_TYPE)
  const [editPrice, setEditPrice] = useState("")
  const [savingEdit, setSavingEdit] = useState(false)

  const [deleteTarget, setDeleteTarget] = useState<Id<"products"> | null>(null)
  const [deleting, setDeleting] = useState(false)

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setAdding(true)
    try {
      await createProduct({
        name: name.trim(),
        itemType,
        price: parseCurrencyInput(price),
      })
      toast.success(`${PRODUCT_SERVICE_TYPE_LABELS[itemType]} cadastrado!`)
      setName("")
      setPrice("")
      setItemType(DEFAULT_PRODUCT_SERVICE_TYPE)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao cadastrar produto/serviço.")
    } finally {
      setAdding(false)
    }
  }

  const startEdit = (item: {
    _id: Id<"products">
    name: string
    itemType: ProductServiceType
    price: number
  }) => {
    setEditingId(item._id)
    setEditName(item.name)
    setEditItemType(item.itemType)
    setEditPrice(formatBRL(item.price))
  }

  const handleSaveEdit = async () => {
    if (!editingId || !editName.trim()) return
    setSavingEdit(true)
    try {
      await updateProduct({
        productId: editingId,
        name: editName.trim(),
        itemType: editItemType,
        price: parseCurrencyInput(editPrice),
      })
      toast.success("Produto/serviço atualizado!")
      setEditingId(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao atualizar.")
    } finally {
      setSavingEdit(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await removeProduct({ productId: deleteTarget })
      toast.success("Produto/serviço excluído.")
      setDeleteTarget(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao excluir.")
    } finally {
      setDeleting(false)
    }
  }

  const deleteName = products?.find((p) => p._id === deleteTarget)?.name ?? "este item"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Produtos e Serviços</DialogTitle>
          <DialogDescription>
            Cada item é um <strong className="font-medium text-foreground">produto</strong> (peça ou
            equipamento) ou um <strong className="font-medium text-foreground">serviço</strong> (mão
            de obra). Nome, tipo e valor formam o catálogo usado no menu "/" do chamado.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleAdd} className="space-y-2">
          <div className="space-y-1.5">
            <Label htmlFor="product-name" className="text-xs text-muted-foreground">
              Nome do produto/serviço
            </Label>
            <Input
              id="product-name"
              placeholder="Ex: Formatação de notebook"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Tipo</Label>
              <Select
                value={itemType}
                onValueChange={(value) => setItemType(value as ProductServiceType)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRODUCT_SERVICE_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {PRODUCT_SERVICE_TYPE_LABELS[type]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="product-price" className="text-xs text-muted-foreground">
                Valor (R$)
              </Label>
              <Input
                id="product-price"
                inputMode="numeric"
                placeholder="R$ 0,00"
                value={price}
                onChange={(e) => setPrice(maskCurrencyInput(e.target.value))}
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            <strong className="font-medium">Produto</strong> = peça ou equipamento ·{" "}
            <strong className="font-medium">Serviço</strong> = mão de obra. O valor é digitado só
            com números — os dois últimos dígitos são os centavos.
          </p>
          <Button
            type="submit"
            size="sm"
            className="w-full gap-1.5"
            disabled={adding || !name.trim()}
          >
            {adding ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            Cadastrar {PRODUCT_SERVICE_TYPE_LABELS[itemType].toLowerCase()}
          </Button>
        </form>

        <div className="max-h-72 overflow-y-auto space-y-1.5 -mx-1 px-1">
          {products === undefined && (
            <p className="text-sm text-muted-foreground py-4 text-center">Carregando…</p>
          )}
          {products?.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 py-8 text-center">
              <Package className="size-7 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                Nenhum produto/serviço cadastrado ainda.
              </p>
            </div>
          )}
          {products?.map((item) => (
            <div
              key={item._id}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-muted/20 px-3 py-2"
            >
              {editingId === item._id ? (
                <>
                  <Input
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="h-8 text-sm min-w-[130px] flex-1"
                    placeholder="Nome"
                  />
                  <Select
                    value={editItemType}
                    onValueChange={(value) => setEditItemType(value as ProductServiceType)}
                  >
                    <SelectTrigger className="h-8 w-28 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRODUCT_SERVICE_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {PRODUCT_SERVICE_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={editPrice}
                    inputMode="numeric"
                    onChange={(e) => setEditPrice(maskCurrencyInput(e.target.value))}
                    className="h-8 w-28 text-sm"
                    placeholder="R$ 0,00"
                  />
                  <Button
                    size="sm"
                    className="h-8"
                    onClick={handleSaveEdit}
                    disabled={savingEdit || !editName.trim()}
                  >
                    {savingEdit ? <Loader2 className="size-3.5 animate-spin" /> : "Salvar"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-8"
                    onClick={() => setEditingId(null)}
                  >
                    Cancelar
                  </Button>
                </>
              ) : (
                <>
                  <div className="flex min-w-0 flex-1 items-center gap-1.5">
                    <ItemTypeBadge type={item.itemType} />
                    <p className="min-w-0 truncate text-sm font-medium">{item.name}</p>
                  </div>
                  <Badge variant="outline" className="text-[11px] tabular-nums">
                    {formatBRL(item.price)}
                  </Badge>
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      onClick={() => startEdit(item)}
                      title="Editar"
                      aria-label="Editar produto/serviço"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7 text-destructive"
                      onClick={() => setDeleteTarget(item._id)}
                      title="Excluir"
                      aria-label="Excluir produto/serviço"
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
            <AlertDialogTitle>Excluir produto/serviço?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{deleteName}</strong> será removido do catálogo. Esta ação não pode ser
              desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                handleDelete()
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
  )
}
