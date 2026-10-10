// Alertas sonoros do painel — gerados via Web Audio API (sem arquivos de áudio).
//
// Navegadores bloqueiam áudio até a primeira interação do usuário e suspendem
// o AudioContext em abas em segundo plano. Para o alerta soar para TODOS os
// chamados novos recebidos, os alertas que não puderem tocar no momento ficam
// enfileirados e são reproduzidos assim que o áudio ficar disponível
// (primeira interação ou ao voltar para a aba).

const STORAGE_KEY = "pingos_sound_alerts"
const MAX_BATCH = 3 // evita rajada de sons com muitos chamados de uma vez

export function isSoundEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== "off"
  } catch {
    return true
  }
}

export function setSoundEnabled(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "on" : "off")
  } catch {
    // armazenamento indisponível — segue com o padrão (som ligado)
  }
}

let audioCtx: AudioContext | null = null
let pending: ("open" | "closed" | "resolved")[] = []

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AC) return null
  if (!audioCtx) {
    audioCtx = new AC()
    // Assim que o contexto sair de "suspended", toca o que ficou pendente.
    audioCtx.onstatechange = () => {
      if (audioCtx?.state === "running") flush()
    }
  }
  if (audioCtx.state === "suspended") void audioCtx.resume()
  return audioCtx
}

function tone(
  ctx: AudioContext,
  freq: number,
  startOffset: number,
  duration: number,
  volume = 0.2,
): void {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = "sine"
  osc.frequency.value = freq
  const t0 = ctx.currentTime + startOffset
  gain.gain.setValueAtTime(0.0001, t0)
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.02)
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration)
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start(t0)
  osc.stop(t0 + duration + 0.05)
}

/** Agenda um alerta (com offsets para tocar em sequência). */
function scheduleChime(
  ctx: AudioContext,
  kind: "open" | "closed" | "resolved",
  offset: number,
): void {
  if (kind === "open") {
    // C5 → E5: "chamado novo"
    tone(ctx, 523.25, offset, 0.18)
    tone(ctx, 659.25, offset + 0.12, 0.26)
  } else if (kind === "resolved") {
    // C5 → E5 → G5 (arpejo): "chamado resolvido"
    tone(ctx, 523.25, offset, 0.14)
    tone(ctx, 659.25, offset + 0.1, 0.14)
    tone(ctx, 783.99, offset + 0.2, 0.28)
  } else {
    // E5 → C5: "chamado fechado"
    tone(ctx, 659.25, offset, 0.18)
    tone(ctx, 523.25, offset + 0.12, 0.3)
  }
}

/** Toca os alertas pendentes (até MAX_BATCH por vez). */
function flush(): void {
  if (pending.length === 0) return
  if (!isSoundEnabled()) {
    pending = []
    return
  }
  const ctx = getCtx()
  if (!ctx) return
  if (ctx.state !== "running") {
    void ctx.resume() // onstatechange re-dispara o flush
    return
  }
  const batch = pending.splice(0, Math.min(pending.length, MAX_BATCH))
  let offset = 0
  for (const kind of batch) {
    scheduleChime(ctx, kind, offset)
    offset += 0.3
  }
}

// Destrava o áudio na primeira interação e toca o que ficou pendente.
if (typeof window !== "undefined") {
  const unlock = () => {
    void getCtx()
    flush()
  }
  window.addEventListener("pointerdown", unlock, { once: true })
  window.addEventListener("keydown", unlock, { once: true })
  // Ao voltar para a aba (o áudio volta a rodar), toca os alertas recebidos.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") flush()
  })
}

/**
 * Enfileira um alerta de chamado aberto/fechado/resolvido e tenta tocar
 * imediatamente. Se o áudio ainda estiver bloqueado, o alerta é tocado assim
 * que possível — garantindo que TODOS os chamados novos recebidos no painel
 * soem.
 */
export function playTicketAlert(kind: "open" | "closed" | "resolved"): void {
  pending.push(kind)
  flush()
}
