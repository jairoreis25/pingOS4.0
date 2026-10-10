/**
 * Configuração de runtime do frontend.
 *
 * Por que existe: as variáveis `VITE_*` são resolvidas pelo Vite em **tempo de
 * build** (`import.meta.env.VITE_X` vira uma string literal dentro do bundle).
 * Isso significa que trocar a URL da API — ou da ponte do WhatsApp — exigia
 * reconstruir a imagem Docker inteira.
 *
 * Para evitar isso, o container do nginx gera `/config.js` na inicialização
 * (`config.js.template` + `docker-entrypoint.sh`), e o `index.html` carrega
 * esse arquivo **antes** do bundle. Assim a ordem de resolução é:
 *
 *   1. `window.__PINGOS_CONFIG__`  ← variáveis do container (runtime)
 *   2. `import.meta.env.VITE_*`    ← valores do build (fallback)
 *
 * Trocar de endereço/ambiente em produção passa a ser: editar a variável na aba
 * Environment e **reiniciar** o serviço — sem rebuild.
 *
 * Em desenvolvimento (Vite) e no preview da plataforma, `public/config.js`
 * está vazio, então tudo continua vindo do `.env.local` como antes.
 */

export interface PingosRuntimeConfig {
  apiUrl?: string;
  whatsappWebUrl?: string;
}

/** Lê o objeto injetado pelo `/config.js` (vazio quando ausente). */
function runtime(): PingosRuntimeConfig {
  if (typeof window === "undefined") return {};
  const scope = window as unknown as { __PINGOS_CONFIG__?: PingosRuntimeConfig };
  return scope.__PINGOS_CONFIG__ ?? {};
}

/** Valor de runtime quando preenchido; senão o valor embutido no build. */
function pick(
  runtimeValue: string | undefined,
  envValue: string | undefined,
): string {
  const fromRuntime = (runtimeValue ?? "").trim();
  if (fromRuntime) return fromRuntime;
  return (envValue ?? "").trim();
}

const injected = runtime();

/** Configuração efetiva do frontend (runtime → build). */
export const runtimeConfig = {
  /** URL base da API (vazio = mesma origem, via proxy do nginx). */
  apiUrl: pick(injected.apiUrl, import.meta.env.VITE_API_URL as string | undefined),
  /** URL de uma ponte WhatsApp externa (vazio = proxy same-origin). */
  whatsappWebUrl: pick(
    injected.whatsappWebUrl,
    import.meta.env.VITE_WHATSAPP_WEB_URL as string | undefined,
  ),
};

/** True quando os valores vieram do `config.js` gerado pelo container. */
export function usingRuntimeConfig(): boolean {
  return Object.keys(injected).some((key) =>
    Boolean((injected[key as keyof PingosRuntimeConfig] ?? "").trim()),
  );
}
