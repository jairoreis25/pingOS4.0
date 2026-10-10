/**
 * Carregador de variáveis de ambiente do backend MySQL.
 *
 * O Bun já carrega automaticamente `.env` / `.env.local`, mas o backend
 * paralelo tem o seu próprio arquivo (`mysql-api.env`, ver o .example) e
 * precisa funcionar também sob Node (sem dotenv instalado). Este loader lê o
 * arquivo de forma simples e NÃO sobrescreve variáveis já definidas no
 * ambiente (o ambiente sempre tem prioridade).
 *
 * Ordem de procura:
 *   1. $MYSQL_ENV_FILE  (caminho explícito)
 *   2. ./mysql-api.env  (raiz do projeto, ao lado do package.json)
 *   3. ./server/mysql-api.env
 */

import fs from "node:fs";
import path from "node:path";

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Remove aspas simples/duplas envolventes
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

let loaded = false;

/** Carrega o arquivo de env do backend MySQL (idempotente). */
export function loadEnvFile(): { file: string | null; applied: number } {
  if (loaded) return { file: null, applied: 0 };
  loaded = true;

  const candidates = [
    process.env.MYSQL_ENV_FILE,
    path.resolve(process.cwd(), "mysql-api.env"),
    path.resolve(process.cwd(), "server/mysql-api.env"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const file of candidates) {
    let content: string;
    try {
      if (!fs.existsSync(file)) continue;
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const parsed = parseEnvFile(content);
    let applied = 0;
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
        applied += 1;
      }
    }
    return { file, applied };
  }

  return { file: null, applied: 0 };
}
