import { useEffect, useRef } from "react"
import { playTicketAlert } from "@/lib/sound"

type AlertTicket = { _id: unknown; status: string }

/**
 * Toca um alerta sonoro quando um chamado NOVO aparece na lista (aberto),
 * quando um chamado existente passa para o status "resolvido" ou quando
 * passa para "fechado".
 *
 * A primeira carga da lista apenas popula o estado anterior — não toca som
 * para chamados que já existiam antes do usuário abrir o painel.
 */
export function useTicketAlerts(tickets: AlertTicket[] | undefined): void {
  const prevRef = useRef<Map<string, string> | null>(null)

  useEffect(() => {
    if (!tickets) return
    const prev = prevRef.current
    const next = new Map<string, string>()

    for (const t of tickets) {
      const id = String(t._id)
      next.set(id, t.status)

      if (!prev) continue // primeira carga: só registra

      const oldStatus = prev.get(id)
      if (oldStatus === undefined) {
        // Id que não existia antes → chamado novo no quadro.
        playTicketAlert("open")
      } else if (oldStatus !== "resolvido" && t.status === "resolvido") {
        // Transição para "Resolvido".
        playTicketAlert("resolved")
      } else if (oldStatus !== "fechado" && t.status === "fechado") {
        // Transição para "Fechado".
        playTicketAlert("closed")
      }
    }

    prevRef.current = next
  }, [tickets])
}
