import { execute, query, queryOne } from "../mysql/pool"
import type { TechnicianRow } from "./types"

export const LIST_COLUMNS =
  "`id`, `title`, `description`, `status`, `priority`, `guest_name`, `creator_name`, `created_at`, `updated_at`, `assignee_id`"

export type Enrichment = { technicians: Record<string, string> }

export async function loadEnrichment(): Promise<Enrichment> {
  const [technicians] = await Promise.all([
    query<Pick<TechnicianRow, "id" | "name">>("SELECT `id`, `name` FROM `technicians`"),
  ])
  return {
    technicians: Object.fromEntries(technicians.map((t) => [t.id, t.name])),
  }
}

export function enrichTicket(enrichment: Enrichment, row: Record<string, unknown>) {
  return {
    ...row,
    assignee_name: enrichment.technicians[String(row.assignee_id)] || "Não atribuído",
  }
}

export { query, execute, queryOne }
