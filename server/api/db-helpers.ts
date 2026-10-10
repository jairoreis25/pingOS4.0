
import { execute, query, queryOne } from "../mysql/pool";

export const LIST_COLUMNS = "`id`, `title`, `description`, `status`, `priority`, `guest_name`, `creator_name`, `created_at`, `updated_at`, `assignee_id`";

export async function loadEnrichment() {
  const [technicians] = await Promise.all([
    query("SELECT `id`, `name` FROM `technicians`"),
  ]);
  return {
    technicians: Object.fromEntries(technicians.map(t => [t.id, t.name])),
  };
}

export function enrichTicket(enrichment: any, row: any) {
  return {
    ...row,
    assignee_name: enrichment.technicians[row.assignee_id] || "Não atribuído",
  };
}

export { query, execute, queryOne };
