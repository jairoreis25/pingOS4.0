import { Package, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  PRODUCT_SERVICE_TYPE_LABELS,
  type ProductServiceType,
} from "@/lib/products";

/**
 * Etiqueta do tipo de um item do catálogo: **Produto** (peça, equipamento) x
 * **Serviço** (mão de obra). Usada no cadastro em Configurações e no menu "/"
 * do chamado, para dar para bater o olho e saber o que se está lançando.
 */
export default function ItemTypeBadge({
  type,
  className,
}: {
  type: ProductServiceType;
  className?: string;
}) {
  const isProduct = type === "produto";
  const Icon = isProduct ? Package : Wrench;

  return (
    <span
      title={`Tipo: ${PRODUCT_SERVICE_TYPE_LABELS[type]}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        isProduct
          ? "border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
        className,
      )}
    >
      <Icon className="size-3" />
      {PRODUCT_SERVICE_TYPE_LABELS[type]}
    </span>
  );
}
