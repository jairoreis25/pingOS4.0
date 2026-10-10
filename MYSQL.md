# PingOS com MySQL â€” backend paralelo

Este documento explica como rodar o PingOS com **banco MySQL**. O backend MySQL
**substituiu o Convex**: o frontend inteiro fala com a API Express por meio do
adaptador `src/lib/backend/*` (que expÃµe `useQuery`/`useMutation` com a mesma
assinatura dos hooks do Convex, entÃ£o os componentes nÃ£o mudaram de lÃ³gica).

```
   Frontend (Vite) â”€â”€â–º src/lib/backend/* â”€â”€â–º API Express â”€â”€â–º MySQL
```

---

## 1. O que jÃ¡ estÃ¡ pronto (fase 1)

| MÃ³dulo                 | Convex (antes)                                    | MySQL (agora)                                                                                                                                                                                                                                |
| ----------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Banco de dados          | Convex                                            | `server/mysql/schema.sql` (14 tabelas)                                                                                                                                                                                                       |
| Login / sessÃµes        | Convex Auth                                       | `POST /api/auth/*` (scrypt + tabela `sessions`)                                                                                                                                                                                              |
| Chamados / Kanban       | `api.tickets.*`                                   | `/api/tickets` (listar, abrir, mover, editar, excluir)                                                                                                                                                                                       |
| Abertura pÃºblica       | `api.tickets.createAsGuest`                       | `POST /api/tickets/guest`                                                                                                                                                                                                                    |
| UsuÃ¡rios               | `api.users.*`                                     | `/api/users`                                                                                                                                                                                                                                 |
| PapÃ©is (RBAC)          | `api.roles.*`                                     | `/api/roles`                                                                                                                                                                                                                                 |
| TÃ©cnicos               | `api.technicians.*`                               | `/api/technicians`                                                                                                                                                                                                                           |
| Produtos e serviÃ§os    | â€” (novo)                                        | `/api/products` (nome + tipo + valor). O tipo (`produto` \| `servico`, coluna `item_type`) diferencia peÃ§a/equipamento de mÃ£o de obra. Leitura livre para logados (menu `/` da SoluÃ§Ã£o e do OrÃ§amento); escrita exige `settings.manage` |
| MÃ©tricas               | `api.tickets.monthlyMetrics` / `dashboardMetrics` | `/api/metrics/monthly` Â· `/api/metrics/dashboard`                                                                                                                                                                                           |
| Imagens dos chamados    | Convex storage                                    | campo `image_url` (data URL no prÃ³prio chamado)                                                                                                                                                                                             |
| NotificaÃ§Ãµes (config) | `api.notificationSettings.*`                      | `GET/PUT /api/notification-settings`                                                                                                                                                                                                         |
| Regras de inatividade   | `api.notificationRules.*`                         | CRUD `/api/notification-rules`                                                                                                                                                                                                               |
| Sino in-app             | `api.inAppNotifications.*`                        | `/api/in-app-notifications`                                                                                                                                                                                                                  |
| PapÃ©is (permissÃµes)   | `api.permissions.*`                               | `GET /api/auth/me` Â· `/api/permissions/any-admin`                                                                                                                                                                                           |
| Backup (painel admin)   | `api.backups.*`                                   | `/api/backups` (listar, gerar, baixar, restaurar, upload)                                                                                                                                                                                    |
| RelatÃ³rios             | â€” (novo)                                        | `/api/reports/*` (chamados, tÃ©cnicos, setores, usuÃ¡rios, notificaÃ§Ãµes) + exportaÃ§Ã£o XLS/PDF no frontend e auditoria em `report_logs`                                                                                                   |
| Login do app            | Convex Auth                                       | `POST /api/auth/login` (token em `localStorage`)                                                                                                                                                                                             |

As **regras de permissÃ£o sÃ£o as mesmas**: `server/api/permissions.ts` importa
`src/lib/permissions.ts`, o mesmo arquivo que o frontend usa. NÃ£o existem duas
verdades sobre quem pode ver/editar o quÃª.

## 2. NotificaÃ§Ãµes, inatividade e backup

Tudo aqui jÃ¡ estÃ¡ no backend MySQL â€” nÃ£o existe mais nenhuma rota respondendo
"ainda nÃ£o migrado".

### Envio de notificaÃ§Ãµes â€” `server/api/notify.ts`

Disparado por:

| Evento                                                        | O que sai                                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **Novo chamado** (`POST /api/tickets` e `/api/tickets/guest`) | sino in-app para quem tem `tickets.view` + e-mail/Telegram/WhatsApp conforme a configuraÃ§Ã£o |
| **MudanÃ§a de status** (`POST /api/tickets/:id/status`)       | sino in-app para solicitante e responsÃ¡vel + canais externos                                 |
| **Inatividade** (regras)                                      | canais escolhidos em cada regra                                                               |

Os canais sÃ£o ligados na aba **ConfiguraÃ§Ãµes â†’ NotificaÃ§Ãµes** do app (tabela
`notification_settings`); os segredos vÃªm do ambiente:

| Canal    | VariÃ¡veis                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------- |
| E-mail   | `RESEND_API_KEY`, `RESEND_FROM` (sem a chave o envio falha e o motivo vai para `notifications`) |
| Telegram | token/chat_id salvos no prÃ³prio app                                                            |
| WhatsApp | API oficial (token + phone number id no app) ou a **ponte Baileys** (`WHATSAPP_BRIDGE_URL`)     |

Cada tentativa Ã© registrada na tabela `notifications` (sent/failed + erro) e o
envio Ã© "fire-and-forget": nunca atrasa nem derruba a requisiÃ§Ã£o do usuÃ¡rio.
`SITE_URL` define o link que aparece nas mensagens.

### Inatividade â€” `server/api/inactivity.ts`

Para cada regra ativa, procura chamados nos status da regra com
`updated_at` mais antigo que `days_inactive` dias, pula os pares chamado+regra
jÃ¡ alertados (tabela `inactivity_logs`, o anti-spam) e dispara o alerta.
Qualquer ediÃ§Ã£o ou mudanÃ§a de status do chamado zera esse histÃ³rico.

Roda:

- automaticamente, a cada `INACTIVITY_INTERVAL_MINUTES` (padrÃ£o 60; `0` desliga);
- manualmente, por `POST /api/inactivity/run` (botÃ£o "verificar agora").

### Backup e restauraÃ§Ã£o â€” `server/api/backup.ts` + `routes/backups.ts`

| Rota                            | AÃ§Ã£o                                             |
| ------------------------------- | -------------------------------------------------- |
| `GET /api/backups`              | histÃ³rico (`backups`) + auditoria (`backup_logs`) |
| `POST /api/backups`             | gera o arquivo `.json` em `BACKUP_DIR`             |
| `GET /api/backups/:id/download` | baixa o arquivo                                    |
| `POST /api/backups/:id/restore` | restaura o banco a partir do arquivo               |
| `POST /api/backups/upload`      | recebe um `.json` do computador, valida e registra |

- O backup Ã© um **JSON com o conteÃºdo das tabelas de dados** (sem `sessions`,
  `backups` e `backup_logs`) â€” nÃ£o depende de `mysqldump` no container.
- A restauraÃ§Ã£o roda em **transaÃ§Ã£o** (`DELETE` + `INSERT`, FKs desligadas
  apenas naquela conexÃ£o) e derruba todas as sessÃµes no fim: todo mundo faz
  login de novo. Falha no meio = rollback, banco atual intacto.
- Antes de restaurar, o servidor gera um **backup de seguranÃ§a**
  (`BACKUP_SAFETY=false` desliga).
- VariÃ¡veis: `BACKUP_DIR` (padrÃ£o `./backups`; em Docker `/data/backups`, com
  volume), `BACKUP_MAX_BYTES`, `BACKUP_SAFETY`.

Os resquÃ­cios do Convex **jÃ¡ foram removidos**: `src/convex/`, `convex.json` e as
dependÃªncias `convex` / `@convex-dev/auth` nÃ£o existem mais no projeto (o
histÃ³rico deste documento mantÃ©m algumas comparaÃ§Ãµes "Convex â†’ MySQL" como
referÃªncia da migraÃ§Ã£o).

---

## 3. PrÃ©-requisitos

- **MySQL 8.0 ou superior** (ou MariaDB 10.6+) rodando e acessÃ­vel.
- **Bun 1.x** (o projeto jÃ¡ usa Bun para o bridge do WhatsApp).

Se quiser subir um MySQL rapidinho sÃ³ para testar (Docker):

```bash
docker run -d --name pingos-mysql \
  -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=pingos \
  -e MYSQL_USER=pingos \
  -e MYSQL_PASSWORD=pingos123 \
  -p 3306:3306 \
  mysql:8
```

---

## 4. Passo 1 â€” Criar o banco e o usuÃ¡rio da aplicaÃ§Ã£o

Em produÃ§Ã£o **nÃ£o use o root**: crie um usuÃ¡rio exclusivo do app.

```bash
mysql -u root -p
```

```sql
CREATE DATABASE IF NOT EXISTS pingos
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'pingos'@'%' IDENTIFIED BY 'uma-senha-forte';
GRANT ALL PRIVILEGES ON pingos.* TO 'pingos'@'%';
FLUSH PRIVILEGES;
```

> As tabelas nÃ£o precisam ser criadas Ã  mÃ£o â€” o passo 3 faz isso (o
> `server/mysql/schema.sql` Ã© idempotente, sÃ³ usa `CREATE TABLE IF NOT EXISTS`).
>
> Se preferir aplicar o schema direto pela CLI:
>
> ```bash
> mysql -u pingos -p < server/mysql/schema.sql
> ```

---

## 5. Passo 2 â€” Configurar as variÃ¡veis de ambiente

Copie o arquivo de exemplo e preencha:

```bash
cp mysql-api.env.example mysql-api.env
```

O arquivo `mysql-api.env` Ã© lido automaticamente pela API (e estÃ¡ no
`.gitignore`, para nÃ£o vazar credenciais no Git).

| VariÃ¡vel                           | ObrigatÃ³ria | DescriÃ§Ã£o                                                                   |
| ----------------------------------- | ------------ | ----------------------------------------------------------------------------- |
| `MYSQL_HOST`                        | âœ…          | Host do banco (`127.0.0.1`, IP do servidor ou nome do container)              |
| `MYSQL_PORT`                        | âœ…          | Porta (padrÃ£o `3306`)                                                        |
| `MYSQL_USER`                        | âœ…          | UsuÃ¡rio do banco                                                             |
| `MYSQL_PASSWORD`                    | âœ…          | Senha do usuÃ¡rio                                                             |
| `MYSQL_DATABASE`                    | âœ…          | Nome do banco (`pingos`)                                                      |
| `MYSQL_POOL_SIZE`                   | â€”          | ConexÃµes simultÃ¢neas (padrÃ£o `10`)                                         |
| `MYSQL_SSL`                         | â€”          | `true` para bancos gerenciados com TLS                                        |
| `MYSQL_AUTO_MIGRATE`                | â€”          | `true` (padrÃ£o): aplica schema/papÃ©is/admin ao subir a API. `false` desliga |
| `API_PORT`                          | â€”          | Porta da API (padrÃ£o `4000`)                                                 |
| `CORS_ORIGIN`                       | â€”          | Origens liberadas, separadas por vÃ­rgula. Vazio = reflete a origem           |
| `SESSION_TTL_DAYS`                  | â€”          | Validade da sessÃ£o em dias (padrÃ£o `30`)                                    |
| `UPLOAD_DIR`                        | â€”          | Pasta das imagens (padrÃ£o `./uploads`)                                       |
| `UPLOAD_MAX_BYTES`                  | â€”          | Tamanho mÃ¡ximo por imagem (padrÃ£o 15 MB)                                    |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | â€”          | Criam o primeiro admin no seed                                                |

No frontend (`.env.local` do Vite):

```
VITE_API_URL=http://localhost:4000
```

---

## 6. Passo 3 â€” Criar as tabelas, papÃ©is e o primeiro administrador

```bash
bun run mysql:seed
```

> **Em Docker / Dokploy nÃ£o execute este passo na mÃ£o.** O container da API roda
> a mesma migraÃ§Ã£o automaticamente no boot (`server/api/boot.ts` â†’
> `server/mysql/migrate.ts`) enquanto `MYSQL_AUTO_MIGRATE` for diferente de
> `false`. O comando acima continua valendo para o desenvolvimento local e para
> reaplicar o schema sob demanda:
>
> ```bash
> docker exec -it <container-da-api> bun run mysql:seed
> ```
>
> Os logs do boot mostram `[migrate] schema aplicado` quando dÃ¡ certo.

O seed Ã© **idempotente** (pode rodar quantas vezes quiser) e faz:

1. Cria o banco, se nÃ£o existir (ou confirma que ele jÃ¡ existe).
2. Cria as 14 tabelas e ajusta colunas de imagem para `MEDIUMTEXT` (as imagens
   sÃ£o data URLs e nÃ£o cabem nos 64 KB do `TEXT`).
3. Cria os papÃ©is padrÃ£o `admin` (todas as permissÃµes) e `user`
   (`DEFAULT_USER_PERMISSIONS`).
4. Garante o contador de nÃºmero de chamado e a linha de configuraÃ§Ãµes.
5. Cria o administrador **se** vocÃª tiver definido `ADMIN_USERNAME` e
   `ADMIN_PASSWORD`:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=senha-com-8-caracteres bun run mysql:seed
```

Sem essas variÃ¡veis, crie o primeiro admin pela prÃ³pria API â€” a rota exige o
`bootstrapToken` (`BOOTSTRAP_TOKEN` ou o token aleatÃ³rio impresso no log do boot
quando a variÃ¡vel nÃ£o existe):

```bash
curl -X POST http://localhost:4000/api/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"bootstrapToken":"SEU_TOKEN","name":"Administrador","username":"admin","password":"senha-com-8-caracteres"}'
```

> O `/api/auth/setup` **sÃ³ funciona com o banco vazio** â€” depois disso, novos
> usuÃ¡rios sÃ£o criados pelo painel (Admin â†’ UsuÃ¡rios). NÃ£o existe senha padrÃ£o:
> um banco vazio sem `ADMIN_*` e sem esse POST fica sem administrador.

---

## 7. Passo 4 â€” Subir a API

```bash
bun run mysql:api
```

SaÃ­da esperada:

```
ðŸš€ PingOS API (MySQL) em http://localhost:4000
   Banco:      mysql://pingos@127.0.0.1:3306/pingos
   Env file:   /caminho/do/projeto/mysql-api.env
   Imagens em: /caminho/do/projeto/uploads
âœ… Conectado ao MySQL e sessÃµes expiradas removidas.
```

Se aparecer `âš ï¸ O MySQL nÃ£o respondeu`, confira as credenciais do
`mysql-api.env` e se o banco foi criado (passo 1).

VerificaÃ§Ã£o rÃ¡pida:

```bash
curl http://localhost:4000/api/health
# {"status":"ok","database":true,"target":{...}}
```

---

## 8. Passo 5 â€” Testar o fluxo principal

```bash
# 1. Login (guarde o token)
curl -X POST http://localhost:4000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"senha-com-8-caracteres"}'

# 2. Listar os chamados (Kanban)
curl http://localhost:4000/api/tickets -H "Authorization: Bearer SEU_TOKEN"

# 3. Abrir um chamado
curl -X POST http://localhost:4000/api/tickets \
  -H "Authorization: Bearer SEU_TOKEN" -H 'Content-Type: application/json' \
  -d '{"title":"Impressora nÃ£o imprime","priority":"alta","location":"RecepÃ§Ã£o"}'

# 4. Mover no Kanban
curl -X POST http://localhost:4000/api/tickets/ID_DO_CHAMADO/status \
  -H "Authorization: Bearer SEU_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"em_andamento"}'
```

---

## 9. Mapa completo de rotas (Convex â†’ REST)

| Convex                                            | REST                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.auth.signIn`                                 | `POST /api/auth/login`                                                                                                                                                                                                                                                                                                        |
| `api.auth.signOut`                                | `POST /api/auth/logout`                                                                                                                                                                                                                                                                                                       |
| `api.permissions.effective`                       | `GET /api/auth/me`                                                                                                                                                                                                                                                                                                            |
| `api.users.anyAdmin` / `systemStatus`             | `GET /api/auth/status`                                                                                                                                                                                                                                                                                                        |
| `POST /api/auth/setup` (com `bootstrapToken`)     | `POST /api/auth/setup`                                                                                                                                                                                                                                                                                                        |
| `api.tickets.list`                                | `GET /api/tickets`                                                                                                                                                                                                                                                                                                            |
| `api.tickets.get`                                 | `GET /api/tickets/:id`                                                                                                                                                                                                                                                                                                        |
| `api.tickets.create`                              | `POST /api/tickets`                                                                                                                                                                                                                                                                                                           |
| `api.tickets.createAsGuest`                       | `POST /api/tickets/guest`                                                                                                                                                                                                                                                                                                     |
| `api.tickets.updateStatus`                        | `POST /api/tickets/:id/status`                                                                                                                                                                                                                                                                                                |
| `api.tickets.update`                              | `PATCH /api/tickets/:id`                                                                                                                                                                                                                                                                                                      |
| `api.tickets.remove`                              | `DELETE /api/tickets/:id`                                                                                                                                                                                                                                                                                                     |
| `api.tickets.monthlyMetrics`                      | `GET /api/metrics/monthly`                                                                                                                                                                                                                                                                                                    |
| `api.tickets.dashboardMetrics`                    | `GET /api/metrics/dashboard`                                                                                                                                                                                                                                                                                                  |
| `api.technicians.list`                            | `GET /api/technicians`                                                                                                                                                                                                                                                                                                        |
| `api.technicians.create`                          | `POST /api/technicians`                                                                                                                                                                                                                                                                                                       |
| `api.technicians.rename`                          | `PATCH /api/technicians/:id`                                                                                                                                                                                                                                                                                                  |
| `api.technicians.toggleActive`                    | `POST /api/technicians/:id/toggle`                                                                                                                                                                                                                                                                                            |
| `api.technicians.remove`                          | `DELETE /api/technicians/:id`                                                                                                                                                                                                                                                                                                 |
| `api.products.list`                               | `GET /api/products`                                                                                                                                                                                                                                                                                                           |
| `api.products.create`                             | `POST /api/products`                                                                                                                                                                                                                                                                                                          |
| `api.products.update`                             | `PATCH /api/products/:id`                                                                                                                                                                                                                                                                                                     |
| `api.products.remove`                             | `DELETE /api/products/:id`                                                                                                                                                                                                                                                                                                    |
| `api.users.listManaged`                           | `GET /api/users`                                                                                                                                                                                                                                                                                                              |
| `api.users.createManaged`                         | `POST /api/users`                                                                                                                                                                                                                                                                                                             |
| `api.users.updateManaged`                         | `PATCH /api/users/:id`                                                                                                                                                                                                                                                                                                        |
| `api.users.resetPassword`                         | `POST /api/users/:id/password`                                                                                                                                                                                                                                                                                                |
| `api.users.deleteManaged`                         | `DELETE /api/users/:id`                                                                                                                                                                                                                                                                                                       |
| `api.roles.list` / `create` / `update` / `remove` | `GET` / `POST` / `PATCH /:id` / `DELETE /:id` em `/api/roles`                                                                                                                                                                                                                                                                 |
| Campo `imageUrl` do chamado                       | `MEDIUMTEXT` na tabela `tickets` (data URL)                                                                                                                                                                                                                                                                                   |
| HistÃ³rico de status                              | `ticket_status_events` â€” gravado a cada mudanÃ§a de status (`POST /api/tickets/:id/status`). Ã‰ a base do **tempo de resposta/resoluÃ§Ã£o** e da **taxa de reabertura**, jÃ¡ que o chamado sÃ³ guarda o status atual                                                                                                        |
| Auditoria de relatÃ³rios                          | `report_logs` â€” quem gerou/exportou, quando, filtros e formato (tela/XLS/PDF)                                                                                                                                                                                                                                               |
| DestinatÃ¡rio/regra do envio                      | colunas `notifications.recipient` e `notifications.rule_id` (alimentam o relatÃ³rio de auditoria de notificaÃ§Ãµes)                                                                                                                                                                                                           |
| Categoria do chamado                              | Coluna `tickets.categoria` (`VARCHAR(40)`, lista fixa: Impressoras, Computadores, Notebooks, Softwares, Rede, Suporte, Outros). Definida no **dropdown ao editar o chamado** e validada pela API (`src/lib/ticket-categories.ts`). Ã‰ classificaÃ§Ã£o interna â€” **nÃ£o** vai para WhatsApp/e-mail/Telegram nem para o cupom |
| â€”                                               | `GET /api/health`                                                                                                                                                                                                                                                                                                             |

---

## 9.1 RelatÃ³rios (`/api/reports/*`)

PÃ¡gina **RelatÃ³rios** (`/reports`, botÃ£o de grÃ¡fico no cabeÃ§alho do painel),
liberada pelas permissÃµes `reports.view` (ver) e `reports.export` (exportar).

| RelatÃ³rio                 | Rota                             | Colunas / totalizadores                                                                                                                                                                              |
| -------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chamados                   | `GET /api/reports/tickets`       | NÂº, tÃ­tulo, status, prioridade, responsÃ¡vel, cliente, setor, abertura, Ãºltima atualizaÃ§Ã£o, tempo total (dias) + total, resolvidos, abertos, tempo mÃ©dio de resoluÃ§Ã£o, por status/prioridade |
| Desempenho por tÃ©cnico    | `GET /api/reports/technicians`   | ResponsÃ¡vel, total, resolvidos, em andamento, tempo mÃ©dio, taxa de reabertura                                                                                                                      |
| Produtividade por setor    | `GET /api/reports/sectors`       | Setor, abertos, resolvidos, pendentes, tempo mÃ©dio de resposta e de resoluÃ§Ã£o                                                                                                                     |
| UsuÃ¡rios e permissÃµes    | `GET /api/reports/users`         | Nome, usuÃ¡rio, e-mail, papel, setor, situaÃ§Ã£o, permissÃµes prÃ³prias, cadastro â€” **sÃ³ admin**                                                                                                  |
| NotificaÃ§Ãµes (auditoria) | `GET /api/reports/notifications` | Data, chamado, regra, destinatÃ¡rio, canal, status do envio                                                                                                                                          |
| OpÃ§Ãµes dos filtros       | `GET /api/reports/filters`       | ResponsÃ¡veis (usuÃ¡rios + tÃ©cnicos), setores, status e prioridades                                                                                                                                 |
| Auditoria                  | `POST /api/reports/log`          | Registra `{ report, format, filters, rowCount }` em `report_logs`                                                                                                                                    |

Filtros comuns (query params): `start` e `end` (timestamp em ms ou
`YYYY-MM-DD`), `status`, `priority`, `assigneeId`, `client`, `setor`,
`categoria`, `q`, `limit` (mÃ¡x. 1000) e `offset`. Sem `start`/`end`, valem os
Ãºltimos 30 dias.

`categoria` aceita uma das opÃ§Ãµes do dropdown de ediÃ§Ã£o (Impressoras,
Computadores, Notebooks, Softwares, Rede, Suporte, Outros â€” a mesma lista de
`src/lib/ticket-categories.ts`, validada no servidor) ou a sentinela
`sem_categoria`, que traz os chamados sem classificaÃ§Ã£o (os anteriores Ã  coluna
existir). A tela de relatÃ³rios manda esse valor no filtro **Categoria**.

DecisÃµes que valem saber:

- **Um `WHERE` sÃ³** alimenta linhas, totalizadores e agrupamentos â€” o nÃºmero do
  rodapÃ© sempre fecha com a tabela.
- **Escopo de visÃ£o:** quem tem Kanban restrito (colunas ou "apenas atribuÃ­dos a
  mim") vÃª nos relatÃ³rios exatamente os mesmos chamados que vÃª no quadro.
- **Tempo de resposta e reabertura** saem de `ticket_status_events`, que comeÃ§ou
  a ser gravado agora: perÃ­odos anteriores a esta versÃ£o aparecem como _sem
  histÃ³rico_ (a tela avisa em vez de mostrar 0%).
- **Datas** sÃ£o BIGINT em ms e o perÃ­odo Ã© filtrado por nÃºmero â€” o navegador
  manda os timestamps calculados no fuso do usuÃ¡rio, sem depender do fuso do
  container.
- **ExportaÃ§Ã£o:** XLS com uma aba por relatÃ³rio + aba de resumo (cabeÃ§alhos em
  negrito, nÃºmeros em pt-BR); PDF com cabeÃ§alho da marca, totalizadores ao final
  e rodapÃ© "PÃ¡gina X de Y". Bibliotecas: `xlsx-js-style`, `jspdf` e
  `jspdf-autotable`, todas carregadas sob demanda.

## 10. Como o frontend consome a API

O adaptador `src/lib/backend/*` Ã© quem conversa com a API â€” os componentes
usam os hooks como sempre usaram:

```tsx
import { api } from "@/lib/backend/api"
import { useQuery, useMutation } from "@/lib/backend/react"

const tickets = useQuery(api.tickets.list) // undefined enquanto carrega
const busy = useQuery(api.tickets.list, "skip") // nÃ£o busca
const updateStatus = useMutation(api.tickets.updateStatus)
await updateStatus({ ticketId, status: "resolvido" })
```

- **Reatividade:** cada mutation invalida as queries montadas e as queries
  tambÃ©m se atualizam a cada 10 s (sÃ³ com a aba visÃ­vel) para pegar o que outro
  usuÃ¡rio mudou.
- **SessÃ£o:** o token fica em `localStorage` (`pingos.mysql.token`); um `401`
  derruba a sessÃ£o e manda para o login.
- **Tipos:** `src/lib/backend/types.ts` descreve o que a API devolve.
- **Adicionar rota nova:** crie em `server/api/routes/`, registre em
  `src/lib/backend/api.ts` e use pelo hook.

A API devolve **os mesmos nomes de campo** do formato antigo (`_id`,
`_creationTime`, camelCase, datas em milissegundos).

---

## 11. ProduÃ§Ã£o (Docker / Dokploy)

A API Ã© um processo Node/Bun normal. Pontos de atenÃ§Ã£o:

1. **Rode o seed uma vez** contra o banco de produÃ§Ã£o:
   `bun run mysql:seed` (com `ADMIN_USERNAME`/`ADMIN_PASSWORD`).
2. **`UPLOAD_DIR` precisa de volume persistente** â€” sem isso as imagens dos
   chamados somem a cada deploy (ex.: montar um volume em `/data/uploads` e
   definir `UPLOAD_DIR=/data/uploads`).
3. **`CORS_ORIGIN`** com o domÃ­nio do app (ex.: `https://pingos.suaempresa.com`),
   ou sirva app e API na mesma origem pelo proxy reverso (aÃ­ `CORS_ORIGIN` pode
   ficar vazio).
4. **Credenciais** vÃªm do painel de variÃ¡veis do serviÃ§o (Dokploy/ZimaOS) â€” nÃ£o
   suba o `mysql-api.env` para dentro da imagem.
5. **Exponha a API** em uma porta/subdomÃ­nio (ex.: `api.suaempresa.com`) e
   aponte `VITE_API_URL` para ela **antes de buildar**, porque variÃ¡veis `VITE_*`
   sÃ£o gravadas no bundle.

### Backup do MySQL

```bash
# Gerar
mysqldump -u pingos -p --single-transaction --routines pingos > backup-$(date +%F).sql

# Restaurar (apaga e reimporta)
mysql -u pingos -p pingos < backup-2026-09-13.sql
```

---

## 12. Trazendo dados antigos (backup do Convex)

O schema MySQL usa **ids de texto no mesmo formato** que o banco antigo e as
mesmas colunas lÃ³gicas â€” de propÃ³sito, para um import direto ser possÃ­vel.
Roteiro (sÃ³ se vocÃª ainda tem o deployment Convex antigo com dados):

1. Exporte as tabelas do Convex antigo (dashboard do Convex â†’ **Data** â†’ export).
   O Convex nÃ£o faz mais parte deste projeto: nada aqui depende dele.
2. Importe `users` **primeiro** (os chamados referenciam `creator_id`).
3. Importe `technicians`, depois `tickets` e as demais.
4. Ajuste o contador de numeraÃ§Ã£o para nÃ£o repetir nÃºmeros:
   ```sql
   UPDATE counters SET value = (SELECT COALESCE(MAX(number), 0) FROM tickets)
   WHERE name = 'ticket_number';
   ```
5. Senhas **nÃ£o sÃ£o importÃ¡veis** (o hash do Convex Auth Ã© diferente do scrypt
   usado aqui): redefina a senha dos usuÃ¡rios pelo painel do admin
   (`POST /api/users/:id/password`).

> Um script de importaÃ§Ã£o dedicado ainda nÃ£o existe â€” se quiser, Ã© o prÃ³ximo
> passo natural.

---

## 13. SoluÃ§Ã£o de problemas

| Sintoma                                       | Causa provÃ¡vel / soluÃ§Ã£o                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `âš ï¸ O MySQL nÃ£o respondeu`                | Credenciais erradas no `mysql-api.env`, banco nÃ£o criado (passo 1) ou MySQL parado                                                         |
| `ER_ACCESS_DENIED_ERROR`                      | UsuÃ¡rio/senha errados, ou o usuÃ¡rio nÃ£o tem `GRANT` no banco                                                                             |
| `ECONNREFUSED`                                | Host/porta errados, firewall, ou MySQL escutando sÃ³ em `localhost` (`bind-address`)                                                        |
| `ER_NO_SUCH_TABLE`                            | Rode `bun run mysql:seed`                                                                                                                   |
| Login responde "UsuÃ¡rio ou senha invÃ¡lidos" | A conta precisa existir no MySQL: crie pelo painel (Admin â†’ UsuÃ¡rios) ou rode `bun run mysql:seed` com `ADMIN_USERNAME`/`ADMIN_PASSWORD` |
| "UsuÃ¡rio inativo"                            | O usuÃ¡rio estÃ¡ com `active = 0` â€” reative em Admin â†’ UsuÃ¡rios                                                                        |
| Imagem do chamado nÃ£o aparece                | A coluna `tickets.image_url` precisa ser `MEDIUMTEXT` (o boot ajusta; rode `bun run mysql:seed` se necessÃ¡rio)                             |
| Erro de CORS no navegador                     | Defina `CORS_ORIGIN` com o domÃ­nio do app                                                                                                  |
| Erros de tipo em `server/`                    | `bun run mysql:typecheck` (o `tsc` do app nÃ£o cobre a pasta `server/`)                                                                     |

---

## 14. Comandos

```bash
bun run mysql:seed        # cria banco, tabelas, papÃ©is e (opcional) o admin
bun run mysql:api         # sobe a API em http://localhost:4000
bun run mysql:typecheck   # typecheck do backend MySQL
```
