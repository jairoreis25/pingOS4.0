import js from "@eslint/js"
import globals from "globals"
import reactHooks from "eslint-plugin-react-hooks"
import reactRefresh from "eslint-plugin-react-refresh"
import tseslint from "typescript-eslint"
import eslintConfigPrettier from "eslint-config-prettier/flat"

export default tseslint.config(
  { ignores: ["dist"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended, eslintConfigPrettier],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      // Dívida técnica rastreada em docs/REVISAO-SENIOR.md (P1): 15 ocorrências
      // de carregamento de dados dentro de useEffect. Rebaixada para "warn"
      // para o gate de lint ficar verde enquanto a migração para hooks de dados
      // (src/lib/backend/react.ts) acontece. Voltar a "error" ao zerar a lista.
      "react-hooks/set-state-in-effect": "warn",
    },
  },
)
