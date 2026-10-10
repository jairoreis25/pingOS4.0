import "@vly-ai/integrations"
import { ThemeProvider } from "next-themes"
import { Toaster } from "@/components/ui/sonner"
import { RequireAuth } from "@/components/RequireAuth"
import { VlyToolbar } from "../vly-toolbar-readonly.tsx"
import React, { StrictMode, useEffect, lazy, Suspense } from "react"
import { createRoot } from "react-dom/client"
import { BrowserRouter, Route, Routes, useLocation } from "react-router"
import "./index.css"

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"))
const AuthPage = lazy(() => import("./pages/Auth.tsx"))
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"))
const Reports = lazy(() => import("./pages/Reports.tsx"))
const PublicTicket = lazy(() => import("./pages/PublicTicket.tsx"))
const NotFound = lazy(() => import("./pages/NotFound.tsx"))

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading...</div>
    </div>
  )
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in WebContainer environment). */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false }
  static getDerivedStateFromError() {
    return { hasError: true }
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message)
  }
  render() {
    return this.state.hasError ? null : this.props.children
  }
}

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" }
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    }
  }
  componentDidCatch(err: Error) {
    console.error("[WebContainer preview] Root crash:", err)
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">{this.state.message}</p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

// O backend é a API Express + MySQL, acessada pelo adaptador src/lib/backend/*.
// A URL base vem do /config.js gerado pelo container (runtime) ou do
// VITE_API_URL embutido no build; vazia significa "mesma origem" (o nginx
// repassa /api para o container `api`). Não há provider global: a sessão vive no
// localStorage + no store de src/lib/backend/session.ts.
function RouteSyncer() {
  const location = useLocation()
  useEffect(() => {
    window.parent.postMessage({ type: "iframe-route-change", path: location.pathname }, "*")
  }, [location.pathname])

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back()
        if (event.data.direction === "forward") window.history.forward()
      }
    }
    window.addEventListener("message", handleMessage)
    return () => window.removeEventListener("message", handleMessage)
  }, [])

  return null
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ToolbarErrorBoundary>
        <VlyToolbar />
      </ToolbarErrorBoundary>
      {/* Tema claro/escuro: aplica a classe `dark` no <html> (ver src/index.css).
          `system` é o padrão, então quem nunca escolheu segue o tema do
          aparelho; a escolha é salva em localStorage pelo next-themes. */}
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        storageKey="pingos-theme"
      >
        <BrowserRouter>
          <RouteSyncer />
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/auth" element={<AuthPage redirectAfterAuth="/dashboard" />} />
              <Route
                path="/dashboard"
                element={
                  <RequireAuth>
                    <Dashboard />
                  </RequireAuth>
                }
              />
              <Route
                path="/reports"
                element={
                  <RequireAuth>
                    <Reports />
                  </RequireAuth>
                }
              />
              <Route path="/chamado/novo" element={<PublicTicket />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster />
      </ThemeProvider>
    </RootErrorBoundary>
  </StrictMode>,
)
