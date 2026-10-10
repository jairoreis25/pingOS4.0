import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@/lib/backend/react";
import { api } from "@/lib/backend/api";
import { usePermissions } from "@/hooks/use-permissions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Mail, MessageCircle, Wrench, Plus, Users as UsersIcon, BellRing, DatabaseBackup, Package, Bot } from "lucide-react";
import { toast } from "sonner";
import TechnicianManagementDialog from "@/components/TechnicianManagementDialog";
import UsersManagementDialog from "@/components/UsersManagementDialog";
import NotificationRulesDialog from "@/components/NotificationRulesDialog";
import BackupRestoreDialog from "@/components/BackupRestoreDialog";
import ProductsServicesDialog from "@/components/ProductsServicesDialog";
import BotConfig from "@/components/BotConfig";

export default function NotificationSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useQuery(api.notificationSettings.get);
  const upsertSettings = useMutation(api.notificationSettings.upsert);
  const { isAdmin } = usePermissions();
  const anyAdmin = useQuery(api.permissions.anyAdmin);
  const showUsersCard = isAdmin || anyAdmin === false;

  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailRecipients, setEmailRecipients] = useState("");
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [telegramBotToken, setTelegramBotToken] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [whatsappEnabled, setWhatsappEnabled] = useState(false);
  const [whatsappToken, setWhatsappToken] = useState("");
  const [whatsappPhoneNumberId, setWhatsappPhoneNumberId] = useState("");

  const [loading, setLoading] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [techOpen, setTechOpen] = useState(false);
  const [usersOpen, setUsersOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [backupOpen, setBackupOpen] = useState(false);
  const [productsOpen, setProductsOpen] = useState(false);
  const [botOpen, setBotOpen] = useState(false);

  // Sync form state when settings load
  useEffect(() => {
    if (settings && !initialized) {
      setEmailEnabled(settings.emailEnabled);
      setEmailRecipients(settings.emailRecipients.join(", "));
      setTelegramEnabled(settings.telegramEnabled);
      setTelegramBotToken(settings.telegramBotToken ?? "");
      setTelegramChatId(settings.telegramChatId ?? "");
      setWhatsappEnabled(settings.whatsappEnabled);
      setWhatsappToken(settings.whatsappToken ?? "");
      setWhatsappPhoneNumberId(settings.whatsappPhoneNumberId ?? "");

      setInitialized(true);
    }
  }, [settings, initialized]);

  const handleSave = async () => {
    setLoading(true);
    try {
      const recipients = emailRecipients
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
      await upsertSettings({
        emailEnabled,
        emailRecipients: recipients,
        telegramEnabled,
        telegramBotToken: telegramBotToken || undefined,
        telegramChatId: telegramChatId || undefined,
        whatsappEnabled,
        whatsappToken: whatsappToken || undefined,
        whatsappPhoneNumberId: whatsappPhoneNumberId || undefined,
        whatsappRecipients: [],
      });
      toast.success("Configurações salvas!");
      onOpenChange(false);
    } catch {
      toast.error("Erro ao salvar configurações.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configurações</DialogTitle>
          <DialogDescription>
            Configure para onde as notificações de novos chamados serão enviadas.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-6">
          {/* Notificação — canais de envio (E-mail, Telegram, WhatsApp) */}
          <div className="space-y-3">
            <div>
              <div className="flex items-center gap-2">
                <BellRing className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Notificação</span>
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground/70">
                Escolha por quais canais os avisos de novos chamados e de
                chamados parados serão enviados. Os campos de cada canal
                aparecem quando ele está ligado.
              </p>
            </div>

            {/* E-mail */}
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Mail className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">E-mail</span>
                </div>
                <Switch
                  checked={emailEnabled}
                  onCheckedChange={setEmailEnabled}
                />
              </div>
              {emailEnabled && (
                <div className="space-y-2 pl-6">
                  <Label className="text-xs text-muted-foreground">
                    Destinatários (separados por vírgula)
                  </Label>
                  <Input
                    placeholder="ti@empresa.com, gerente@empresa.com"
                    value={emailRecipients}
                    onChange={(e) => setEmailRecipients(e.target.value)}
                  />
                  <p className="text-[11px] text-muted-foreground/60">
                    Envio via Resend. Configure RESEND_API_KEY nas variáveis de ambiente.
                  </p>
                </div>
              )}
            </div>

            {/* Telegram */}
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageCircle className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Telegram</span>
                </div>
                <Switch
                  checked={telegramEnabled}
                  onCheckedChange={setTelegramEnabled}
                />
              </div>
              {telegramEnabled && (
                <div className="space-y-3 pl-6">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      Bot Token
                    </Label>
                    <Input
                      type="password"
                      placeholder="123456:ABC-DEF..."
                      value={telegramBotToken}
                      onChange={(e) => setTelegramBotToken(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      Chat ID
                    </Label>
                    <Input
                      placeholder="-1001234567890"
                      value={telegramChatId}
                      onChange={(e) => setTelegramChatId(e.target.value)}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground/60">
                    Crie um bot com @BotFather e adicione-o a um grupo ou chat.
                  </p>
                </div>
              )}
            </div>

            {/* WhatsApp */}
            <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <MessageCircle className="size-4 text-green-600 dark:text-green-400" />
                  <span className="text-sm font-medium">WhatsApp</span>
                </div>
                <Switch
                  checked={whatsappEnabled}
                  onCheckedChange={setWhatsappEnabled}
                />
              </div>
              {whatsappEnabled && (
                <div className="space-y-3 pl-6">
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      Token de Acesso (WhatsApp Cloud API)
                    </Label>
                    <Input
                      type="password"
                      placeholder="EAAx...seu_token_aqui"
                      value={whatsappToken}
                      onChange={(e) => setWhatsappToken(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">
                      Phone Number ID
                    </Label>
                    <Input
                      placeholder="123456789012345"
                      value={whatsappPhoneNumberId}
                      onChange={(e) => setWhatsappPhoneNumberId(e.target.value)}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground/60">
                    As mensagens serão enviadas automaticamente para o telefone do solicitante informado no chamado. Configure WHATSAPP_TOKEN e WHATSAPP_PHONE_NUMBER_ID nas variáveis de ambiente.
                  </p>
                </div>
              )}
            </div>
          </div>

          {/* Usuários e Permissões — contas de acesso (somente admin) */}
          {showUsersCard && (
            <div className="rounded-lg border border-primary/30 bg-primary/[0.03] px-4 py-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <UsersIcon className="size-4 text-primary" />
                  <span className="text-sm font-medium">Usuários e Permissões</span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setUsersOpen(true)}
                >
                  <Plus className="size-3.5" />
                  Gerenciar usuários
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground/70 mt-1.5">
                Cadastre usuários para login, crie papéis e controle permissões
                de acesso ao painel.
              </p>
            </div>
          )}

          {/* Regras de inatividade — notificações para chamados parados (somente admin) */}
          {isAdmin && (
            <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <BellRing className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Regras de inatividade</span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setRulesOpen(true)}
                >
                  <Plus className="size-3.5" />
                  Gerenciar regras
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground/70 mt-1.5">
                Crie regras para notificar o cliente ou o responsável quando um
                chamado ficar parado sem atualizações por um período definido.
              </p>
            </div>
          )}

          {/* Backup e Restauração — dump/restore do banco (somente admin) */}
          {isAdmin && (
            <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <DatabaseBackup className="size-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Backup e Restauração</span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setBackupOpen(true)}
                >
                  <Plus className="size-3.5" />
                  Gerenciar backups
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground/70 mt-1.5">
                Gere um backup do banco de dados, baixe para o seu computador ou
                restaure o sistema a partir de um backup salvo ou enviado.
              </p>
            </div>
          )}

          {/* Técnicos — cadastro usado no campo "Atribuído a" */}
          <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Wrench className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Técnicos</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setTechOpen(true)}
              >
                <Plus className="size-3.5" />
                Gerenciar técnicos
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground/70 mt-1.5">
              Cadastre os técnicos exibidos no campo "Atribuído a" dos chamados.
            </p>
          </div>

          {/* Bot Ping IA — agente administrativo no Telegram (somente admin) */}
          {isAdmin && (
            <div className="rounded-lg border border-primary/30 bg-primary/[0.03] px-4 py-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2">
                  <Bot className="size-4 text-primary" />
                  <span className="text-sm font-medium">Bot Ping IA</span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setBotOpen(true)}
                >
                  <Plus className="size-3.5" />
                  Configurar bot
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground/70 mt-1.5">
                Agente administrativo no Telegram que usa o provedor de IA
                escolhido (NVIDIA, OpenAI, Gemini...) para consultar chamados,
                buscar clientes e criar/fechar chamados.
              </p>
            </div>
          )}

          {/* Produtos e Serviços — catálogo simples (nome + valor) */}
          <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                <Package className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">Produtos e Serviços</span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setProductsOpen(true)}
              >
                <Plus className="size-3.5" />
                Gerenciar produtos
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground/70 mt-1.5">
              Cadastre produtos e serviços com nome e valor para manter o
              catálogo de referência do sistema.
            </p>
          </div>

          {/* WhatsApp Web bridge — where ticket notifications are actually sent */}
          <div className="rounded-lg border border-green-200/70 bg-green-50/40 px-4 py-3 dark:border-green-900/50 dark:bg-green-950/30">
            <div className="flex items-center gap-2">
              <MessageCircle className="size-4 text-green-600 dark:text-green-400" />
              <span className="text-sm font-medium">Servidor WhatsApp Web</span>
            </div>
            <p className="text-[11px] text-muted-foreground/70 mt-1.5">
              Os chamados são enviados automaticamente para o WhatsApp do solicitante pelo servidor
              local (porta 3001), que inicia junto com o aplicativo. Para conectar ou ver o QR
              Code, status e logs, use o ícone verde no topo do painel.
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading ? "Salvando..." : "Salvar"}
          </Button>
        </DialogFooter>
      </DialogContent>

      <TechnicianManagementDialog open={techOpen} onOpenChange={setTechOpen} />
      <UsersManagementDialog open={usersOpen} onOpenChange={setUsersOpen} />
      <NotificationRulesDialog open={rulesOpen} onOpenChange={setRulesOpen} />
      <BackupRestoreDialog open={backupOpen} onOpenChange={setBackupOpen} />
      <ProductsServicesDialog open={productsOpen} onOpenChange={setProductsOpen} />
      <BotConfig open={botOpen} onOpenChange={setBotOpen} />
    </Dialog>
  );
}