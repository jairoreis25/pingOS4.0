/**
 * Logo do PingOS (redesign iOS).
 *
 * Quadrado arredondado com gradiente azul→roxo, a letra "P" e um "ping": um ponto
 * com anel que pulsa, lembrando o sonar do nome. É puramente decorativo (o texto
 * ao lado carrega o nome acessível), então o quadrado fica `aria-hidden`.
 */

export function Logo({
  size = 32,
  withText = false,
  className = "",
}: {
  size?: number
  /** Mostra "PingOS" ao lado do ícone. */
  withText?: boolean
  className?: string
}) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <span
        aria-hidden="true"
        className="relative inline-flex shrink-0 items-center justify-center font-bold text-white select-none"
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.5),
          borderRadius: Math.max(8, Math.round(size * 0.375)),
          backgroundImage: "linear-gradient(135deg, #007AFF 0%, #5856D6 100%)",
          boxShadow: "0 1px 3px rgb(0 0 0 / 0.12), 0 6px 16px rgb(0 122 255 / 0.24)",
        }}
      >
        P{/* O "ping": ondas saindo do canto inferior direito. */}
        <span className="absolute -right-0.5 -bottom-0.5 flex size-2.5 items-center justify-center">
          <span className="absolute size-2.5 animate-ping rounded-full bg-white/70" />
          <span className="relative size-1.5 rounded-full border border-white/70 bg-white" />
        </span>
      </span>
      {withText && (
        <span className="text-ios-label text-base font-semibold tracking-[-0.01em]">PingOS</span>
      )}
    </span>
  )
}
