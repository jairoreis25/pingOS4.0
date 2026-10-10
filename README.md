## Overview

PingOS — sistema de help desk com Kanban (Aberto, Em Andamento, Aguardando,
Resolvido, Fechado), autenticação RBAC e backend próprio em MySQL.

Tech stack:

- Vite
- Typescript
- React Router v7 (all imports from `react-router` instead of `react-router-dom`)
- React 19 (for frontend components)
- Tailwind v4 (for styling)
- Shadcn UI (for UI components library)
- Lucide Icons (for icons)
- **Express + MySQL (`mysql2`)** — backend em `server/` (API REST em `/api`)
- Framer Motion (for animations)

All relevant files live in the 'src' directory. O backend vive em `server/`:

```
server/
  api/            API Express (rotas, permissões, sessões)
    routes/       tickets, users, roles, technicians, metrics, notifications, backups…
    index.ts      sobe o servidor (bun run mysql:api)
    boot.ts       aplica as migrações e sobe o servidor (usado no Docker)
  mysql/          schema.sql, pool de conexões, migrações e seed
```

Use bun for the package manager.

## Backend: rotas, autenticação e banco

O frontend fala com a API pelo adaptador `src/lib/backend/*`, que expõe
`useQuery` / `useMutation` / `useAction` com a mesma assinatura de antes
(`api.tickets.list`, `api.users.createManaged`, …) — os componentes não sabem
qual é o transporte.

- **Banco:** MySQL 8 (ou MariaDB 10.6+). Schema em `server/mysql/schema.sql`.
- **Sessão:** token opaco em `localStorage` (`pingos.mysql.token`), validado a
  cada requisição (`Authorization: Bearer <token>`), com tabela `sessions`.
- **Senhas:** `scrypt` (node:crypto), salt por usuário.
- **Permissões:** `src/lib/permissions.ts` é a única fonte de verdade, usada pelo
  frontend e pelo backend.

### Configuração

```bash
cp mysql-api.env.example mysql-api.env     # credenciais do banco (não versionado)
bun run mysql:seed                         # cria banco, tabelas, papéis e o 1º admin
bun run mysql:api                          # sobe a API em http://localhost:4000
```

- `MYSQL_AUTO_MIGRATE=true` faz o boot aplicar schema/papéis automaticamente
  (é o que o container faz no deploy).
- Um banco vazio **não cria mais** admin com senha padrão. Defina
  `ADMIN_USERNAME` e `ADMIN_PASSWORD` (mínimo 8 caracteres) antes do
  `mysql:seed`, ou crie o primeiro administrador com `POST /api/auth/setup`
  enviando `bootstrapToken` (o valor de `BOOTSTRAP_TOKEN`; sem essa variável o
  servidor gera um token aleatório e mostra no log do boot).
- Passo a passo para rodar (local com Bun, Docker local e Dokploy): **`RODAR.md`**.
- Detalhes e troubleshooting: **`MYSQL.md`**. Deploy no Dokploy: **`DOKPLOY.md`**.

### Variáveis de ambiente

| Onde                                              | Variáveis                                                                                                                                                                                                         |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend (`mysql-api.env` ou painel do serviço)    | `MYSQL_*`, `API_PORT`, `CORS_ORIGIN`, `SESSION_TTL_DAYS`, `UPLOAD_DIR`, `BACKUP_DIR`, `SITE_URL`, `RESEND_API_KEY`, `RESEND_FROM`, `WHATSAPP_BRIDGE_URL`, `INACTIVITY_INTERVAL_MINUTES`, `ADMIN_ID` (bot Ping IA) |
| Frontend (`.env.local` / `config.js` / build arg) | `VITE_API_URL` (vazio = mesma origem via nginx), `VITE_WHATSAPP_WEB_URL`                                                                                                                                          |

> Nunca coloque segredo em variável `VITE_*`: tudo que começa com `VITE_` é
> gravado no JavaScript público do site.

### Tipo do backend

```bash
bun run mysql:typecheck      # tsc -p server/tsconfig.json --noEmit
```

### Notificações, inatividade e backup

Já no backend MySQL:

- **Envio** de e-mail (Resend), Telegram e WhatsApp + sino in-app ao abrir ou
  mudar o status de um chamado (`server/api/notify.ts`);
- **Verificação de inatividade** das regras, a cada
  `INACTIVITY_INTERVAL_MINUTES` ou pelo botão "verificar agora"
  (`server/api/inactivity.ts`);
- **Backup e restauração** pelo painel do Administrador — arquivo `.json` em
  `BACKUP_DIR`, restauração em transação e backup de segurança automático
  (`server/api/backup.ts`).

Detalhes em `MYSQL.md` → "Notificações, inatividade e backup".

### Bot "Ping IA" (Telegram)

Agente administrativo no Telegram que usa a API do **provedor de IA escolhido no
dashboard** — NVIDIA (padrão), OpenAI, Google Gemini, Anthropic, Groq,
OpenRouter, DeepSeek, Mistral ou um endpoint próprio compatível com a OpenAI —
para raciocinar e executar ações no PingOS com **acesso total**: listar,
buscar e relatar chamados/clientes/usuários com filtros poderosos, criar,
editar, fechar e reabrir chamados — tudo na hora. A **única** ação que pede
confirmação (resumo + Sim/Não) é a exclusão. Toda mutação vai para a auditoria
(`audit_log`). A configuração é toda feita pelo dashboard e guardada na tabela
`bot_config`.

- **Código do bot:** `hermes/bot-ia.ts` (grammy + openai + o mesmo pool MySQL).
- **Provedores:** `server/api/ai-providers.ts` — URL base, rótulo da chave,
  modelos sugeridos e o chat genérico. É de lá que o dashboard monta a tela.
- **Rotas de configuração:** `server/api/routes/bot-config.ts` sob `/api/admin`
  (somente administrador; as chaves são mascaradas na leitura).
- **Painel:** Configurações → **Bot Ping IA** (visível apenas para admin).

#### 1. Criar o bot no Telegram

1. Abra o Telegram e fale com o **@BotFather**.
2. Envie `/newbot`.
3. Escolha um nome — ex.: **Ping IA**.
4. Escolha um username que termine com `bot` — ex.: **PingIA_bot**.
5. Copie o token retornado (formato `123456789:ABCdef...`).
6. Descubra o seu **Id numérico** no Telegram (ex.: `987654321`) — o jeito mais
   fácil é mandar qualquer mensagem para o seu próprio bot: enquanto não houver
   Id configurado, ele responde com o seu. Também funciona o **@userinfobot**
   (envie `oi`). Esse número vai no campo **Seu Id no Telegram** do dashboard.

#### 2. Escolher o provedor e obter a API Key

O padrão é a **NVIDIA** (`build.nvidia.com`, grátis e sem cartão):

1. Acesse **build.nvidia.com** e crie uma conta.
2. Escolha um modelo (ex.: `nvidia/nemotron-3-super-120b-a12b`).
3. Clique em **Get API Key** e copie a chave (começa com `nvapi-`).

Qualquer outro provedor do dropdown também serve: o agente fala o dialeto
**compatível com a OpenAI**, então entre provedores só mudam a URL base e o
formato da chave. O campo **Modelo de visão** (leitura das fotos de O.S.) só
aparece quando o provedor escolhido lê imagem:

| Provedor                      | Chave                                 | Lê foto de O.S.              |
| ----------------------------- | ------------------------------------- | ---------------------------- |
| **NVIDIA** (padrão, grátis)   | `nvapi-...` em build.nvidia.com       | sim (`nemotron-3-nano-omni`) |
| OpenAI                        | `sk-...` em platform.openai.com       | sim (`gpt-4o-mini`)          |
| Google Gemini                 | `AIza...` em aistudio.google.com      | sim (`gemini-2.5-flash`)     |
| Anthropic Claude              | `sk-ant-...` em console.anthropic.com | sim (`claude-sonnet-4-5`)    |
| Groq (grátis)                 | `gsk_...` em console.groq.com         | sim (`llama-4-scout`)        |
| OpenRouter                    | `sk-or-...` em openrouter.ai/keys     | sim (escolha um multimodal)  |
| DeepSeek                      | `sk-...` em platform.deepseek.com     | **não**                      |
| Mistral                       | em console.mistral.ai                 | sim (`pixtral-large-latest`) |
| Outro (compatível com OpenAI) | a do seu servidor                     | depende do modelo            |

Para acrescentar um provedor novo basta uma entrada em
`server/api/ai-providers.ts` — o dashboard e o bot leem o catálogo de lá, sem ID
de modelo fixo no frontend.

#### 3. Configurar pelo dashboard

1. Entre como administrador e abra **Configurações → Bot Ping IA**.
2. Escolha o **Provedor de IA** (começa na NVIDIA) e cole a **API Key** dele.
   Trocar de provedor exige colar a chave do novo: a chave é uma só no banco.
   Em provedor próprio (servidor/Azure/LM Studio) aparece também a **URL base**.
3. Cole o **Telegram Bot Token**.
4. Preencha **Seu Id no Telegram** (o número do passo 1). Sem ele o agente sobe,
   mas só sabe responder qual é o Id de quem escreve — nada é executado.
5. Escolha o **Modelo** (o dropdown lista os recomendados e consulta os
   disponíveis no provedor **na hora**; há a opção **Outro (digitar o ID)**) e
   clique em **Testar** para validar.
6. Escolha o **Modelo de visão (fotos de O.S.)** — usado só para ler as fotos
   de ordem de serviço impressa — e clique no **Testar** ao lado dele: o botão
   desenha dígitos numa imagem, manda para o modelo e confere se ele leu certo.
   Se o modelo não aceitar foto, o teste avisa na hora. Com um provedor sem
   visão (DeepSeek) o campo vira um aviso de que a leitura de fotos fica
   desligada.
7. (Opcional) Ajuste o **System Prompt** — vazio usa o prompt padrão
   (pt-BR, profissional e direto). É a base do agente: vale quando **nenhuma**
   personalidade está ativa.
8. (Opcional) Escolha uma **Personalidade** — veja abaixo.
9. Marque **Ativar bot** e clique em **Salvar Configurações**.

#### Personalidades do Ping IA

Ainda em **Configurações → Bot Ping IA**, a seção **Personalidades** dá ao bot
quatro estilos de atendimento (guardados na tabela `bot_personalidades`):

- **Slot 1 — Padrão (fixo):** nome, emoji e system prompt vêm do **código**
  (`PROMPT_PADRAO_PINGOS` em `hermes/bot-ia.ts`) e **não são editáveis**. Ele só
  pode ser ativado — é o botão para **voltar ao comportamento padrão**. O
  servidor recusa qualquer tentativa de editar esse slot (HTTP 403), não só a
  tela.
- **Slots 2, 3 e 4 — editáveis:** nome (até 50 caracteres), emoji (até 10) e
  system prompt (até 8000). Os botões **Salvar** e **Ativar esta** gravam no
  banco.

Apenas **uma personalidade fica ativa por vez**: ativar uma desliga as outras
numa transação. Quando há uma ativa, o `system_prompt` dela **substitui** o
System Prompt do agente; sem nenhuma ativa, o agente usa o prompt do
`bot_config` (e, se vazio, o padrão do código). O supervisor do bot relê essa
escolha a cada 15s — a troca vale no próximo ciclo.

- **Rotas:** `server/api/routes/bot-personalidades.ts` sob `/api/admin`
  (somente administrador).
- **Painel:** componente `src/components/BotPersonalidades.tsx`.

#### 4. Rodar o bot na máquina/servidor

O bot roda como um processo separado da API:

```bash
bun run bot-ia      # equivale a: bun run hermes/bot-ia.ts
```

O Id do administrador vem do **dashboard** (`bot_config.admin_id`), então o
processo só precisa das `MYSQL_*` para ler a configuração. A variável de
ambiente `ADMIN_ID` continua valendo como alternativa (aceita vários Ids
separados por vírgula) e é somada aos que estiverem no banco:

```bash
ADMIN_ID=987654321 bun run bot-ia
```

No Docker ele já está no `docker-compose.yml` como o serviço **`bot`**
(`hermes/Dockerfile`).

O processo é um **supervisor**: relê o `bot_config` a cada 15s. Enquanto faltar
algo, ele fica de plantão e diz no log exatamente o que falta:

```
⏳ Ping IA aguardando configuração — Ativar bot está desligado.
🤖 Ping IA no ar como @PingIA_bot — provedor: NVIDIA (build.nvidia.com)
   Modelo: nvidia/nemotron-3-super-120b-a12b
   Visão (fotos de O.S.): nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
   Restrito ao ADMIN_ID: 987654321
```

Sem nenhum Id de administrador configurado, o bot ainda sobe (ele não fica
mudo) e o log explica como resolver:

```
🤖 Ping IA no ar como @PingIA_bot — provedor: NVIDIA (build.nvidia.com)
   Modelo: nvidia/nemotron-3-super-120b-a12b
   Visão (fotos de O.S.): nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
   ⚠️  Sem administrador definido — o bot está no ar só para isso:
       1. Mande qualquer mensagem para o bot no Telegram;
       2. Ele responde com o seu Id numérico;
       3. Cole em Configurações → Bot Ping IA → "Seu Id no Telegram".
```

Ou seja: depois de ligar o switch e salvar no dashboard, **não é preciso
reiniciar o processo** — ele entra (ou sai) do ar sozinho no ciclo seguinte.

> Se o bot não responde, confira nesta ordem: (1) o switch **Ativar bot** está
> ligado e salvo; (2) o processo do bot está de fato rodando (serviço `bot` no
> `docker-compose.yml` ou `bun run bot-ia`); (3) o log diz
> `🤖 Ping IA no ar como @...`; (4) **Seu Id no Telegram** está preenchido no
> dashboard — sem ele o bot responde apenas com o seu Id (é assim que você
> descobre o número).
>
> Sobre o modelo: a NVIDIA **aposenta modelos sem aviso** e a API passa a
> responder `410 Gone` — o padrão antigo (`meta/llama-3.3-70b-instruct`) morreu
> em 26/08/2026. Os IDs ficam em um lugar só, `server/api/nvidia.ts`: se um
> modelo cair, troque o `DEFAULT_MODEL` de lá e as configurações antigas se
> curam sozinhas (a API e o bot trocam ID aposentado pelo padrão ao ler o banco).
>
> **Provedores:** os padrões e sugestões de cada um ficam em
> `server/api/ai-providers.ts`. Trocar de provedor no dashboard troca também o
> modelo pelo padrão do provedor novo (o ID antigo não existe lá) e o bot avisa
> que a chave precisa ser colada de novo.
>
> Hoje os modelos vivos são da família **Nemotron 3** e são de _raciocínio_:
> sem `enable_thinking: false` eles gastam o orçamento de tokens "pensando" e
> devolvem texto vazio (era o `resposta: (vazia)` do **Testar**). O parâmetro já
> vai em toda chamada feita pelo bot e pelo teste.

#### Foto de uma O.S. impressa → chamado automático

Mande a **foto da ordem de serviço impressa** no Telegram e o bot cadastra o
chamado sozinho. Aceita foto normal ou o cupom enviado **como arquivo** (sem a
compressão do Telegram, o que melhora a leitura do texto miúdo) — nos dois casos
vale o mesmo fluxo:

1. ele baixa a imagem, manda para o **modelo de visão** com um prompt que pede
   **só JSON** (`numero_os`, `solicitante`, `fone`, `descricao`, `problemas`);
2. cria o chamado com o mapeamento abaixo (prioridade **Média**, status
   **Aberto**, categoria detectada automaticamente);
3. responde com o resumo do chamado criado.

| Na O.S. impressa            | Vai para o chamado                       |
| --------------------------- | ---------------------------------------- |
| **NÚMERO O.S.**             | `os`                                     |
| **SOLICITANTE**             | `guest_name` (cliente do chamado)        |
| **FONE**                    | `guest_contact`                          |
| **DESCRIÇÃO** (equipamento) | `title` (**título** do chamado)          |
| **PROBLEMAS** (defeito)     | `description` (**descrição** do chamado) |

O resto do cupom — CNPJ, IE, endereço, ATENDENTE, datas, número de série,
marca, serviços, preços, OBS e assinaturas — é **descartado de propósito**. A
foto fica anexada ao chamado (`image_url`), então a equipe vê a O.S. original
dentro do PingOS.

A categoria sai de palavras-chave do texto lido (Notebook, Impressora, PC,
Rede, Software...; o que não casar vira **Suporte**) e prioridade/responsável
dá para ajustar depois — é o que a resposta final pergunta.

Exemplo de conversa:

```
[admin manda a foto da O.S. 3139]

✅ Chamado #1055 criado!

O.S.: 3139
Cliente: ELIANE SILVA SENA
Fone: 94991953506
Título: NOTEBOOK PRETO C/ FONTE
Descrição: REPARO NA CARCAÇA / NÃO ENTRA NO WINDOWS.
Categoria: Notebooks

Quer ajustar prioridade, categoria ou responsável?
```

E dá para continuar a conversa normalmente — depois do cadastro, basta pedir
"muda a prioridade do 1055 para Alta" ou "joga para o João".

**Situações tratadas:**

| Situação                                      | O que o bot faz                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Foto ilegível / sem O.S.                      | `❌ Não consegui ler a O.S.` — pede foto mais nítida, bem iluminada e sem sombras        |
| Número da O.S. já cadastrado                  | `⚠️ A O.S. 3139 já foi cadastrada como chamado #1042. Quer criar mesmo assim?` (Sim/Não) |
| Faltou o número, o solicitante ou a Descrição | Mostra o que leu e pede `Sim` ou `Não` antes de criar                                    |
| Falha na API de visão                         | Explica e pede para tentar de novo ou digitar os dados manualmente                       |
| Modelo de visão aposentado / chave recusada   | Aponta para Configurações → Bot Ping IA → **Modelo de visão**                            |
| Imagem grande demais (acima de 5 MB)          | Pede para mandar como foto (compactada) ou em resolução menor                            |
| Documento que não é imagem                    | Explica que só lê imagem (foto ou .jpg/.png)                                             |

> O "cliente" do chamado sai do próprio cupom (nome + fone): o PingOS **não tem
> tabela de clientes** — o cliente mora no chamado (`guest_name`/
> `guest_contact`). Quando a O.S. não traz telefone (ou nome), o bot aproveita o
> que ficou no último chamado daquele mesmo nome/telefone.
>
> Quando o cadastro precisa de confirmação (O.S. repetida ou campo ilegível), a
> **foto não fica anexada** — o payload da confirmação é gravado em
> `acoes_pendentes` e um JPEG em base64 não cabe lá.
>
> Sobre o modelo de visão: `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` é o
> padrão. Os IDs de visão que circulam em tutoriais (`meta/llama-3.2-90b-vision-instruct`,
> `meta/llama-3.2-11b-vision-instruct`, `microsoft/phi-3.5-vision-instruct`) são
> de 2024 e a NVIDIA não mantém mais essa linha. Se o **Testar** do campo de
> visão falhar, escolha no dropdown um modelo multimodal do catálogo da sua
> conta (procure `omni` ou `vl` no nome). O ID padrão fica em
> `server/api/nvidia.ts` (`DEFAULT_VISION_MODEL`).

#### O que o Ping IA pode fazer

| Ferramenta                                                            | Para quê                                           |
| --------------------------------------------------------------------- | -------------------------------------------------- |
| `listar_chamados`                                                     | Buscar/listar chamados com todos os filtros abaixo |
| `listar_clientes`                                                     | Clientes (solicitantes) com totais e filtros       |
| `listar_usuarios`                                                     | Usuários por papel, setor, atividade...            |
| `buscar_chamado_por_numero` / `buscar_chamado_por_id`                 | Chamado completo (com histórico)                   |
| `buscar_cliente`                                                      | Cliente por nome, contato ou setor                 |
| `criar_chamado` / `atualizar_chamado`                                 | Abrir e editar (imediato)                          |
| `fechar_chamado` / `reabrir_chamado`                                  | Mudar status (imediato)                            |
| `excluir_chamado`                                                     | Excluir — **pede confirmação Sim/Não**             |
| `relatorio_chamados` / `relatorio_produtividade` / `relatorio_sla`    | Totais e desempenho por período                    |
| `relatorio_clientes_top` / `relatorio_categorias` / `dashboard_geral` | Rankings e visão geral                             |
| `consultar_audit_log`                                                 | Auditoria das ações do bot                         |

#### Filtros de `listar_chamados`

Todos os filtros são **opcionais** e somam (E). Um filtro pode receber um valor
único **ou um array** (array = OU dentro do mesmo campo).

| Grupo             | Filtros                                                                                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identificação     | `id`, `numero_os`, `busca_texto`                                                                                                                                 |
| Status/prioridade | `status`, `prioridade`, `excluir_status`                                                                                                                         |
| Cliente           | `cliente_id`, `cliente_nome`, `cliente_telefone`, `cliente_setor`                                                                                                |
| Responsável       | `responsavel_id`, `responsavel_nome`, `sem_responsavel`                                                                                                          |
| Classificação     | `categoria` (Impressoras, Computadores, Notebooks, Softwares, Rede, Suporte, Outros, `sem_categoria`)                                                            |
| Datas             | `criado_apos`/`criado_antes`, `atualizado_apos`/`atualizado_antes`, `fechado_apos`/`fechado_antes`, `sem_atualizacao_dias`                                       |
| SLA               | `sla_estourando`, `sla_a_estourar`, `sla_cumprido`                                                                                                               |
| Métricas          | `tempo_resolucao_min_dias`/`tempo_resolucao_max_dias`, `tem_comentarios`, `tem_anexos`                                                                           |
| Ordenação         | `ordenar_por` (`created_at`, `updated_at`, `prioridade`, `urgencia`, `status`, `cliente_nome`, `responsavel_nome`, `tempo_resolucao`) + `direcao` (`asc`/`desc`) |
| Paginação         | `limite` (padrão 20, máx 200) e `offset`; a resposta diz `N de TOTAL`                                                                                            |

Datas aceitam ISO (`2026-09-30`) **ou** expressões em português: `hoje`, `ontem`,
`7d`/`30d`/`90d`, `ultimos_7_dias`, `esta semana`, `semana passada`,
`este mes`/`ultimos_30_dias`, `mes passado`, `este ano`.

**Busca textual (`busca_texto`)** procura em título, descrição, solução, cliente,
responsável, número e O.S. e aceita operadores:

| Operador    | Exemplo                 | Significado                        |
| ----------- | ----------------------- | ---------------------------------- |
| frase exata | `"erro 34"`             | a frase precisa aparecer assim     |
| negação     | `impressora -resolvido` | com "impressora" e sem "resolvido" |
| E           | `impressora erro`       | os dois termos                     |
| OU          | `rede \| impressora`    | qualquer um dos dois               |

**SLA:** a regra vigente do PingOS é "Aberto/Em Andamento há mais de 3 dias" —
`sla_estourando` usa esse limite, `sla_a_estourar` cobre a véspera (2 a 3 dias) e
`sla_cumprido` os resolvidos dentro de 3 dias.

> Mapeamentos do schema real: "cliente" é o solicitante (`guest_name`/
> `creator_name` ou o usuário `creator_id`); "responsável" é
> `tickets.assignee_id` (usuário **ou** técnico); `tem_comentarios` olha o campo
> `obs` e `tem_anexos` a `image_url` (o PingOS não tem tabelas separadas de
> comentários/anexos).

#### Exemplos em português

```
Admin:  Lista os 20 chamados mais urgentes do setor Financeiro que estão abertos ou em andamento
Ping IA: [listar_chamados] 📋 6 de 6 chamados encontrados:
         #1042 - Impressora Financeiro
           Status: Aberto | Prioridade: Crítica | Responsável: —
           Aberto em: 18/09/2026 10:56
         ...

Admin:  Chamados que não têm responsável e são de impressoras
Ping IA: [listar_chamados {sem_responsavel:true, categoria:"Impressoras"}] ...

Admin:  Me mostra os 5 chamados mais antigos ainda abertos
Ping IA: [listar_chamados {status:["Aberto"], ordenar_por:"created_at", direcao:"asc", limite:5}] ...

Admin:  Todos os chamados que mencionam "erro 34"
Ping IA: [listar_chamados {busca_texto:"\"erro 34\""}] 🔍 3 de 47 chamados com "erro 34": ...

Admin:  Fecha o chamado #1055, resolvido ontem
Ping IA: [fechar_chamado] ✅ Chamado #1055 fechado como Resolvido.

Admin:  Exclui o chamado #1099
Ping IA: ⚠️ Confirmar EXCLUSÃO do chamado #1099?
         Título: Impressora queimada
         Status: Aberto | Prioridade: Crítica
         Esta ação é permanente. Responda *Sim* para excluir ou *Não* para cancelar.

Admin:  Sim
Ping IA: 🗑️ Chamado #1099 excluído com sucesso.
```

## Authentication (Important!)

Os arquivos de auth vivem em `server/api/auth.ts` (login/logout/me/status/setup)
e `src/hooks/use-auth.ts` no frontend.

Você DEVE usar este hook para dados do usuário — nunca leia a sessão na mão:

```typescript
import { useAuth } from "@/hooks/use-auth"

const { isLoading, isAuthenticated, user, signIn, signOut } = useAuth()
```

## Protected Routes

The starter `/dashboard` route is protected with `RequireAuth`, which sends
signed-out users to `/auth?returnTo=<current route>`. Extend that page for the
product's authenticated experience, and reuse `RequireAuth` when adding another
protected route.

## Auth Page

The auth page is defined in `src/pages/Auth.tsx`. Send sign-in and sign-up actions
to `/auth`. Não existe auto-cadastro: as contas são criadas pelo administrador
(Admin → Configurações → Usuários).

## Authorization

You can perform authorization checks on the frontend and backend.

On the frontend, use `usePermissions()` (`src/hooks/use-permissions.ts`) para
`can(...)`, `canMoveTo(...)`, `canViewTicket(...)`, etc.

No backend, proteja TODA rota com `requireAuth` / `requirePermission` /
`requireAdmin` (`server/api/permissions.ts`) — nunca confie no que o frontend
manda.

## Adding a redirect after auth

The `/auth` route in `src/main.tsx` redirects to `/dashboard` by default. If the
product's main authenticated route is different, update `redirectAfterAuth` to
that route. A validated same-origin `returnTo` query parameter takes priority so
users can resume the protected page they originally requested. Never leave an
authenticated product redirecting back to the public landing page.

## Complete authenticated products

When the requested product implies accounts, a workspace, a dashboard, or other
signed-in functionality, the task is not complete with only a landing page and
auth form. Build the main authenticated experience, protect its route, and verify
that signing in reaches it.

# Frontend Conventions

You will be using the Vite frontend with React 19, Tailwind v4, and Shadcn UI.

Generally, pages should be in the `src/pages` folder, and components should be in the `src/components` folder.

Shadcn primitives are located in the `src/components/ui` folder and should be used by default.

## Page routing

Your page component should go under the `src/pages` folder.

When adding a page, update the react router configuration in `src/main.tsx` to include the new route you just added.

## Shad CN conventions

Follow these conventions when using Shad CN components, which you should use by default.

- Remember to use "cursor-pointer" to make the element clickable
- For title text, use the "tracking-tight font-bold" class to make the text more readable
- Always make apps MOBILE RESPONSIVE. This is important
- AVOID NESTED CARDS. Try and not to nest cards, borders, components, etc. Nested cards add clutter and make the app look messy.
- AVOID SHADOWS. Avoid adding any shadows to components. stick with a thin border without the shadow.
- Avoid skeletons; instead, use the loader2 component to show a spinning loading state when loading data.

## Landing Pages

You must always create good-looking designer-level styles to your application.

- Make it well animated and fit a certain "theme", ie neo brutalist, retro, neumorphism, glass morphism, etc

Use known images and emojis from online.

If the user is logged in already, show the get started button to say "Dashboard" or "Profile" instead to take them there.

## Responsiveness and formatting

Make sure pages are wrapped in a container to prevent the width stretching out on wide screens. Always make sure they are centered aligned and not off-center.

Always make sure that your designs are mobile responsive. Verify the formatting to ensure it has correct max and min widths as well as mobile responsiveness.

- Always create sidebars for protected dashboard pages and navigate between pages
- Always create navbars for landing pages
- On these bars, the created logo should be clickable and redirect to the index page

## Animating with Framer Motion

You must add animations to components using Framer Motion. It is already installed and configured in the project.

To use it, import the `motion` component from `framer-motion` and use it to wrap the component you want to animate.

### Other Items to animate

- Fade in and Fade out
- Slide in and Slide Out animations
- Rendering animations
- Button clicks and UI elements

Animate for all components, including on landing page and app pages.

## Colors

You can override colors in: `src/index.css`

This uses the oklch color format for tailwind v4.

Always use these color variable names.

Make sure all ui components are set up to be mobile responsive and compatible with both light and dark mode.

Set theme using `dark` or `light` variables at the parent className.

## Tema claro / escuro

O PingOS tem os dois temas de verdade: a classe `dark` no `<html>` liga os tokens
já definidos em `src/index.css`.

- **Provider:** `ThemeProvider` (next-themes) em `src/main.tsx` — `attribute="class"`,
  `defaultTheme="system"`, chave salva em `localStorage` como `pingos-theme`.
- **Seletor:** `src/components/ThemeToggle.tsx` (Claro · Escuro · Sistema), usado no
  cabeçalho do painel, de Relatórios, da landing, da tela de login e do chamado público.
- **Padrão:** `system` — quem nunca escolheu acompanha o tema do sistema operacional.

Ao criar telas novas, use os tokens (`bg-card`, `text-muted-foreground`, `border-border`,
...). Se precisar de uma cor fixa do Tailwind (ex.: `bg-amber-50`), **sempre** declare a
variante escura ao lado (`dark:bg-amber-950/40`), senão o bloco "estoura" no tema escuro.
Exceções conscientes: o fundo branco do QR Code (leitor precisa de contraste) e o
overlay do visualizador de imagem (`bg-black/85`).

## Styling and Theming

When changing the theme, always change the underlying theme of the shad cn components app-wide under `src/components/ui` and the colors in the index.css file.

Avoid hardcoding in colors unless necessary for a use case, and properly implement themes through the underlying shad cn ui components.

When styling, ensure buttons and clickable items have pointer-click on them (don't by default).

Always follow a set theme style and ensure it is tuned to the user's liking.

## Toasts

You should always use toasts to display results to the user, such as confirmations, results, errors, etc.

Use the shad cn Sonner component as the toaster. For example:

```
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
export function SonnerDemo() {
  return (
    <Button
      variant="outline"
      onClick={() =>
        toast("Event has been created", {
          description: "Sunday, December 03, 2023 at 9:00 AM",
          action: {
            label: "Undo",
            onClick: () => console.log("Undo"),
          },
        })
      }
    >
      Show Toast
    </Button>
  )
}
```

Remember to import { toast } from "sonner". Usage: `toast("Event has been created.")`

## Dialogs

Always ensure your larger dialogs have a scroll in its content to ensure that its content fits the screen size. Make sure that the content is not cut off from the screen.

Ideally, instead of using a new page, use a Dialog instead.

# Backend conventions (API Express + MySQL)

## Adding a query or mutation

1. Crie a rota em `server/api/routes/<módulo>.ts` (use `asyncHandler`, valide a
   entrada e devolva o JSON já em camelCase com `_id`/`_creationTime` — o contrato
   é o mesmo que o frontend já consome).
2. Registre a referência no adaptador: `src/lib/backend/api.ts`
   (`api.<módulo>.<ação>`) e, se precisar de tipo, em `src/lib/backend/types.ts`.
3. No componente, use o hook do adaptador:

```ts
import { api } from "@/lib/backend/api"
import { useMutation, useQuery } from "@/lib/backend/react"

const tickets = useQuery(api.tickets.list) // undefined enquanto carrega
const updateStatus = useMutation(api.tickets.updateStatus)
await updateStatus({ ticketId, status: "resolvido" })
```

Regras:

- Não use `fetch` solto nos componentes: sempre passe pelo adaptador (ele cuida
  de token, invalidação das queries e 401).
- Proteja toda rota de escrita com `requirePermission`/`requireAdmin`.
- Datas trafegam como `BIGINT` em milissegundos; ids são strings de 32 chars.
- Mudou o schema? Edite `server/mysql/schema.sql` (idempotente) e, se for uma
  coluna nova em banco existente, adicione o ajuste em `server/mysql/migrate.ts`.
- Imagens anexadas aos chamados são data URLs no campo `image_url`
  (`MEDIUMTEXT`) — nunca as corte como texto comum.

## Deploy

`DOKPLOY.md` (Docker Compose: `app` + `api` + `whatsapp` + o MySQL do painel).
