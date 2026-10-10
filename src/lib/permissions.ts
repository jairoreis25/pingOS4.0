/**
 * Catálogo central de permissões do PingOS.
 * Usado pelo backend (server/api/permissions.ts) e pelo frontend.
 * Mantenha este arquivo puro (sem imports de React/browser) para poder
 * ser importado por qualquer camada (sem dependências).
 */

export const ADMIN_ROLE = "admin";
export const DEFAULT_ROLE = "user";

export const TICKET_STATUSES = [
  "aberto",
  "em_andamento",
  "aguardando",
  "resolvido",
  "fechado",
] as const;

export interface PermissionDef {
  key: string;
  label: string;
  description: string;
}

export interface PermissionGroup {
  id: string;
  label: string;
  description?: string;
  permissions: PermissionDef[];
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    id: "chamados",
    label: "Chamados",
    permissions: [
      {
        key: "tickets.view",
        label: "Ver chamados",
        description: "Acessar o painel e visualizar os chamados no Kanban",
      },
      {
        key: "tickets.create",
        label: "Criar chamado",
        description: "Abrir novos chamados pelo painel",
      },
      {
        key: "tickets.edit",
        label: "Editar chamado",
        description: "Editar dados, descrição, valores e anexos dos chamados",
      },
      {
        key: "tickets.assign",
        label: "Atribuir técnico",
        description: "Definir o responsável no campo \"Atribuído a\"",
      },
      {
        key: "tickets.delete",
        label: "Excluir chamado",
        description: "Excluir chamados permanentemente",
      },
    ],
  },
  {
    id: "visualizar_kanban",
    label: "Visualizar no Kanban",
    description:
      "Se \"Visualizar todos os status\" estiver marcado, o usuário vê todas as colunas. Caso contrário, marque individualmente as colunas que ele pode ver. Com nenhuma coluna marcada, ele vê todas (comportamento padrão).",
    permissions: [
      {
        key: "tickets.view.all",
        label: "Visualizar todos os status",
        description: "Permite ver chamados de qualquer coluna do Kanban",
      },
      {
        key: "tickets.view.aberto",
        label: "Ver chamados de Aberto",
        description: "Mostra a coluna Aberto no Kanban",
      },
      {
        key: "tickets.view.em_andamento",
        label: "Ver chamados de Em Andamento",
        description: "Mostra a coluna Em Andamento no Kanban",
      },
      {
        key: "tickets.view.aguardando",
        label: "Ver chamados de Aguardando",
        description: "Mostra a coluna Aguardando no Kanban",
      },
      {
        key: "tickets.view.resolvido",
        label: "Ver chamados de Resolvido",
        description: "Mostra a coluna Resolvido no Kanban",
      },
      {
        key: "tickets.view.fechado",
        label: "Ver chamados de Fechado",
        description: "Mostra a coluna Fechado no Kanban",
      },
    ],
  },
  {
    id: "editar_kanban",
    label: "Editar no Kanban",
    description:
      "Se \"Editar chamados de todos os status\" estiver marcado, o usuário pode editar chamados de qualquer coluna. Caso contrário, marque individualmente os status em que ele pode editar. Com nenhum status marcado, ele pode editar todos (comportamento padrão).",
    permissions: [
      {
        key: "tickets.edit.all",
        label: "Editar chamados de todos os status",
        description: "Permite editar chamados em qualquer coluna do Kanban",
      },
      {
        key: "tickets.edit.aberto",
        label: "Editar chamados de Aberto",
        description: "Permite editar chamados da coluna Aberto",
      },
      {
        key: "tickets.edit.em_andamento",
        label: "Editar chamados de Em Andamento",
        description: "Permite editar chamados da coluna Em Andamento",
      },
      {
        key: "tickets.edit.aguardando",
        label: "Editar chamados de Aguardando",
        description: "Permite editar chamados da coluna Aguardando",
      },
      {
        key: "tickets.edit.resolvido",
        label: "Editar chamados de Resolvido",
        description: "Permite editar chamados da coluna Resolvido",
      },
      {
        key: "tickets.edit.fechado",
        label: "Editar chamados de Fechado",
        description: "Permite editar chamados da coluna Fechado",
      },
    ],
  },
  {
    id: "editar_atribuicao",
    label: "Editar por atribuição",
    description:
      "Restringe a edição de chamados conforme o responsável. Se \"Editar apenas chamados atribuídos a mim\" estiver marcado, o usuário só edita chamados em que ele é o responsável (\"Atribuído a\"). Com nenhuma restrição marcada, ele pode editar chamados de qualquer responsável (comportamento padrão).",
    permissions: [
      {
        key: "tickets.edit.own",
        label: "Editar apenas chamados atribuídos a mim",
        description:
          "Permite editar somente chamados em que o usuário é o responsável",
      },
      {
        key: "tickets.edit.unassigned",
        label: "Editar chamados sem responsável",
        description:
          "Permite editar também chamados que ainda não têm responsável atribuído",
      },
    ],
  },
  {
    id: "visualizar_atribuicao",
    label: "Visualizar por atribuição",
    description:
      "Restringe a visualização de chamados conforme o responsável. Se \"Visualizar apenas chamados atribuídos a mim\" estiver marcado, o usuário só vê no Kanban (e ao abrir um chamado) aqueles em que ele é o responsável (\"Atribuído a\"). Com nenhuma restrição marcada, ele vê chamados de qualquer responsável (comportamento padrão).",
    permissions: [
      {
        key: "tickets.view.own",
        label: "Visualizar apenas chamados atribuídos a mim",
        description:
          "Permite visualizar somente chamados em que o usuário é o responsável",
      },
      {
        key: "tickets.view.unassigned",
        label: "Visualizar chamados sem responsável",
        description:
          "Permite visualizar também chamados que ainda não têm responsável atribuído",
      },
    ],
  },
  {
    id: "kanban",
    label: "Mover no Kanban",
    description:
      "Se \"Mover no Kanban (todas as colunas)\" estiver marcado, o usuário pode mover para qualquer coluna. Caso contrário, marque individualmente as colunas permitidas.",
    permissions: [
      {
        key: "tickets.move",
        label: "Mover no Kanban (todas as colunas)",
        description: "Permite mover chamados para qualquer coluna",
      },
      {
        key: "tickets.move.aberto",
        label: "Mover para Aberto",
        description: "Permite mover chamados para a coluna Aberto",
      },
      {
        key: "tickets.move.em_andamento",
        label: "Mover para Em Andamento",
        description: "Permite mover chamados para a coluna Em Andamento",
      },
      {
        key: "tickets.move.aguardando",
        label: "Mover para Aguardando",
        description: "Permite mover chamados para a coluna Aguardando",
      },
      {
        key: "tickets.move.resolvido",
        label: "Mover para Resolvido",
        description: "Permite mover chamados para a coluna Resolvido",
      },
      {
        key: "tickets.move.fechado",
        label: "Mover para Fechado",
        description: "Permite mover chamados para a coluna Fechado",
      },
    ],
  },
  {
    id: "painel",
    label: "Painel",
    permissions: [
      {
        key: "metrics.view",
        label: "Ver métricas",
        description: "Visualizar os indicadores e relatórios do sistema",
      },
    ],
  },
  {
    id: "relatorios",
    label: "Relatórios",
    description:
      "Acesso ao módulo de Relatórios (chamados, desempenho por técnico, produtividade por setor, usuários e auditoria de notificações). Permitir apenas a quem realmente precisa: os relatórios expõem a base inteira de chamados.",
    permissions: [
      {
        key: "reports.view",
        label: "Ver relatórios",
        description:
          "Abrir a página Relatórios, aplicar filtros e ver os totais em tela",
      },
      {
        key: "reports.export",
        label: "Exportar relatórios",
        description: "Baixar os relatórios em XLS (Excel) e PDF",
      },
    ],
  },
  {
    id: "configuracoes",
    label: "Configurações",
    permissions: [
      {
        key: "settings.manage",
        label: "Gerenciar configurações",
        description:
          "Acessar as configurações (notificações, WhatsApp, técnicos)",
      },
      {
        key: "users.manage",
        label: "Gerenciar usuários",
        description:
          "Criar, editar, excluir usuários e gerenciar papéis e permissões",
      },
    ],
  },
];

export const ALL_PERMISSIONS: string[] = PERMISSION_GROUPS.flatMap((g) =>
  g.permissions.map((p) => p.key),
);

/** Permissões padrão do papel "Usuário Padrão". */
export const DEFAULT_USER_PERMISSIONS: string[] = [
  "tickets.view",
  "tickets.view.all",
  "tickets.create",
  "tickets.edit",
  "tickets.edit.all",
  "tickets.move",
  "tickets.move.aberto",
  "tickets.move.em_andamento",
  "tickets.move.aguardando",
  "tickets.move.resolvido",
  "metrics.view",
];

export function permissionLabel(key: string): string {
  for (const group of PERMISSION_GROUPS) {
    const def = group.permissions.find((p) => p.key === key);
    if (def) return def.label;
  }
  return key;
}

export function isAdmin(role?: string | null): boolean {
  return role === ADMIN_ROLE;
}

export function canMoveTo(
  permissions: string[],
  status: string,
): boolean {
  if (permissions.includes("tickets.move")) return true;
  return permissions.includes(`tickets.move.${status}`);
}

export function canMoveAny(permissions: string[]): boolean {
  if (permissions.includes("tickets.move")) return true;
  return TICKET_STATUSES.some((s) => permissions.includes(`tickets.move.${s}`));
}

/** O usuário pode visualizar chamados de um status/coluna específico? */
export function canViewStatus(
  permissions: string[],
  status: string,
): boolean {
  if (permissions.includes("tickets.view.all")) return true;
  // Sem restrição por coluna configurada → vê tudo (compatível com papéis antigos).
  if (!hasStatusViewRestriction(permissions)) return true;
  return permissions.includes(`tickets.view.${status}`);
}

/** O usuário tem alguma restrição de visualização por status configurada? */
export function hasStatusViewRestriction(permissions: string[]): boolean {
  return TICKET_STATUSES.some((s) => permissions.includes(`tickets.view.${s}`));
}

/** O usuário pode editar chamados de um status/coluna específico? */
export function canEditStatus(
  permissions: string[],
  status: string,
): boolean {
  if (permissions.includes("tickets.edit.all")) return true;
  // Sem restrição de edição por coluna configurada → pode editar todos
  // (compatível com papéis antigos).
  if (!hasStatusEditRestriction(permissions)) return true;
  return permissions.includes(`tickets.edit.${status}`);
}

/** O usuário tem alguma restrição de edição por status configurada? */
export function hasStatusEditRestriction(permissions: string[]): boolean {
  return TICKET_STATUSES.some((s) => permissions.includes(`tickets.edit.${s}`));
}

/** O usuário tem alguma restrição de edição por atribuição configurada? */
export function hasEditAssignmentRestriction(
  permissions: string[],
): boolean {
  return (
    permissions.includes("tickets.edit.own") ||
    permissions.includes("tickets.edit.unassigned")
  );
}

/** O usuário tem alguma restrição de visualização por atribuição configurada? */
export function hasViewAssignmentRestriction(
  permissions: string[],
): boolean {
  return (
    permissions.includes("tickets.view.own") ||
    permissions.includes("tickets.view.unassigned")
  );
}

/**
 * Regra completa de visualização de um chamado: status + atribuição (espelha
 * canEditTicket). `assigneeId` pode ser um id de usuário ou de técnico;
 * `assigneeName`/`userName` permitem casar por nome quando o responsável é um
 * técnico (cadastro separado do usuário). Sem restrição de atribuição
 * configurada, vale apenas a regra de status (comportamento padrão).
 */
export function canViewTicket(
  permissions: string[],
  status: string,
  assigneeId: string | null | undefined,
  userId: string | null | undefined,
  assigneeName?: string | null,
  userName?: string | null,
  isAdminRole = false,
): boolean {
  if (!canViewStatus(permissions, status)) return false;
  // Administradores têm poder total: a restrição por atribuição não se aplica.
  if (isAdminRole) return true;
  if (!hasViewAssignmentRestriction(permissions)) return true;
  const isOwn =
    (!!userId && assigneeId === userId) ||
    namesMatch(assigneeName, userName);
  const isUnassigned = !assigneeId;
  if (permissions.includes("tickets.view.own") && isOwn) return true;
  if (permissions.includes("tickets.view.unassigned") && isUnassigned) {
    return true;
  }
  return false;
}

/** Compara dois nomes ignorando caixa e espaços (ex.: usuário × técnico). */
export function namesMatch(
  a?: string | null,
  b?: string | null,
): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Regra completa de edição de um chamado: status + atribuição.
 * `assigneeId` pode ser um id de usuário ou de técnico; `userId` é o id do
 * usuário logado e `assigneeName`/`userName` permitem casar por nome quando o
 * responsável é um técnico (cadastro separado do usuário). Sem restrição de
 * atribuição configurada, vale apenas a regra de status (comportamento padrão).
 */
export function canEditTicket(
  permissions: string[],
  status: string,
  assigneeId: string | null | undefined,
  userId: string | null | undefined,
  assigneeName?: string | null,
  userName?: string | null,
  isAdminRole = false,
): boolean {
  if (!canEditStatus(permissions, status)) return false;
  // Administradores têm poder total: a restrição por atribuição não se aplica,
  // então podem editar (inclusive o campo "Atribuída a") de qualquer chamado.
  if (isAdminRole) return true;
  if (!hasEditAssignmentRestriction(permissions)) return true;
  const isOwn =
    (!!userId && assigneeId === userId) ||
    namesMatch(assigneeName, userName);
  const isUnassigned = !assigneeId;
  if (permissions.includes("tickets.edit.own") && isOwn) return true;
  if (permissions.includes("tickets.edit.unassigned") && isUnassigned) {
    return true;
  }
  return false;
}