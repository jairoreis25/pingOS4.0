# Deploy do PingOS no Dokploy — guia detalhado (aba por aba)

Guia completo para implantar o PingOS num VPS com **Dokploy**, cobrindo as abas
**General**, **Environment**, **Domains**, **Deployments/Logs** e **Advanced**,
com as variáveis de ambiente exatas, o fluxo de deploy e as duas formas de
acessar o app (**domínio** com HTTPS ou **IP:porta**).

---

## 0. Arquitetura do que vai subir

```
┌────────────────────────────── VPS com Dokploy ───────────────────────────────┐
│                                                                              │
│   Traefik (80/443)  ──HTTPS──▶  app  (nginx, porta 80 no container)          │
│                                    │  SPA + proxy /whatsapp-api              │
│                                    ▼                                         │
│                                 whatsapp  (Baileys, porta 3001, interna)      │
│                                                                              │
│                                 api  (Express + MySQL, porta 4000)           │
│                                        │                                     │
│   dokploy-network ◀────────────────────┘  (rede interna do Dokploy)          │
│        └── database  (MySQL do painel, porta 3306 — sem porta pública)       │
└──────────────────────────────────────────────────────────────────────────────┘
```

(Não há nenhuma dependência de nuvem: o Convex foi removido do projeto.)

- O **app** é o bundle do Vite servido pelo nginx, com fallback de SPA
  (react-router) e proxy de `/whatsapp-api`, `/api` e `/uploads` (mesma origem,
  sem CORS).
- O **backend inteiro roda no Dokploy**: a API Express é quem fala com o MySQL.
- A **ponte do WhatsApp** roda no VPS e guarda a sessão num volume persistente.
- A **API MySQL** (`server/api/`) também roda no VPS e alcança o **MySQL criado
  no painel do Dokploy** pelo _host interno_, dentro da rede `dokploy-network`
  — o banco não precisa de porta publicada (veja a **seção 3.3**).

### Portas envolvidas

| Serviço           | Porta no container | Porta no host (VPS) | Para que serve                                       |
| ----------------- | ------------------ | ------------------- | ---------------------------------------------------- |
| `app` (nginx)     | `80`               | `8090`              | SPA + proxy do WhatsApp                              |
| `whatsapp`        | `3001`             | — (interna)         | Ponte Baileys                                        |
| `api`             | `4000`             | `4000`              | Backend MySQL (`/api/health`)                        |
| `bot` (Ping IA)   | — (long polling)   | — (interna)         | Agente administrativo no Telegram                    |
| MySQL (Dokploy)   | `3306`             | — (interna)         | Banco do painel; acessível só pela `dokploy-network` |
| Traefik (Dokploy) | `80` / `443`       | `80` / `443`        | Domínios + HTTPS                                     |
| Painel do Dokploy | `3000`             | `3000`              | **Não use esta porta**                               |

> **Por que `8090` e não `3000`?** O painel do Dokploy já ocupa a `3000` no host,
> e o Traefik usa `80`/`443`. Publicar o app na `3000` faria o deploy falhar com
> `port is already allocated`.

---

## 1. Pré-requisitos

1. **VPS** (Ubuntu 22.04/24.04, 2 GB de RAM no mínimo) com o **Dokploy
   instalado** → https://docs.dokploy.com/docs/core/installation
2. **Domínio** apontando para o IP da VPS (registro **A**), ex.:
   `pingos.suaempresa.com → 203.0.113.10`. Para HTTPS é obrigatório.
3. **Banco MySQL** criado no painel do Dokploy (seção 3.3) — dele saem o host
   interno, o usuário, a senha e o nome do banco.
4. **Portas abertas** no firewall da VPS:
   ```bash
   sudo ufw allow 80,443/tcp     # domínio + HTTPS (obrigatório)
   sudo ufw allow 8090/tcp       # SOMENTE se quiser acessar por IP
   sudo ufw allow 4000/tcp       # SOMENTE se quiser testar a API por IP
   ```
   > Se você usa o firewall do painel do provedor (Oracle, Hetzner, etc.), libere
   > lá também.

---

## 2. Aba General — criar e configurar o serviço

1. **Projects → Create Project** → nome `PingOS`.
2. Dentro do projeto: **Create Service → Docker Compose**.
   - Tipo **Docker Compose** (NÃO use **Stack**: o modo Swarm não suporta
     `build:`, e é isso que o nosso compose usa).
3. Na aba **General**, preencha:

| Campo            | Valor                    | Observação                              |
| ---------------- | ------------------------ | --------------------------------------- |
| **Name**         | `pingos`                 | nome do serviço no Dokploy              |
| **Provider**     | `GitHub` (ou Git/GitLab) | conecte a conta em Settings → Git antes |
| **Repository**   | seu repo do PingOS       | ex.: `seuusuario/pingos`                |
| **Branch**       | `main`                   | a branch que será deployada             |
| **Compose Path** | `docker-compose.yml`     | caminho relativo à raiz do repo         |
| **Auto Deploy**  | ligue se quiser          | gera webhook: cada `git push` redeploya |

4. Confira que estes arquivos estão **commitados** no repo (sem eles o build
   falha):

```
docker-compose.yml
Dockerfile
nginx.conf
server/Dockerfile
server/api/Dockerfile        (só se for usar o MySQL)
.dockerignore
config.js.template           (config de runtime servida em /config.js)
docker-entrypoint.sh         (gera o /config.js no start do container)
src/lib/backend/           (adaptador que fala com a API)
```

5. **Não** adicione `container_name:` em nenhum serviço do compose. O Dokploy
   usa o nome gerado pelo Docker para logs, métricas e monitoramento.

> Dica: existe o botão **Preview Compose** — ele mostra o compose final com as
> labels e redes que o Dokploy adiciona. Use antes de deployar.

### Advanced (opcional)

- **Command**: deixe em branco. Só preencha para substituir o comando padrão do
  Dokploy (ele mostra qual é; o comando custom **substitui**, não complementa).
- **Mounts / Volumes**: **não** use caminhos do repositório como bind mount —
  o Dokploy roda `git clone` a cada deploy e o conteúdo some. O nosso compose já
  usa **volumes nomeados** (`whatsapp-session`, `uploads`), que persistem e ainda
  aparecem na aba **Volume Backups** (backup para S3).

---

## 3. Aba Environment — as variáveis

⚠️ **Faça isso antes do primeiro deploy.** As variáveis `VITE_*` funcionam em
dois níveis: o valor de **runtime** (servido em `/config.js`, gerado pelo próprio
container) tem prioridade sobre o valor **embutido no build** (fallback). Na
prática, mudar qualquer `VITE_*` depois do deploy **não exige rebuild** — basta
**Restart** do serviço. Veja a **seção 3.2**.

O Dokploy grava o que você digita aqui num arquivo `.env` ao lado do
`docker-compose.yml`. **As variáveis não entram nos containers
automaticamente** — só as que o compose referencia via `${VAR}` (é exatamente o
que o nosso compose faz).

Cole na aba **Environment** (troque pelos seus valores):

```env
# Deixe VAZIO para a API ser chamada na mesma origem (/api pelo nginx) —
# é o recomendado. Só preencha com URL HTTP se expor a API num subdomínio.
VITE_API_URL=

# Opcional: só se a ponte do WhatsApp for exposta num subdomínio próprio.
# Vazio = o navegador usa o proxy /whatsapp-api do nginx (recomendado).
# VITE_WHATSAPP_WEB_URL=https://wa.suaempresa.com

# ── Backend MySQL (runtime — só se o serviço `api` estiver no compose) ──
# Banco criado no Dokploy → cole o "Internal Host" da aba Connection (seção 3.3).
# MySQL fora do Docker, na mesma VPS → use host.docker.internal.
MYSQL_HOST=pingod-h2rdn7
MYSQL_PORT=3306
MYSQL_USER=pingos
MYSQL_PASSWORD=troque-por-uma-senha-forte
MYSQL_DATABASE=pingos
MYSQL_POOL_SIZE=10
MYSQL_SSL=false

# Aplica schema + papéis + admin a cada boot (idempotente). "false" desliga.
MYSQL_AUTO_MIGRATE=true

# Opcional: cria o 1º administrador no primeiro boot do container `api`.
# ADMIN_USERNAME=admin
# ADMIN_PASSWORD=uma-senha-com-8-ou-mais-caracteres
# ADMIN_NAME=Administrador

API_PORT=4000
# Só importa para acesso direto à API (IP:4000). Com o site servindo /api na
# mesma origem, pode ficar vazio.
CORS_ORIGIN=https://pingos.suaempresa.com
SESSION_TTL_DAYS=30
JSON_BODY_LIMIT=2mb
UPLOAD_MAX_BYTES=15728640

# ── Backup e restauração (Configurações → Backup) ───────────────────────
# A pasta é do container; o volume `backups` do compose guarda os arquivos.
BACKUP_DIR=/data/backups
BACKUP_SAFETY=true
BACKUP_MAX_BYTES=268435456

# ── Notificações ────────────────────────────────────────────────────────
# URL pública do app (links das mensagens) e segredos de envio.
SITE_URL=https://pingos.suaempresa.com
RESEND_API_KEY=
RESEND_FROM=PingOS <nao-responda@suaempresa.com>
WHATSAPP_BRIDGE_URL=http://whatsapp:3001
NOTIFY_TIMEOUT_MS=10000
# De quanto em quanto tempo o servidor procura chamados parados (0 desliga).
INACTIVITY_INTERVAL_MINUTES=60

# ── Bot Ping IA (agente administrativo no Telegram) ────────────────────
# OPCIONAL: o Id do administrador já é configurado pelo dashboard
# (Configurações → Bot Ping IA → "Seu Id no Telegram"). Esta variável só é
# necessária como alternativa, e aceita vários Ids separados por vírgula.
ADMIN_ID=
```

> ⚠️ **Nunca coloque senha/segredo em variável `VITE_*`.** Tudo que começa com
> `VITE_` é **gravado no JavaScript público** do site — qualquer visitante lê no
> bundle. `VITE_API_URL` é a **URL HTTP base** da API (ex.: `http://api:4000`, ou
> `https://api.suaempresa.com`), e **não** a string de conexão do MySQL. Uma
> `mysql://usuario:senha@host:3306/banco` ali deixa a **senha do banco exposta na
> internet**: se você já subiu assim, troque a senha no MySQL
> (`ALTER USER 'usuario'@'%' IDENTIFIED BY 'nova-senha';`), atualize
> `MYSQL_PASSWORD` na aba Environment e redeploye com `VITE_API_URL=` vazio.

### 3.1 Preview x produção (qual banco cada um usa)

O banco é **um só**: o MySQL do seu servidor (criado pelo painel — seção 3.3).
O navegador nunca fala com o banco: ele chama a API Express (`/api`), e **só a
API** acessa o MySQL.

| Ambiente                              | Onde está o banco                        | Como fica                                                  |
| ------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| **Produção** (domínio do Dokploy)     | MySQL do Dokploy, pela rede interna      | ✅ recomendado                                             |
| **Preview da plataforma** (`.vly.sh`) | não alcança a rede do Docker             | funciona apontando `apiUrl` para a URL pública (seção 3.4) |
| **Máquina local** (`bun run dev`)     | `mysql-api.env` (`MYSQL_HOST=127.0.0.1`) | ✅                                                         |

> Quer ambientes **isolados** (produção x homologação)? Crie um segundo banco no
> Dokploy e um segundo serviço de compose com outro `MYSQL_DATABASE` — é só
> variável de ambiente, sem mexer em código.

> Não existe mais nenhum passo de "enviar funções para produção": o backend é o
> container `api`, e ele é atualizado junto com o Deploy.

### 3.2 Trocar endereço/URL sem rebuild (`config.js` de runtime)

`import.meta.env.VITE_*` é resolvido pelo Vite em **tempo de build**: o valor
fica gravado dentro do JavaScript do site. Sem nada mais, trocar a URL da API
exigiria reconstruir a imagem inteira (3–8 min).

O container resolve isso gerando o arquivo `/config.js` **na inicialização**:

```
config.js.template ──envsubst──▶ /usr/share/nginx/html/config.js
       (no repo)                          ▲
                                lido pelo index.html ANTES do bundle
```

A ordem de leitura no frontend é: `window.__PINGOS_CONFIG__` → `import.meta.env`
(a segunda só existe como rede de segurança).

| Ação                                              | Antes                                  | Agora                                    |
| ------------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| Trocar `VITE_API_URL` (ou apontar para outra API) | editar variável + **Deploy** (rebuild) | editar variável + **Restart** (segundos) |
| Trocar `VITE_WHATSAPP_WEB_URL`                    | idem                                   | idem                                     |
| Dev / preview da plataforma                       | `.env.local` do Vite                   | igual (o `public/config.js` é vazio)     |

**Como aplicar:** aba **Environment** → altere a variável → botão **Restart** do
serviço (ou **Redeploy**, se preferir) → recarregue o site no navegador. O nginx
serve o `config.js` com `no-store`, então não há cache para limpar.

> Os build args continuam no compose de propósito: se o `/config.js` não for
> gerado por algum motivo, o app segue funcionando com o valor do build.

> O backend (container `api`) **não** é afetado por isso: ele lê as variáveis
> `MYSQL_*` direto do ambiente dele, na hora em que sobe.

### 3.3 Usar o MySQL criado no painel do Dokploy

O jeito mais simples de rodar **tudo dentro do Dokploy**: criar o banco pelo
painel e apontar a API para ele. O banco fica **sem porta pública** — o
container `api` o alcança pela rede interna `dokploy-network`.

#### Passo 1 — Criar o banco

No projeto do Dokploy: **Create Service → Database → MySQL**. Preencha:

| Campo                 | Sugestão                                 |
| --------------------- | ---------------------------------------- |
| **Name**              | `pingos-db` (vira parte do host interno) |
| **Database Name**     | `pingos`                                 |
| **Database User**     | `pingos` (evite `root`)                  |
| **Database Password** | uma senha forte (gere e copie)           |

Clique em **Create** / **Deploy** e espere o status ficar verde.

> O Dokploy cria o banco **já com usuário e privilégios** (`GRANT ALL` no banco).
> Você **não** precisa rodar `CREATE DATABASE`/`CREATE USER` na mão.

#### Passo 2 — Copiar as credenciais internas

Abra o banco → aba **Connection → Internal Credentials**:

| O que copiar                             | Vai para         |
| ---------------------------------------- | ---------------- |
| **Internal Host** (ex.: `pingod-h2rdn7`) | `MYSQL_HOST`     |
| **Internal Port** (normalmente `3306`)   | `MYSQL_PORT`     |
| **User**                                 | `MYSQL_USER`     |
| **Password**                             | `MYSQL_PASSWORD` |
| **Database Name**                        | `MYSQL_DATABASE` |

> ⚠️ **Internal Host ≠ domínio.** É um nome interno do Docker
> (`<projeto>-<serviço>-<aleatório>`), que só resolve dentro da rede do Dokploy.
> O par **External Port / External URL** existe apenas para conectar de fora
> (DBeaver, Workbench) e abre o banco para a internet — só use se precisar.

#### Passo 3 — Colar na aba Environment do serviço `pingos`

```env
MYSQL_HOST=pingod-h2rdn7
MYSQL_PORT=3306
MYSQL_USER=pingos
MYSQL_PASSWORD=a-senha-que-voce-definiu
MYSQL_DATABASE=pingos
MYSQL_AUTO_MIGRATE=true
```

As outras (`API_PORT`, `SESSION_TTL_DAYS`, …) já têm padrão no compose. Se quiser
que o primeiro administrador já nasça pronto, inclua também
`ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_NAME`.

#### Passo 4 — Aplicar

Clique em **Deploy** (ou **Redeploy**): o Dokploy regenera o `.env` e **recria**
os containers com as variáveis novas. Na aba **Logs → api** você deve ver:

```
[boot] env: (nenhum — usando o ambiente do container)
[migrate] banco "pingos" garantido.
[migrate] schema aplicado (CREATE TABLE IF NOT EXISTS).
[migrate] papel "Administrador" criado (...)
[migrate] concluído — 0 usuário(s) no banco.
🚀 PingOS API (MySQL) em http://localhost:4000
✅ Conectado ao MySQL e sessões expiradas removidas.
```

Não é preciso rodar `docker exec ... mysql:seed` na mão — o schema e os papéis
saem prontos em cada boot (idempotente).

#### Passo 5 — Verificar

```bash
curl -s https://pingos.suaempresa.com/api/health
# {"status":"ok","database":true,"target":{"host":"pingod-h2rdn7",...}}
```

- `database: true` → conectado.
- `503` + `database: false` → credenciais/host errados (veja a seção 10).
- `502` no domínio → o container `api` não está no ar (veja os **Logs → api**).

#### Por que funciona: a rede `dokploy-network`

No Dokploy, os bancos criados pelo painel entram na rede **`dokploy-network`**,
enquanto um compose cria, por padrão, uma rede própria (`<projeto>_default`).
Redes diferentes = host interno não resolve (`getaddrinfo ENOTFOUND ...`).

Por isso o `docker-compose.yml` do PingOS declara:

```yaml
services:
  api:
    networks: [dokploy-network]
  # ...o mesmo em app e whatsapp

networks:
  dokploy-network:
    external: true
```

O App e a ponte também entram nessa rede para continuar se enxergando entre si
(o nginx aponta para `whatsapp:3001` e `api:4000`). Se um dia o Dokploy for
instalado com outro nome de rede, confira com `docker network ls` e ajuste o
compose.

### 3.4 Backend MySQL é o único backend

O frontend fala com a API Express + MySQL pelo **adaptador** `src/lib/backend/*`
(mesmas assinaturas de `useQuery`/`useMutation`), então os componentes não
mudaram de lógica — o Dokploy roda **todo o backend**. O Convex foi removido do
projeto (código, dependências e variáveis).

#### O que deixar na aba Environment

```env
# Deixe VAZIO: o site e a API ficam na mesma origem (/api pelo nginx).
VITE_API_URL=
```

Se você ainda tem `VITE_CONVEX_URL` / `VITE_CONVEX_SITE_URL` na aba Environment,
**apague as duas** — nenhum código as lê.

As variáveis do MySQL (`MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`,
`MYSQL_DATABASE`, …) continuam sendo as da seção 3.3, e os três containers
(`app`, `whatsapp`, `api`) são os mesmos.

> ⚠️ Depois de mudar `VITE_API_URL`, faça **Deploy** (não só Restart) se o valor
> também estiver nos **build args** — o `config.js` de runtime é regenerado no
> restart, mas o valor embutido no bundle só muda no build.

#### Onde ficam as rotas agora

| Módulo                            | Rota                                                                  | Situação |
| --------------------------------- | --------------------------------------------------------------------- | -------- |
| Login/sessão                      | `POST /api/auth/login` · `/logout` · `GET /me` · `/status` · `/setup` | ✅       |
| Chamados / Kanban                 | `GET/POST/PATCH/DELETE /api/tickets` · `/:id/status` · `/guest`       | ✅       |
| Usuários / papéis                 | `/api/users` · `/api/roles`                                           | ✅       |
| Técnicos                          | `/api/technicians`                                                    | ✅       |
| Permissões                        | `GET /api/auth/me` · `/api/permissions/any-admin`                     | ✅       |
| Métricas                          | `/api/metrics/dashboard` · `/monthly`                                 | ✅       |
| Imagens dos chamados              | campo `image_url` (data URL no próprio chamado)                       | ✅       |
| Notificações (config)             | `GET/PUT /api/notification-settings`                                  | ✅       |
| Regras de inatividade             | CRUD `/api/notification-rules`                                        | ✅       |
| Sino in-app                       | `/api/in-app-notifications`                                           | ✅       |
| Envio de e-mail/Telegram/WhatsApp | `server/api/notify.ts` (criação e mudança de status)                  | ✅       |
| Verificação de inatividade        | `POST /api/inactivity/run` + agendador no boot                        | ✅       |
| Backup e restauração              | `/api/backups` (gerar, baixar, restaurar, upload)                     | ✅       |

#### Backup do banco (Configurações → Backup)

O painel do Administrador gera um arquivo `.json` com todas as tabelas de dados
em `BACKUP_DIR` (no container, `/data/backups`), permitindo baixar, restaurar um
backup do servidor ou enviar um arquivo do computador:

- a restauração roda em transação e derruba todas as sessões (todo mundo faz
  login de novo);
- um **backup de segurança** é criado automaticamente antes de cada restauração
  (`BACKUP_SAFETY=false` desliga);
- o volume `backups` do compose guarda os arquivos — sem ele, os backups somem a
  cada deploy;
- tudo fica auditado em `backup_logs` (create/download/upload/restore/error).

Para baixar um backup direto do servidor (sem passar pelo app):

```bash
docker ps --format '{{.Names}}' | grep -i api
docker cp <container-da-api>:/data/backups/ .
```

#### Envio de notificações

Ligado na aba **Configurações → Notificações** do app. O e-mail usa a **Resend**
(`RESEND_API_KEY` + `RESEND_FROM` da aba Environment); o Telegram usa o token e o
chat_id salvos no app; o WhatsApp usa a API oficial (token no app) ou a ponte
Baileys interna (`WHATSAPP_BRIDGE_URL`, já apontando para o serviço `whatsapp`).
Cada tentativa fica registrada na tabela `notifications` (sent/failed + erro).

#### Preview da plataforma (opcional)

O preview de desenvolvimento (`.vly.sh`) não tem o MySQL. Se quiser usá-lo,
aponte para a API pública:

```js
// public/config.js  (vale só no dev/preview — em Docker o arquivo é regerado)
window.__PINGOS_CONFIG__ = { apiUrl: "https://SEU_DOMINIO" }
```

Como o app é servido em outra origem nesse caso, deixe `CORS_ORIGIN` vazio na
aba Environment (a API reflete a origem da requisição).

### Como cada variável chega no container

| Variável                                                                                | Onde é usada                                                              | Tipo        |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------- |
| `VITE_API_URL`                                                                          | `app`: `environment:` (runtime → `/config.js`) **e** build arg (fallback) | **runtime** |
| `VITE_WHATSAPP_WEB_URL`                                                                 | idem                                                                      | **runtime** |
| `MYSQL_*`, `API_PORT`, `CORS_ORIGIN`, `UPLOAD_MAX_BYTES`                                | container `api` (`environment:`)                                          | runtime     |
| `SESSION_TTL_DAYS`, `JSON_BODY_LIMIT`                                                   | container `api`                                                           | runtime     |
| `BACKUP_DIR`, `BACKUP_SAFETY`, `BACKUP_MAX_BYTES`                                       | container `api` (+ volume `backups`)                                      | runtime     |
| `SITE_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `WHATSAPP_BRIDGE_URL`, `NOTIFY_TIMEOUT_MS` | container `api`                                                           | runtime     |
| `INACTIVITY_INTERVAL_MINUTES`                                                           | container `api`                                                           | runtime     |
| `ADMIN_ID` (opcional — o Id é gravado pelo dashboard)                                   | container `bot` (agente Ping IA no Telegram)                              | runtime     |

**Sobre o `MYSQL_HOST`:**

| Onde está o seu MySQL                       | Valor de `MYSQL_HOST`                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------- |
| **Criado no painel do Dokploy**             | **Internal Host** da aba Connection (ex.: `pingod-h2rdn7`) — seção 3.3 |
| Na mesma VPS, fora do Docker                | `host.docker.internal` (já configurado no compose via `extra_hosts`)   |
| Em outra máquina / servidor gerenciado      | IP ou hostname dele (ex.: `10.0.0.25` ou `db.suaempresa.com`)          |
| Em Docker na mesma VPS, com porta publicada | `host.docker.internal` + `MYSQL_PORT` correto                          |

> Para o banco do Dokploy, `MYSQL_PORT` é a porta **interna do container**
> (`3306`), não a `External Port` mostrada para acesso pela internet.

> `CORS_ORIGIN` aceita vários domínios separados por vírgula. Deixando vazio, a
> API reflete a origem da requisição (cômodo, mas menos restritivo) — em
> produção liste o domínio do app.

---

## 4. Deploy

1. Clique em **Deploy** (aba General, canto superior direito).
2. Acompanhe na aba **Deployments** (histórico dos últimos 10 deploys) e na aba
   **Logs** (agrupados por serviço: `app`, `whatsapp`, `api`).
3. O que acontece na ordem:
   1. `git clone` do repositório
   2. build da imagem do `app` — instala dependências e compila o Vite
      (primeira vez: 3–8 minutos)
   3. build da imagem do `whatsapp`
   4. build da imagem do `api` (se presente)
   5. `docker compose up -d --build` → containers no ar
4. Aguarde **“Deployment successful”** (ou verifique na aba **Monitoring** se os
   containers estão rodando).

### Redeploy / atualizações

- **Automático:** com **Auto Deploy** ligado, cada `git push` na branch
  configurada dispara um deploy (webhook).
- **Manual:** botão **Deploy** / **Redeploy** (aba General).
- **Commit específico:** campo **Commit hash** nas configurações do serviço.
- A sessão do WhatsApp (volume `whatsapp-session`) e as imagens enviadas
  (volume `uploads`) **sobrevivem** a redeploys.
- Mudou alguma variável `VITE_*`? Basta **Restart** do serviço: elas viram
  `/config.js` em runtime (seção 3.2). **Redeploy** só é necessário quando muda
  código, dependências ou arquivos do repositório.

---

## 5. Aba Domains — acesso por domínio (recomendado)

1. Abra a aba **Domains** → **Add Domain**.
2. Preencha:

| Campo                    | Valor                   | Por quê                                                       |
| ------------------------ | ----------------------- | ------------------------------------------------------------- |
| **Host**                 | `pingos.suaempresa.com` | o registro A já deve apontar para o IP do VPS                 |
| **Path**                 | `/`                     | raiz do site                                                  |
| **Port**                 | `80`                    | **porta interna do container `app`** (o nginx), não a do host |
| **HTTPS**                | ✅ ligado               | certificado Let's Encrypt automático                          |
| **Certificate Provider** | Let's Encrypt           | padrão                                                        |

> ⚠️ **Erro mais comum:** colocar `8090` no campo **Port**. Esse campo é a porta
> **dentro do container** (o nginx escuta na `80`). A `8090` é só a porta
> publicada no host para acesso por IP.

3. Salve. O Dokploy injeta as labels do Traefik automaticamente e emite o
   certificado em ~1 minuto.
4. Acesse **https://pingos.suaempresa.com** → landing page do PingOS.
5. Entre como **Administrador** (o primeiro usuário criado vira Admin) e siga
   para **Configurações → WhatsApp Web** para escanear o QR Code.

> Com domínio + HTTPS, o navegador fala com a API e com a ponte pelo **mesmo
> domínio** (`/api` e `/whatsapp-api`) — nada de CORS e nada de conteúdo misto.

### Quer expor a API MySQL num subdomínio?

**Normalmente não precisa.** O domínio do site já serve a API na mesma origem:
`https://pingos.suaempresa.com/api/...` → nginx → `api:4000` (por isso
`VITE_API_URL` fica vazio). CORS e conteúdo misto deixam de existir.

Se ainda quiser um subdomínio próprio (ex.: para usar de outra origem), adicione
um domínio com **Service = `api`** e **Port = `4000`**, defina
`VITE_API_URL=https://api.suaempresa.com` e preencha `CORS_ORIGIN` com o domínio
do site (**Restart** depois — sem rebuild).

---

## 6. Acesso por IP (sem domínio)

Funciona, mas **sem HTTPS**. É útil para validar o deploy antes do DNS
propagar, porém o navegador marca a origem como "não segura" e alguns recursos
(área de transferência, service workers, notificações) ficam bloqueados. Para
uso real, use o domínio com HTTPS (seção 5).

| O que             | Endereço                              | Pré-requisito                                 |
| ----------------- | ------------------------------------- | --------------------------------------------- |
| App (SPA)         | `http://203.0.113.10:8090`            | porta `8090` publicada + liberada no firewall |
| API MySQL         | `http://203.0.113.10:4000/api/health` | porta `4000` publicada + liberada             |
| Painel do Dokploy | `http://203.0.113.10:3000`            | porta `3000` do próprio Dokploy               |

Para **desligar** o acesso por IP depois, troque no `docker-compose.yml`:

```yaml
# ports:
#   - "8090:80"     # acesso por IP desligado
expose:
  - "80" # acessível apenas pelo Traefik (domínio)
```

> Sem `ports` publicados e sem domínio configurado, o app fica inacessível de
> fora — é o comportamento desejado quando só o domínio importa.

---

## 7. MySQL — schema, primeiro admin e verificação

**Com o banco do Dokploy (seção 3.3)** não existe passo manual: o container
`api` aplica o schema e cria os papéis no boot (`MYSQL_AUTO_MIGRATE=true`). Esta
seção serve para conferir, para criar o administrador e para o caso de um MySQL
próprio.

### 7.1 Migração automática (padrão)

O entrypoint do container (`server/api/boot.ts`) roda as migrações antes de
subir o Express:

1. confere que o banco existe e aceita as credenciais;
2. aplica o `server/mysql/schema.sql` (`CREATE TABLE IF NOT EXISTS` — idempotente);
3. garante os papéis padrão (`Administrador`, `Usuário`) e os registros únicos;
4. se `ADMIN_USERNAME`/`ADMIN_PASSWORD` existirem, cria o administrador (não
   troca a senha de quem já existe).

Se o banco estiver inacessível, a API **sobe mesmo assim** e o `/api/health`
responde `503` com o motivo — mais fácil de diagnosticar do que um container em
loop de restart. Depois de corrigir a variável: **Deploy/Redeploy** (ou um
simples **Restart**).

Para desligar: `MYSQL_AUTO_MIGRATE=false` na aba Environment.

#### Reimplantou só um serviço?

Cada serviço tem a sua imagem, e um serviço novo com banco antigo reclama de
coluna/tabela que ainda não existe (`Unknown column 'modelo_visao' in 'field
list'`, `Unknown column 'provider' in 'field list'`, `Table
'pingos.acoes_pendentes' doesn't exist`). Duas defesas evitam ficar preso nisso:

- o serviço `bot` garante o schema no boot dele (melhor esforço, o mesmo
  interruptor `MYSQL_AUTO_MIGRATE`);
- ao salvar Configurações → Bot Ping IA, a API cria a coluna que faltar na hora
  (`modelo_visao`, `provider`, `base_url`); se o banco não deixar, ela salva o
  resto e avisa na tela.

Ainda assim o caminho certo é **redeployar o serviço `api`** (é ele que roda a
migração completa).

### 7.2 Rodar o seed manualmente (opcional)

Útil em um MySQL próprio, ou para reaplicar o schema sob demanda:

```bash
docker ps --format '{{.Names}}' | grep -i api     # descobrir o nome do container
docker exec -it <container-da-api> bun run mysql:seed
```

Se o banco **não** for o do Dokploy (usuário com privilégios), crie banco e
usuário antes:

```sql
CREATE DATABASE IF NOT EXISTS pingos
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER 'pingos'@'%' IDENTIFIED BY 'troque-por-uma-senha-forte';
GRANT ALL PRIVILEGES ON pingos.* TO 'pingos'@'%';
FLUSH PRIVILEGES;
```

> Se o MySQL roda na mesma VPS com a porta publicada em `127.0.0.1:3306`, o
> container `api` alcança via `host.docker.internal:3306`. Para isso o MySQL
> precisa aceitar conexões de fora do loopback (`bind-address = 0.0.0.0`) e o
> usuário acima ser `'pingos'@'%'`.

### 7.3 Criar o primeiro administrador

Três caminhos:

| Caminho                                | Como                                                                                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Variáveis**                       | `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ADMIN_NAME` na aba Environment → Deploy                                                                                                |
| **B. Endpoint** (só com o banco vazio) | `curl -X POST https://SEU_DOMINIO/api/auth/setup -H 'Content-Type: application/json' -d '{"username":"admin","password":"uma-senha-com-8-ou-mais","name":"Administrador"}'` |
| **C. Tela do app**                     | entre na tela de login e use o admin criado (banco vazio já oferece `admin` / `admin123`)                                                                                   |

### 7.4 Verificar

```bash
# pela mesma origem do site (recomendado)
curl -s https://pingos.suaempresa.com/api/health
# por IP, se a porta 4000 estiver publicada e liberada
curl -s http://203.0.113.10:4000/api/health
# {"status":"ok","database":true,"target":{"host":"pingod-h2rdn7","database":"pingos",...}}
```

| Resposta                  | Significado                                                                              |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `database: true`          | conectado e migrado                                                                      |
| `503` + `database: false` | API no ar, mas sem falar com o MySQL → veja `MYSQL_HOST`, `MYSQL_USER`, `MYSQL_PASSWORD` |
| `502`                     | o container `api` não está no ar → **Logs → api**                                        |

> **Importante:** o app já roda 100% sobre esta API (o Convex saiu do
> frontend). As telas leem e escrevem direto no MySQL; o que ainda falta é só o
> envio automático de notificações, a verificação de inatividade e a geração de
> backup (ver a seção 3.4).

---

## 8. WhatsApp — conectar o número

1. App → login como **Administrador** → **Configurações → WhatsApp Web**.
2. **Gerar QR Code** → escaneie no celular (WhatsApp → Aparelhos conectados).
3. Status → **Conectado**. As notificações de chamado saem por esse número.
4. A sessão fica no volume `whatsapp-session`: sobrevive a deploys e restarts.
   Só precisa escanear de novo se o celular desconectar o aparelho.

Se aparecer **“Servidor offline”**, veja os logs do container da ponte:

```bash
docker ps --format '{{.Names}}' | grep -i whatsapp
docker logs --tail 100 <container-do-whatsapp>
```

---

## 9. Rotas internas do Dokploy (referência)

| Aba / atalho               | Para que serve aqui                                         |
| -------------------------- | ----------------------------------------------------------- |
| **General** (`g g`)        | repo, branch, compose path, auto deploy, botão Deploy       |
| **Environment** (`g e`)    | todas as variáveis acima (viram `.env`)                     |
| **Domains** (`g u`)        | `pingos.suaempresa.com` → porta **80**                      |
| **Deployments** (`g d`)    | histórico e status de cada deploy                           |
| **Logs** (`g l`)           | logs por serviço (`app`, `whatsapp`, `api`)                 |
| **Monitoring** (`g m`)     | CPU/RAM dos containers                                      |
| **Volume Backups** (`g v`) | backup dos volumes nomeados (`whatsapp-session`, `uploads`) |
| **Advanced** (`g a`)       | comando customizado, mounts, volumes                        |

---

## 10. Problemas comuns

| Sintoma                                                         | Causa provável / solução                                                                                                                                                         |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deploy falha com `port is already allocated`                    | Alguma porta publicada já está em uso (provavelmente `3000` do painel) → use `8090:80` e `4000:4000`                                                                             |
| Tela em branco / login não sai do lugar                         | `VITE_API_URL` apontando para uma URL inalcançável → deixe vazio e abra `https://SEU_DOMINIO/api/health`                                                                         |
| Domínio responde 404 ou “Bad Gateway”                           | Campo **Port** do domínio errado → deve ser `80` (porta do nginx no container), não `8090`                                                                                       |
| Certificado não emite                                           | Registro A ainda propagando ou portas 80/443 fechadas → confira o DNS e o firewall                                                                                               |
| Loop de login / "Usuário ou senha inválidos"                    | Confirme o usuário no banco (`SELECT username, active FROM users`) — contas são criadas pelo admin                                                                               |
| Imagem do chamado não aparece                                   | A coluna `tickets.image_url` precisa ser `MEDIUMTEXT` → rode `docker exec -it <api> bun run mysql:seed` (o boot já ajusta)                                                       |
| Build falha no passo do Vite                                    | Dependência faltando no `package.json`/`bun.lock` → rode `bun install` local e commite o lockfile                                                                                |
| Container `api` reiniciando / 503 no health                     | MySQL inacessível: `MYSQL_HOST` errado, usuário sem host `'%'` ou senha divergente                                                                                               |
| `getaddrinfo ENOTFOUND <host>` nos logs da `api`                | O container não está na rede do banco → confirme `networks: [dokploy-network]` no serviço `api` e `dokploy-network: external: true` no fim do compose (seção 3.3)                |
| `Access denied for user ...`                                    | Credenciais internas copiadas erradas (troque `MYSQL_USER`/`MYSQL_PASSWORD` pelos da aba **Connection**)                                                                         |
| `Unknown database 'pingos'`                                     | `MYSQL_DATABASE` diferente do **Database Name** do banco no Dokploy                                                                                                              |
| `/api/...` responde 502 pelo domínio                            | Container `api` fora do ar → **Logs → api**; o nginx segue servindo o site normalmente                                                                                           |
| Alterei `MYSQL_*` e nada mudou                                  | Variável de container só vale após **Deploy/Redeploy** (o `Restart` reaproveita os containers, sem reler o `.env`)                                                               |
| `docker exec ... bun run mysql:seed` falha                      | Não é mais necessário (migração automática no boot). Se usar, confira o nome do container com `docker ps`                                                                        |
| WhatsApp “Servidor offline”                                     | Veja `docker logs <container-do-whatsapp>` — a ponte pode estar reiniciando por sessão corrompida (delete o volume `whatsapp-session` na aba Volume Backups/volumes e reconecte) |
| Alterei uma `VITE_*` e nada mudou                               | Faça **Restart** do serviço (o `/config.js` é gerado no start) e recarregue o site                                                                                               |
| Alterações feitas no Dokploy aparecem no preview (e vice-versa) | Os dois estão apontando para a **mesma API/banco** → para separar, use outro `MYSQL_DATABASE` (seção 3.1)                                                                        |
| Senha do MySQL visível no site                                  | Ela foi colada numa variável `VITE_*` (vai para o bundle público) → remova, troque a senha no banco e redeploye                                                                  |

---

## 11. Checklist final

- [ ] DNS: registro A do domínio apontando para o IP da VPS
- [ ] Serviço **Docker Compose** criado, `Compose Path = docker-compose.yml`
- [ ] Banco MySQL criado no Dokploy e variáveis `MYSQL_*` preenchidas na aba **Environment**
- [ ] `VITE_API_URL` vazio (mesma origem) ou com **URL HTTP** da API — **sem** senha de banco
- [ ] `config.js.template` e `docker-entrypoint.sh` commitados (config de runtime)
- [ ] **Deploy** concluído sem erro
- [ ] Troca de URL/banco validada com **Restart** do serviço (sem rebuild)
- [ ] Aba **Domains**: host + porta `80` + HTTPS ligado
- [ ] HTTPS abre a landing page do PingOS
- [ ] Primeiro usuário criado → promovido a Administrador
- [ ] **Configurações → WhatsApp Web** conectado (QR escaneado)
- [ ] (MySQL) banco do Dokploy criado e credenciais **internas** na aba Environment (`MYSQL_HOST` = Internal Host)
- [ ] (MySQL) `docker-compose.yml` com os serviços na rede `dokploy-network` (external)
- [ ] (MySQL) `/api/health` retornando `"database": true` e logs da `api` com `[migrate] schema aplicado`
- [ ] (MySQL) primeiro administrador criado (`ADMIN_*` na aba Environment ou `POST /api/auth/setup`)
- [ ] `BACKUP_DIR`/volume `backups` ativos e o botão **Gerar Backup Agora** produzindo um arquivo
- [ ] `SITE_URL` preenchido e, se for usar e-mail, `RESEND_API_KEY`/`RESEND_FROM` na aba Environment
- [ ] Sino de notificações recebendo alertas (abrir um chamado de teste)

Documentação complementar no repositório: `MYSQL.md` (backend MySQL) e
`README.md` (visão geral do app).
