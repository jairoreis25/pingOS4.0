import { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery } from "@/lib/backend/react"
import { api } from "@/lib/backend/api"
import { usePermissions } from "@/hooks/use-permissions"
import type { ProductService } from "@/lib/backend/types"
import { formatBRL, maskCurrencyInput, parseCurrencyInput } from "@/lib/currency"
import ItemTypeBadge from "@/components/ItemTypeBadge"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Check, Loader2, Package, Pencil, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { toast } from "sonner"

/**
 * Procura um comando "/" imediatamente antes do cursor: precisa estar no começo
 * do texto ou depois de espaço/quebra de linha, para não disparar no meio de uma
 * palavra (ex.: "http://").
 */
function findCommand(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const match = /(?:^|\s)\/([^/\n]*)$/.exec(before)
  if (!match) return null
  const query = match[1]
  return { start: before.length - query.length - 1, query }
}

type Props = Omit<React.ComponentProps<typeof Textarea>, "value" | "onChange"> & {
  value: string
  onValueChange: (value: string) => void
}

/**
 * Textarea com menu de produtos/serviços: ao digitar "/" abre a lista do
 * catálogo (Configurações → Produtos e Serviços) e insere "Nome — R$ valor".
 *
 *   ↑/↓ navega · Enter/Tab insere · Esc fecha · clique também insere
 *
 * Quem tem `settings.manage` pode corrigir o valor de um item sem sair do
 * chamado: o lápis abre um campo no próprio menu e o valor novo já vale para os
 * próximos usos.
 *
 * Cada linha mostra o tipo do item (Produto/Serviço) para dar para escolher sem
 * consultar o cadastro em Configurações.
 */
export default function SlashProductsTextarea({ value, onValueChange, ...props }: Props) {
  const products = useQuery(api.products.list)
  const updateProduct = useMutation(api.products.update)
  const { can } = usePermissions()
  const canEditPrice = can("settings.manage")

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)

  // Edição do valor de um item, dentro do próprio menu.
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editPrice, setEditPrice] = useState("")
  const [saving, setSaving] = useState(false)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Trecho do texto que o item escolhido vai substituir ("/nome digitado").
  const triggerRef = useRef<{ start: number; end: number } | null>(null)

  const items = useMemo(() => {
    const list = (products ?? []).filter((p) => p.active !== false)
    const q = query.trim().toLowerCase()
    if (!q) return list
    return list.filter((p) => p.name.toLowerCase().includes(q))
  }, [products, query])

  // Mantém o destaque dentro da lista filtrada.
  useEffect(() => {
    setActive(0)
  }, [query, open])

  // Garante o item destacado visível ao navegar com o teclado.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: "nearest" })
  }, [active, open])

  const close = () => {
    setOpen(false)
    setEditingId(null)
    triggerRef.current = null
  }

  const focusTextarea = () => {
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
    })
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value
    onValueChange(next)

    const caret = e.target.selectionStart ?? next.length
    const found = findCommand(next, caret)
    if (found) {
      triggerRef.current = { start: found.start, end: caret }
      setQuery(found.query)
      setOpen(true)
    } else {
      close()
    }
  }

  const select = (item: ProductService) => {
    const trigger = triggerRef.current
    if (!trigger) return

    const insertion = item.price > 0 ? `${item.name} — ${formatBRL(item.price)}` : item.name
    const rest = value.slice(trigger.end)
    // Se já houver texto depois do comando, quebra a linha para não colar nele.
    const needsBreak = rest.length > 0 && !rest.startsWith("\n")
    const next = value.slice(0, trigger.start) + insertion + (needsBreak ? "\n" : "") + rest

    onValueChange(next)
    close()

    const caret = trigger.start + insertion.length + (needsBreak ? 1 : 0)
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  const startEditPrice = (item: ProductService) => {
    setEditingId(item._id)
    setEditPrice(item.price > 0 ? formatBRL(item.price) : "")
  }

  const cancelEditPrice = () => {
    setEditingId(null)
    focusTextarea()
  }

  const savePrice = async (item: ProductService) => {
    const price = parseCurrencyInput(editPrice)
    setSaving(true)
    try {
      await updateProduct({ productId: item._id, price })
      // O useMutation invalida as queries: a lista já volta com o valor novo.
      toast.success(`Valor de "${item.name}" atualizado.`)
      setEditingId(null)
      focusTextarea()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar o valor.")
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!open || editingId) return
    if (e.key === "ArrowDown") {
      e.preventDefault()
      if (items.length) setActive((i) => (i + 1) % items.length)
      return
    }
    if (e.key === "ArrowUp") {
      e.preventDefault()
      if (items.length) setActive((i) => (i - 1 + items.length) % items.length)
      return
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (items[active]) {
        e.preventDefault()
        select(items[active])
      }
      return
    }
    if (e.key === "Escape") {
      e.preventDefault()
      close()
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <PopoverAnchor asChild>
        <div className="relative">
          <Textarea
            {...props}
            ref={textareaRef}
            value={value}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
          />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        // Não rouba o foco do campo — o cursor continua no textarea.
        onOpenAutoFocus={(e) => e.preventDefault()}
        // Com o campo de valor aberto, Esc cancela a edição em vez de fechar o menu.
        onEscapeKeyDown={(e) => {
          if (!editingId) return
          e.preventDefault()
          cancelEditPrice()
        }}
        className="w-[var(--radix-popover-trigger-width)] p-1"
      >
        {products === undefined ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">Carregando…</p>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-3 py-4 text-center">
            <Package className="size-5 text-muted-foreground/50" />
            {query.trim() ? (
              <p className="text-xs text-muted-foreground">
                Nenhum produto/serviço para <span className="font-medium">“{query.trim()}”</span>.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Nenhum produto/serviço cadastrado. Cadastre em{" "}
                <span className="font-medium">Configurações → Produtos e Serviços</span>.
              </p>
            )}
          </div>
        ) : (
          <div ref={listRef} className="max-h-56 overflow-y-auto">
            {items.map((item, index) => {
              if (editingId === item._id) {
                return (
                  <div
                    key={item._id}
                    className="flex items-center gap-1.5 rounded-md bg-accent/60 px-2 py-1.5"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm">{item.name}</span>
                    <Input
                      autoFocus
                      inputMode="numeric"
                      value={editPrice}
                      placeholder="R$ 0,00"
                      onChange={(e) => setEditPrice(maskCurrencyInput(e.target.value))}
                      onKeyDown={(e) => {
                        // Não deixa o atalho vazar para o menu nem para o diálogo.
                        e.stopPropagation()
                        if (e.key === "Enter") {
                          e.preventDefault()
                          void savePrice(item)
                        }
                        if (e.key === "Escape") {
                          e.preventDefault()
                          cancelEditPrice()
                        }
                      }}
                      disabled={saving}
                      className="h-7 w-24 px-2 text-xs tabular-nums"
                    />
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      title="Salvar valor"
                      onClick={() => void savePrice(item)}
                      disabled={saving}
                    >
                      {saving ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Check className="size-3.5 text-green-600 dark:text-green-400" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      title="Cancelar"
                      onClick={cancelEditPrice}
                      disabled={saving}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </div>
                )
              }

              return (
                <div
                  key={item._id}
                  className={cn(
                    "flex items-center rounded-md transition-colors",
                    index === active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60",
                  )}
                >
                  <button
                    type="button"
                    // preventDefault mantém o foco no textarea ao clicar.
                    onMouseDown={(e) => {
                      e.preventDefault()
                      select(item)
                    }}
                    onMouseEnter={() => setActive(index)}
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 px-2 py-1.5 text-left text-sm"
                  >
                    <ItemTypeBadge type={item.itemType} />
                    <span className="min-w-0 flex-1 truncate">{item.name}</span>
                    {item.price > 0 && (
                      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatBRL(item.price)}
                      </span>
                    )}
                  </button>
                  {canEditPrice && (
                    <button
                      type="button"
                      title="Editar valor"
                      onMouseDown={(e) => {
                        e.preventDefault()
                        startEditPrice(item)
                      }}
                      onMouseEnter={() => setActive(index)}
                      className="mr-1 grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-background/70 hover:text-foreground"
                    >
                      <Pencil className="size-3" />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <div className="mt-1 flex items-center gap-1.5 border-t px-2 pt-1.5 pb-0.5 text-[11px] text-muted-foreground">
          <Search className="size-3" />
          {editingId
            ? "Enter salva o valor · Esc cancela"
            : canEditPrice
              ? "Digite para filtrar · ↑↓ · Enter insere · ✎ edita o valor"
              : "Digite para filtrar · ↑↓ · Enter para inserir · Esc fecha"}
        </div>
      </PopoverContent>
    </Popover>
  )
}
