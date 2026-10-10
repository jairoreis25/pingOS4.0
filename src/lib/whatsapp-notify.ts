/**
 * Notificação de chamados pela ponte do WhatsApp Web (Baileys).
 *
 * Estava dentro de `pages/Dashboard.tsx`; foi movido para cá para ser usado
 * pela página e pelos componentes extraídos (`GuestNewTicketDialog`, ...).
 */
import { apiFetch } from "@/lib/mysql-api"
import { buildTicketMessage } from "@/lib/desc-fields"
import { waBridgeUrl } from "@/lib/whatsapp-bridge"

/**
 * Busca a imagem do chamado só quando ela é realmente necessária.
 *
 * A listagem do Kanban não carrega mais as imagens (data URLs de centenas de KB
 * cada); a ponte do WhatsApp ainda precisa delas para anexar no envio, então a
 * imagem é buscada aqui, sob demanda, pelo número do chamado.
 */
export async function fetchTicketImage(number?: number | null): Promise<string | null> {
  if (!number) return null
  try {
    const ticket = await apiFetch<{ imageUrl?: string | null } | null>(
      `/api/tickets/by-number/${number}`,
    )
    return ticket?.imageUrl ?? null
  } catch (error) {
    console.warn(
      "[WhatsApp Web] não foi possível carregar a imagem do chamado:",
      error instanceof Error ? error.message : error,
    )
    return null
  }
}

// WhatsApp Web notification helper — sends via the local bridge server
export async function sendWhatsAppWebNotification(
  ticket: {
    number?: number | null
    title?: string | null
    description?: string | null
    solucao?: string | null
    orcamento?: string | null
    obs?: string | null
    statusEquipamento?: string | null
    priority: string
    status: string
    guestContact?: string | null
    creatorName?: string | null
    location?: string | null
    os?: string | null
    valorTotal?: number | null
    assigneeName?: string | null
    imageUrl?: string | null
  },
  type: "created" | "status_changed",
  oldStatus?: string | null,
) {
  try {
    // Step 1: Check bridge connection
    const statusRes = await fetch(waBridgeUrl("/status"))
    const statusData = await statusRes.json()
    console.log("[WhatsApp Web] Bridge status:", statusData.status)
    if (statusData.status !== "connected") {
      console.warn("[WhatsApp Web] Bridge not connected — skipping notification")
      return
    }

    // Step 2: Get phone from contact
    const contact = ticket.guestContact
    if (!contact) {
      console.warn("[WhatsApp Web] No guestContact — skipping notification")
      return
    }

    // Extract phone: try to find digits that look like a phone
    const digits = contact.replace(/\D/g, "")
    if (digits.length < 8) {
      console.warn(
        `[WhatsApp Web] Contact '${contact}' does not contain a valid phone (${digits.length} digits) — skipping`,
      )
      return
    }
    // Take the last 10-13 digits (handles names with phone mixed in)
    const phone = digits.length > 13 ? digits.slice(-13) : digits
    console.log(`[WhatsApp Web] Sending ${type} notification to phone: ${phone}`)

    const msg = buildTicketMessage(ticket, type, {
      oldStatus,
      newStatus: ticket.status,
    })

    // Step 3: Send via bridge
    const payload: Record<string, unknown> = { phone, message: msg }
    // A listagem não traz as imagens: buscamos só a deste chamado, e só quando
    // o envio realmente vai acontecer.
    const image = ticket.imageUrl ?? (await fetchTicketImage(ticket.number))
    if (image) {
      payload.image = image
    }
    const sendRes = await fetch(waBridgeUrl("/send"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
    const sendResult = await sendRes.json()
    if (sendResult.success) {
      console.log("[WhatsApp Web] ✅ Message sent successfully")
    } else {
      console.error("[WhatsApp Web] ❌ Send failed:", sendResult.error || sendResult)
    }
  } catch (err) {
    console.error("[WhatsApp Web] ❌ Notification error:", err)
  }
}
