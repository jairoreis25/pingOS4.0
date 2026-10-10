# RevisÃ£o SÃªnior â€” pingOS4.0

**Data:** 2026-10-10 Â· **Escopo:** repositÃ³rio completo (`src/`, `server/`, `hermes/`, infra, docs) Â· **MÃ©todo:** leitura integral dos mÃ³dulos + gates executados localmente (Node 24.20.0, bun 1.4.2).

RelatÃ³rio consolidado de trÃªs auditorias paralelas (backend, frontend, infra/qualidade). Cada achado tem evidÃªncia `arquivo:linha` verificÃ¡vel. O que nÃ£o pÃ´de ser confirmado estÃ¡ marcado como **nÃ£o verificado**.

---

## 1. Baseline dos gates (medido, nÃ£o estimado)

| Gate                          | Antes                                                             | Depois desta sessÃ£o                               |
| ----------------------------- | ----------------------------------------------------------------- | -------------------------------------------------- |
| `tsc -b` (app)                | **6 erros** â€” `src/components/ui/calendar.tsx` (12,135,145,166) | verde                                              |
| `tsc -p server/tsconfig.json` | verde                                                             | verde                                              |
| `eslint .`                    | **50 erros / 16 warnings** em 27 arquivos                         | **0 erros / 31 warnings** (16 arquivos corrigidos) |
| `prettier --check .`          | **166 arquivos** fora do padrÃ£o                                  | verde (baseline aplicado)                          |
| `vite build`                  | nÃ£o rodava (bloqueado pelo `tsc`)                                | verde â€” 9,47 s                                   |
| Testes                        | ausentes                                                          | **ausentes** (dÃ­vida P0)                          |
| CI                            | ausente                                                           | `.github/workflows/ci.yml`                         |

Causa raiz do typecheck quebrado: `calendar.tsx:12` importa o tipo `DayButton`, exportado pelo `react-day-picker` a partir da **9.14.0**, mas `package.json:73` fixava `9.13.0`. CorreÃ§Ã£o: bump para `9.14.0`.

### CorreÃ§Ãµes aplicadas nesta sessÃ£o

| #   | CorreÃ§Ã£o                                                                                                                                                                                       | EvidÃªncia                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| 1   | `react-day-picker` 9.13.0 â†’ 9.14.0 (destrava `tsc -b` e o build)                                                                                                                               | `package.json`                                                                        |
| 2   | **Painel da ponte WhatsApp nÃ£o compilava**: o template literal interpretava `\n` e `\"`, emitindo strings JS quebradas em duas linhas â€” o `<script>` inteiro do painel caÃ­a em `SyntaxError` | `server/whatsapp-web-server.ts:540,548` (`\\n`), `:582` (aspas simples no `setError`) |
| 3   | 35 erros de lint zerados em 16 arquivos, sem `eslint-disable` novo (inclui `any` â†’ tipos precisos em `db-helpers.ts` e `tickets.ts`)                                                           | `eslint .` = 0 erros                                                                  |
| 4   | `.env`/`.env.*` passam a ser ignorados (o `.env` do Compose guarda senhas)                                                                                                                       | `.gitignore`                                                                          |
| 5   | `package-lock.json` obsoleto removido (listava Convex; o Docker usa `bun.lock`)                                                                                                                  | â€”                                                                                   |
| 6   | `.prettierrc` alinhado ao estilo real (`semi: false`, `printWidth: 100`) + baseline aplicado                                                                                                     | `.prettierrc`                                                                         |
| 7   | Gates novos: `typecheck`, `format:check`, `verify` + CI bloqueante                                                                                                                               | `package.json`, `.github/workflows/ci.yml`                                            |
| 8   | Contrato de trabalho sÃªnior e regras para agentes                                                                                                                                               | `AGENTS.md`                                                                           |

> VerificaÃ§Ã£o do item 2: o `PANEL_HTML` foi extraÃ­do e avaliado como o servidor faz; no commit anterior o `<script>` falhava em `node --check` (`SyntaxError: Invalid or unexpected token` na linha do `logs.join`), e depois da correÃ§Ã£o passa.

---

## 2. Arquitetura em uma pÃ¡gina

- **TrÃªs processos**: API Express+MySQL (`server/api`, 4000), ponte WhatsApp/Baileys (`server/whatsapp-web-server.ts`, 3001) e bot Telegram (`hermes/bot-ia.ts`, long polling). O front Ã© servido por nginx (`nginx.conf`), que tambÃ©m faz proxy de `/api`, `/uploads` e `/whatsapp-api`.
- **Frontend**: React 19 + Vite 7 + Tailwind 4 + shadcn/ui; 6 rotas com lazy loading (`src/main.tsx:132-156`); camada de dados prÃ³pria que imita a API do Convex (`src/lib/backend/api.ts`, `react.ts`) sobre `apiFetch` (`src/lib/mysql-api.ts:96`).
- **AutenticaÃ§Ã£o**: **sem JWT** â€” token opaco de 64 hex em `sessions`, enviado como `Authorization: Bearer`, validado em `server/api/auth.ts:83-103` (1 SELECT com JOIN + 1 SELECT de papel por requisiÃ§Ã£o: `server/api/permissions.ts:36-51`).
- **AutorizaÃ§Ã£o**: `src/lib/permissions.ts` Ã© fonte Ãºnica para front e back â€” ponto forte, evita duas verdades.
- **Banco**: MySQL 8/MariaDB, 19 tabelas (`server/mysql/schema.sql`); `tickets` Ã© o nÃºcleo, com `assignee_id` **sem FK** (aponta para `users` ou `technicians` conforme `assignee_type`, `schema.sql:118-121`). MigraÃ§Ãµes idempotentes em `server/mysql/migrate.ts`.
- **Deploy**: `docker-compose.yml` (Dokploy) e `docker-compose.local.yml` (stack local: app 8090, api 4000, mysql 3307).

---

## 3. P0 â€” bloqueadores (corrigir antes de qualquer feature)

| #   | Achado                                                                        | EvidÃªncia                                                                                                         | Impacto                                                                                 | AÃ§Ã£o                                                                                                                           |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Ponte WhatsApp sem autenticaÃ§Ã£o e com CORS aberto**, publicada pelo nginx | `server/whatsapp-web-server.ts:42` (+ rotas em `:272,:288,:296,:304,:374,:656`), `nginx.conf:47-56`                | Qualquer origem envia mensagens pelo nÃºmero pareado, pausa, desloga e limpa a sessÃ£o  | Exigir token (`X-Bridge-Token`) em todas as rotas + allowlist de origem                                                          |
| 2   | **Segredo hardcoded e rotas de bypass fora do `attachUser`**                  | `server/api/index.ts:75-78` (montado antes do middleware em `:92`), `server/api/routes/tickets.ts:563-605`         | Leitura/ediÃ§Ã£o ampla de chamados com a chave `HERMES_SECRET_ADMIN_KEY_2026` sem login | Remover: nenhum consumidor em `src/` nem `hermes/` (grep). Se necessÃ¡rio, `requireAdmin` + segredo em env com `timingSafeEqual` |
| 3   | **CriaÃ§Ã£o de admin sem autenticaÃ§Ã£o com senha padrÃ£o**                   | `server/api/routes/users.ts:45-64` (`admin123` na `:59`), `users.ts:67-76` (`ensure-bootstrap` dispara migraÃ§Ã£o) | Quem chamar primeiro vira administrador                                                 | Exigir `requireAdmin` (ou desabilitar) e remover a senha fixa                                                                    |
| 4   | **Upload anÃ´nimo de 15 MB, servido publicamente**                            | `server/api/routes/uploads.ts:14-15,51-97`, `server/api/index.ts:128`, `nginx.conf:75-83`                          | Enche o disco do servidor; arquivo servido sem autorizaÃ§Ã£o                            | `requireAuth` no POST + validaÃ§Ã£o de magic bytes + rota pÃºblica separada com limite baixo                                     |
| 5   | **Erro de query engolido no front**                                           | `src/lib/backend/react.ts:79-88`                                                                                   | API fora do ar ou 403 â†’ tela presa em "carregando" para sempre, sem retry             | Expor estado de erro (`{data,error}`) e tratar no consumidor                                                                     |
| 6   | **Zero testes automatizados**                                                 | sem `*.test.*`/`*.spec.*`, sem vitest/jest/playwright em `package.json`                                            | Toda mudanÃ§a Ã© validada manualmente; regressÃ£o silenciosa                            | Introduzir vitest + primeiros testes de `src/lib/` e `server/mysql/pool.ts`                                                      |

Resolvidos nesta sessÃ£o: `package-lock.json` obsoleto (listava Convex, `package-lock.json:11,48`; o Docker usa `bun.lock`) foi removido; `.env`/`.env.*` passaram a ser ignorados (`.gitignore`), jÃ¡ que `RODAR.md:183-198` manda criar um `.env` com senhas.

---

## 4. P1 â€” alto impacto

| #   | Achado                                                                                               | EvidÃªncia                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /api/health` pÃºblico devolve host, porta e usuÃ¡rio do banco                                   | `server/api/index.ts:94-102`, `server/mysql/pool.ts:38-46`                                                                                                                                                                                                                                                                  |
| 2   | Erros internos vazam `error.message` do driver MySQL                                                 | `server/api/errors.ts:50-52`, `server/api/index.ts:87-89`                                                                                                                                                                                                                                                                   |
| 3   | Sem rate limiting em login (brute force), guest, upload e OCR (chamada paga de IA)                   | `server/api/auth.ts:116-143`, `routes/tickets.ts:386`, `uploads.ts:51`, `routes/ocr-chamado.ts:242`                                                                                                                                                                                                                         |
| 4   | Nomes de coluna vindos do JSON de backup entram crus no `INSERT` da restauraÃ§Ã£o                    | `server/api/backup.ts:292-306`                                                                                                                                                                                                                                                                                              |
| 5   | Senhas default versionadas (`pingos-root`, `pingos`, `admin123`)                                     | `docker-compose.local.yml:27,30,58`; `README.md:54`                                                                                                                                                                                                                                                                         |
| 6   | Containers rodam como root e nÃ£o tÃªm `HEALTHCHECK`; `depends_on` sem `condition`                   | 4 Dockerfiles (nenhum `USER`), `docker-compose.yml:59-61,166-167`                                                                                                                                                                                                                                                           |
| 7   | API 4000 publicada em produÃ§Ã£o e `CORS_ORIGIN` vazio reflete qualquer origem                       | `docker-compose.yml:129-130`, `server/api/index.ts:52-64`                                                                                                                                                                                                                                                                   |
| 8   | `GET /api/tickets` sem paginaÃ§Ã£o + poll global de 10 s por usuÃ¡rio                                | `src/lib/backend/api.ts:163`, `src/lib/backend/session.ts:43-46`, `src/pages/Dashboard.tsx:1045`                                                                                                                                                                                                                            |
| 9   | Kanban sem update otimista: card volta Ã  coluna antiga atÃ© o poll responder                        | `src/pages/Dashboard.tsx:1081-1123`, `src/components/KanbanColumn.tsx:302`                                                                                                                                                                                                                                                  |
| 10  | Backup/restore com `fetch` cru: perde dedupe, 401 e mensagem padronizada                             | `src/components/BackupRestoreDialog.tsx:115-178`                                                                                                                                                                                                                                                                            |
| 11  | `any` sistÃªmico na camada de dados (`useQuery<T = any>`)                                            | `src/lib/backend/api.ts:29-42`, `react.ts:59,136`; cast em `UsersManagementDialog.tsx:183`                                                                                                                                                                                                                                  |
| 12  | 15 `setState` sÃ­ncronos dentro de efeito (regra rebaixada para `warn`)                              | `BotConfig.tsx:248,272`, `BotPersonalidades.tsx:40`, `NotificationSettingsDialog.tsx:60`, `SlashProductsTextarea.tsx:87`, `ThemeToggle.tsx:37`, `UsersManagementDialog.tsx:290`, `WhatsAppWebDialog.tsx:120`, `ui/carousel.tsx:96`, `use-mobile.ts:14`, `react.ts:93`, `mobile.tsx:20`, `Auth.tsx:65,80`, `Reports.tsx:274` |
| 13  | Listener de `paste` registrado sem array de dependÃªncias (re-registra a cada render)                | `src/pages/Dashboard.tsx:212-230`                                                                                                                                                                                                                                                                                           |
| 14  | Credencial padrÃ£o exibida na prÃ³pria tela de login                                                 | `src/pages/Auth.tsx:143`                                                                                                                                                                                                                                                                                                    |
| 15  | `proxy_pass http://whatsapp:3001/` fixo: sem o host `whatsapp` o nginx nÃ£o sobe                     | `nginx.conf:48` (contra `/api` e `/uploads`, que usam `resolver`)                                                                                                                                                                                                                                                           |
| 16  | Bases de imagem flutuantes (`oven/bun:1`, `nginx:1.27-alpine`) e sem `engines`/`packageManager`      | 4 Dockerfiles, `package.json:1-17`                                                                                                                                                                                                                                                                                          |
| 17  | Cache de query sem TTL/limite e listeners de Ã¡udio de mÃ³dulo nunca removidos                       | `src/lib/backend/session.ts:63`, `src/lib/sound.ts:114-125`                                                                                                                                                                                                                                                                 |
| 18  | DuplicaÃ§Ã£o de regra: validaÃ§Ã£o de imagem 6Ã—, contador de chamado 2Ã—, `resolveAssigneeType` 2Ã— | `Dashboard.tsx:197`, `NewTicketDialog.tsx:49`, `GuestNewTicketDialog.tsx:56`, `PublicTicket.tsx:168,192`, `CameraTicketButton.tsx:156`; `routes/tickets.ts:154-166` vs `hermes/bot-ia.ts:1567-1580`                                                                                                                         |

---

## 5. P2 â€” dÃ­vida estrutural

- **21 primitivos shadcn nunca importados** (`ui/sidebar.tsx` 726 linhas, `ui/chart.tsx`, `ui/carousel.tsx`, `ui/menubar.tsx`, `ui/command.tsx`â€¦) e `src/instrumentation.tsx:240` sem nenhum uso.
- **CÃ³digo morto/resquÃ­cio Convex**: `main.ts:1-15` (fora de todo tsconfig e script), `sst-env.d.ts:8` (`import "sst"`), `.env.example` (VITE*CONVEX_URL/CONVEX_SITE_URL/CONVEX_DEPLOYMENT), `COPY src/lib/desc-fields.ts` sem uso em `server/Dockerfile:18`. *(`.env.example` e `main.ts`/`sst-env.d.ts` continuam no repo â€” remoÃ§Ã£o pendente de confirmaÃ§Ã£o.)\_
- **Docs divergentes do cÃ³digo**: `README.md:653-654` descreve imagens como data URL, mas o cÃ³digo grava arquivo e serve `/uploads/<nome>` (`uploads.ts:89-93`); `README.md:64` omite variÃ¡veis existentes em `RODAR.md:290-302`; `mysql-api.env.example:6-7` afirma nÃ£o estar no `.gitignore` (estÃ¡).
- **Escritas multi-etapa sem transaÃ§Ã£o**: `routes/tickets.ts:342-379` (nÃºmero + INSERT + notificaÃ§Ã£o) e `:446-465` (status + logs + evento).
- **Acessibilidade**: botÃµes sÃ³-Ã­cone sem `aria-label` (sÃ³ `title`) â€” `Dashboard.tsx:1220,1228-1288`, `NotificationBell.tsx:65-77`, `UsersManagementDialog.tsx:741-771`, `TechnicianManagementDialog.tsx:242-261`, `ProductsServicesDialog.tsx:314-333`, `LogoDropdown.tsx:36`.
- **`index.html:2` declara `lang="en"`** num app 100 % pt-BR; sem i18n (textos literais nos componentes).
- **RÃ³tulos de status em 3 lugares**: `src/lib/ticket-ui.ts`, `UsersManagementDialog.tsx:70-76`, `src/lib/reports.ts:203`.
- **N+1 em notificaÃ§Ã£o**: `server/api/notify.ts:467-475` (1 SELECT de usuÃ¡rios + 1 de permissÃµes por usuÃ¡rio, sem paginaÃ§Ã£o).
- **`server/tsconfig.json:22` exclui `whatsapp-web-server.ts`** do typecheck â€” justamente o arquivo sem auth; ou seja, o cÃ³digo mais exposto nÃ£o passa por `tsc`.
- Sem limites de recurso/`logging:` nos composes; sem `.nvmrc`/`.node-version`.

---

## 6. Maiores arquivos (alvo de decomposiÃ§Ã£o)

| Linhas | Arquivo                                                    | Deveria virar                                                                   |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 3251   | `hermes/bot-ia.ts`                                         | Handlers por domÃ­nio (`createBot` sozinho tem 334 linhas, `:2725-3058`)        |
| 1392   | `src/pages/Dashboard.tsx`                                  | `TicketDetailDialog`, `DashboardHeader`, `useKanbanDrag`, `lib/ticket-print.ts` |
| 1177   | `src/components/UsersManagementDialog.tsx`                 | `UsersTab`, `RolesTab`, `PermissionsPanel`, `useManagedUsers`                   |
| 945    | `src/lib/reports.ts`                                       | `reports/metrics`, `reports/export-xls`, `reports/export-pdf`, `reports/period` |
| 941    | `src/pages/Reports.tsx`                                    | `ReportsFilters`, `ReportsTable`, `useReportExport`                             |
| 901    | `server/api/routes/reports.ts`                             | ServiÃ§o de relatÃ³rios + router fino                                           |
| 726    | `src/components/ui/sidebar.tsx`                            | Nada â€” remover (nÃ£o usado)                                                   |
| 679    | `src/pages/PublicTicket.tsx` (571) / `BotConfig.tsx` (679) | `useImageAttach`, `PublicTicketForm`, `BotProviderForm`, `BotVisionTest`        |
| 615    | `server/api/notify.ts`                                     | Canais separados (e-mail/Telegram/WhatsApp)                                     |
| 605    | `server/api/routes/tickets.ts`                             | ServiÃ§o de chamados + validadores                                              |

---

## 7. Plano de burn-down

**Onda 1 â€” seguranÃ§a (P0 1-4, P1 1-4).** Remover as rotas de bypass e o segredo literal; proteger a ponte WhatsApp; autenticar upload; rate limit em login/guest/upload/OCR; `/api/health` mÃ­nimo; erro genÃ©rico no 500; validar colunas do backup.
_SaÃ­da:_ nenhuma rota sem auth alÃ©m de `/api/health`(mÃ­nimo) e `/api/auth/*`; zero segredo literal (`grep ghp_/sk-/HERMES_`).

**Onda 2 â€” qualidade e dados (P0 5-6, P1 8-14).** Estado de erro no `useQuery`; paginaÃ§Ã£o de `tickets.list` + poll adaptativo; update otimista no Kanban; `fetch` cru â†’ `apiFetch`; tipar a camada de API; zerar os 15 `set-state-in-effect` e voltar a regra para `error`; suÃ­te vitest com os primeiros testes.
_SaÃ­da:_ `react-hooks/set-state-in-effect` = `error` no `eslint.config.js`; cobertura inicial em `src/lib/`.

**Onda 3 â€” estrutura e infra (P1 15-18, P2).** Pin de imagens + `USER` non-root + `HEALTHCHECK`; CORS/porta da API; decompor os 6 maiores arquivos; remover cÃ³digo morto e primitivos shadcn nÃ£o usados; alinhar README/RODAR; a11y (`aria-label`).

---

## 8. NÃ£o verificado

- Runtime de nenhum processo (nÃ£o hÃ¡ MySQL nem Docker nesta mÃ¡quina): os achados de backend/infra sÃ£o de leitura de cÃ³digo.
- `docker compose config` e o smoke da stack nÃ£o foram executados.
- Se `/api/tickets` jÃ¡ aplica limite no servidor (o achado P1-8 assume que nÃ£o; o cliente nÃ£o envia `limit`).
- Vazamento da flag `SET FOREIGN_KEY_CHECKS = 0` entre queries da mesma conexÃ£o do pool (`server/api/backup.ts:268`).

---

## 9. Onda 1 â€” execuÃ§Ã£o (2026-10-10, sessÃ£o 2)

Cinco itens, um commit cada. Estado ao final de cada item verificado com `bun run verify`, `bun run build` e `bun run format:check`.

| #   | Item                                                                                                                                                                                                                                                   | Arquivos                                                                                                                                                                                             | Estado     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Ponte WhatsApp autenticada: `BRIDGE_TOKEN` obrigatÃ³rio (fail closed), `X-Bridge-Token` em todas as rotas JSON, CORS por allowlist (`BRIDGE_ALLOWED_ORIGINS`), gate antes do parser de 20 MB, painel com token via `?token=` e cliente `waBridgeFetch` | `server/whatsapp-web-server.ts`, `src/lib/whatsapp-bridge.ts`, `src/lib/whatsapp-notify.ts`, `src/pages/PublicTicket.tsx`, `src/components/WhatsAppWebDialog.tsx`, `docker-compose*.yml`, `RODAR.md` | concluÃ­do |
| 2   | Removido o bypass de autenticaÃ§Ã£o (`/api/agent/list`, `/api/tickets/admin-list`, `/api/tickets/admin-edit/:id`), o segredo literal `HERMES_SECRET_ADMIN_KEY_2026` e o mÃ³dulo `server/api/db-helpers.ts`                                             | `server/api/index.ts`, `server/api/routes/tickets.ts`, `server/api/db-helpers.ts`                                                                                                                    | concluído  |
| 3   | Primeiro administrador sem senha padrÃ£o e sem criaÃ§Ã£o pÃºblica                                                                                                                                                                                      | `server/api/routes/users.ts`, `server/api/auth.ts`, `server/mysql/migrate.ts`, `src/pages/Auth.tsx`                                                                                                  | concluído  |
| 4   | Upload autenticado, validado por conteÃºdo e servido com nome gerado                                                                                                                                                                                   | `server/api/routes/uploads.ts`, `server/api/index.ts`, `nginx.conf`                                                                                                                                  | pendente   |
| 5   | Rate limit nas entradas sensÃ­veis (login, guest, upload, OCR)                                                                                                                                                                                         | `server/api/index.ts`, `server/api/auth.ts`, `server/api/routes/*`                                                                                                                                   | pendente   |

### VerificaÃ§Ã£o em runtime do item 1

Ponte iniciada localmente com `BRIDGE_TOKEN=test-token-123` na porta 3998:

| RequisiÃ§Ã£o                                | Resultado                                                  |
| ------------------------------------------- | ---------------------------------------------------------- |
| `GET /status` sem header                    | **401** `{"error":"token do bridge ausente ou invÃ¡lido"}` |
| `GET /status` com token errado              | **401**                                                    |
| `GET /status` com `X-Bridge-Token` correto  | **200**                                                    |
| `GET /` (casca do painel)                   | **200**                                                    |
| `POST /logout` com token                    | **200**                                                    |
| Preflight `OPTIONS` com `Origin` autorizada | **204** + `Access-Control-Allow-Origin`                    |
| Preflight `OPTIONS` com `Origin` estranha   | **401**, sem cabeÃ§alhos CORS                              |
| Iniciar sem `BRIDGE_TOKEN`                  | **exit 1** com mensagem explicando como definir            |

O `<script>` do painel continua compilando apÃ³s as alteraÃ§Ãµes (`node --check` no HTML avaliado = OK, 0 interpolaÃ§Ãµes no template).
