import { useMemo } from "react";
import { api } from "@/lib/backend/api";
import { useAuthActions } from "@/lib/backend/auth";
import { useConvexAuth, useQuery } from "@/lib/backend/react";

/**
 * Sessão do usuário logado.
 *
 * O objeto devolvido é memoizado: sem isso cada render do consumidor (o
 * `Dashboard` renderiza a cada tecla digitada na busca) entregava referências
 * novas e derrubava qualquer `useMemo`/`React.memo` que dependesse daqui.
 */
export function useAuth() {
  const { isLoading: isAuthLoading, isAuthenticated } = useConvexAuth();
  const user = useQuery(api.users.currentUser);
  const { signIn, signOut } = useAuthActions();

  // Deriva o carregamento das próprias dependências, sem estado paralelo.
  const isLoading = isAuthLoading || user === undefined;

  return useMemo(
    () => ({ isLoading, isAuthenticated, user, signIn, signOut }),
    [isLoading, isAuthenticated, user, signIn, signOut],
  );
}
