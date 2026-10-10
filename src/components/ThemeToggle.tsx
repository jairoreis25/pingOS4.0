/**
 * Seletor de tema: Claro · Escuro · Sistema.
 *
 * O `ThemeProvider` (next-themes, em `main.tsx`) aplica a classe `dark` no
 * `<html>`, que é exatamente o que `src/index.css` espera (`@custom-variant dark
 * (&:is(.dark *))`). A escolha fica salva em `localStorage` sob
 * `pingos-theme`, então sobrevive a recarregar a página e a novos deploys.
 *
 * "Sistema" acompanha o tema do sistema operacional — inclusive quando o
 * usuário troca o tema com a aba aberta.
 */
import { useEffect, useState } from "react"
import { useTheme } from "next-themes"
import { Check, Monitor, Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

const THEME_OPTIONS = [
  { value: "light", label: "Claro", icon: Sun },
  { value: "dark", label: "Escuro", icon: Moon },
  { value: "system", label: "Sistema", icon: Monitor },
] as const

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, resolvedTheme, setTheme } = useTheme()
  // O tema real só é conhecido depois de montar (o HTML chega sem a classe);
  // até lá o ícone fica neutro para não piscar o sol no escuro.
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])

  const isDark = mounted && resolvedTheme === "dark"
  const Icon = !mounted ? Monitor : isDark ? Moon : Sun
  const currentLabel = THEME_OPTIONS.find((o) => o.value === theme)?.label ?? "Sistema"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-8", className)}
          title={`Tema: ${currentLabel}`}
          aria-label="Alterar tema (claro, escuro ou sistema)"
        >
          <Icon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Aparência
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {THEME_OPTIONS.map((option) => {
          const OptionIcon = option.icon
          return (
            <DropdownMenuItem
              key={option.value}
              onClick={() => setTheme(option.value)}
              className="cursor-pointer gap-2"
            >
              <OptionIcon className="size-4 text-muted-foreground" />
              {option.label}
              {mounted && theme === option.value && (
                <Check className="ml-auto size-3.5 text-primary" />
              )}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default ThemeToggle
