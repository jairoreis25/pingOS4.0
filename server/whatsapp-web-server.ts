/**
 * WhatsApp Web Bridge Server (Baileys)
 * 
 * Uses @whiskeysockets/baileys - pure JavaScript, no Chrome/Puppeteer needed.
 * Run: bun run server/whatsapp-web-server.ts  (port: $PORT or 3001)
 *
 * ── Deploying it as your always-on server ──────────────────────────────────
 * The published app (jairoreis.freebuff.app) is static hosting and cannot run
 * this process. For WhatsApp notifications to work there, keep this server
 * running 24/7 on a machine you control (PC, VPS, Raspberry Pi...) and expose
 * it over HTTPS, e.g.:
 *   cloudflared tunnel --url http://localhost:3001
 * or a VPS reverse proxy (nginx/caddy) with a TLS certificate.
 * Then set the project env var VITE_WHATSAPP_WEB_URL to that https:// URL —
 * every client call (QR Code, status, send) will go to your server.
 * CORS is open so any origin can call it.
 *
 * Endpoints:
 * - GET /qr       — Returns QR code as data URL (for scanning)
 * - GET /status   — Connection status + phone info (+ `paused`)
 * - POST /send    — Send a message to a phone number
 * - POST /pause   — Stop sending messages (keeps the WhatsApp session connected)
 * - POST /resume  — Resume sending messages
 * - POST /logout  — Disconnect and clear session
 */

import express from "express";
import cors from "cors";
import fs from "fs";
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidUser,
} from "@whiskeysockets/baileys";
import path from "path";
import pino from "pino";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = Number(process.env.PORT) || 3001;
// Session directory is configurable (Docker mounts a volume at
// /data/whatsapp-session); defaults to ./whatsapp-session for local runs.
const SESSION_DIR = process.env.SESSION_DIR || path.join(process.cwd(), "whatsapp-session");

// ── Log capture (for the web console page) ───────────────────────────────────
const logBuffer: string[] = [];
const MAX_LOG_LINES = 300;
const origLog = console.log.bind(console);
function captureLog(...args: unknown[]) {
  const line = args
    .map((a) => {
      if (typeof a === "string") return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
  logBuffer.push(`[${new Date().toLocaleTimeString("pt-BR")}] ${line}`);
  if (logBuffer.length > MAX_LOG_LINES) {
    logBuffer.splice(0, logBuffer.length - MAX_LOG_LINES);
  }
  origLog(...args);
}
console.log = captureLog;

// ── State ──────────────────────────────────────────────────────────────────────
let sock: ReturnType<typeof makeWASocket> | null = null;
let connectionStatus = "disconnected";
let qrCodeDataUrl: string | null = null;
let phoneInfo: { phone?: string; name?: string } = {};
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// ── Envio pausado (Configurações → WhatsApp Web no painel do PingOS) ─────────
// Pausar NÃO desconecta o WhatsApp: a sessão pareada continua ativa e os
// envios apenas param. O estado fica salvo dentro da pasta da sessão (o volume
// do Docker), então sobrevive a reinícios do container — só um logout explícito
// (que limpa a sessão inteira) volta ao estado "ativo".
const PAUSE_FILE = path.join(SESSION_DIR, "pingos-paused.json");
let sendingPaused = false;

function loadPauseState() {
  try {
    if (!fs.existsSync(PAUSE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(PAUSE_FILE, "utf8")) as { paused?: boolean };
    sendingPaused = raw.paused === true;
    console.log(`Estado de envio carregado: ${sendingPaused ? "pausado" : "ativo"}`);
  } catch (error) {
    console.warn("Não deu para ler o estado de pausa:", error);
  }
}

function savePauseState() {
  try {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(
      PAUSE_FILE,
      JSON.stringify({ paused: sendingPaused, at: Date.now() }, null, 2),
    );
  } catch (error) {
    console.warn("Não deu para salvar o estado de pausa:", error);
  }
}

loadPauseState();

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatPhone(phone: string): string {
  let digits = phone.replace(/\D/g, "");
  // Auto-add Brazil country code if missing
  if (!digits.startsWith("55")) {
    digits = "55" + digits;
  }
  // Remove the mobile "9" prefix (3rd digit after country code) if present
  // e.g. 5594991112740 → 559491112740 (13→12 digits)
  if (digits.length === 13 && digits[4] === "9") {
    digits = digits.slice(0, 4) + digits.slice(5);
  }
  return digits + "@s.whatsapp.net";
}

// ── Connect ────────────────────────────────────────────────────────────────────
async function startSock() {
  // Prevent multiple simultaneous connections
  if (sock) {
    try { sock.end(undefined); } catch {}
    sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
    },
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  // ── Connection update ──────────────────────────────────────────────────────
  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      const QRCode = await import("qrcode");
      qrCodeDataUrl = await QRCode.toDataURL(qr, {
        width: 300,
        margin: 2,
      });
      connectionStatus = "waiting_for_qr";
      reconnectAttempts = 0;
      console.log("QR Code generated — scan with WhatsApp");
      // Also print an ASCII QR directly in the terminal, so it can be scanned
      // even without opening the browser page (PowerShell / Windows Terminal).
      try {
        const ascii = await QRCode.toString(qr, {
          type: "terminal",
          small: true,
        });
        console.log(ascii);
      } catch {}
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`Connection closed. Status: ${statusCode}. Reconnect: ${shouldReconnect}`);

      qrCodeDataUrl = null;

      if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        connectionStatus = "reconnecting";
        console.log(`Reconnecting... (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);

        // Wait before reconnecting
        await new Promise((r) => setTimeout(r, 2000 * reconnectAttempts));
        startSock();
      } else {
        // Max retries reached or logged out — clear session and reset
        connectionStatus = "disconnected";
        phoneInfo = {};
        reconnectAttempts = 0;

        // Clear invalid session files so a new QR can be generated
        try {
          const fs = await import("fs");
          if (fs.existsSync(SESSION_DIR)) {
            fs.rmSync(SESSION_DIR, { recursive: true, force: true });
            console.log("Session cleared — will generate new QR on next connection");
          }
        } catch {}

        // Auto-start a fresh connection so a new QR code is generated,
        // including after a logout (e.g. user disconnected from the phone)
        console.log("Starting fresh connection for new QR code...");
        setTimeout(() => {
          connectionStatus = "disconnected";
          startSock();
        }, 1000);
      }
    }

    if (connection === "open") {
      connectionStatus = "connected";
      qrCodeDataUrl = null;
      reconnectAttempts = 0;

      const me = sock?.user;
      if (me) {
        phoneInfo = {
          phone: me.id?.replace(/:.*@/, "@").split("@")[0],
          name: me.name,
        };
      }
      console.log(`Connected as ${phoneInfo.name} (${phoneInfo.phone})`);
    }
  });

  // ── Save credentials on update ────────────────────────────────────────────
  sock.ev.on("creds.update", saveCreds);

  // ── Log incoming messages (optional) ──────────────────────────────────────
  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.message) {
        const from = msg.key.remoteJid;
        const body =
          msg.message.conversation || msg.message.extendedTextMessage?.text || "";
        if (body) {
          console.log(`📩 ${from}: ${body.slice(0, 80)}`);
        }
      }
    }
  });

  // ── Log delivery receipts ─────────────────────────────────────────────────
  sock.ev.on("messages.update", (messages) => {
    for (const msg of messages) {
      if (msg.update?.status) {
        const statusMap: Record<number, string> = {
          0: "ERROR",
          1: "PENDING",
          2: "SERVER_ACK",
          3: "DELIVERY_ACK",
          4: "READ",
          5: "PLAYED",
          6: "COMPOSED",
        };
        const statusName = statusMap[msg.update.status] || `UNKNOWN(${msg.update.status})`;
        console.log(`📨 Message ${msg.key?.id?.slice(0, 8)}... → ${statusName}`);
      }
    }
  });
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// QR Code
app.get("/qr", async (_req, res) => {
  if (connectionStatus === "connected") {
    return res.json({ status: "connected", qr: null, paused: sendingPaused });
  }
  if (qrCodeDataUrl) {
    return res.json({ status: connectionStatus, qr: qrCodeDataUrl, paused: sendingPaused });
  }
  return res.json({ status: connectionStatus, qr: null, paused: sendingPaused });
});

// Status
app.get("/status", (_req, res) => {
  res.json({ status: connectionStatus, info: phoneInfo, paused: sendingPaused });
});

// Pausar os envios (mantém a conexão e o pareamento intactos)
app.post("/pause", (_req, res) => {
  sendingPaused = true;
  savePauseState();
  console.log("⏸️  Envio de mensagens pausado pelo painel");
  res.json({ success: true, paused: true });
});

// Retomar os envios
app.post("/resume", (_req, res) => {
  sendingPaused = false;
  savePauseState();
  console.log("▶️  Envio de mensagens retomado pelo painel");
  res.json({ success: true, paused: false });
});

// Send message
app.post("/send", async (req, res) => {
  const { phone, message, image } = req.body;

  console.log(`\n📤 POST /send received — phone: ${phone}`);
  console.log(`   Message preview: ${message?.slice(0, 100)}...`);
  console.log(`   Has image: ${!!image}`);

  if (!phone || !message) {
    console.error("   ❌ Missing phone or message");
    return res
      .status(400)
      .json({ error: "phone and message are required" });
  }

  if (sendingPaused) {
    console.log("   ⏸️  Envio pausado no painel — mensagem ignorada");
    return res.status(409).json({
      error: "Envio de mensagens pausado no painel do PingOS",
      paused: true,
    });
  }

  if (!sock || connectionStatus !== "connected") {
    console.error(`   ❌ WhatsApp not connected (status: ${connectionStatus})`);
    return res.status(503).json({ error: "WhatsApp not connected" });
  }

  try {
    const jid = formatPhone(phone);
    const number = jid.replace("@s.whatsapp.net", "");
    console.log(`   Normalized JID: ${jid}`);

    const [check] = await sock.onWhatsApp(jid);
    if (!check?.exists) {
      console.error(`   ❌ Phone ${phone} (normalized: ${number}) is not on WhatsApp`);
      return res.status(400).json({ error: "Phone number is not on WhatsApp" });
    }

    // Keep as-is if valid

    console.log(`   Sending to JID: ${jid}`);

    let result;
    if (image) {
      // Convert base64 data URL to Buffer
      let imageBuffer: Buffer;
      if (image.startsWith("data:")) {
        const base64 = image.split(",")[1];
        imageBuffer = Buffer.from(base64, "base64");
      } else {
        imageBuffer = Buffer.from(image, "base64");
      }
      console.log(`   📷 Sending image (${imageBuffer.length} bytes) with caption...`);
      result = await sock.sendMessage(jid, { image: imageBuffer, caption: message });
    } else {
      result = await sock.sendMessage(jid, { text: message });
    }
    console.log(`   ✅ Message sent! Key ID: ${result?.key?.id}`);
    console.log(`   Delivery status will appear in logs shortly.`);
    res.json({ success: true, message: "Message sent", jid, keyId: result?.key?.id });
  } catch (error) {
    console.error(`   ❌ Send error:`, error);
    res.status(500).json({
      error: "Failed to send message",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Logout
app.post("/logout", async (_req, res) => {
  try {
    if (sock) {
      await sock.logout();
      sock = null;
    }
    connectionStatus = "disconnected";
    qrCodeDataUrl = null;
    phoneInfo = {};
    reconnectAttempts = 0;

    // Clear session files
    const fs = await import("fs");
    if (fs.existsSync(SESSION_DIR)) {
      fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    }

    console.log("Logged out and session cleared");
    res.json({ success: true, message: "Logged out" });
  } catch (error) {
    res.status(500).json({
      error: "Logout failed",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// ── Web console page ───────────────────────────────────────────────────────────
const PANEL_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PingOS — Servidor WhatsApp</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0f1216;
    color: #e5e7eb;
  }
  .topbar {
    display: flex; align-items: center; gap: 12px;
    padding: 14px 20px;
    background: #161a20;
    border-bottom: 1px solid #262c35;
    position: sticky; top: 0; z-index: 10;
  }
  .logo { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 15px; }
  .logo .dot { width: 10px; height: 10px; border-radius: 999px; background: #25d366; box-shadow: 0 0 10px rgba(37, 211, 102, 0.4); }
  .status-pill {
    margin-left: auto; display: inline-flex; align-items: center; gap: 8px;
    padding: 5px 12px; border-radius: 999px; font-size: 12px; font-weight: 600;
    border: 1px solid #262c35; background: #1a1f26;
  }
  .status-pill .dot { width: 8px; height: 8px; border-radius: 999px; background: #6b7280; }
  .status-pill.connected .dot { background: #22c55e; box-shadow: 0 0 8px rgba(34, 197, 94, 0.5); }
  .status-pill.waiting_for_qr .dot { background: #f59e0b; box-shadow: 0 0 8px rgba(245, 158, 11, 0.5); }
  .status-pill.disconnected .dot, .status-pill.error .dot, .status-pill.auth_failure .dot, .status-pill.offline .dot { background: #ef4444; box-shadow: 0 0 8px rgba(239, 68, 68, 0.5); }
  .status-pill.reconnecting .dot, .status-pill.authenticated .dot { background: #3b82f6; box-shadow: 0 0 8px rgba(59, 130, 246, 0.5); }
  .status-pill.paused .dot { background: #f59e0b; box-shadow: 0 0 8px rgba(245, 158, 11, 0.5); }
  main { display: grid; grid-template-columns: 340px 1fr; gap: 16px; padding: 16px 20px; max-width: 1200px; margin: 0 auto; }
  @media (max-width: 860px) { main { grid-template-columns: 1fr; } }
  .card { background: #161a20; border: 1px solid #262c35; border-radius: 12px; padding: 16px; }
  .card h2 { margin: 0 0 12px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #9ca3af; }
  .qr-box { display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .qr-box img { width: 260px; height: 260px; border-radius: 8px; background: #fff; padding: 8px; }
  .qr-placeholder {
    width: 260px; height: 260px; border-radius: 8px; border: 1px dashed #333b47;
    display: flex; align-items: center; justify-content: center; color: #6b7280;
    font-size: 13px; text-align: center; padding: 16px;
  }
  .btn {
    border: 1px solid #2c333d; background: #1f242c; color: #e5e7eb;
    padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer;
  }
  .btn:hover { background: #272e38; }
  .btn.green { background: #128c4b; border-color: #128c4b; color: #fff; }
  .btn.green:hover { background: #0f7a41; }
  .btn.red { background: transparent; border-color: #7f1d1d; color: #f87171; }
  .btn.red:hover { background: #2a1518; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
  .meta { font-size: 13px; color: #9ca3af; margin: 4px 0; }
  .meta b { color: #e5e7eb; font-weight: 600; }
  .err {
    display: none; margin: 10px 0; padding: 10px 12px; border-radius: 8px;
    font-size: 12px; line-height: 1.5; background: #2a1518;
    border: 1px solid #7f1d1d; color: #fca5a5;
  }
  #logs {
    background: #0b0e12; border: 1px solid #1f242c; border-radius: 8px;
    padding: 12px; height: 420px; overflow-y: auto;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word;
  }
  #logs .muted { color: #6b7280; }
  .hint { font-size: 12px; color: #9ca3af; margin-top: 10px; }
  .hint b { color: #d1d5db; }
</style>
</head>
<body>
  <div class="topbar">
    <div class="logo"><span class="dot"></span> PingOS — Servidor WhatsApp</div>
    <span class="status-pill" id="statusPill"><span class="dot"></span><span id="statusLabel">Verificando...</span></span>
  </div>
  <main>
    <div>
      <div class="card">
        <h2>Conexão</h2>
        <div id="phoneInfo" class="meta">Nenhum aparelho conectado</div>
        <div class="err" id="connErr"></div>
        <div class="qr-box">
          <img id="qrImg" alt="QR Code" style="display:none" />
          <div class="qr-placeholder" id="qrPlaceholder">Aguardando QR Code...</div>
        </div>
        <div class="actions">
          <button class="btn green" id="btnQr">Gerar novo QR</button>
          <button class="btn red" id="btnLogout">Desconectar</button>
        </div>
        <div class="hint">Em Docker/Dokploy, reinicie o container <b>whatsapp</b>. Rodando local: <b>bun run whatsapp</b> (porta 3001).</div>
      </div>
    </div>
    <div class="card">
      <h2>Console do servidor</h2>
      <div id="logs"><span class="muted">Conectando ao servidor...</span></div>
    </div>
  </main>
<script>
(function () {
  var pill = document.getElementById("statusPill");
  var label = document.getElementById("statusLabel");
  var qrImg = document.getElementById("qrImg");
  var qrPh = document.getElementById("qrPlaceholder");
  var logsEl = document.getElementById("logs");
  var phoneInfo = document.getElementById("phoneInfo");
  var connErr = document.getElementById("connErr");
  var statusLabels = {
    connected: "Conectado",
    waiting_for_qr: "Aguardando QR Code",
    authenticated: "Autenticando...",
    disconnected: "Desconectado",
    reconnecting: "Reconectando...",
    auth_failure: "Falha na autenticação",
    error: "Erro",
    paused: "Envios pausados",
    offline: "Servidor offline"
  };
  function setStatus(status) {
    pill.className = "status-pill " + (status || "disconnected");
    label.textContent = statusLabels[status] || status || "Desconhecido";
  }
  function setError(msg) {
    if (msg) {
      connErr.textContent = msg;
      connErr.style.display = "block";
    } else {
      connErr.style.display = "none";
    }
  }
  // Surface any runtime/parse error instead of leaving the page stuck on
  // "Verificando..."/"Conectando ao servidor...".
  window.addEventListener("error", function (ev) {
    var msg = "Erro na página: " + (ev.message || "desconhecido");
    setError(msg);
    try {
      logsEl.textContent = msg + "\nPressione F5 para recarregar a página.";
    } catch (_) {}
  });
  function renderLogs(logs) {
    if (!logs || !logs.length) {
      logsEl.innerHTML = '<span class="muted">Sem logs ainda...</span>';
      return;
    }
    logsEl.textContent = logs.join("\n");
    logsEl.scrollTop = logsEl.scrollHeight;
  }
  function fetchJSON(url, opts) {
    opts = opts || {};
    var ctrl = new AbortController();
    var t = setTimeout(function () { ctrl.abort(); }, opts.timeoutMs || 5000);
    return fetch(url, {
      method: opts.method || "GET",
      body: opts.body,
      signal: ctrl.signal
    })
      .then(function (r) { return r.json(); })
      .then(function (d) { clearTimeout(t); return d; })
      .catch(function (e) { clearTimeout(t); throw e; });
  }
  function pollStatus() {
    fetchJSON("/status", { timeoutMs: 4000 })
      .then(function (d) {
        setError("");
        setStatus(d.paused ? "paused" : d.status);
        if (d.info && d.info.phone) {
          phoneInfo.innerHTML = "Conectado como <b>" + (d.info.name || "") + "</b> (" + d.info.phone + ")";
        } else {
          phoneInfo.textContent = "Nenhum aparelho conectado";
        }
        if (d.status === "connected") {
          qrImg.style.display = "none";
          qrPh.style.display = "flex";
          qrPh.textContent = "WhatsApp conectado ✓";
        }
      })
      .catch(function () {
        setStatus("offline");
        setError("Sem resposta do servidor. Abra esta página no MESMO computador em que o servidor roda (http://localhost:3001) e confirme que o comando \"bun run whatsapp\" continua ativo no terminal.");
        logsEl.innerHTML = '<span class="muted">Servidor sem resposta — confira se o processo está rodando (bun run whatsapp).</span>';
      });
  }
  function pollQR() {
    fetchJSON("/qr", { timeoutMs: 4000 })
      .then(function (d) {
        if (d.qr) {
          qrImg.src = d.qr;
          qrImg.style.display = "block";
          qrPh.style.display = "none";
        } else {
          qrImg.style.display = "none";
          qrPh.style.display = "flex";
          if (d.status === "connected") qrPh.textContent = "WhatsApp conectado ✓";
          else qrPh.textContent = "Aguardando QR Code...";
        }
        if (d.status) setStatus(d.paused ? "paused" : d.status);
      })
      .catch(function () {});
  }
  function pollLogs() {
    fetchJSON("/logs", { timeoutMs: 4000 })
      .then(function (d) {
        renderLogs(d.logs);
      })
      .catch(function () {
        logsEl.innerHTML = '<span class="muted">Servidor sem resposta — confira se o processo está rodando (bun run whatsapp).</span>';
      });
  }
  document.getElementById("btnQr").addEventListener("click", function () {
    setError("Gerando novo QR Code...");
    fetchJSON("/reconnect", { method: "POST", timeoutMs: 6000 })
      .then(function () { pollStatus(); pollQR(); })
      .catch(function () {
        setError("Não foi possível gerar um novo QR — servidor sem resposta.");
      });
  });
  document.getElementById("btnLogout").addEventListener("click", function () {
    if (!confirm("Desconectar o WhatsApp e limpar a sessão?")) return;
    fetchJSON("/logout", { method: "POST", timeoutMs: 6000 })
      .then(function () { pollStatus(); pollQR(); })
      .catch(function () {
        setError("Não foi possível desconectar — servidor sem resposta.");
      });
  });
  try {
    pollStatus(); pollQR(); pollLogs();
    setInterval(pollStatus, 2500);
    setInterval(pollQR, 2500);
    setInterval(pollLogs, 2500);
  } catch (err) {
    setError("Erro ao iniciar a página: " + (err && err.message ? err.message : String(err)));
  }
})();
</script>
</body>
</html>`;

// Web console page (also served at / so the server root is viewable)
app.get(["/", "/panel"], (_req, res) => {
  // Never cache: the page embeds the polling script and must always be fresh
  // (a stale cached copy is what makes it look stuck on "Verificando...").
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.type("html").send(PANEL_HTML);
});

// Recent server logs (for the web console page)
app.get("/logs", (_req, res) => {
  res.json({ logs: logBuffer.slice(-200) });
});

// Force a fresh connection (generates a new QR code)
app.post("/reconnect", async (_req, res) => {
  try {
    await startSock();
    res.json({ success: true, status: connectionStatus });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 WhatsApp Web Bridge running on http://localhost:${PORT}`);
  console.log(`   GET  /            — Web console (status, QR Code, logs)`);
  console.log(`   GET  /qr          — QR Code`);
  console.log(`   GET  /status      — Connection status`);
  console.log(`   GET  /logs        — Recent server logs`);
  console.log(`   POST /send        — Send message`);
  console.log(`   POST /reconnect   — Generate new QR Code`);
  console.log(`   POST /logout      — Disconnect\n`);
  startSock().catch(console.error);
});
