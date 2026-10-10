/**
 * Configurações → WhatsApp Web.
 *
 * Estava dentro de `pages/Dashboard.tsx` (arquivo grande demais); foi movido
 * para cá **sem mudança de comportamento**. Cuida de:
 *   * status/QR Code da ponte (Baileys) com poll a cada 5s;
 *   * pausar/retomar os envios (mantém a conexão pareada);
 *   * URL personalizada do servidor WhatsApp (salva no navegador);
 *   * envio de teste.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Pause,
  Play,
  RefreshCw,
  Save,
  Server,
  Smartphone,
  Terminal,
  Wifi,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  waBridgeUrl,
  waConsoleUrl,
  whatsappBridgeConfigured,
  getBridgeOverride,
  setBridgeOverride,
  bridgeSourceLabel,
} from "@/lib/whatsapp-bridge";

export default function WhatsAppWebDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [status, setStatus] = useState<string>("disconnected");
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [phone, setPhone] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testSending, setTestSending] = useState(false);
  const [serverOnline, setServerOnline] = useState<boolean | null>(null);
  const [paused, setPaused] = useState(false);
  const [togglingPause, setTogglingPause] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bridgeUrl, setBridgeUrl] = useState<string>(getBridgeOverride());
  const [showBridgeConfig, setShowBridgeConfig] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const wasOnlineRef = useRef<boolean | null>(null);
  const serverOnlineRef = useRef<boolean | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch(waBridgeUrl("/status"));
      const result = await res.json();
      setStatus(result.status ?? "disconnected");
      setPaused(result.paused === true);
      if (result.info?.phone) setPhone(result.info.phone);
      if (result.info?.name) setName(result.info.name);
      if (result.status === "connected" || result.status === "disconnected") {
        setQrImage(null);
      }
      // Server just came back online (e.g. watchdog started it, user ran the command)
      if (wasOnlineRef.current === false) {
        toast.success("Servidor WhatsApp Web online! Escaneie o QR Code para conectar.");
      }
      wasOnlineRef.current = true;
      serverOnlineRef.current = true;
      setServerOnline(true);
      setError(null);
    } catch {
      // Bridge unreachable: show the offline panel instead of a misleading QR error.
      setStatus("offline");
      setError(null);
      wasOnlineRef.current = false;
      serverOnlineRef.current = false;
      setServerOnline(false);
    }
  }, []);

  const refreshQR = useCallback(async () => {
    try {
      const res = await fetch(waBridgeUrl("/qr"));
      const result = await res.json();
      serverOnlineRef.current = true;
      if (result.qr) {
        setQrImage(result.qr);
        setStatus(result.status ?? "waiting_for_qr");
        setError(null);
      }
      if (result.status) setStatus(result.status);
      if (result.error) setError(result.error);
    } catch {
      // When the bridge is down the amber offline panel already explains what
      // to do - don't stack a generic "Falha ao obter QR Code" error on top.
      if (serverOnlineRef.current !== false) {
        setError("Falha ao obter QR Code.");
      }
    }
  }, []);

  useEffect(() => {
    if (open) {
      setError(null);
      refreshStatus();
      pollRef.current = setInterval(() => {
        refreshStatus();
        refreshQR();
      }, 5000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [open, refreshStatus, refreshQR]);

  const handleLogout = async () => {
    setLoading(true);
    try {
      await fetch(waBridgeUrl("/logout"), { method: "POST" });
      setStatus("disconnected");
      setQrImage(null);
      setPhone("");
      setName("");
      toast.success("Desconectado do WhatsApp Web");
    } catch {
      toast.error("Erro ao desconectar.");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Pausa ou retoma os envios na ponte do WhatsApp.
   *
   * Pausar mantém o WhatsApp conectado: a sessão pareada continua ativa e só o
   * envio de mensagens para — sem precisar desconectar (e perder o pareamento).
   */
  const handleTogglePause = useCallback(async () => {
    const next = !paused;
    setTogglingPause(true);
    try {
      const res = await fetch(waBridgeUrl(next ? "/pause" : "/resume"), {
        method: "POST",
      });
      const result = (await res.json().catch(() => ({}))) as { paused?: boolean };
      if (!res.ok || result.paused !== next) throw new Error("falhou");
      setPaused(next);
      toast.success(
        next
          ? "Envio de WhatsApp pausado — os chamados não vão notificar por WhatsApp"
          : "Envio de WhatsApp retomado",
      );
    } catch {
      toast.error(
        "Não foi possível alterar o envio. Confira se o servidor WhatsApp está online.",
      );
      refreshStatus();
    } finally {
      setTogglingPause(false);
    }
  }, [paused, refreshStatus]);

  const handleStartServer = useCallback(async () => {
    // Open the WhatsApp server console (status, QR Code and logs) in a new
    // window. The console page polls by itself. The bridge starts together
    // with the app; if it is really down, the amber panel below explains what
    // to do (and this dialog keeps polling until the server comes back).
    window.open(
      waConsoleUrl(),
      "_blank",
      "noopener,noreferrer,width=1000,height=760",
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const res = await fetch(waBridgeUrl("/status"), { signal: controller.signal });
      const result = await res.json();
      setStatus(result.status ?? "disconnected");
      serverOnlineRef.current = true;
      setServerOnline(true);
      setError(null);
      toast.success("Servidor online — console aberto em nova janela");
    } catch {
      setStatus("offline");
      setError(null);
      serverOnlineRef.current = false;
      setServerOnline(false);
      toast.info("Servidor offline — veja as instruções abaixo para iniciar.");
    } finally {
      clearTimeout(timer);
    }
  }, []);

  const handleSaveBridgeUrl = async () => {
    const value = bridgeUrl.trim();
    if (value) {
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        toast.error("URL inválida — use o formato https://seu-servidor.com");
        return;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        toast.error("URL inválida — deve começar com http:// ou https://");
        return;
      }
      setBridgeOverride(parsed.toString().replace(/\/+$/, ""));
      toast.success("URL do servidor salva neste navegador");
    } else {
      setBridgeOverride("");
      toast.info("URL personalizada removida");
    }
    setBridgeUrl(getBridgeOverride());
    setShowBridgeConfig(false);
    refreshStatus();
    refreshQR();
  };

  const handleTestSend = async () => {
    const digits = testPhone.replace(/\D/g, "");
    if (digits.length < 10) {
      toast.error("Número de telefone inválido (mínimo 10 dígitos)");
      return;
    }
    setTestSending(true);
    try {
      const res = await fetch(waBridgeUrl("/send"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: digits,
          message: "✅ Teste de notificação PingOS — Se você recebeu esta mensagem, o WhatsApp Web está funcionando corretamente!",
        }),
      });
      const result = await res.json();
      if (result.success) {
        toast.success("Mensagem de teste enviada para " + digits);
        setTestPhone("");
      } else {
        toast.error("Erro ao enviar: " + (result.error || "desconhecido"));
      }
    } catch {
      toast.error("Erro ao enviar mensagem de teste.");
    } finally {
      setTestSending(false);
    }
  };

  // Cada estado traz também a variante escura — as faixas ficam legíveis nos
  // dois temas sem perder a cor que identifica o status.
  const statusConfig: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
    connected: { label: "Conectado", color: "text-emerald-600 bg-emerald-50 border-emerald-200 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-900/60", icon: <Wifi className="size-4" /> },
    waiting_for_qr: { label: "Aguardando QR Code", color: "text-amber-600 bg-amber-50 border-amber-200 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-900/60", icon: <Smartphone className="size-4" /> },
    authenticated: { label: "Autenticando...", color: "text-blue-600 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-950/40 dark:border-blue-900/60", icon: <Wifi className="size-4" /> },
    disconnected: { label: "Desconectado", color: "text-muted-foreground bg-muted border-border", icon: <WifiOff className="size-4" /> },
    reconnecting: { label: "Reconectando...", color: "text-blue-600 bg-blue-50 border-blue-200 dark:text-blue-300 dark:bg-blue-950/40 dark:border-blue-900/60", icon: <RefreshCw className="size-4" /> },
    auth_failure: { label: "Falha na autenticação", color: "text-red-600 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-950/40 dark:border-red-900/60", icon: <WifiOff className="size-4" /> },
    error: { label: "Erro", color: "text-red-600 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-950/40 dark:border-red-900/60", icon: <WifiOff className="size-4" /> },
    offline: { label: "Servidor offline", color: "text-red-600 bg-red-50 border-red-200 dark:text-red-300 dark:bg-red-950/40 dark:border-red-900/60", icon: <WifiOff className="size-4" /> },
  };

  const currentStatus = statusConfig[status] ?? statusConfig.disconnected;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[92vh] sm:max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="size-5 text-green-600 dark:text-green-400" />
            WhatsApp Web
          </DialogTitle>
          <DialogDescription>
            Conecte-se ao WhatsApp Web para enviar notificações dos chamados.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className={`flex items-center gap-2 rounded-lg border px-4 py-3 flex-wrap ${currentStatus.color}`}>
            {currentStatus.icon}
            <span className="text-sm font-medium">{currentStatus.label}</span>
            {phone && <span className="text-xs opacity-70 ml-auto">({phone})</span>}
          </div>
          {name && status === "connected" && (
            <p className="text-sm text-muted-foreground">
              Conectado como <span className="font-medium text-foreground">{name}</span>
            </p>
          )}
          {paused && status === "connected" && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 dark:bg-amber-950/30 dark:border-amber-900/60">
              <p className="text-xs text-amber-700/90 dark:text-amber-200/90">
                Envio de mensagens pausado — os chamados não notificam pelo WhatsApp
                enquanto estiver assim. A conexão com o WhatsApp continua ativa.
              </p>
            </div>
          )}
          {qrImage && status === "waiting_for_qr" && (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm text-muted-foreground">Escaneie o QR Code com seu WhatsApp:</p>
              {/* O QR Code precisa de fundo claro em qualquer tema: leitores não
                  reconhecem o código com o contraste invertido. */}
              <div className="rounded-xl border border-border/40 bg-white p-3 shadow-sm">
                <img src={qrImage} alt="QR Code WhatsApp" className="w-full max-w-56 h-auto aspect-square" />
              </div>
              <p className="text-xs text-muted-foreground/60 text-center">
                Abra o WhatsApp → Configurações → Aparelhos conectados → Conectar um aparelho
              </p>
            </div>
          )}
          {error && serverOnline !== false && (
            <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 dark:bg-red-950/40 dark:border-red-900/60">
              <p className="text-sm text-red-600 dark:text-red-300">{error}</p>
            </div>
          )}
          {serverOnline === false && (
            <div className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-3 dark:bg-amber-950/30 dark:border-amber-900/60">
              <div className="flex items-start gap-2">
                <Terminal className="size-4 text-amber-600 mt-0.5 shrink-0 dark:text-amber-400" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-200">Servidor WhatsApp offline</p>
                  <p className="text-xs text-amber-700/80 dark:text-amber-200/80">
                    O servidor inicia automaticamente junto com o aplicativo. Se ele
                    continuar offline, confirme se o container{" "}
                    <code className="bg-amber-100 border border-amber-300 rounded px-1 font-mono text-[11px] dark:bg-amber-900/40 dark:border-amber-800">whatsapp</code>{" "}
                    está em execução no servidor e aguarde o QR Code aparecer acima.
                  </p>
                  {!whatsappBridgeConfigured() && (
                    <p className="text-[11px] text-amber-700/70 mt-1.5 dark:text-amber-200/70">
                      No site publicado, informe abaixo a URL (HTTPS) do seu servidor WhatsApp
                      sempre ativo — ou configure <code className="bg-amber-100 border border-amber-300 rounded px-1 font-mono text-[10px] dark:bg-amber-900/40 dark:border-amber-800">VITE_WHATSAPP_WEB_URL</code>{" "}
                      nas Keys/API keys e republique o app.
                    </p>
                  )}
                  <div className="flex gap-2 mt-1 flex-wrap">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        refreshStatus();
                        refreshQR();
                      }}
                    >
                      <RefreshCw className="size-3.5" />
                      Verificar novamente
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
          <div className="rounded-lg border border-border/40 px-4 py-3">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-2 text-left flex-wrap"
              onClick={() => setShowBridgeConfig((v) => !v)}
            >
              <span className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Server className="size-3.5" />
                URL do servidor WhatsApp
              </span>
              <span className="text-[11px] text-muted-foreground/70">
                {bridgeSourceLabel()}
                {getBridgeOverride() && " •"}
              </span>
            </button>
            {showBridgeConfig && (
              <div className="mt-3 space-y-2">
                <p className="text-[11px] text-muted-foreground/70">
                  Se o WhatsApp roda num servidor seu (PC sempre ligado, VPS), cole aqui a URL
                  HTTPS exposta por ele (ex.: <code className="bg-muted border border-border/60 rounded px-1 font-mono text-[10px]">https://xxxx.trycloudflare.com</code>).
                  Fica salvo apenas neste navegador.
                </p>
                <Input
                  placeholder="https://seu-servidor-whatsapp.com"
                  value={bridgeUrl}
                  onChange={(e) => setBridgeUrl(e.target.value)}
                  className="text-sm font-mono"
                />
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveBridgeUrl}>
                    <Save className="size-3.5" />
                    Salvar
                  </Button>
                  {getBridgeOverride() && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        setBridgeUrl("");
                        await handleSaveBridgeUrl();
                      }}
                    >
                      Remover
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
          <div className="rounded-lg bg-muted/50 border border-border/40 px-4 py-3">
            <p className="text-xs text-muted-foreground font-medium mb-2">Como funciona:</p>
            <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
              <li>O servidor WhatsApp inicia junto com o aplicativo</li>
              <li>Escaneie o QR Code exibido acima</li>
              <li>As notificações serão enviadas automaticamente</li>
            </ol>
            <div className="flex flex-col gap-2 mt-3">
              <Button size="sm" onClick={handleStartServer} className="gap-1.5">
                <Play className="size-3.5" />
                Abrir console do servidor
              </Button>
              <div className="flex items-center justify-between gap-2 flex-wrap rounded-md border border-border/60 bg-background px-3 py-2">
                <span className="text-[11px] text-muted-foreground">
                  Envio de mensagens:{" "}
                  <span
                    className={
                      paused
                        ? "font-semibold text-amber-600 dark:text-amber-400"
                        : "font-semibold text-emerald-600 dark:text-emerald-400"
                    }
                  >
                    {paused ? "pausado" : "ativo"}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant={paused ? "default" : "outline"}
                  onClick={handleTogglePause}
                  disabled={togglingPause || serverOnline === false}
                >
                  {paused ? (
                    <Play className="size-3.5" />
                  ) : (
                    <Pause className="size-3.5" />
                  )}
                  {togglingPause
                    ? "Aguarde..."
                    : paused
                      ? "Retomar envios"
                      : "Pausar envios"}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground/60">
                Pausar mantém o WhatsApp conectado: os chamados deixam de notificar
                pelo WhatsApp até você retomar (e-mail e avisos no app continuam
                normais). O console acima mostra status, QR Code e logs do servidor.
              </p>
            </div>
          </div>
          {status === "connected" && (
            <div className="space-y-2 rounded-lg border border-border/40 bg-muted/30 px-4 py-3">
              <p className="text-xs font-medium text-muted-foreground">Testar envio</p>
              <div className="flex gap-2">
                <Input placeholder="Número: 5591999999999" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} className="flex-1 text-sm" />
                <Button
                  size="sm"
                  onClick={handleTestSend}
                  disabled={testSending || !testPhone.trim() || paused}
                  title={paused ? "Retome os envios para testar" : undefined}
                >
                  {testSending ? "Enviando..." : "Testar"}
                </Button>
              </div>
            </div>
          )}
        </div>
        <DialogFooter className="sticky bottom-0 z-10 -mb-4 sm:-mb-6 rounded-b-lg border-t border-border/40 bg-background pt-2">
          {status === "connected" ? (
            <Button variant="destructive" onClick={handleLogout} disabled={loading} className="w-full sm:w-auto">
              {loading ? "Desconectando..." : "Desconectar"}
            </Button>
          ) : (
            <Button onClick={() => { refreshStatus(); refreshQR(); }} disabled={loading} className="w-full sm:w-auto">
              {loading ? "Verificando..." : "Atualizar"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
