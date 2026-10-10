# Revisão Sênior — pingOS4.0

**Data:** 2026-10-10 · **Escopo:** repositório completo (`src/`, `server/`, `hermes/`, infra, docs) · **Método:** leitura integral dos módulos + gates executados localmente (Node 24.20.0, bun 1.4.2).

Relatório consolidado de três auditorias paralelas (backend, frontend, infra/qualidade). Cada achado tem evidência `arquivo:linha` verificável. O que não pôde ser confirmado está marcado como **não verificado**.

---

## 1. Baseline dos gates (medido, não estimado)

| Gate                          | Antes                                                           | Depois desta sessão                                |
| ----------------------------- | --------------------------------------------------------------- | -------------------------------------------------- |
| `tsc -b` (app)                | **6 erros** — `src/components/ui/calendar.tsx` (12,135,145,166) | verde                                              |
| `tsc -p server/tsconfig.json` | verde                                                           | verde                                              |
| `eslint .`                    | **50 erros / 16 warnings** em 27 arquivos                       | **0 erros / 31 warnings** (16 arquivos corrigidos) |
| `prettier --check .`          | **166 arquivos** fora do padrão                                 | verde (baseline aplicado)                          |
| `vite build`                  | não rodava (bloqueado pelo `tsc`)                               | verde — 9,47 s                                     |
| Testes                        | ausentes                                                        | **ausentes** (dívida P0)                           |
| CI                            | ausente                                                         | `.github/workflows/ci.yml`                         |

Causa raiz do typecheck quebrado: `calendar.tsx:12` importa o tipo `DayButton`, exportado pelo `react-day-picker` a partir da **9.14.0**, mas `package.json:73` fixava `9.13.0`. Correção: bump para `9.14.0`.

### Correções aplicadas nesta sessão

| #   | Correção                                                                                                                                                                                     | Evidência                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `react-day-picker` 9.13.0 → 9.14.0 (destrava `tsc -b` e o build)                                                                                                                             | `package.json`                                                                        |
| 2   | **Painel da ponte WhatsApp não compilava**: o template literal interpretava `\n` e `\"`, emitindo strings JS quebradas em duas linhas — o `<script>` inteiro do painel caía em `SyntaxError` | `server/whatsapp-web-server.ts:540,548` (`\\n`), `:582` (aspas simples no `setError`) |
| 3   | 35 erros de lint zerados em 16 arquivos, sem `eslint-disable` novo (inclui `any` → tipos precisos em `db-helpers.ts` e `tickets.ts`)                                                         | `eslint .` = 0 erros                                                                  |
| 4   | `.env`/`.env.*` passam a ser ignorados (o `.env` do Compose guarda senhas)                                                                                                                   | `.gitignore`                                                                          |
| 5   | `package-lock.json` obsoleto removido (listava Convex; o Docker usa `bun.lock`)                                                                                                              | —                                                                                     |
| 6   | `.prettierrc` alinhado ao estilo real (`semi: false`, `printWidth: 100`) + baseline aplicado                                                                                                 | `.prettierrc`                                                                         |
| 7   | Gates novos: `typecheck`, `format:check`, `verify` + CI bloqueante                                                                                                                           | `package.json`, `.github/workflows/ci.yml`                                            |
| 8   | Contrato de trabalho sênior e regras para agentes                                                                                                                                            | `AGENTS.md`                                                                           |

> Verificação do item 2: o `PANEL_HTML` foi extraído e avaliado como o servidor faz; no commit anterior o `<script>` falhava em `node --check` (`SyntaxError: Invalid or unexpected token` na linha do `logs.join`), e depois da correção passa.

---

## 2. Arquitetura em uma página

- **Três processos**: API Express+MySQL (`server/api`, 4000), ponte WhatsApp/Baileys (`server/whatsapp-web-server.ts`, 3001) e bot Telegram (`hermes/bot-ia.ts`, long polling). O front é servido por nginx (`nginx.conf`), que também faz proxy de `/api`, `/uploads` e `/whatsapp-api`.
- **Frontend**: React 19 + Vite 7 + Tailwind 4 + shadcn/ui; 6 rotas com lazy loading (`src/main.tsx:132-156`); camada de dados própria que imita a API do Convex (`src/lib/backend/api.ts`, `react.ts`) sobre `apiFetch` (`src/lib/mysql-api.ts:96`).
- **Autenticação**: **sem JWT** — token opaco de 64 hex em `sessions`, enviado como `Authorization: Bearer`, validado em `server/api/auth.ts:83-103` (1 SELECT com JOIN + 1 SELECT de papel por requisição: `server/api/permissions.ts:36-51`).
- **Autorização**: `src/lib/permissions.ts` é fonte única para front e back — ponto forte, evita duas verdades.
- **Banco**: MySQL 8/MariaDB, 19 tabelas (`server/mysql/schema.sql`); `tickets` é o núcleo, com `assignee_id` **sem FK** (aponta para `users` ou `technicians` conforme `assignee_type`, `schema.sql:118-121`). Migrações idempotentes em `server/mysql/migrate.ts`.
- **Deploy**: `docker-compose.yml` (Dokploy) e `docker-compose.local.yml` (stack local: app 8090, api 4000, mysql 3307).

---

## 3. P0 — bloqueadores (corrigir antes de qualquer feature)

| #   | Achado                                                                      | Evidência                                                                                                        | Impacto                                                                               | Ação                                                                                                                            |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Ponte WhatsApp sem autenticação e com CORS aberto**, publicada pelo nginx | `server/whatsapp-web-server.ts:42` (+ rotas em `:272,:288,:296,:304,:374,:656`), `nginx.conf:47-56`              | Qualquer origem envia mensagens pelo número pareado, pausa, desloga e limpa a sessão  | Exigir token (`X-Bridge-Token`) em todas as rotas + allowlist de origem                                                         |
| 2   | **Segredo hardcoded e rotas de bypass fora do `attachUser`**                | `server/api/index.ts:75-78` (montado antes do middleware em `:92`), `server/api/routes/tickets.ts:563-605`       | Leitura/edição ampla de chamados com a chave `HERMES_SECRET_ADMIN_KEY_2026` sem login | Remover: nenhum consumidor em `src/` nem `hermes/` (grep). Se necessário, `requireAdmin` + segredo em env com `timingSafeEqual` |
| 3   | **Criação de admin sem autenticação com senha padrão**                      | `server/api/routes/users.ts:45-64` (`admin123` na `:59`), `users.ts:67-76` (`ensure-bootstrap` dispara migração) | Quem chamar primeiro vira administrador                                               | Exigir `requireAdmin` (ou desabilitar) e remover a senha fixa                                                                   |
| 4   | **Upload anônimo de 15 MB, servido publicamente**                           | `server/api/routes/uploads.ts:14-15,51-97`, `server/api/index.ts:128`, `nginx.conf:75-83`                        | Enche o disco do servidor; arquivo servido sem autorização                            | `requireAuth` no POST + validação de magic bytes + rota pública separada com limite baixo                                       |
| 5   | **Erro de query engolido no front**                                         | `src/lib/backend/react.ts:79-88`                                                                                 | API fora do ar ou 403 → tela presa em "carregando" para sempre, sem retry             | Expor estado de erro (`{data,error}`) e tratar no consumidor                                                                    |
| 6   | **Zero testes automatizados**                                               | sem `*.test.*`/`*.spec.*`, sem vitest/jest/playwright em `package.json`                                          | Toda mudança é validada manualmente; regressão silenciosa                             | Introduzir vitest + primeiros testes de `src/lib/` e `server/mysql/pool.ts`                                                     |

Resolvidos nesta sessão: `package-lock.json` obsoleto (listava Convex, `package-lock.json:11,48`; o Docker usa `bun.lock`) foi removido; `.env`/`.env.*` passaram a ser ignorados (`.gitignore`), já que `RODAR.md:183-198` manda criar um `.env` com senhas.

---

## 4. P1 — alto impacto

| #   | Achado                                                                                          | Evidência                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `GET /api/health` público devolve host, porta e usuário do banco                                | `server/api/index.ts:94-102`, `server/mysql/pool.ts:38-46`                                                                                                                                                                                                                                                                  |
| 2   | Erros internos vazam `error.message` do driver MySQL                                            | `server/api/errors.ts:50-52`, `server/api/index.ts:87-89`                                                                                                                                                                                                                                                                   |
| 3   | Sem rate limiting em login (brute force), guest, upload e OCR (chamada paga de IA)              | `server/api/auth.ts:116-143`, `routes/tickets.ts:386`, `uploads.ts:51`, `routes/ocr-chamado.ts:242`                                                                                                                                                                                                                         |
| 4   | Nomes de coluna vindos do JSON de backup entram crus no `INSERT` da restauração                 | `server/api/backup.ts:292-306`                                                                                                                                                                                                                                                                                              |
| 5   | Senhas default versionadas (`pingos-root`, `pingos`, `admin123`)                                | `docker-compose.local.yml:27,30,58`; `README.md:54`                                                                                                                                                                                                                                                                         |
| 6   | Containers rodam como root e não têm `HEALTHCHECK`; `depends_on` sem `condition`                | 4 Dockerfiles (nenhum `USER`), `docker-compose.yml:59-61,166-167`                                                                                                                                                                                                                                                           |
| 7   | API 4000 publicada em produção e `CORS_ORIGIN` vazio reflete qualquer origem                    | `docker-compose.yml:129-130`, `server/api/index.ts:52-64`                                                                                                                                                                                                                                                                   |
| 8   | `GET /api/tickets` sem paginação + poll global de 10 s por usuário                              | `src/lib/backend/api.ts:163`, `src/lib/backend/session.ts:43-46`, `src/pages/Dashboard.tsx:1045`                                                                                                                                                                                                                            |
| 9   | Kanban sem update otimista: card volta à coluna antiga até o poll responder                     | `src/pages/Dashboard.tsx:1081-1123`, `src/components/KanbanColumn.tsx:302`                                                                                                                                                                                                                                                  |
| 10  | Backup/restore com `fetch` cru: perde dedupe, 401 e mensagem padronizada                        | `src/components/BackupRestoreDialog.tsx:115-178`                                                                                                                                                                                                                                                                            |
| 11  | `any` sistêmico na camada de dados (`useQuery<T = any>`)                                        | `src/lib/backend/api.ts:29-42`, `react.ts:59,136`; cast em `UsersManagementDialog.tsx:183`                                                                                                                                                                                                                                  |
| 12  | 15 `setState` síncronos dentro de efeito (regra rebaixada para `warn`)                          | `BotConfig.tsx:248,272`, `BotPersonalidades.tsx:40`, `NotificationSettingsDialog.tsx:60`, `SlashProductsTextarea.tsx:87`, `ThemeToggle.tsx:37`, `UsersManagementDialog.tsx:290`, `WhatsAppWebDialog.tsx:120`, `ui/carousel.tsx:96`, `use-mobile.ts:14`, `react.ts:93`, `mobile.tsx:20`, `Auth.tsx:65,80`, `Reports.tsx:274` |
| 13  | Listener de `paste` registrado sem array de dependências (re-registra a cada render)            | `src/pages/Dashboard.tsx:212-230`                                                                                                                                                                                                                                                                                           |
| 14  | Credencial padrão exibida na própria tela de login                                              | `src/pages/Auth.tsx:143`                                                                                                                                                                                                                                                                                                    |
| 15  | `proxy_pass http://whatsapp:3001/` fixo: sem o host `whatsapp` o nginx não sobe                 | `nginx.conf:48` (contra `/api` e `/uploads`, que usam `resolver`)                                                                                                                                                                                                                                                           |
| 16  | Bases de imagem flutuantes (`oven/bun:1`, `nginx:1.27-alpine`) e sem `engines`/`packageManager` | 4 Dockerfiles, `package.json:1-17`                                                                                                                                                                                                                                                                                          |
| 17  | Cache de query sem TTL/limite e listeners de áudio de módulo nunca removidos                    | `src/lib/backend/session.ts:63`, `src/lib/sound.ts:114-125`                                                                                                                                                                                                                                                                 |
| 18  | Duplicação de regra: validação de imagem 6×, contador de chamado 2×, `resolveAssigneeType` 2×   | `Dashboard.tsx:197`, `NewTicketDialog.tsx:49`, `GuestNewTicketDialog.tsx:56`, `PublicTicket.tsx:168,192`, `CameraTicketButton.tsx:156`; `routes/tickets.ts:154-166` vs `hermes/bot-ia.ts:1567-1580`                                                                                                                         |

---

## 5. P2 — dívida estrutural

- **21 primitivos shadcn nunca importados** (`ui/sidebar.tsx` 726 linhas, `ui/chart.tsx`, `ui/carousel.tsx`, `ui/menubar.tsx`, `ui/command.tsx`…) e `src/instrumentation.tsx:240` sem nenhum uso.
- **Código morto/resquício Convex**: `main.ts:1-15` (fora de todo tsconfig e script), `sst-env.d.ts:8` (`import "sst"`), `.env.example` (VITE*CONVEX_URL/CONVEX_SITE_URL/CONVEX_DEPLOYMENT), `COPY src/lib/desc-fields.ts` sem uso em `server/Dockerfile:18`. *(`.env.example` e `main.ts`/`sst-env.d.ts` continuam no repo — remoção pendente de confirmação.)\_
- **Docs divergentes do código**: `README.md:653-654` descreve imagens como data URL, mas o código grava arquivo e serve `/uploads/<nome>` (`uploads.ts:89-93`); `README.md:64` omite variáveis existentes em `RODAR.md:290-302`; `mysql-api.env.example:6-7` afirma não estar no `.gitignore` (está).
- **Escritas multi-etapa sem transação**: `routes/tickets.ts:342-379` (número + INSERT + notificação) e `:446-465` (status + logs + evento).
- **Acessibilidade**: botões só-ícone sem `aria-label` (só `title`) — `Dashboard.tsx:1220,1228-1288`, `NotificationBell.tsx:65-77`, `UsersManagementDialog.tsx:741-771`, `TechnicianManagementDialog.tsx:242-261`, `ProductsServicesDialog.tsx:314-333`, `LogoDropdown.tsx:36`.
- **`index.html:2` declara `lang="en"`** num app 100 % pt-BR; sem i18n (textos literais nos componentes).
- **Rótulos de status em 3 lugares**: `src/lib/ticket-ui.ts`, `UsersManagementDialog.tsx:70-76`, `src/lib/reports.ts:203`.
- **N+1 em notificação**: `server/api/notify.ts:467-475` (1 SELECT de usuários + 1 de permissões por usuário, sem paginação).
- **`server/tsconfig.json:22` exclui `whatsapp-web-server.ts`** do typecheck — justamente o arquivo sem auth; ou seja, o código mais exposto não passa por `tsc`.
- Sem limites de recurso/`logging:` nos composes; sem `.nvmrc`/`.node-version`.

---

## 6. Maiores arquivos (alvo de decomposição)

| Linhas | Arquivo                                                    | Deveria virar                                                                   |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 3251   | `hermes/bot-ia.ts`                                         | Handlers por domínio (`createBot` sozinho tem 334 linhas, `:2725-3058`)         |
| 1392   | `src/pages/Dashboard.tsx`                                  | `TicketDetailDialog`, `DashboardHeader`, `useKanbanDrag`, `lib/ticket-print.ts` |
| 1177   | `src/components/UsersManagementDialog.tsx`                 | `UsersTab`, `RolesTab`, `PermissionsPanel`, `useManagedUsers`                   |
| 945    | `src/lib/reports.ts`                                       | `reports/metrics`, `reports/export-xls`, `reports/export-pdf`, `reports/period` |
| 941    | `src/pages/Reports.tsx`                                    | `ReportsFilters`, `ReportsTable`, `useReportExport`                             |
| 901    | `server/api/routes/reports.ts`                             | Serviço de relatórios + router fino                                             |
| 726    | `src/components/ui/sidebar.tsx`                            | Nada — remover (não usado)                                                      |
| 679    | `src/pages/PublicTicket.tsx` (571) / `BotConfig.tsx` (679) | `useImageAttach`, `PublicTicketForm`, `BotProviderForm`, `BotVisionTest`        |
| 615    | `server/api/notify.ts`                                     | Canais separados (e-mail/Telegram/WhatsApp)                                     |
| 605    | `server/api/routes/tickets.ts`                             | Serviço de chamados + validadores                                               |

---

## 7. Plano de burn-down

**Onda 1 — segurança (P0 1-4, P1 1-4).** Remover as rotas de bypass e o segredo literal; proteger a ponte WhatsApp; autenticar upload; rate limit em login/guest/upload/OCR; `/api/health` mínimo; erro genérico no 500; validar colunas do backup.
_Saída:_ nenhuma rota sem auth além de `/api/health`(mínimo) e `/api/auth/*`; zero segredo literal (`grep ghp_/sk-/HERMES_`).

**Onda 2 — qualidade e dados (P0 5-6, P1 8-14).** Estado de erro no `useQuery`; paginação de `tickets.list` + poll adaptativo; update otimista no Kanban; `fetch` cru → `apiFetch`; tipar a camada de API; zerar os 15 `set-state-in-effect` e voltar a regra para `error`; suíte vitest com os primeiros testes.
_Saída:_ `react-hooks/set-state-in-effect` = `error` no `eslint.config.js`; cobertura inicial em `src/lib/`.

**Onda 3 — estrutura e infra (P1 15-18, P2).** Pin de imagens + `USER` non-root + `HEALTHCHECK`; CORS/porta da API; decompor os 6 maiores arquivos; remover código morto e primitivos shadcn não usados; alinhar README/RODAR; a11y (`aria-label`).

---

## 8. Não verificado

- Runtime de nenhum processo (não há MySQL nem Docker nesta máquina): os achados de backend/infra são de leitura de código.
- `docker compose config` e o smoke da stack não foram executados.
- Se `/api/tickets` já aplica limite no servidor (o achado P1-8 assume que não; o cliente não envia `limit`).
- Vazamento da flag `SET FOREIGN_KEY_CHECKS = 0` entre queries da mesma conexão do pool (`server/api/backup.ts:268`).

---

## 9. Onda 1 — execução (2026-10-10, sessão 2)

Cinco itens, um commit cada. Estado ao final de cada item verificado com `bun run verify`, `bun run build` e `bun run format:check`.

| #   | Item                                                                                                                                                                                                                                                  | Arquivos                                                                                                                                                                                             | Estado    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| 1   | Ponte WhatsApp autenticada: `BRIDGE_TOKEN` obrigatório (fail closed), `X-Bridge-Token` em todas as rotas JSON, CORS por allowlist (`BRIDGE_ALLOWED_ORIGINS`), gate antes do parser de 20 MB, painel com token via `?token=` e cliente `waBridgeFetch` | `server/whatsapp-web-server.ts`, `src/lib/whatsapp-bridge.ts`, `src/lib/whatsapp-notify.ts`, `src/pages/PublicTicket.tsx`, `src/components/WhatsAppWebDialog.tsx`, `docker-compose*.yml`, `RODAR.md` | concluído |
| 2   | Removido o bypass de autenticação (`/api/agent/list`, `/api/tickets/admin-list`, `/api/tickets/admin-edit/:id`), o segredo literal `HERMES_SECRET_ADMIN_KEY_2026` e o módulo `server/api/db-helpers.ts`                                               | `server/api/index.ts`, `server/api/routes/tickets.ts`, `server/api/db-helpers.ts`                                                                                                                    | concluído |
| 3   | Primeiro administrador sem senha padrão e sem criação pública                                                                                                                                                                                         | `server/api/routes/users.ts`, `server/api/auth.ts`, `server/mysql/migrate.ts`, `src/pages/Auth.tsx`                                                                                                  | concluído |
| 4   | Upload autenticado, validado por conteúdo e servido com nome gerado                                                                                                                                                                                   | `server/api/routes/uploads.ts`, `server/api/index.ts`, `nginx.conf`                                                                                                                                  | concluído |
| 5   | Rate limit nas entradas sensíveis (login, guest, upload, OCR)                                                                                                                                                                                         | `server/api/index.ts`, `server/api/auth.ts`, `server/api/routes/*`                                                                                                                                   | concluído |

### Verificação em runtime do item 1

Ponte iniciada localmente com `BRIDGE_TOKEN=test-token-123` na porta 3998:

| Requisição                                  | Resultado                                                 |
| ------------------------------------------- | --------------------------------------------------------- |
| `GET /status` sem header                    | **401** `{"error":"token do bridge ausente ou inválido"}` |
| `GET /status` com token errado              | **401**                                                   |
| `GET /status` com `X-Bridge-Token` correto  | **200**                                                   |
| `GET /` (casca do painel)                   | **200**                                                   |
| `POST /logout` com token                    | **200**                                                   |
| Preflight `OPTIONS` com `Origin` autorizada | **204** + `Access-Control-Allow-Origin`                   |
| Preflight `OPTIONS` com `Origin` estranha   | **401**, sem cabeçalhos CORS                              |
| Iniciar sem `BRIDGE_TOKEN`                  | **exit 1** com mensagem explicando como definir           |

O `<script>` do painel continua compilando após as alterações (`node --check` no HTML avaliado = OK, 0 interpolações no template).

### Verificação em runtime do item 5

API iniciada localmente sem banco (porta 3994), o que faz cada tentativa de login responder 500 — falha que **conta** no limitador:

| Cenário                                                   | Resultado                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 12 POSTs em `/api/auth/login` (`RATE_LIMIT_ENABLED=true`) | `500` × 10 e depois **`429`** com `RateLimit-Policy: 10;w=900` e `Retry-After: 900` |
| 6 POSTs em `/api/tickets/guest` (limite 5/h)              | `400` × 5 e depois **`429`**                                                        |
| `RATE_LIMIT_ENABLED=false`                                | nenhum `429` (limites desligados)                                                   |

Observação: `express.json()` roda antes dos roteadores, então um corpo JSON inválido é rejeitado com 500 antes de chegar ao limitador — o limite é contado nas requisições que chegam à rota.

### Pendências conhecidas após a Onda 1

- O store do rate limit é em memória: com mais de uma réplica da API é preciso um store compartilhado (Redis/MySQL).
- `GET /api/health` continua público e ainda devolve host/porta/usuário do banco (P1-1), e o erro interno continua vazando `error.message` (P1-2).
- A ponte do WhatsApp e o upload foram validados por runtime local; o restante segue sem cobertura de testes automatizados (dívida P0).

---

## 10. Semana 1 — itens extras

| #   | Item                                                                                                                                                                                                                                                  | Commit             | Evidência                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| 6   | Estado de erro nas queries: `useQueryState` com `{ data, error, retry }` e `QueryErrorBanner` (antes a falha só ia para o console e a tela ficava presa em "carregando")                                                                              | `77496a9`          | `src/lib/backend/react.ts`, `src/components/QueryErrorBanner.tsx`, `src/pages/Dashboard.tsx` |
| 7   | Acessibilidade: 22 `aria-label` em botões só-ícone (7 diálogos + cabeçalho do painel) e cartão do Kanban operável por teclado (`role="button"`, `tabIndex`, Enter/Espaço abrem o chamado, onde o status muda pelos botões do diálogo com `canMoveTo`) | commit da Semana 1 | `src/components/*.tsx`, `src/components/KanbanColumn.tsx`, `src/pages/Dashboard.tsx`         |

`useQuery` continua devolvendo `T | undefined`, então os ~100 pontos de uso não mudaram — só as telas que querem tratar falha passaram a usar `useQueryState`.

---

## 11. Semana 2-3 — progresso

| #   | Item                                                                                                                                                                                                                                     | Commit      | Evidência                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 8   | Logs estruturados: `pino` + `pino-http` (uma linha JSON por requisição com id, rota, status e latência), `LOG_LEVEL`, `Authorization`/`Cookie` redigidos, `X-Request-Id` na resposta, `/api/health` fora do log                          | `51cd674`   | `server/api/logger.ts`, `server/api/index.ts`, `server/api/errors.ts`                                                               |
| 9   | Vazamentos internos (P1-1/P1-2): `/api/health` só devolve host/porta/usuário e arquivo de ambiente para admin; erro não tratado responde genérico, com o detalhe apenas no log                                                           | `9e85b73`   | runtime: `{"status":"degraded","database":false}` e `{"message":"Erro interno do servidor."}`                                       |
| 10  | `GET_LOCK` nas migrações: `withNamedLock` no pool (lock numa conexão dedicada) e `runMigrations` segurando `pingos:migrate` por 30 s                                                                                                     | `8c55c4b`   | `server/mysql/pool.ts:114-145`, `server/mysql/migrate.ts`                                                                           |
| 11  | Update otimista no Kanban: o card muda de coluna na hora e volta se a mutation falhar                                                                                                                                                    | `e1c3970`   | `src/pages/Dashboard.tsx`                                                                                                           |
| 12  | Suíte inicial de testes: **10 arquivos / 200 casos**, sem banco e sem navegador                                                                                                                                                          | `d4cc8b6`   | `tests/`, `vitest.config.ts`, `bun run test`                                                                                        |
| 13  | Tempo real por SSE: `GET /api/events` avisa as conexões abertas quando uma escrita termina bem; o cliente consome o stream com `fetch` (token no `Authorization`, nunca na query) e o poll caiu de 10 s para 60 s como rede de segurança | `faea516`   | `server/api/events.ts`, `src/lib/backend/session.ts`, `nginx.conf` (`proxy_buffering off`), `tests/server-events.test.ts` (4 casos) |
| 14  | Paginação por keyset no **servidor**: `GET /api/tickets` aceita `limit`/`cursor`, ordena por `(created_at, id)` e devolve `X-Next-Cursor`; sem parâmetros mantém a lista completa; laço com teto cobre o filtro de permissão pós-SELECT  | este commit | `server/api/tickets-page.ts`, `server/api/routes/tickets.ts`, `tests/tickets-page.test.ts` (10 casos)                               |

### Cobertura da suíte

| Arquivo                                                      | Casos | Foco                                                                               |
| ------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------- |
| `tests/permissions.test.ts`                                  | 38    | fonte única de permissões (`canMoveTo`, `canViewStatus`, restrições, `namesMatch`) |
| `tests/currency.test.ts`                                     | 24    | formatação/máscara BRL e soma de itens                                             |
| `tests/desc-fields.test.ts`                                  | 20    | descrição, rótulos e mensagem de WhatsApp                                          |
| `tests/reports.test.ts`                                      | 30    | tabelas dos 5 relatórios, resumo e presets de período                              |
| `tests/server-types.test.ts`                                 | 27    | normalizadores da API (nunca expõe `password_hash`)                                |
| `tests/server-errors.test.ts`                                | 19    | `ApiError`, `asyncHandler`, 500 sem vazar mensagem + `logger.error`                |
| `tests/ticket-ui.test.ts`                                    | 18    | colunas, prioridades, iniciais e `timeAgo`                                         |
| `tests/ticket-categories.test.ts` + `tests/products.test.ts` | 16    | normalizadores compartilhados front/back                                           |
| `tests/server-rate-limit.test.ts`                            | 8     | passthrough com `RATE_LIMIT_ENABLED=false` e 429 nos limites                       |

Gate atual: `bun run verify` = typecheck + lint + **testes** (0 erros, 200 passando) · `build` verde · `format:check` verde.
Nota de ambiente: no sandbox do DSH o `vitest` via `bun run` falha com `EPERM` ao criar pasta no `%TEMP%`; apontando `TEMP`/`TMP` para dentro do workspace (ou rodando num shell normal/CI) passa 200/200.

### Achados da suíte (registrados, ainda não corrigidos)

| #   | Achado                                                                                                         | Evidência                                    | Impacto                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | `fromDateInput` aceita data impossível e ano < 100 é deslocado (rollover do `Date`)                            | `src/lib/reports.ts:927-935`                 | Filtro de relatório pode usar data errada silenciosamente                    |
| 2   | Checagem de status roda antes do override de admin (admin com `tickets.view.<status>` explícito fica restrito) | `src/lib/permissions.ts:355-357`, `:390-393` | Latente (admin recebe `ALL_PERMISSIONS`); o comentário promete "poder total" |
| 3   | `namesMatch("   ", " ")` devolve `true`                                                                        | `src/lib/permissions.ts:369-372`             | Sem impacto prático, mas é um falso positivo de identidade                   |
| 4   | `RATE_LIMIT_ENABLED` é lido na importação (mudança exige restart) e o store é em memória                       | `server/api/rate-limit.ts:17`                | Operação: em múltiplas réplicas o limite não é global                        |

### Ainda pendente na Semana 2-3

**Adoção da paginação no cliente.** O servidor já responde por keyset (item 14); falta o painel pedir a primeira página em vez da base inteira. Próximo passo:

1. **Transporte**: expor os headers da resposta. Hoje `apiFetch` devolve só o corpo, e `X-Next-Cursor` se perde — adicionar uma opção `withMeta` (ou um `pagedFetch`) em `src/lib/mysql-api.ts`.
2. **Hook**: `usePagedQuery(ref, { pageSize })` em `src/lib/backend/react.ts`, acumulando páginas e devolvendo `loadMore()`/`hasMore`; ao receber `changed` do SSE, revalida a primeira página e mantém as já carregadas.
3. **Painel**: `Dashboard.tsx` passa a pedir `limit: 200` e mostra "Carregar mais chamados" enquanto houver cursor.
4. **Verificação**: teste do hook com `fetch` simulado (cursor inválido, fim da lista, revalidação por SSE) + smoke no navegador.
