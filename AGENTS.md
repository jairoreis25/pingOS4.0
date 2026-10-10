# AGENTS.md — Modo Dev Sênior · pingOS4.0

> Contrato de trabalho para qualquer dev **ou agente de IA** que altere este repositório.
> Leia antes de escrever código. Vale para `src/`, `server/`, `hermes/`, infra e docs.

## 1. Protocolo de trabalho

1. **Leia antes de editar** — arquivo inteiro, não só o trecho do grep.
2. **Escopo declarado e mínimo** — mudança cirúrgica; nada de refactor "de passagem".
3. **Uma intenção = um commit**, mensagem em pt-BR no imperativo (`corrige`, `adiciona`, `remove`).
4. **Nunca** commitar/push sem pedido explícito do dono do repositório.
5. **Nunca** usar `--no-verify`, `--force` em `main`, nem editar `bun.lock` à mão.
6. **Nunca** versionar segredo (ver §5). `VITE_*` é público: vai para o bundle.
7. Antes de dizer "pronto": rode os gates do §3 e cole o resultado real.

## 2. Comandos canônicos

| Objetivo                              | Comando                             | Porta |
| ------------------------------------- | ----------------------------------- | ----- |
| Dependências (igual ao Docker)        | `bun install --frozen-lockfile`     | —     |
| Frontend (Vite)                       | `bun run dev`                       | 5173  |
| API + MySQL (carrega `mysql-api.env`) | `bun run mysql:api`                 | 4000  |
| Banco: schema, papéis, 1º admin       | `bun run mysql:seed`                | 3306  |
| Ponte WhatsApp (Baileys)              | `bun run whatsapp`                  | 3001  |
| Bot Telegram "Ping IA"                | `bun run bot-ia`                    | —     |
| Tipos (app + backend)                 | `bun run typecheck`                 | —     |
| Lint                                  | `bun run lint`                      | —     |
| Formatação (verificação)              | `bun run format:check`              | —     |
| **Gate rápido**                       | `bun run verify` (typecheck + lint) | —     |
| Build de produção                     | `bun run build`                     | —     |

Empacotador: **bun** (lock vigente `bun.lock`). `package-lock.json` foi removido por estar obsoleto (ainda listava Convex) — não recriar com `npm install`.

## 3. Definition of Done (bloqueia merge)

```
bun install --frozen-lockfile && bun run verify && bun run build && bun run format:check
```

- [ ] `typecheck` verde (app **e** `server/tsconfig.json`)
- [ ] `lint` sem erros (warnings tolerados, mas justificados)
- [ ] `build` verde
- [ ] `format:check` verde
- [ ] Nenhum `any`, `@ts-ignore` ou `eslint-disable` novo sem comentário de motivo
- [ ] Rota nova: autenticação + autorização + validação + erro tipado (§6)
- [ ] Mudou comportamento? `README.md` / `RODAR.md` / `MYSQL.md` / `DOKPLOY.md` atualizados
- [ ] Nenhum segredo, token ou senha no diff
- [ ] Testes: quando existirem para o módulo tocado, eles passam (hoje **não há suíte** — ver §7)

## 4. Mapa do projeto

```
index.html          → carrega /config.js (runtime) e o bundle
src/                → React 19 + Vite + Tailwind 4 + shadcn/ui
  main.tsx          → rotas (6), error boundaries, ThemeProvider
  pages/            → Landing, Auth, Dashboard(Kanban), Reports, PublicTicket
  components/       → dialogs de negócio + ui/ (primitivos shadcn)
  lib/backend/      → camada de dados (api.ts registra operações; react.ts = useQuery/useMutation)
  lib/mysql-api.ts  → transporte HTTP real (apiFetch, dedupe de GET, ApiClientError)
  lib/permissions.ts→ FONTE ÚNICA de permissões (usada pelo front E pelo back)
server/             → Express + mysql2 (bun run mysql:api, porta 4000)
  api/index.ts      → middlewares, montagem das rotas, /uploads estático
  api/routes/       → tickets, users, roles, technicians, metrics, reports, uploads, backups…
  api/auth.ts       → sessão por token opaco (tabela sessions) + scrypt
  mysql/schema.sql  → 19 tabelas (tickets, users, sessions, roles, notifications, backups…)
  whatsapp-web-server.ts → ponte Baileys (porta 3001), painel HTML próprio
hermes/bot-ia.ts    → bot Telegram (3251 linhas; o maior arquivo do repo)
nginx.conf          → serve o app e faz proxy de /api, /uploads, /whatsapp-api
docker-compose.yml  → Dokploy | docker-compose.local.yml → stack local (app 8090, api 4000)
```

Modelo de dados: `tickets` é o núcleo; `assignee_id` **não tem FK** (aponta para `users` ou `technicians`, discriminado por `assignee_type`). Config singleton: `notification_settings`, `bot_config`, `bot_personalidades`. Auditoria: `audit_log`, `ticket_status_events`.

## 5. Invariantes de segurança (não negociáveis)

1. **Toda rota nova nasce autenticada** (`requireAuth`/`requirePermission`/`requireAdmin`).
   As exceções atuais estão listadas como P0 em `docs/REVISAO-SENIOR.md` e só podem **diminuir**.
2. **Segredo vive em variável de ambiente.** Proibido literal em código (`HERMES_SECRET_ADMIN_KEY_2026` é dívida a remover).
3. **Permissão se decide em `src/lib/permissions.ts`** — nunca duplicar regra de acesso no componente.
4. **Erro interno não vaza**: responder `ApiError` com status; `error.message` cru só no log do servidor.
5. **Escrita multi-etapa usa `withTransaction`** (`server/mysql/pool.ts`).
6. **Upload valida conteúdo**, não o `Content-Type` declarado; nunca servir arquivo de usuário sem autorização.
7. **CORS fechado em produção** (`CORS_ORIGIN` definido); a API não deve ficar publicamente exposta atrás do nginx.
8. **Comparação de segredo com `timingSafeEqual`**, nunca `===`.

## 6. Convenções de código

- **TypeScript strict** (`tsconfig.app.json`, `server/tsconfig.json`). Proibido `any` novo; use `unknown` + narrowing.
- **Validação de entrada com `zod`** (já é dependência) em todo body/query novo; nada de `String(raw)` silencioso.
- **SQL sempre com placeholder `?`**; identificador dinâmico (coluna/ordem) só via whitelist ou regex.
- **React**: componente < 300 linhas; extraia hooks para `src/hooks/` e helpers para `src/lib/`.
- **Dados**: use `src/lib/backend/*` (`apiFetch`). `fetch` cru novo é proibido (perde dedupe, tratamento de 401 e mensagem padrão).
- **Efeitos**: sempre com cleanup; `setState` dentro de `useEffect` só quando inevitável (regra `react-hooks/set-state-in-effect` está como `warn` — não aumentar a lista).
- **Acessibilidade**: botão só-ícone precisa de `aria-label` (não basta `title`).
- **Idioma**: nomes de arquivo/função/variável em inglês; texto de UI em pt-BR.

## 7. Baseline dos gates e dívida

Medido nesta máquina em **2026-10-10** (Node 24.20.0, bun 1.4.2):

| Gate                 | Estado                                                                              |
| -------------------- | ----------------------------------------------------------------------------------- |
| `tsc -b` (app)       | verde — exigiu `react-day-picker` 9.14.0 (9.13.0 não exporta `DayButton`)           |
| `tsc -p server`      | verde                                                                               |
| `eslint .`           | verde (warnings de `set-state-in-effect` em burn-down)                              |
| `prettier --check .` | verde após baseline de formatação (`.prettierrc`: `semi: false`, `printWidth: 100`) |
| `vite build`         | verde                                                                               |
| Testes               | **ausentes** — dívida P0 (sem vitest/jest/playwright)                               |
| CI                   | `.github/workflows/ci.yml` (criado)                                                 |
| Docker/Dokploy       | **não validado** nesta máquina (sem Docker instalado)                               |

Backlog priorizado, com evidência `arquivo:linha`: **[docs/REVISAO-SENIOR.md](docs/REVISAO-SENIOR.md)**.

## 8. Proibido

- Commitar `node_modules/`, `dist/`, `uploads/`, `backups/`, `.env*` (exceto `.env.example`).
- Rodar migração/seed apontando para banco de produção.
- Subir containers ou publicar deploy sem pedido explícito.
- Duplicar regra de negócio que já vive em `src/lib/` (permissões, status, categorias, relatórios).
- "Consertar" lint desligando regra sem registrar a dívida e a condição de reversão.
