# PingOS com MySQL — backend paralelo

Este documento explica como rodar o PingOS com **banco MySQL**. O backend MySQL
**substituiu o Convex**: o frontend inteiro fala com a API Express por meio do
adaptador `src/lib/backend/*` (que expõe `useQuery`/`useMutation` com a mesma
assinatura dos hooks do Convex, então os componentes não mudaram de lógica).

```
   Frontend (Vite) ──► src/lib/backend/* ──► API Express ──► MySQL
```

---

## 1. O que já está pronto (fase 1)

| Módulo                | Convex (antes)                                    | MySQL (agora)                                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Banco de dados        | Convex                                            | `server/mysql/schema.sql` (14 tabelas)                                                                                                                                                                                                  |
| Login / sessões       | Convex Auth                                       | `POST /api/auth/*` (scrypt + tabela `sessions`)                                                                                                                                                                                         |
| Chamados / Kanban     | `api.tickets.*`                                   | `/api/tickets` (listar, abrir, mover, editar, excluir)                                                                                                                                                                                  |
| Abertura pública      | `api.tickets.createAsGuest`                       | `POST /api/tickets/guest`                                                                                                                                                                                                               |
| Usuários              | `api.users.*`                                     | `/api/users`                                                                                                                                                                                                                            |
| Papéis (RBAC)         | `api.roles.*`                                     | `/api/roles`                                                                                                                                                                                                                            |
| Técnicos              | `api.technicians.*`                               | `/api/technicians`                                                                                                                                                                                                                      |
| Produtos e serviços   | — (novo)                                          | `/api/products` (nome + tipo + valor). O tipo (`produto` \| `servico`, coluna `item_type`) diferencia peça/equipamento de mão de obra. Leitura livre para logados (menu `/` da Solução e do Orçamento); escrita exige `settings.manage` |
| Métricas              | `api.tickets.monthlyMetrics` / `dashboardMetrics` | `/api/metrics/monthly` · `/api/metrics/dashboard`                                                                                                                                                                                       |
| Imagens dos chamados  | Convex storage                                    | campo `image_url` (data URL no próprio chamado)                                                                                                                                                                                         |
| Notificações (config) | `api.notificationSettings.*`                      | `GET/PUT /api/notification-settings`                                                                                                                                                                                                    |
| Regras de inatividade | `api.notificationRules.*`                         | CRUD `/api/notification-rules`                                                                                                                                                                                                          |
| Sino in-app           | `api.inAppNotifications.*`                        | `/api/in-app-notifications`                                                                                                                                                                                                             |
| Papéis (permissões)   | `api.permissions.*`                               | `GET /api/auth/me` · `/api/permissions/any-admin`                                                                                                                                                                                       |
| Backup (painel admin) | `api.backups.*`                                   | `/api/backups` (listar, gerar, baixar, restaurar, upload)                                                                                                                                                                               |
| Relatórios            | — (novo)                                          | `/api/reports/*` (chamados, técnicos, setores, usuários, notificações) + exportação XLS/PDF no frontend e auditoria em `report_logs`                                                                                                    |
| Login do app          | Convex Auth                                       | `POST /api/auth/login` (token em `localStorage`)                                                                                                                                                                                        |

As **regras de permissão são as mesmas**: `server/api/permissions.ts` importa
`src/lib/permissions.ts`, o mesmo arquivo que o frontend usa. Não existem duas
verdades sobre quem pode ver/editar o quê.

## 2. Notificações, inatividade e backup

Tudo aqui já está no backend MySQL — não existe mais nenhuma rota respondendo
"ainda não migrado".

### Envio de notificações — `server/api/notify.ts`

Disparado por:

| Evento                                                        | O que sai                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Novo chamado** (`POST /api/tickets` e `/api/tickets/guest`) | sino in-app para quem tem `tickets.view` + e-mail/Telegram/WhatsApp conforme a configuração |
| **Mudança de status** (`POST /api/tickets/:id/status`)        | sino in-app para solicitante e responsável + canais externos                                |
| **Inatividade** (regras)                                      | canais escolhidos em cada regra                                                             |

Os canais são ligados na aba **Configurações → Notificações** do app (tabela
`notification_settings`); os segredos vêm do ambiente:

| Canal    | Variáveis                                                                                       |
| -------- | ----------------------------------------------------------------------------------------------- |
| E-mail   | `RESEND_API_KEY`, `RESEND_FROM` (sem a chave o envio falha e o motivo vai para `notifications`) |
| Telegram | token/chat_id salvos no próprio app                                                             |
| WhatsApp | API oficial (token + phone number id no app) ou a **ponte Baileys** (`WHATSAPP_BRIDGE_URL`)     |

Cada tentativa é registrada na tabela `notifications` (sent/failed + erro) e o
envio é "fire-and-forget": nunca atrasa nem derruba a requisição do usuário.
`SITE_URL` define o link que aparece nas mensagens.

### Inatividade — `server/api/inactivity.ts`

Para cada regra ativa, procura chamados nos status da regra com
`updated_at` mais antigo que `days_inactive` dias, pula os pares chamado+regra
já alertados (tabela `inactivity_logs`, o anti-spam) e dispara o alerta.
Qualquer edição ou mudança de status do chamado zera esse histórico.

Roda:

- automaticamente, a cada `INACTIVITY_INTERVAL_MINUTES` (padrão 60; `0` desliga);
- manualmente, por `POST /api/inactivity/run` (botão "verificar agora").

### Backup e restauração — `server/api/backup.ts` + `routes/backups.ts`

| Rota                            | Ação                                               |
| ------------------------------- | -------------------------------------------------- |
| `GET /api/backups`              | histórico (`backups`) + auditoria (`backup_logs`)  |
| `POST /api/backups`             | gera o arquivo `.json` em `BACKUP_DIR`             |
| `GET /api/backups/:id/download` | baixa o arquivo                                    |
| `POST /api/backups/:id/restore` | restaura o banco a partir do arquivo               |
| `POST /api/backups/upload`      | recebe um `.json` do computador, valida e registra |

- O backup é um **JSON com o conteúdo das tabelas de dados** (sem `sessions`,
  `backups` e `backup_logs`) — não depende de `mysqldump` no container.
- A restauração roda em **transação** (`DELETE` + `INSERT`, FKs desligadas
  apenas naquela conexão) e derruba todas as sessões no fim: todo mundo faz
  login de novo. Falha no meio = rollback, banco atual intacto.
- Antes de restaurar, o servidor gera um **backup de segurança**
  (`BACKUP_SAFETY=false` desliga).
- Variáveis: `BACKUP_DIR` (padrão `./backups`; em Docker `/data/backups`, com
  volume), `BACKUP_MAX_BYTES`, `BACKUP_SAFETY`.

Os resquícios do Convex **já foram removidos**: `src/convex/`, `convex.json` e as
dependências `convex` / `@convex-dev/auth` não existem mais no projeto (o
histórico deste documento mantém algumas comparações "Convex → MySQL" como
referência da migração).

---

## 3. Pré-requisitos

- **MySQL 8.0 ou superior** (ou MariaDB 10.6+) rodando e acessível.
- **Bun 1.x** (o projeto já usa Bun para o bridge do WhatsApp).

Se quiser subir um MySQL rapidinho só para testar (Docker):

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

## 4. Passo 1 — Criar o banco e o usuário da aplicação

Em produção **não use o root**: crie um usuário exclusivo do app.

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

> As tabelas não precisam ser criadas à mão — o passo 3 faz isso (o
> `server/mysql/schema.sql` é idempotente, só usa `CREATE TABLE IF NOT EXISTS`).
>
> Se preferir aplicar o schema direto pela CLI:
>
> ```bash
> mysql -u pingos -p < server/mysql/schema.sql
> ```

---

## 5. Passo 2 — Configurar as variáveis de ambiente

Copie o arquivo de exemplo e preencha:

```bash
cp mysql-api.env.example mysql-api.env
```

O arquivo `mysql-api.env` é lido automaticamente pela API (e está no
`.gitignore`, para não vazar credenciais no Git).

| Variável                            | Obrigatória | Descrição                                                                   |
| ----------------------------------- | ----------- | --------------------------------------------------------------------------- |
| `MYSQL_HOST`                        | ✅          | Host do banco (`127.0.0.1`, IP do servidor ou nome do container)            |
| `MYSQL_PORT`                        | ✅          | Porta (padrão `3306`)                                                       |
| `MYSQL_USER`                        | ✅          | Usuário do banco                                                            |
| `MYSQL_PASSWORD`                    | ✅          | Senha do usuário                                                            |
| `MYSQL_DATABASE`                    | ✅          | Nome do banco (`pingos`)                                                    |
| `MYSQL_POOL_SIZE`                   | —           | Conexões simultâneas (padrão `10`)                                          |
| `MYSQL_SSL`                         | —           | `true` para bancos gerenciados com TLS                                      |
| `MYSQL_AUTO_MIGRATE`                | —           | `true` (padrão): aplica schema/papéis/admin ao subir a API. `false` desliga |
| `API_PORT`                          | —           | Porta da API (padrão `4000`)                                                |
| `CORS_ORIGIN`                       | —           | Origens liberadas, separadas por vírgula. Vazio = reflete a origem          |
| `SESSION_TTL_DAYS`                  | —           | Validade da sessão em dias (padrão `30`)                                    |
| `UPLOAD_DIR`                        | —           | Pasta das imagens (padrão `./uploads`)                                      |
| `UPLOAD_MAX_BYTES`                  | —           | Tamanho máximo por imagem (padrão 15 MB)                                    |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | —           | Criam o primeiro admin no seed                                              |

No frontend (`.env.local` do Vite):

```
VITE_API_URL=http://localhost:4000
```

---

## 6. Passo 3 — Criar as tabelas, papéis e o primeiro administrador

```bash
bun run mysql:seed
```

> **Em Docker / Dokploy não execute este passo na mão.** O container da API roda
> a mesma migração automaticamente no boot (`server/api/boot.ts` →
> `server/mysql/migrate.ts`) enquanto `MYSQL_AUTO_MIGRATE` for diferente de
> `false`. O comando acima continua valendo para o desenvolvimento local e para
> reaplicar o schema sob demanda:
>
> ```bash
> docker exec -it <container-da-api> bun run mysql:seed
> ```
>
> Os logs do boot mostram `[migrate] schema aplicado` quando dá certo.

O seed é **idempotente** (pode rodar quantas vezes quiser) e faz:

1. Cria o banco, se não existir (ou confirma que ele já existe).
2. Cria as 14 tabelas e ajusta colunas de imagem para `MEDIUMTEXT` (as imagens
   são data URLs e não cabem nos 64 KB do `TEXT`).
3. Cria os papéis padrão `admin` (todas as permissões) e `user`
   (`DEFAULT_USER_PERMISSIONS`).
4. Garante o contador de número de chamado e a linha de configurações.
5. Cria o administrador **se** você tiver definido `ADMIN_USERNAME` e
   `ADMIN_PASSWORD`:

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=senha-com-8-caracteres bun run mysql:seed
```

Sem essas variáveis, crie o primeiro admin pela própria API:

```bash
curl -X POST http://localhost:4000/api/auth/setup \
  -H 'Content-Type: application/json' \
  -d '{"name":"Administrador","username":"admin","password":"senha-com-8-caracteres"}'
```

> O `/api/auth/setup` **só funciona com o banco vazio** — depois disso, novos
> usuários são criados pelo painel (Admin → Usuários).

---

## 7. Passo 4 — Subir a API

```bash
bun run mysql:api
```

Saída esperada:

```
🚀 PingOS API (MySQL) em http://localhost:4000
   Banco:      mysql://pingos@127.0.0.1:3306/pingos
   Env file:   /caminho/do/projeto/mysql-api.env
   Imagens em: /caminho/do/projeto/uploads
✅ Conectado ao MySQL e sessões expiradas removidas.
```

Se aparecer `⚠️ O MySQL não respondeu`, confira as credenciais do
`mysql-api.env` e se o banco foi criado (passo 1).

Verificação rápida:

```bash
curl http://localhost:4000/api/health
# {"status":"ok","database":true,"target":{...}}
```

---

## 8. Passo 5 — Testar o fluxo principal

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
  -d '{"title":"Impressora não imprime","priority":"alta","location":"Recepção"}'

# 4. Mover no Kanban
curl -X POST http://localhost:4000/api/tickets/ID_DO_CHAMADO/status \
  -H "Authorization: Bearer SEU_TOKEN" -H 'Content-Type: application/json' \
  -d '{"status":"em_andamento"}'
```

---

## 9. Mapa completo de rotas (Convex → REST)

| Convex                                            | REST                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.auth.signIn`                                 | `POST /api/auth/login`                                                                                                                                                                                                                                                                                                  |
| `api.auth.signOut`                                | `POST /api/auth/logout`                                                                                                                                                                                                                                                                                                 |
| `api.permissions.effective`                       | `GET /api/auth/me`                                                                                                                                                                                                                                                                                                      |
| `api.users.anyAdmin` / `systemStatus`             | `GET /api/auth/status`                                                                                                                                                                                                                                                                                                  |
| `api.users.seedFirstAdmin`                        | `POST /api/auth/setup`                                                                                                                                                                                                                                                                                                  |
| `api.tickets.list`                                | `GET /api/tickets`                                                                                                                                                                                                                                                                                                      |
| `api.tickets.get`                                 | `GET /api/tickets/:id`                                                                                                                                                                                                                                                                                                  |
| `api.tickets.create`                              | `POST /api/tickets`                                                                                                                                                                                                                                                                                                     |
| `api.tickets.createAsGuest`                       | `POST /api/tickets/guest`                                                                                                                                                                                                                                                                                               |
| `api.tickets.updateStatus`                        | `POST /api/tickets/:id/status`                                                                                                                                                                                                                                                                                          |
| `api.tickets.update`                              | `PATCH /api/tickets/:id`                                                                                                                                                                                                                                                                                                |
| `api.tickets.remove`                              | `DELETE /api/tickets/:id`                                                                                                                                                                                                                                                                                               |
| `api.tickets.monthlyMetrics`                      | `GET /api/metrics/monthly`                                                                                                                                                                                                                                                                                              |
| `api.tickets.dashboardMetrics`                    | `GET /api/metrics/dashboard`                                                                                                                                                                                                                                                                                            |
| `api.technicians.list`                            | `GET /api/technicians`                                                                                                                                                                                                                                                                                                  |
| `api.technicians.create`                          | `POST /api/technicians`                                                                                                                                                                                                                                                                                                 |
| `api.technicians.rename`                          | `PATCH /api/technicians/:id`                                                                                                                                                                                                                                                                                            |
| `api.technicians.toggleActive`                    | `POST /api/technicians/:id/toggle`                                                                                                                                                                                                                                                                                      |
| `api.technicians.remove`                          | `DELETE /api/technicians/:id`                                                                                                                                                                                                                                                                                           |
| `api.products.list`                               | `GET /api/products`                                                                                                                                                                                                                                                                                                     |
| `api.products.create`                             | `POST /api/products`                                                                                                                                                                                                                                                                                                    |
| `api.products.update`                             | `PATCH /api/products/:id`                                                                                                                                                                                                                                                                                               |
| `api.products.remove`                             | `DELETE /api/products/:id`                                                                                                                                                                                                                                                                                              |
| `api.users.listManaged`                           | `GET /api/users`                                                                                                                                                                                                                                                                                                        |
| `api.users.createManaged`                         | `POST /api/users`                                                                                                                                                                                                                                                                                                       |
| `api.users.updateManaged`                         | `PATCH /api/users/:id`                                                                                                                                                                                                                                                                                                  |
| `api.users.resetPassword`                         | `POST /api/users/:id/password`                                                                                                                                                                                                                                                                                          |
| `api.users.deleteManaged`                         | `DELETE /api/users/:id`                                                                                                                                                                                                                                                                                                 |
| `api.roles.list` / `create` / `update` / `remove` | `GET` / `POST` / `PATCH /:id` / `DELETE /:id` em `/api/roles`                                                                                                                                                                                                                                                           |
| Campo `imageUrl` do chamado                       | `MEDIUMTEXT` na tabela `tickets` (data URL)                                                                                                                                                                                                                                                                             |
| Histórico de status                               | `ticket_status_events` — gravado a cada mudança de status (`POST /api/tickets/:id/status`). É a base do **tempo de resposta/resolução** e da **taxa de reabertura**, já que o chamado só guarda o status atual                                                                                                          |
| Auditoria de relatórios                           | `report_logs` — quem gerou/exportou, quando, filtros e formato (tela/XLS/PDF)                                                                                                                                                                                                                                           |
| Destinatário/regra do envio                       | colunas `notifications.recipient` e `notifications.rule_id` (alimentam o relatório de auditoria de notificações)                                                                                                                                                                                                        |
| Categoria do chamado                              | Coluna `tickets.categoria` (`VARCHAR(40)`, lista fixa: Impressoras, Computadores, Notebooks, Softwares, Rede, Suporte, Outros). Definida no **dropdown ao editar o chamado** e validada pela API (`src/lib/ticket-categories.ts`). É classificação interna — **não** vai para WhatsApp/e-mail/Telegram nem para o cupom |
| —                                                 | `GET /api/health`                                                                                                                                                                                                                                                                                                       |

---

## 9.1 Relatórios (`/api/reports/*`)

Página **Relatórios** (`/reports`, botão de gráfico no cabeçalho do painel),
liberada pelas permissões `reports.view` (ver) e `reports.export` (exportar).

| Relatório                | Rota                             | Colunas / totalizadores                                                                                                                                                                     |
| ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chamados                 | `GET /api/reports/tickets`       | Nº, título, status, prioridade, responsável, cliente, setor, abertura, última atualização, tempo total (dias) + total, resolvidos, abertos, tempo médio de resolução, por status/prioridade |
| Desempenho por técnico   | `GET /api/reports/technicians`   | Responsável, total, resolvidos, em andamento, tempo médio, taxa de reabertura                                                                                                               |
| Produtividade por setor  | `GET /api/reports/sectors`       | Setor, abertos, resolvidos, pendentes, tempo médio de resposta e de resolução                                                                                                               |
| Usuários e permissões    | `GET /api/reports/users`         | Nome, usuário, e-mail, papel, setor, situação, permissões próprias, cadastro — **só admin**                                                                                                 |
| Notificações (auditoria) | `GET /api/reports/notifications` | Data, chamado, regra, destinatário, canal, status do envio                                                                                                                                  |
| Opções dos filtros       | `GET /api/reports/filters`       | Responsáveis (usuários + técnicos), setores, status e prioridades                                                                                                                           |
| Auditoria                | `POST /api/reports/log`          | Registra `{ report, format, filters, rowCount }` em `report_logs`                                                                                                                           |

Filtros comuns (query params): `start` e `end` (timestamp em ms ou
`YYYY-MM-DD`), `status`, `priority`, `assigneeId`, `client`, `setor`,
`categoria`, `q`, `limit` (máx. 1000) e `offset`. Sem `start`/`end`, valem os
últimos 30 dias.

`categoria` aceita uma das opções do dropdown de edição (Impressoras,
Computadores, Notebooks, Softwares, Rede, Suporte, Outros — a mesma lista de
`src/lib/ticket-categories.ts`, validada no servidor) ou a sentinela
`sem_categoria`, que traz os chamados sem classificação (os anteriores à coluna
existir). A tela de relatórios manda esse valor no filtro **Categoria**.

Decisões que valem saber:

- **Um `WHERE` só** alimenta linhas, totalizadores e agrupamentos — o número do
  rodapé sempre fecha com a tabela.
- **Escopo de visão:** quem tem Kanban restrito (colunas ou "apenas atribuídos a
  mim") vê nos relatórios exatamente os mesmos chamados que vê no quadro.
- **Tempo de resposta e reabertura** saem de `ticket_status_events`, que começou
  a ser gravado agora: períodos anteriores a esta versão aparecem como _sem
  histórico_ (a tela avisa em vez de mostrar 0%).
- **Datas** são BIGINT em ms e o período é filtrado por número — o navegador
  manda os timestamps calculados no fuso do usuário, sem depender do fuso do
  container.
- **Exportação:** XLS com uma aba por relatório + aba de resumo (cabeçalhos em
  negrito, números em pt-BR); PDF com cabeçalho da marca, totalizadores ao final
  e rodapé "Página X de Y". Bibliotecas: `xlsx-js-style`, `jspdf` e
  `jspdf-autotable`, todas carregadas sob demanda.

## 10. Como o frontend consome a API

O adaptador `src/lib/backend/*` é quem conversa com a API — os componentes
usam os hooks como sempre usaram:

```tsx
import { api } from "@/lib/backend/api"
import { useQuery, useMutation } from "@/lib/backend/react"

const tickets = useQuery(api.tickets.list) // undefined enquanto carrega
const busy = useQuery(api.tickets.list, "skip") // não busca
const updateStatus = useMutation(api.tickets.updateStatus)
await updateStatus({ ticketId, status: "resolvido" })
```

- **Reatividade:** cada mutation invalida as queries montadas e as queries
  também se atualizam a cada 10 s (só com a aba visível) para pegar o que outro
  usuário mudou.
- **Sessão:** o token fica em `localStorage` (`pingos.mysql.token`); um `401`
  derruba a sessão e manda para o login.
- **Tipos:** `src/lib/backend/types.ts` descreve o que a API devolve.
- **Adicionar rota nova:** crie em `server/api/routes/`, registre em
  `src/lib/backend/api.ts` e use pelo hook.

A API devolve **os mesmos nomes de campo** do formato antigo (`_id`,
`_creationTime`, camelCase, datas em milissegundos).

---

## 11. Produção (Docker / Dokploy)

A API é um processo Node/Bun normal. Pontos de atenção:

1. **Rode o seed uma vez** contra o banco de produção:
   `bun run mysql:seed` (com `ADMIN_USERNAME`/`ADMIN_PASSWORD`).
2. **`UPLOAD_DIR` precisa de volume persistente** — sem isso as imagens dos
   chamados somem a cada deploy (ex.: montar um volume em `/data/uploads` e
   definir `UPLOAD_DIR=/data/uploads`).
3. **`CORS_ORIGIN`** com o domínio do app (ex.: `https://pingos.suaempresa.com`),
   ou sirva app e API na mesma origem pelo proxy reverso (aí `CORS_ORIGIN` pode
   ficar vazio).
4. **Credenciais** vêm do painel de variáveis do serviço (Dokploy/ZimaOS) — não
   suba o `mysql-api.env` para dentro da imagem.
5. **Exponha a API** em uma porta/subdomínio (ex.: `api.suaempresa.com`) e
   aponte `VITE_API_URL` para ela **antes de buildar**, porque variáveis `VITE_*`
   são gravadas no bundle.

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
mesmas colunas lógicas — de propósito, para um import direto ser possível.
Roteiro (só se você ainda tem o deployment Convex antigo com dados):

1. Exporte as tabelas do Convex antigo (dashboard do Convex → **Data** → export).
   O Convex não faz mais parte deste projeto: nada aqui depende dele.
2. Importe `users` **primeiro** (os chamados referenciam `creator_id`).
3. Importe `technicians`, depois `tickets` e as demais.
4. Ajuste o contador de numeração para não repetir números:
   ```sql
   UPDATE counters SET value = (SELECT COALESCE(MAX(number), 0) FROM tickets)
   WHERE name = 'ticket_number';
   ```
5. Senhas **não são importáveis** (o hash do Convex Auth é diferente do scrypt
   usado aqui): redefina a senha dos usuários pelo painel do admin
   (`POST /api/users/:id/password`).

> Um script de importação dedicado ainda não existe — se quiser, é o próximo
> passo natural.

---

## 13. Solução de problemas

| Sintoma                                     | Causa provável / solução                                                                                                                 |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `⚠️ O MySQL não respondeu`                  | Credenciais erradas no `mysql-api.env`, banco não criado (passo 1) ou MySQL parado                                                       |
| `ER_ACCESS_DENIED_ERROR`                    | Usuário/senha errados, ou o usuário não tem `GRANT` no banco                                                                             |
| `ECONNREFUSED`                              | Host/porta errados, firewall, ou MySQL escutando só em `localhost` (`bind-address`)                                                      |
| `ER_NO_SUCH_TABLE`                          | Rode `bun run mysql:seed`                                                                                                                |
| Login responde "Usuário ou senha inválidos" | A conta precisa existir no MySQL: crie pelo painel (Admin → Usuários) ou rode `bun run mysql:seed` com `ADMIN_USERNAME`/`ADMIN_PASSWORD` |
| "Usuário inativo"                           | O usuário está com `active = 0` — reative em Admin → Usuários                                                                            |
| Imagem do chamado não aparece               | A coluna `tickets.image_url` precisa ser `MEDIUMTEXT` (o boot ajusta; rode `bun run mysql:seed` se necessário)                           |
| Erro de CORS no navegador                   | Defina `CORS_ORIGIN` com o domínio do app                                                                                                |
| Erros de tipo em `server/`                  | `bun run mysql:typecheck` (o `tsc` do app não cobre a pasta `server/`)                                                                   |

---

## 14. Comandos

```bash
bun run mysql:seed        # cria banco, tabelas, papéis e (opcional) o admin
bun run mysql:api         # sobe a API em http://localhost:4000
bun run mysql:typecheck   # typecheck do backend MySQL
```
