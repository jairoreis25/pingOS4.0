import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ArrowRight, ArrowRightLeft } from "lucide-react"

/**
 * Mensagem de confirmação exibida sempre que um chamado muda de status.
 *
 * O movimento por arrastar-e-soltar e o clique nos botões de status do chamado
 * pedem confirmação antes de gravar, para que um arraste acidental no Kanban não
 * mude o status do chamado sem intenção.
 *
 * O nome do solicitante aparece junto do número para que quem confirma saiba de
 * quem é o chamado — o arraste no Kanban é feito no card, mas a confirmação é
 * uma tela separada.
 */
export default function StatusChangeConfirmDialog({
  open,
  onOpenChange,
  ticketLabel,
  requesterName,
  fromLabel,
  toLabel,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Ex.: "chamado #12 · Impressora sem rede" */
  ticketLabel?: string
  /** Solicitante do chamado (mesmo campo exibido no cartão e no cupom). */
  requesterName?: string
  /** Status atual do chamado, quando conhecido. */
  fromLabel?: string
  /** Status de destino. */
  toLabel: string
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-md rounded-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <ArrowRightLeft className="size-4 text-primary" />
            </span>
            Confirmar alteração de status
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 pt-1">
              <p>
                Você está alterando o status d{ticketLabel ? "o" : "este"}{" "}
                {ticketLabel ? (
                  <span className="font-medium text-foreground">{ticketLabel}</span>
                ) : (
                  "chamado"
                )}
                .
              </p>
              <div className="flex items-center justify-center gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs font-medium">
                {fromLabel && (
                  <>
                    <span className="text-muted-foreground">{fromLabel}</span>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </>
                )}
                <span className="text-foreground font-semibold">{toLabel}</span>
              </div>
              {requesterName && (
                <p className="text-xs text-muted-foreground">
                  Solicitante: <span className="font-medium text-foreground">{requesterName}</span>
                </p>
              )}
              <p>Deseja confirmar esta alteração?</p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Sim, alterar status</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
