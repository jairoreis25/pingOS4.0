import { useMutation, useQuery } from "@/lib/backend/react"
import { api } from "@/lib/backend/api"
import type { Id } from "@/lib/backend/types"
import { Bell, CheckCheck, Inbox } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { formatDistanceToNow } from "date-fns"
import { ptBR } from "date-fns/locale"
import { toast } from "sonner"

type BellItem = {
  _id: Id<"inAppNotifications">
  ticketId: Id<"tickets">
  title: string
  message: string
  read: boolean
  createdAt: number
  ticketNumber: number | null
  ticketTitle: string | null
}

export default function NotificationBell({
  onTicketClick,
}: {
  onTicketClick?: (ticketId: Id<"tickets">) => void
}) {
  const data = useQuery(api.inAppNotifications.listForUser)
  const markRead = useMutation(api.inAppNotifications.markRead)
  const markAllRead = useMutation(api.inAppNotifications.markAllRead)

  const items: BellItem[] = data?.items ?? []
  const unread = data?.unreadCount ?? 0

  const handleClickItem = async (item: BellItem) => {
    if (!item.read) {
      try {
        await markRead({ notificationId: item._id })
      } catch {
        // continua abrindo o chamado mesmo se falhar a marcação
      }
    }
    onTicketClick?.(item.ticketId)
  }

  const handleMarkAll = async () => {
    try {
      const count = await markAllRead({})
      if (count > 0) {
        toast.success(
          count === 1
            ? "1 notificação marcada como lida."
            : `${count} notificações marcadas como lidas.`,
        )
      }
    } catch {
      toast.error("Erro ao marcar as notificações como lidas.")
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="relative size-8"
          title="Notificações"
          aria-label="Notificações"
        >
          <Bell className="size-4" />
          {unread > 0 && (
            <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white ring-2 ring-background">
              {unread > 99 ? "99+" : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,380px)] overflow-hidden p-0">
        <div className="flex items-center justify-between border-b px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Notificações</span>
            {unread > 0 && (
              <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">
                {unread} não {unread === 1 ? "lida" : "lidas"}
              </Badge>
            )}
          </div>
          {unread > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              onClick={handleMarkAll}
            >
              <CheckCheck className="size-3.5" />
              Marcar todas
            </Button>
          )}
        </div>
        <ScrollArea className="h-[min(60vh,380px)]">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
              <Inbox className="size-8 text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">Nenhuma notificação por aqui.</p>
            </div>
          ) : (
            <div className="divide-y divide-border/60">
              {items.map((item) => (
                <button
                  key={item._id}
                  onClick={() => handleClickItem(item)}
                  className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/50 ${
                    item.read ? "opacity-75" : ""
                  }`}
                >
                  <span
                    className={`mt-1.5 size-2 shrink-0 rounded-full ${
                      item.read ? "bg-transparent" : "bg-primary"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {item.title}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-muted-foreground">
                      {item.message}
                    </span>
                    <span className="mt-1 block text-[11px] text-muted-foreground/80">
                      {formatDistanceToNow(new Date(item.createdAt), {
                        addSuffix: true,
                        locale: ptBR,
                      })}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
