/**
 * Shim de `@convex-dev/auth/react`.
 *
 * Os componentes importam `useAuthActions` daqui em vez do pacote do Convex
 * Auth. O login/senha continua sendo usuário + senha, agora contra
 * `POST /api/auth/login` (scrypt + tabela `sessions` no MySQL).
 */

import type { ReactNode } from "react"

export { useAuthActions, useConvexAuth } from "./react"

/**
 * O Convex Auth exigia um provider em volta da árvore para injetar o cliente.
 * No backend HTTP não há cliente global: a sessão vive em `./session`. O
 * componente é mantido como pass-through para que o `main.tsx` continue legível
 * (e para o caso de alguém importar o provider de um exemplo antigo).
 */
export function ConvexAuthProvider({ children }: { children: ReactNode }) {
  return children
}
