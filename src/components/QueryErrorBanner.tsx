import { AlertTriangle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * Aviso padrão para query que falhou, com botão de tentar novamente.
 *
 * Existe porque uma query que falha antes deixava a tela presa em "carregando"
 * para sempre (o erro só ia para o console). Use com `useQueryState`.
 */
export function QueryErrorBanner({
  error,
  onRetry,
  label,
}: {
  error: unknown
  onRetry: () => void
  /** O que não pôde ser carregado, para a frase do aviso (ex.: "os chamados"). */
  label?: string
}) {
  const detail = error instanceof Error ? error.message : String(error ?? "")

  return (
    <div
      role="alert"
      className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm dark:border-red-900/60 dark:bg-red-950/40"
    >
      <div className="flex items-start gap-2 text-red-700 dark:text-red-200">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <p title={detail}>
          Não foi possível carregar {label ?? "os dados"}. Verifique a conexão com o servidor.
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshCw className="size-3.5" />
        Tentar novamente
      </Button>
    </div>
  )
}
