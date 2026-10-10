import { Button } from "@/components/ui/button"
import { useMutation, useQuery } from "@/lib/backend/react"
import { api } from "@/lib/backend/api"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

import { useAuth } from "@/hooks/use-auth"
import { ThemeToggle } from "@/components/ThemeToggle"
import logo from "@/assets/logo.svg"
import { ArrowRight, Headphones, Loader2, Lock, User as UserIcon } from "lucide-react"
import { Suspense, useEffect, useState } from "react"
import { useNavigate, useSearchParams } from "react-router"

interface AuthProps {
  redirectAfterAuth?: string
}

function resolveRedirectAfterAuth(returnTo: string | null, fallback = "/dashboard") {
  if (returnTo?.startsWith("/") && !returnTo.startsWith("//")) {
    return returnTo
  }
  return fallback
}

function Auth({ redirectAfterAuth }: AuthProps = {}) {
  const { isLoading: authLoading, isAuthenticated, user, signIn, signOut } = useAuth()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const redirect = resolveRedirectAfterAuth(searchParams.get("returnTo"), redirectAfterAuth)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Primeiro acesso: se o sistema ainda não tem admin nem contas de senha,
  // cria o admin inicial (admin/admin123) e avisa na tela.
  const systemStatus = useQuery(api.users.systemStatus)
  const seedFirstAdmin = useMutation(api.users.seedFirstAdmin)
  const needsBootstrap = systemStatus?.needsBootstrap === true
  // Mantém a dica visível durante toda a visita à página, mesmo depois do seed.
  const [bootstrapHint, setBootstrapHint] = useState<boolean | null>(null)
  useEffect(() => {
    if (bootstrapHint === null && systemStatus !== undefined) {
      setBootstrapHint(systemStatus.needsBootstrap)
    }
  }, [systemStatus, bootstrapHint])
  useEffect(() => {
    if (needsBootstrap) {
      seedFirstAdmin().catch(() => {
        // se falhar (ex.: alguém já criou), o status reativa e some sozinho
      })
    }
  }, [needsBootstrap, seedFirstAdmin])

  // Usuário inativo (desativado pelo admin) é deslogado e avisado.
  useEffect(() => {
    if (!authLoading && isAuthenticated && user && user.active === false) {
      void signOut()
      setError("Usuário inativo. Contate o administrador.")
      return
    }
    if (!authLoading && isAuthenticated) {
      navigate(redirect)
    }
  }, [authLoading, isAuthenticated, user, navigate, redirect, signOut])

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setIsLoading(true)
    setError(null)
    try {
      await signIn("password", {
        flow: "signIn",
        email: username.trim(),
        password,
      })
      // isAuthenticated atualiza via subscription; o redirect acontece no effect
    } catch (err) {
      console.error("Login error:", err)
      const msg = err instanceof Error ? err.message : "Falha ao entrar. Tente novamente."
      setError(
        msg.toLowerCase().includes("invalid") || msg.toLowerCase().includes("credentials")
          ? "Usuário ou senha inválidos."
          : msg,
      )
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      {/* Tema disponível já na entrada (mesmo antes de fazer login) */}
      <ThemeToggle className="fixed right-3 top-3 z-40" />
      {/* Auth Content */}
      <div className="flex-1 flex items-center justify-center px-4 py-10">
        <Card className="w-full max-w-[420px] border-border/50 shadow-xl shadow-primary/[0.03]">
          <CardHeader className="text-center pt-8">
            <div className="flex justify-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-primary mb-2">
                <img
                  src={logo}
                  alt="PingOS"
                  width={36}
                  height={36}
                  className="cursor-pointer brightness-0 invert"
                  onClick={() => navigate("/")}
                />
              </div>
            </div>
            <CardTitle className="text-xl">Entrar no PingOS</CardTitle>
            <CardDescription>Acesse com seu nome de usuário e senha</CardDescription>
          </CardHeader>
          <form onSubmit={handleLogin}>
            <CardContent className="space-y-4 pt-2">
              {" "}
              {bootstrapHint === true && (
                <div className="rounded-lg border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-200 space-y-1">
                  <p className="font-semibold">Primeiro acesso</p>
                  <p>
                    Use <b>admin</b> / <b>admin123</b> para entrar e depois troque a senha e crie os
                    usuários da equipe em Configurações → Usuários.
                  </p>
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="username" className="text-xs text-muted-foreground">
                  Nome de usuário
                </Label>
                <div className="relative">
                  <UserIcon className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input
                    id="username"
                    name="username"
                    placeholder="seu.usuario"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="pl-9"
                    disabled={isLoading}
                    required
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="password" className="text-xs text-muted-foreground">
                  Senha
                </Label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                  <Input
                    id="password"
                    name="password"
                    placeholder="••••••••"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="pl-9"
                    disabled={isLoading}
                    required
                  />
                </div>
              </div>
              {error && (
                <p className="text-sm text-red-500 bg-red-50 dark:bg-red-950/40 rounded-md px-3 py-2 border border-red-200/60 dark:border-red-900/50">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full gap-1.5"
                disabled={isLoading || !username.trim() || !password}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Entrando...
                  </>
                ) : (
                  <>
                    Entrar
                    <ArrowRight className="size-4" />
                  </>
                )}
              </Button>
              <div className="text-center">
                <a
                  href="/chamado/novo"
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors underline underline-offset-2"
                >
                  Abrir chamado sem login
                </a>
              </div>
            </CardContent>
          </form>
          <CardFooter className="flex-col">
            <div className="w-full py-3 px-4 text-xs text-center text-muted-foreground bg-muted border-t rounded-b-lg">
              Contas criadas somente pelo administrador do sistema.
            </div>
          </CardFooter>
        </Card>
      </div>

      {/* Footer */}
      <footer className="border-t border-border/40 py-4">
        <div className="mx-auto max-w-md px-4 sm:px-6 flex flex-col items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-6 items-center justify-center rounded-md bg-primary">
              <Headphones className="size-3 text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground">PingOS</span>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            © {new Date().getFullYear()} PingOS. Desenvolvido por Jairo Reis.
          </p>
        </div>
      </footer>
    </div>
  )
}

export default function AuthPage(props: AuthProps) {
  return (
    <Suspense>
      <Auth {...props} />
    </Suspense>
  )
}
