import { useMemo } from "react";
import { api } from "@/lib/backend/api";
import { useQuery } from "@/lib/backend/react";
import {
  canMoveTo as canMoveToHelper,
  canMoveAny as canMoveAnyHelper,
  canViewStatus as canViewStatusHelper,
  canEditStatus as canEditStatusHelper,
  canEditTicket as canEditTicketHelper,
  canViewTicket as canViewTicketHelper,
} from "@/lib/permissions";

/**
 * Permissões efetivas do usuário logado.
 *
 * Tudo sai de um único `useMemo`: as funções `can*` só trocam de identidade
 * quando o próprio backend responde algo diferente. Isso é o que permite ao
 * `Dashboard` memoizar as colunas visíveis e ao `KanbanColumn` (`React.memo`)
 * parar de re-renderizar a cada mudança de estado da tela.
 */
export function usePermissions() {
  const data = useQuery(api.permissions.effective);

  return useMemo(() => {
    const permissions = data?.permissions ?? [];
    const userId = data?.userId ?? null;
    const userName = data?.name ?? null;
    const isAdmin = data?.isAdmin ?? false;
    const role = data?.role ?? null;

    return {
      isLoading: data === undefined,
      isAdmin,
      role,
      active: data?.active ?? true,
      userId,
      userName,
      permissions,
      can: (key: string) => permissions.includes(key),
      canMoveTo: (status: string) => canMoveToHelper(permissions, status),
      canMoveAny: () => canMoveAnyHelper(permissions),
      canViewStatus: (status: string) =>
        canViewStatusHelper(permissions, status),
      canEditStatus: (status: string) =>
        canEditStatusHelper(permissions, status),
      canViewTicket: (
        status: string,
        assigneeId?: string | null,
        assigneeName?: string | null,
      ) =>
        canViewTicketHelper(
          permissions,
          status,
          assigneeId,
          userId,
          assigneeName,
          userName,
          isAdmin,
        ),
      canEditTicket: (
        status: string,
        assigneeId?: string | null,
        assigneeName?: string | null,
      ) =>
        canEditTicketHelper(
          permissions,
          status,
          assigneeId,
          userId,
          assigneeName,
          userName,
          isAdmin,
        ),
    };
  }, [data]);
}
