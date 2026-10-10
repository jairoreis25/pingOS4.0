# PingOS — como rodar o projeto (versão atualizada)

Três formas de subir o mesmo código. Escolha pela coluna **quando usar**:

| Forma | Arquivo/Comando | Quando usar |
|---|---|---|
| **1. Local sem Docker** | `bun run dev` + `bun run mysql:api` | desenvolvimento do dia a dia (mais rápido) |
| **2. Local com Docker** | `docker-compose.local.yml` | testar a stack igual à produção, sem Dokploy |
| **3. Produção (Dokploy)** | `docker-compose.yml` | servidor — passo a passo em `DOKPLOY.md` |

Portas do projeto:

| Serviço | Local sem Docker | Local com Docker | Dokploy |
|---|---|---|---|
| App (frontend) | **5173** (Vite) | **8090** (nginx) | `8090` no host → domínio na porta **80** do container |
| API Express | **4000** | **4000** | 4000 |
| MySQL | **3306** | **3307** no host / 3306 no container | banco do painel |
| Ponte WhatsApp | **3001** | interna | interna |

---

## 0. O que mudou nesta versão (o que exige ação sua)

- O **backend MySQL é o único backend** — o Convex saiu do projeto.
- **Notificações reais**: sino in-app, e-mail (Resend), Telegram e WhatsApp ao
  abrir/mudar o status de um chamado.
- **Verificação de inatividade** automática (agendada) e pelo botão "verificar
  agora" em Configurações → Regras de inatividade.
- **Backup e restauração reais** em Configurações → Backup (arquivo `.json` em
  `BACKUP_DIR`, com backup de segurança automático antes de restaurar).
- Dependência nova: **`multer`** (upload do arquivo de backup) → precisa rodar
  `bun install` de novo e **rebuildar** a imagem no Docker (Restart não basta).
- `nginx.conf`: `/api/` aceita uploads grandes (`client_max_body_size 512m`) —
  sem isso a restauração por upload falharia com **413**.

---

## 1. Rodar local **sem Docker** (Bun + MySQL instalado)

### 1.1 Requisitos

- [Bun](https://bun.sh) 1.1 ou superior (`bun --version`)
- MySQL 8 (ou MariaDB 10.6+) rodando na máquina

### 1.2 Instalar as dependências

Na raiz do projeto (onde está o `package.json`):

```bash
bun install
```

### 1.3 Criar o banco e o usuário

```sql
-- mysql -u root -p
CREATE DATABASE IF NOT EXISTS pingos
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'pingos'@'%' IDENTIFIED BY 'troque-esta-senha';
GRANT ALL PRIVILEGES ON pingos.* TO 'pingos'@'%';
FLUSH PRIVILEGES;
```

> O app também tenta criar o banco sozinho, mas em MySQL gerenciado o usuário do
> app normalmente não tem esse privilégio — crie pelo root, como acima.

### 1.4 Criar o arquivo de ambiente do backend

```bash
cp mysql-api.env.example mysql-api.env
```

O mínimo a preencher em `mysql-api.env`:

```env
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=pingos
MYSQL_PASSWORD=troque-esta-senha
MYSQL_DATABASE=pingos
API_PORT=4000
UPLOAD_DIR=./uploads
BACKUP_DIR=./backups
SITE_URL=http://localhost:5173
# opcional (cria o 1º administrador automaticamente)
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
```

Esse arquivo **não é versionado** — ele é lido automaticamente pelo servidor
(`server/api/env.ts`), e o ambiente do processo sempre tem prioridade sobre ele.

### 1.5 Criar as tabelas, papéis e o primeiro administrador

```bash
bun run mysql:seed
```

Cria as 14 tabelas (`server/mysql/schema.sql`), os papéis padrão e o admin do
`ADMIN_USERNAME` / `ADMIN_PASSWORD`. É idempotente: pode rodar de novo.

### 1.6 Subir a API e o site

Em **dois terminais** (o `mysql:api` fica em primeiro plano):

```bash
# terminal 1 — API Express + MySQL em http://localhost:4000
bun run mysql:api

# terminal 2 — frontend Vite em http://localhost:5173
bun run dev
```

Abra **http://localhost:5173** e entre com `admin` / `admin123` (troque a senha
depois). Em desenvolvimento o frontend aponta sozinho para
`http://localhost:4000` — **não é preciso criar `.env.local`** para começar. Se
preferir fixar (ou usar outra porta), crie `.env.local`:

```env
VITE_API_URL=http://localhost:4000
# VITE_WHATSAPP_WEB_URL=http://localhost:3001
```

### 1.7 Opcional: ponte do WhatsApp (Baileys)

```bash
# terminal 3 — ponte na porta 3001 (o Vite já faz proxy de /whatsapp-api)
bun run whatsapp
```

Depois conecte o número em **Configurações → WhatsApp Web** (QR Code). No
`mysql-api.env`, deixe `WHATSAPP_BRIDGE_URL=http://localhost:3001` para as
notificações saírem por ela.

O mesmo painel tem **Pausar envios / Retomar envios**: pausar mantém o WhatsApp
conectado e apenas para de enviar mensagens (mantém e-mail e avisos no app). O
estado fica salvo na pasta da sessão, então sobrevive a reinícios do container.

### 1.8 Conferir se subiu

```bash
curl http://localhost:4000/api/health
# {"status":"ok","database":true,"target":{...},"envFile":".../mysql-api.env"}
```

No terminal da API você deve ver:

```
[migrate] schema aplicado (CREATE TABLE IF NOT EXISTS).
🚀 PingOS API (MySQL) em http://localhost:4000
✅ Conectado ao MySQL e sessões expiradas removidas.
[inatividade] verificando chamados parados a cada 60 minuto(s).
```

---

## 2. Rodar local **com Docker** (stack completa, MySQL incluído)

Use o compose local — o `docker-compose.yml` é o do Dokploy e depende da rede
externa `dokploy-network` e de um banco criado no painel.

```bash
docker compose -f docker-compose.local.yml up -d --build
```

O que sobe:

| Container | Endereço | Observação |
|---|---|---|
| `app` | http://localhost:8090 | nginx servindo o SPA + proxy de `/api`, `/uploads` e `/whatsapp-api` |
| `api` | http://localhost:4000/api/health | aplica o schema e cria o admin no boot |
| `mysql` | localhost:**3307** (3306 dentro da rede) | dados no volume `mysql-data` |
| `whatsapp` | interno (3001 na rede) | sessão no volume `whatsapp-session` |

- **Login inicial:** `admin` / `admin123` (mude em `ADMIN_USERNAME` /
  `ADMIN_PASSWORD` antes do primeiro start, se quiser).
- **Acesso pelo navegador é sempre pelo 8090**: `VITE_API_URL` fica vazio e o
  nginx repassa `/api` para o container `api` — mesma origem, sem CORS.

### Personalizar (senhas, porta do MySQL, Resend)

O Compose lê um arquivo `.env` na raiz do projeto. Cuidado: esse é o arquivo do
**Docker Compose** — não confunda com o `.env.local`, que é do Vite (frontend).

```env
# .env  (opcional — sem ele, valem os padrões mostrados abaixo)
MYSQL_ROOT_PASSWORD=pingos-root
MYSQL_USER=pingos
MYSQL_PASSWORD=uma-senha-forte
MYSQL_DATABASE=pingos
ADMIN_USERNAME=admin
ADMIN_PASSWORD=uma-senha-forte
SITE_URL=http://localhost:8090
RESEND_API_KEY=           # só se for enviar e-mail pela Resend
RESEND_FROM=PingOS <onboarding@resend.dev>
INACTIVITY_INTERVAL_MINUTES=60
```

### Comandos do dia a dia

```bash
# acompanhar os logs (migração, envios, inatividade, backups)
docker compose -f docker-compose.local.yml logs -f api

# aplicar mudanças de código
docker compose -f docker-compose.local.yml up -d --build

# parar (mantém banco, imagens dos chamados e backups)
docker compose -f docker-compose.local.yml down

# apagar TUDO: banco, uploads e backups
docker compose -f docker-compose.local.yml down -v

# backup gerado pelo painel, direto do container para a sua máquina
docker compose -f docker-compose.local.yml cp api:/data/backups ./backups-do-servidor
```

> ⚠️ O primeiro `up --build` demora alguns minutos (build do frontend). O
> container `api` só sobe depois que o MySQL responde (`healthcheck`), então a
> migração automática não falha na primeira subida.

---

## 3. Atualizar o **Dokploy** (produção)

O Dokploy builda a partir do Git, então o fluxo é: subir o código → ajustar as
variáveis → **Deploy**.

1. **Commit e push** das mudanças (o compose, `nginx.conf`, `package.json` e
   `bun.lock` mudaram).
2. **Aba Environment** do serviço `pingos` — acrescente (e mantenha
   `VITE_API_URL` **vazio**):

   ```env
   BACKUP_DIR=/data/backups
   BACKUP_SAFETY=true
   BACKUP_MAX_BYTES=268435456
   SITE_URL=https://pingos.suaempresa.com
   RESEND_API_KEY=
   RESEND_FROM=PingOS <nao-responda@suaempresa.com>
   WHATSAPP_BRIDGE_URL=http://whatsapp:3001
   NOTIFY_TIMEOUT_MS=10000
   INACTIVITY_INTERVAL_MINUTES=60
   ```

3. Clique em **Deploy** (não `Restart`): a dependência `multer` entrou no
   `package.json`, então a imagem precisa ser reconstruída.
4. Confira em **Logs → api**: `[migrate] schema aplicado` → `🚀 PingOS API
   (MySQL)` → `[inatividade] verificando chamados parados…`.
5. Abra `https://SEU_DOMINIO/api/health` → `"database": true`.
6. O compose já cria o volume **`backups`**. Sem volume, os arquivos de backup
   somem a cada deploy.

Detalhes de aba por aba (General, Domains, IP x domínio, erros comuns):
**`DOKPLOY.md`**.

---

## 4. Roteiro de teste (5 minutos, depois de subir)

| # | O que fazer | O que deve acontecer |
|---|---|---|
| 1 | Entrar com o admin | Kanban abre com as 5 colunas |
| 2 | **Chamado público** → abrir um chamado | aparece em "Aberto"; quem tem `tickets.view` recebe aviso no sino |
| 3 | Mover para **Resolvido** | alerta sonoro no painel + sino para solicitante/responsável |
| 4 | **Configurações → Notificações** | ligue um canal e salve; sem `RESEND_API_KEY` o e-mail aparece como *failed* em `notifications` |
| 5 | **Configurações → Regras de inatividade** → criar regra (status "Aberto", 1 dia) → **Verificar agora** | aviso "N alerta(s) enviado(s)…" (sem chamados parados há 1 dia, 0 é o esperado) |
| 6 | **Configurações → Backup** → **Gerar Backup Agora** | arquivo aparece na lista; **Baixar** salva o `.json` |
| 7 | Restaurar um backup | modal de confirmação → "Restauração concluída! N registros" → **login de novo** (as sessões são apagadas) |
| 8 | **Configurações → Backup** → enviar um `.json` do computador | arquivo é validado, entra na lista e a restauração roda em seguida |

Consultar o histórico de envios no banco:

```sql
SELECT type, status, LEFT(error, 80) AS erro, FROM_UNIXTIME(sent_at/1000)
  FROM notifications ORDER BY sent_at DESC LIMIT 20;
```

---

## 5. Variáveis de ambiente (referência)

### Backend (`mysql-api.env` local / aba Environment no Dokploy)

| Variável | Padrão | Para que serve |
|---|---|---|
| `MYSQL_HOST` / `MYSQL_PORT` | `127.0.0.1` / `3306` | conexão com o banco |
| `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` | `pingos` / — / `pingos` | credenciais |
| `MYSQL_AUTO_MIGRATE` | `true` | aplica o schema e garante papéis/admin no boot |
| `API_PORT` | `4000` | porta da API |
| `CORS_ORIGIN` | vazio | vazio = reflete a origem (dev); em produção liste o domínio |
| `SESSION_TTL_DAYS` | `30` | validade da sessão |
| `JSON_BODY_LIMIT` | `2mb` | limite do corpo JSON (imagens vão por upload binário) |
| `UPLOAD_DIR` / `UPLOAD_MAX_BYTES` | `./uploads` / 15 MB | imagens dos chamados |
| `BACKUP_DIR` | `./backups` | pasta dos arquivos `.json` de backup |
| `BACKUP_SAFETY` | `true` | backup de segurança antes de restaurar |
| `BACKUP_MAX_BYTES` | 256 MB | tamanho máximo do arquivo enviado para restaurar |
| `SITE_URL` | — | link usado nas notificações |
| `RESEND_API_KEY` / `RESEND_FROM` | — | e-mail transacional |
| `WHATSAPP_BRIDGE_URL` | `http://whatsapp:3001` | ponte Baileys (Docker) |
| `NOTIFY_TIMEOUT_MS` | `10000` | tempo máximo de cada chamada externa |
| `INACTIVITY_INTERVAL_MINUTES` | `60` | de quanto em quanto tempo varre chamados parados (`0` desliga) |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | primeiro administrador criado no boot |

### Frontend (`.env.local` no dev, `/config.js` no Docker)

| Variável | Padrão | Para que serve |
|---|---|---|
| `VITE_API_URL` | dev: `http://localhost:4000` | URL base da API. **Vazio no Docker/Dokploy** = mesma origem via nginx |
| `VITE_WHATSAPP_WEB_URL` | vazio | ponte WhatsApp externa (vazio = proxy `/whatsapp-api`) |

> Nunca coloque senha em variável `VITE_*`: tudo que começa com `VITE_` vai para
> o JavaScript público do site.

---

## 6. Problemas comuns

| Sintoma | Causa provável / solução |
|---|---|
| "Não foi possível falar com a API (mesma origem)" | a API não está no ar. Rode `bun run mysql:api` ou veja `logs api` no Docker |
| `/api/health` responde 503 com `"database":false` | credenciais/`MYSQL_HOST` errados. Em Docker do Dokploy, `MYSQL_HOST` é o **Internal Host** da aba Connection |
| `[boot] migração automática falhou` | o banco ainda não aceitava conexão no start — reinicie o serviço; se persistir, confira usuário/senha/base |
| `docker compose up` do compose do Dokploy: *network dokploy-network declared as external, but could not be found* | fora do Dokploy use o **`docker-compose.local.yml`** |
| Restauração/upload de backup retorna **413** | proxy na frente da API com limite pequeno — o `nginx.conf` já está em `512m`; ajuste se usar outro proxy |
| "Arquivo de backup inválido" | o arquivo enviado não é um `.json` gerado pelo PingOS |
| E-mail não chega | `RESEND_API_KEY`/`RESEND_FROM` ausentes. O motivo fica na tabela `notifications` |
| WhatsApp não envia | ponte não pareada (**Configurações → WhatsApp Web** → QR) ou `WHATSAPP_BRIDGE_URL` errado |
| Sino sem notificação nova | o autor da ação não recebe aviso do próprio chamado; confirme que outro usuário tem `tickets.view` |
| Preview da plataforma (`.vly.sh`) sem dados | o preview não tem MySQL. Aponte `apiUrl` em `public/config.js` para a API pública |

Documentação complementar: **`MYSQL.md`** (backend MySQL por dentro),
**`DOKPLOY.md`** (deploy) e **`README.md`** (visão geral e convenções).
