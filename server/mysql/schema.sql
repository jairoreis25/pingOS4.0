-- ============================================================================
-- PingOS — Schema MySQL (backend paralelo ao Convex)
-- ============================================================================
-- Espelha o modelo de dados hoje definido em src/convex/schema.ts, para que o
-- frontend possa ser migrado módulo a módulo sem mudar o formato dos dados.
--
-- Convenções (mantidas de propósito para a migração ser mecânica):
--   * ids são strings opacas de 32 caracteres (como os ids do Convex), não
--     inteiros sequenciais — assim o frontend continua tratando ids como texto
--     e um eventual import dos dados atuais é uma cópia direta.
--   * `created_at` / `updated_at` são BIGINT em milissegundos desde a epoch
--     (mesmo significado de `Date.now()` no Convex), então a formatação de
--     datas no frontend continua idêntica.
--   * listas (permissões, canais, statuses...) usam JSON, como no Convex.
--
-- Uso:
--   mysql -u root -p < server/mysql/schema.sql
-- (troque o nome do banco abaixo, se quiser — e ajuste MYSQL_DATABASE no .env)
-- ============================================================================

CREATE DATABASE IF NOT EXISTS `pingos`
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE `pingos`;

-- ─────────────────────────────────────────────────────────────────────────────
-- Usuários (login por usuário/senha; o campo `email` guarda o username)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `users` (
  `id`                      VARCHAR(64)  NOT NULL,
  `name`                    VARCHAR(255) NULL,
  `image`                   MEDIUMTEXT   NULL,
  `email`                   VARCHAR(255) NULL,
  `username`                VARCHAR(255) NULL,
  `password_hash`           VARCHAR(255) NULL,
  `email_verification_time` BIGINT       NULL,
  `is_anonymous`            TINYINT(1)   NOT NULL DEFAULT 0,
  `role`                    VARCHAR(64)  NULL,
  `active`                  TINYINT(1)   NOT NULL DEFAULT 1,
  `setor`                   VARCHAR(255) NULL,
  `contato`                 VARCHAR(64)  NULL,
  `permissions`             JSON         NULL,
  `created_by`              VARCHAR(64)  NULL,
  `created_at`              BIGINT       NULL,
  `updated_at`              BIGINT       NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_users_email` (`email`),
  KEY `idx_users_username` (`username`),
  KEY `idx_users_role` (`role`),
  CONSTRAINT `fk_users_created_by` FOREIGN KEY (`created_by`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Sessões (substituem as sessões do Convex Auth)
--
-- `token` guarda o HASH SHA-256 (hex) do token de sessão: o token em claro só
-- existe no navegador do usuário, então um dump/backup desta tabela não permite
-- se autenticar. Sessões criadas por versões antigas (token em claro) são
-- migradas para o hash na primeira requisição que as usar.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `sessions` (
  `token`      CHAR(64)     NOT NULL,
  `user_id`    VARCHAR(64)  NOT NULL,
  `created_at` BIGINT       NOT NULL,
  `expires_at` BIGINT       NOT NULL,
  `user_agent` VARCHAR(255) NULL,
  PRIMARY KEY (`token`),
  KEY `idx_sessions_user` (`user_id`),
  KEY `idx_sessions_expires` (`expires_at`),
  CONSTRAINT `fk_sessions_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Papéis (RBAC) — "admin" e "user" são criados pelo seed
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `roles` (
  `id`          VARCHAR(64) NOT NULL,
  `name`        VARCHAR(64) NOT NULL,
  `permissions` JSON        NOT NULL,
  `is_system`   TINYINT(1)  NOT NULL DEFAULT 0,
  `created_at`  BIGINT      NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_roles_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Técnicos (cadastro separado dos usuários; pode ser o responsável do chamado)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `technicians` (
  `id`         VARCHAR(64)  NOT NULL,
  `name`       VARCHAR(255) NOT NULL,
  `funcao`     VARCHAR(255) NULL,
  `contato`    VARCHAR(64)  NULL,
  `active`     TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at` BIGINT       NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_technicians_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Produtos e serviços (catálogo usado nos orçamentos/valores dos chamados)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `products_services` (
  `id`         VARCHAR(64)   NOT NULL,
  `name`       VARCHAR(255)  NOT NULL,
  -- Produto (peça/equipamento) x Serviço (mão de obra): é o que diferencia um
  -- item do outro no catálogo. Itens criados antes desta coluna existir ficam
  -- como 'servico' (a maioria num Help Desk).
  `item_type`  ENUM('produto','servico') NOT NULL DEFAULT 'servico',
  `price`      DECIMAL(12,2) NOT NULL DEFAULT 0.00,
  `active`     TINYINT(1)    NOT NULL DEFAULT 1,
  `created_at` BIGINT        NOT NULL,
  `updated_at` BIGINT        NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_products_services_name` (`name`),
  KEY `idx_products_services_type` (`item_type`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Chamados (o Kanban)
-- `assignee_id` aponta para users.id OU technicians.id (como no Convex), por
-- isso não tem FK: `assignee_type` diz qual dos dois é. Mantido assim para a
-- regra de permissões existente (tickets.view.own etc.) continuar válida.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `tickets` (
  `id`                  VARCHAR(64)  NOT NULL,
  `number`              INT          NOT NULL,
  `title`               VARCHAR(255) NULL,
  `description`         TEXT         NULL,
  `solucao`             TEXT         NULL,
  `orcamento`           TEXT         NULL,
  `obs`                 TEXT         NULL,
  `status_equipamento`  VARCHAR(120) NULL,
  -- Categoria do chamado (Impressoras, Rede, ...): classificação INTERNA da
  -- equipe, definida no dropdown ao editar. Não vai para WhatsApp/e-mail nem
  -- para o cupom impresso.
  `categoria`           VARCHAR(40)  NULL,
  `status`              ENUM('aberto','em_andamento','aguardando','resolvido','fechado')
                        NOT NULL DEFAULT 'aberto',
  `priority`            ENUM('baixa','media','alta','critica')
                        NOT NULL DEFAULT 'media',
  `creator_id`          VARCHAR(64)  NULL,
  `guest_name`          VARCHAR(160) NULL,
  `guest_contact`       VARCHAR(200) NULL,
  -- As imagens dos chamados são data URLs (base64 de um JPEG redimensionado
  -- para 1200px), então podem passar bem dos 64 KB do TEXT. MEDIUMTEXT (16 MB)
  -- é o que o Convex armazenava sem limite.
  `image_url`           MEDIUMTEXT   NULL,
  `valor_total`         DECIMAL(12,2) NULL,
  `os`                  VARCHAR(80)  NULL,
  `creator_name`        VARCHAR(160) NULL,
  `location`            VARCHAR(255) NULL,
  `assignee_id`         VARCHAR(64)  NULL,
  `assignee_type`       ENUM('user','technician') NULL,
  `created_at`          BIGINT       NOT NULL,
  `updated_at`          BIGINT       NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_tickets_status` (`status`),
  KEY `idx_tickets_categoria` (`categoria`),
  KEY `idx_tickets_creator` (`creator_id`),
  KEY `idx_tickets_created_at` (`created_at`),
  KEY `idx_tickets_number` (`number`),
  KEY `idx_tickets_assignee` (`assignee_id`),
  -- Número da O.S. impressa (foto no Telegram): é por aqui que o bot procura
  -- chamado duplicado antes de cadastrar de novo.
  KEY `idx_tickets_os` (`os`),
  CONSTRAINT `fk_tickets_creator` FOREIGN KEY (`creator_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Configurações de notificação (linha única, id = 1)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `notification_settings` (
  `id`                       TINYINT(1)   NOT NULL DEFAULT 1,
  `email_enabled`            TINYINT(1)   NOT NULL DEFAULT 0,
  `email_recipients`         JSON         NOT NULL,
  `telegram_enabled`         TINYINT(1)   NOT NULL DEFAULT 0,
  `telegram_bot_token`       VARCHAR(255) NULL,
  `telegram_chat_id`         VARCHAR(120) NULL,
  `whatsapp_enabled`         TINYINT(1)   NOT NULL DEFAULT 0,
  `whatsapp_token`           VARCHAR(255) NULL,
  `whatsapp_phone_number_id` VARCHAR(120) NULL,
  `whatsapp_recipients`      JSON         NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `chk_notification_settings_singleton` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Configuração do bot "Ping IA" (linha única, id = 1)
--
-- O dashboard (Configurações → Bot Ping IA, só admin) grava aqui a chave da
-- NVIDIA, o modelo, o token do Telegram e o system prompt. O processo
-- `hermes/bot-ia.ts` lê esta linha ao iniciar e só sobe quando `ativo = 1` e as
-- credenciais necessárias existem.
--
-- `admin_id` é o Id numérico do administrador no Telegram (o antigo ADMIN_ID de
-- variável de ambiente): fica aqui para poder ser preenchido pelo dashboard,
-- sem depender de mexer no ambiente do container. Aceita vários ids separados
-- por vírgula.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `bot_config` (
  `id`             TINYINT(1)   NOT NULL DEFAULT 1,
  -- A chave guardada aqui é a do provedor escolhido em `provider` (o nome da
  -- coluna é herdado da época em que o Ping IA falava só com a NVIDIA).
  `nvidia_api_key` VARCHAR(255) NULL,
  -- Provedor de IA do agente: nvidia (padrão), openai, google, anthropic,
  -- groq, openrouter, deepseek, mistral ou custom.
  `provider`       VARCHAR(32)  NOT NULL DEFAULT 'nvidia',
  -- URL base própria (servidor compatível com a OpenAI, Azure, LM Studio...).
  -- Vazia = a URL padrão do provedor escolhido.
  `base_url`       VARCHAR(255) NULL,
  `modelo`         VARCHAR(150) NOT NULL DEFAULT 'nvidia/nemotron-3-super-120b-a12b',
  -- Modelo de VISÃO, usado só para ler fotos de O.S. impressas enviadas no
  -- Telegram. Fica separado do `modelo` porque precisa aceitar imagem no
  -- conteúdo da mensagem (ex.: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning).
  `modelo_visao`   VARCHAR(150) NULL,
  `telegram_token` VARCHAR(255) NULL,
  `admin_id`       VARCHAR(64)  NULL,
  `ativo`          TINYINT(1)   NOT NULL DEFAULT 0,
  `system_prompt`  TEXT         NULL,
  `updated_at`     DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                                ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  CONSTRAINT `chk_bot_config_singleton` CHECK (`id` = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Personalidades do bot "Ping IA"
-- São 4 slots fixos (o `slot` é UNIQUE e o CHECK limita de 1 a 4). O slot 1 é o
-- PADRÃO (`fixo = 1`): nome, emoji e system prompt vêm do código e não podem ser
-- editados — só ativados/desativados. Os slots 2, 3 e 4 são editáveis pelo admin
-- no dashboard (Configurações → Bot Ping IA → Personalidades). No máximo um slot
-- fica com `ativo = 1`; o agente lê a linha ativa em `hermes/bot-ia.ts`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `bot_personalidades` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `slot`          TINYINT      NOT NULL UNIQUE,
  `nome`          VARCHAR(50)  NOT NULL,
  `emoji`         VARCHAR(10)  DEFAULT '🤖',
  `system_prompt` TEXT         NULL,
  -- 1 no slot Padrão (prompt definido no código), 0 nos editáveis.
  `fixo`          TINYINT(1)   NOT NULL DEFAULT 0,
  `ativo`         TINYINT(1)   NOT NULL DEFAULT 0,
  `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                               ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `chk_bot_personalidades_slot` CHECK (`slot` BETWEEN 1 AND 4)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Histórico de envios (e-mail / telegram / whatsapp)
-- `recipient` e `rule_id` alimentam o relatório de auditoria de notificações:
-- para quem foi, por qual regra de inatividade (quando houver) e por qual canal.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `notifications` (
  `id`        VARCHAR(64) NOT NULL,
  `ticket_id` VARCHAR(64) NOT NULL,
  `type`      ENUM('email','telegram','whatsapp') NOT NULL,
  `status`    ENUM('sent','failed','pending')      NOT NULL,
  `recipient` VARCHAR(255) NULL,
  `rule_id`   VARCHAR(64)  NULL,
  `error`     TEXT        NULL,
  `sent_at`   BIGINT      NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_notifications_ticket` (`ticket_id`),
  KEY `idx_notifications_sent_at` (`sent_at`),
  KEY `idx_notifications_type_status` (`type`, `status`),
  CONSTRAINT `fk_notifications_ticket` FOREIGN KEY (`ticket_id`)
    REFERENCES `tickets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Regras de notificação por inatividade
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `notification_rules` (
  `id`             VARCHAR(64)  NOT NULL,
  `name`           VARCHAR(255) NOT NULL,
  `statuses`       JSON         NOT NULL,
  `days_inactive`  INT          NOT NULL,
  `recipient`      ENUM('cliente','responsavel','ambos') NOT NULL,
  `channels`       JSON         NOT NULL,
  `active`         TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at`     BIGINT       NOT NULL,
  `updated_at`     BIGINT       NOT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Notificações in-app (sino) por usuário
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `in_app_notifications` (
  `id`         VARCHAR(64)  NOT NULL,
  `user_id`    VARCHAR(64)  NOT NULL,
  `ticket_id`  VARCHAR(64)  NOT NULL,
  `rule_id`    VARCHAR(64)  NULL,
  `title`      VARCHAR(255) NOT NULL,
  `message`    TEXT         NOT NULL,
  `is_read`    TINYINT(1)   NOT NULL DEFAULT 0,
  `created_at` BIGINT       NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_inapp_user` (`user_id`, `created_at`),
  KEY `idx_inapp_user_unread` (`user_id`, `is_read`, `created_at`),
  KEY `idx_inapp_ticket` (`ticket_id`),
  CONSTRAINT `fk_inapp_user` FOREIGN KEY (`user_id`)
    REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_inapp_ticket` FOREIGN KEY (`ticket_id`)
    REFERENCES `tickets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Anti-spam de inatividade (1 alerta por chamado+regra até o chamado mudar)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `inactivity_logs` (
  `id`        VARCHAR(64) NOT NULL,
  `ticket_id` VARCHAR(64) NOT NULL,
  `rule_id`   VARCHAR(64) NOT NULL,
  `sent_at`   BIGINT      NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_inactivity_ticket_rule` (`ticket_id`, `rule_id`),
  KEY `idx_inactivity_rule` (`rule_id`),
  CONSTRAINT `fk_inactivity_ticket` FOREIGN KEY (`ticket_id`)
    REFERENCES `tickets` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_inactivity_rule` FOREIGN KEY (`rule_id`)
    REFERENCES `notification_rules` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Histórico de status (transições do Kanban)
--
-- É o que sustenta os relatórios de **tempo de resposta/resolução** e a
-- **taxa de reabertura**: o chamado guarda apenas o status atual, então sem
-- este log não há como saber quando ele saiu de "Aberto" nem se voltou de
-- "Resolvido". Cada mudança de status grava uma linha (fire-and-forget).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `ticket_status_events` (
  `id`          VARCHAR(64) NOT NULL,
  `ticket_id`   VARCHAR(64) NOT NULL,
  `from_status` VARCHAR(20) NULL,
  `to_status`   VARCHAR(20) NOT NULL,
  `user_id`     VARCHAR(64)  NULL,
  `user_name`   VARCHAR(255) NULL,
  `created_at`  BIGINT       NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_status_events_ticket` (`ticket_id`, `created_at`),
  KEY `idx_status_events_to_status` (`to_status`, `created_at`),
  CONSTRAINT `fk_status_events_ticket` FOREIGN KEY (`ticket_id`)
    REFERENCES `tickets` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Auditoria dos relatórios (Módulo de Relatórios)
-- Registra quem gerou/exportou, quando, com quais filtros e em qual formato.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `report_logs` (
  `id`         VARCHAR(64)  NOT NULL,
  `report`     VARCHAR(40)  NOT NULL,
  `format`     ENUM('tela','xls','pdf') NOT NULL DEFAULT 'tela',
  `filters`    JSON         NULL,
  `row_count`  INT          NOT NULL DEFAULT 0,
  `user_id`    VARCHAR(64)  NULL,
  `user_name`  VARCHAR(255) NULL,
  `created_at` BIGINT       NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_report_logs_created_at` (`created_at`),
  KEY `idx_report_logs_report` (`report`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Contadores atômicos (ex.: próximo número de chamado)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `counters` (
  `name`  VARCHAR(64) NOT NULL,
  `value` INT         NOT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Backups (painel do admin) — o arquivo fica em BACKUP_DIR no servidor
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `backups` (
  `id`           VARCHAR(64)  NOT NULL,
  `filename`     VARCHAR(255) NOT NULL,
  `storage_path` VARCHAR(512) NULL,
  `size`         BIGINT       NOT NULL,
  `created_at`   BIGINT       NOT NULL,
  `created_by`   VARCHAR(255) NULL,
  `restored_at`  BIGINT       NULL,
  `restored_by`  VARCHAR(255) NULL,
  PRIMARY KEY (`id`),
  KEY `idx_backups_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Auditoria de backup/restauração
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `backup_logs` (
  `id`         VARCHAR(64)  NOT NULL,
  `action`     VARCHAR(32)  NOT NULL,
  `filename`   VARCHAR(255) NULL,
  `detail`     TEXT         NULL,
  `user_name`  VARCHAR(255) NULL,
  `created_at` BIGINT       NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_backup_logs_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Ações pendentes do bot (ex.: aguardando o "Sim/Não" de uma exclusão)
--
-- O bot Ping IA executa tudo imediatamente, MENOS exclusões: estas viram uma
-- linha aqui com o resumo e um prazo (`expires_at`), até o administrador
-- responder Sim (confirmada) ou Não (cancelada).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS `acoes_pendentes` (
  `id`         VARCHAR(64)  NOT NULL,
  `admin_id`   VARCHAR(64)  NULL,
  `chat_id`    VARCHAR(64)  NULL,
  `tipo`       VARCHAR(40)  NOT NULL,
  `payload`    TEXT         NULL,
  `resumo`     TEXT         NULL,
  `status`     ENUM('pendente','confirmada','cancelada','expirada') NOT NULL DEFAULT 'pendente',
  `created_at` BIGINT       NOT NULL,
  `expires_at` BIGINT       NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_acoes_pendentes_chat` (`chat_id`, `admin_id`, `status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Auditoria das ações administrativas (bot Ping IA)
--
-- Cada mutação feita pelo bot grava uma linha: quem (admin_id), qual ação
-- (criar/editar/fechar/reabrir/excluir), em qual tabela/registro e os detalhes
-- em JSON — é o que sustenta o `consultar_audit_log`.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `audit_log` (
  `id`          VARCHAR(64)  NOT NULL,
  `admin_id`    VARCHAR(64)  NULL,
  `usuario_id`  VARCHAR(64)  NULL,
  `tipo_acao`   VARCHAR(40)  NOT NULL,
  `tabela`      VARCHAR(40)  NOT NULL,
  `registro_id` VARCHAR(64)  NULL,
  `detalhes`    TEXT         NULL,
  `created_at`  BIGINT       NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_audit_log_created_at` (`created_at`),
  KEY `idx_audit_log_tipo` (`tipo_acao`, `created_at`),
  KEY `idx_audit_log_tabela` (`tabela`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─────────────────────────────────────────────────────────────────────────────
-- Dados iniciais: contador de número de chamado e configurações de notificação
-- (os papéis padrão e o primeiro administrador são criados por server/mysql/seed.ts)
-- ─────────────────────────────────────────────────────────────────────────────
INSERT INTO `counters` (`name`, `value`) VALUES ('ticket_number', 0)
  ON DUPLICATE KEY UPDATE `name` = `name`;

INSERT INTO `notification_settings`
  (`id`, `email_enabled`, `email_recipients`, `telegram_enabled`,
   `whatsapp_enabled`, `whatsapp_recipients`)
VALUES (1, 0, JSON_ARRAY(), 0, 0, JSON_ARRAY())
  ON DUPLICATE KEY UPDATE `id` = `id`;

-- Configuração do bot (linha única; o admin preenche pelo dashboard).
INSERT INTO `bot_config` (`id`) VALUES (1)
  ON DUPLICATE KEY UPDATE `id` = `id`;

-- Personalidades padrão do bot (4 slots). `INSERT IGNORE` pelo `slot` UNIQUE:
-- nunca sobrescreve o que o admin já editou. O slot 1 é o Padrão fixo; os outros
-- vêm prontos como exemplo e podem ser editados no dashboard.
INSERT IGNORE INTO `bot_personalidades` (`slot`, `nome`, `emoji`, `fixo`) VALUES
  (1, 'Padrão',       '🤖', 1),
  (2, 'Descontraída', '🎭', 0),
  (3, 'Ranzinza',     '😒', 0),
  (4, 'Preguiçoso',   '😴', 0);
