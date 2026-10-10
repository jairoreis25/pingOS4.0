import { motion, type Variants } from "framer-motion";
import {
  ArrowRight,
  Columns3,
  Headphones,
  Shield,
  Zap,
  CheckCircle2,
} from "lucide-react";
import { useNavigate } from "react-router";
import { ThemeToggle } from "@/components/ThemeToggle";

const features = [
  {
    icon: Columns3,
    title: "Kanban Visual",
    description:
      "Arraste e solte chamados entre colunas. Visualize todo o fluxo de trabalho de uma vez.",
  },
  {
    icon: Zap,
    title: "Rápido e Intuitivo",
    description:
      "Abra chamados em segundos. Interface limpa que não atrapalha seu trabalho.",
  },
  {
    icon: Shield,
    title: "Controle Total",
    description:
      "Defina prioridades, atribua responsáveis e acompanhe cada etapa do atendimento.",
  },
  {
    icon: Headphones,
    title: "Para Clientes e TI",
    description:
      "Clientes abrem chamados diretamente. A equipe de TI gerencia tudo em um só lugar.",
  },
];

const steps = [
  {
    num: "01",
    title: "Abra um chamado",
    description: "Descreva o problema com título, detalhes e prioridade.",
  },
  {
    num: "02",
    title: "Acompanhe no Kanban",
    description: "Mova entre Aberto → Em Andamento → Aguardando → Resolvido.",
  },
  {
    num: "03",
    title: "Resolva e feche",
    description: "Marque como resolvido quando o problema for atendido.",
  },
];

const kanbanColumns = [
  {
    label: "Aberto",
    count: 2,
    dot: "bg-blue-500",
    cards: [
      { t: "Impressora não imprime", p: "alta", n: "Ana Souza" },
      { t: "Instalar Office 365", p: "media", n: "Carlos Lima" },
    ],
  },
  {
    label: "Em Andamento",
    count: 3,
    dot: "bg-amber-500",
    cards: [
      { t: "Trocar monitor", p: "alta", n: "Marcos Alves" },
      { t: "Configurar VPN", p: "critica", n: "Julia Castro" },
      { t: "Backup de dados", p: "baixa", n: "Pedro Nunes" },
    ],
  },
  {
    label: "Aguardando",
    count: 1,
    dot: "bg-purple-500",
    cards: [{ t: "Aguardando senha", p: "media", n: "Rafael Dias" }],
  },
  {
    label: "Resolvido",
    count: 1,
    dot: "bg-emerald-500",
    cards: [{ t: "Reinstalar Windows", p: "baixa", n: "Beatriz Rocha" }],
  },
];

// Pills suaves idênticas às dos cards reais do Kanban (ver ticket-ui.ts).
const priorityPillClass: Record<string, string> = {
  critica: "bg-red-50 text-red-600 dark:bg-red-950/50 dark:text-red-400",
  alta: "bg-orange-50 text-orange-600 dark:bg-orange-950/50 dark:text-orange-400",
  media: "bg-amber-50 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400",
  baixa: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/50 dark:text-emerald-400",
};

const priorityLabel: Record<string, string> = {
  critica: "Crítica",
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

function getInitials(name: string) {
  return name
    .split(" ")
    .map((n) => n[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08 } },
};

const item: Variants = {
  hidden: { opacity: 0, y: 20 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.5, ease: "easeOut" as const },
  },
};

export default function Landing() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Nav */}
      <header className="fixed inset-x-0 top-0 z-50 border-b border-border/40 bg-background/70 backdrop-blur-xl">
        <div className="mx-auto flex h-14 sm:h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div className="flex items-center gap-2 sm:gap-2.5">
            <div className="flex size-7 sm:size-8 items-center justify-center rounded-lg bg-primary">
              <Headphones className="size-3.5 sm:size-4 text-primary-foreground" />
            </div>
            <span className="text-base sm:text-lg font-semibold tracking-tight">
              PingOS
            </span>
          </div>
          <nav className="flex items-center gap-1.5 sm:gap-2">
            <ThemeToggle />
            <button
              onClick={() => navigate("/chamado/novo")}
              className="rounded-lg px-3 sm:px-4 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Abrir chamado
            </button>
            <button
              onClick={() => navigate("/auth")}
              className="rounded-lg bg-primary px-4 sm:px-5 py-1.5 sm:py-2 text-xs sm:text-sm font-medium text-primary-foreground transition-all hover:shadow-lg hover:shadow-primary/20"
            >
              Entrar
            </button>
          </nav>
        </div>
      </header>

      {/* Hero */}
      <section className="relative pt-24 sm:pt-32 pb-16 sm:pb-24 overflow-hidden">
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-0 left-1/2 -translate-x-1/2 h-[700px] w-[1000px] rounded-full bg-primary/[0.04] blur-3xl" />
          <div className="absolute top-20 right-0 h-[400px] w-[400px] rounded-full bg-primary/[0.03] blur-3xl" />
        </div>
        <div className="mx-auto max-w-6xl px-6">
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            className="max-w-3xl"
          >
            <div className="inline-flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 mb-6 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300">
              <span className="size-1.5 rounded-full bg-primary animate-pulse" />
              Sistema de chamados para equipes de TI
            </div>
            <h1 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight leading-[1.1]">
              Gerencie chamados de forma{" "}
              <span className="text-primary">simples</span>
            </h1>
            <p className="mt-6 text-lg text-muted-foreground max-w-xl leading-relaxed">
              Abra, acompanhe e resolva chamados de TI com um painel Kanban
              visual. Seus clientes abrem chamados — você gerencia tudo.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                onClick={() => navigate("/auth")}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-6 py-3 text-sm font-semibold text-primary-foreground transition-all hover:bg-primary/90 hover:shadow-lg hover:shadow-primary/20"
              >
                Começar agora
                <ArrowRight className="size-4" />
              </button>

            </div>
          </motion.div>

          {/* Kanban Preview */}
          <motion.div
            initial={{ opacity: 0, y: 40 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, delay: 0.2 }}
            className="mt-14 sm:mt-20 rounded-2xl border border-border bg-card p-4 sm:p-6 shadow-2xl shadow-slate-900/10 dark:shadow-black/40"
          >
            <div className="flex items-center gap-2 mb-4 sm:mb-6">
              <div className="size-2 sm:size-2.5 rounded-full bg-red-400" />
              <div className="size-2 sm:size-2.5 rounded-full bg-yellow-400" />
              <div className="size-2 sm:size-2.5 rounded-full bg-emerald-400" />
              <span className="ml-2 text-[10px] sm:text-xs text-muted-foreground font-medium">Kanban Board</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              {kanbanColumns.map((col) => (
                <div
                  key={col.label}
                  className="rounded-xl bg-muted/50 p-3 sm:p-3.5"
                >
                  <div className="flex items-center gap-2 mb-3">
                    <span className={`size-1.5 shrink-0 rounded-full ${col.dot}`} />
                    <span className="text-xs font-semibold text-foreground">
                      {col.label}
                    </span>
                    <span className="text-xs font-medium text-muted-foreground tabular-nums">
                      {col.count}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {col.cards.map((card, i) => (
                      <div
                        key={i}
                        className="rounded-lg border border-border bg-card p-3 shadow-sm transition-colors hover:border-blue-200 dark:hover:border-blue-900/60"
                      >
                        <div className="flex items-center gap-2">
                          <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[8px] font-semibold text-muted-foreground">
                            {getInitials(card.n)}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                            {card.n}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs font-semibold leading-snug">
                          {card.t}
                        </p>
                        <div className="mt-2">
                          <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${priorityPillClass[card.p]}`}>
                            {priorityLabel[card.p]}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </section>

      {/* Features */}
      <section className="py-24 border-t border-border/40">
        <div className="mx-auto max-w-6xl px-6">
          <motion.div
            variants={container}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-100px" }}
            className="text-center mb-16"
          >
            <motion.p variants={item} className="text-xs font-semibold text-primary uppercase tracking-widest mb-3">
              Funcionalidades
            </motion.p>
            <motion.h2 variants={item} className="text-3xl sm:text-4xl font-bold tracking-tight">
              Tudo que sua equipe precisa
            </motion.h2>
            <motion.p variants={item} className="mt-4 text-muted-foreground max-w-lg mx-auto">
              Ferramentas pensadas para equipes de TI que precisam organizar chamados sem complicação.
            </motion.p>
          </motion.div>
          <motion.div
            variants={container}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-100px" }}
            className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4"
          >
            {features.map((f) => (
              <motion.div
                key={f.title}
                variants={item}
                className="group rounded-2xl border border-border/50 bg-card p-6 transition-all hover:border-primary/20 hover:shadow-lg hover:shadow-primary/[0.04]"
              >
                <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                  <f.icon className="size-5" />
                </div>
                <h3 className="font-semibold mb-2">{f.title}</h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {f.description}
                </p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-24 border-t border-border/40 bg-muted/30">
        <div className="mx-auto max-w-6xl px-6">
          <motion.div
            variants={container}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-100px" }}
            className="text-center mb-16"
          >
            <motion.p variants={item} className="text-xs font-semibold text-primary uppercase tracking-widest mb-3">
              Como funciona
            </motion.p>
            <motion.h2 variants={item} className="text-3xl sm:text-4xl font-bold tracking-tight">
              Três passos simples
            </motion.h2>
          </motion.div>
          <motion.div
            variants={container}
            initial="hidden"
            whileInView="show"
            viewport={{ once: true, margin: "-100px" }}
            className="grid md:grid-cols-3 gap-8"
          >
            {steps.map((s, i) => (
              <motion.div key={s.num} variants={item} className="relative text-center">
                {i < steps.length - 1 && (
                  <div className="hidden md:block absolute top-8 left-[60%] w-[80%] border-t border-dashed border-border/60" />
                )}
                <div className="relative mx-auto mb-5 flex size-16 items-center justify-center rounded-2xl bg-card border border-border/50 shadow-sm">
                  <span className="text-xl font-bold text-primary">{s.num}</span>
                </div>
                <h3 className="font-semibold text-lg mb-2">{s.title}</h3>
                <p className="text-sm text-muted-foreground max-w-xs mx-auto">
                  {s.description}
                </p>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* CTA */}
      <section className="py-24 border-t border-border/40">
        <div className="mx-auto max-w-6xl px-6">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="rounded-3xl bg-primary px-8 py-16 text-center sm:px-16 relative overflow-hidden"
          >
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.1),transparent_60%)]" />
            <div className="relative">
              <h2 className="text-3xl sm:text-4xl font-bold text-primary-foreground tracking-tight">
                Comece a gerenciar seus chamados
              </h2>
              <p className="mt-4 text-primary-foreground/80 max-w-md mx-auto">
                Entre com a conta criada pelo administrador e comece a organizar os chamados de TI da sua empresa.
              </p>
              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <button
                  onClick={() => navigate("/auth")}
                  className="inline-flex items-center gap-2 rounded-xl bg-background px-6 py-3 text-sm font-semibold text-foreground transition-all hover:shadow-xl hover:-translate-y-0.5"
                >
                  Entrar no PingOS
                  <ArrowRight className="size-4" />
                </button>

              </div>
            </div>
          </motion.div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/40 py-6 sm:py-8">
        <div className="mx-auto max-w-6xl px-4 sm:px-6 flex flex-col items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="flex size-6 items-center justify-center rounded-md bg-primary">
              <Headphones className="size-3 text-primary-foreground" />
            </div>
            <span className="text-sm font-semibold text-foreground">PingOS</span>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            © {new Date().getFullYear()} PingOS. Desenvolvido por Jairo Reis.
          </p>
        </div>
      </footer>
    </div>
  );
}
