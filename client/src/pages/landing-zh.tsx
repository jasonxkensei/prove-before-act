import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Shield,
  Wallet,
  CheckCircle,
  ArrowRight,
  ChevronRight,
  Blocks,
  Bot,
  Cog,
  Copy,
  Loader2,
  Key,
  Zap,
  Play,
  Network,
  FileText,
  BarChart3,
  Award,
  CreditCard,
  ShoppingCart,
  AlertTriangle,
  Clock,
  Users,
} from "lucide-react";
import { WalletLoginModal } from "@/components/wallet-login-modal";
import { trackAgentCta, useAgentCtaExposure } from "@/lib/conversionTracking";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export default function LandingZh() {
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const { data: pricing } = useQuery<{
    current_price_usd: number;
    total_certifications: number;
  }>({ queryKey: ["/api/pricing"] });
  const price = pricing ? `$${pricing.current_price_usd}` : "$0.01";

  const [agentName, setAgentName] = useState("");
  const [trialKey, setTrialKey] = useState<string | null>(null);
  const [trialAgentName, setTrialAgentName] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const [trialError, setTrialError] = useState<string | null>(null);
  const heroTrialCtaRef = useAgentCtaExposure<HTMLButtonElement>("landing_zh", "trial_register");

  // Single entry point for trial registration so the button click and the
  // Enter key record the same conversion telemetry before submitting.
  const submitTrialRegistration = () => {
    const name = agentName.trim();
    if (name.length < 2 || registerMutation.isPending) return;
    trackAgentCta("cta_clicked", "landing_zh", "trial_register");
    registerMutation.mutate(name);
  };

  const registerMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch("/api/agent/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_name: name }),
      });
      const data = await res.json();
      if (!res.ok)
        throw new Error(data.message || "注册失败，请换一个名称重试。");
      return data;
    },
    onSuccess: (data, name) => {
      setTrialKey(data.api_key);
      setTrialAgentName(name);
      setTrialError(null);
    },
    onError: (err: Error) => {
      setTrialError(err.message);
    },
  });

  const handleCopyKey = () => {
    if (!trialKey) return;
    navigator.clipboard.writeText(trialKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-16 items-center justify-between">
          <a href="/zh" className="flex items-center gap-2" data-testid="link-logo-home-zh">
            <img src="/pba-logo.svg" alt="Prove Before Act" className="h-8 w-auto" />
          </a>
          <nav className="hidden md:flex items-center gap-6">
            <a href="#how-it-works" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              工作原理
            </a>
            <a href="/leaderboard" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              信任排行榜
            </a>
            <a href="/stats" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              数据统计
            </a>
            <a href="/docs" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              开发文档
            </a>
            <a href="/agent-context/zh" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1">
              <Bot className="h-3.5 w-3.5" />
              智能体集成
            </a>
            <a href="#faq" className="text-sm font-medium text-muted-foreground hover:text-foreground transition-colors">
              常见问题
            </a>
          </nav>
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors border border-border/50 rounded-md px-2.5 py-1.5 font-mono"
              data-testid="link-lang-en"
            >
              EN
            </a>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsLoginModalOpen(true)}
              data-testid="button-login-zh"
            >
              <Wallet className="mr-2 h-4 w-4" />
              连接钱包
            </Button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="container pt-14 pb-20 md:pt-20 md:pb-28">
        <div className="mx-auto max-w-5xl text-center">
          <div className="mb-5 flex justify-center">
            <Badge variant="outline" className="text-xs px-3 py-1 gap-1.5" data-testid="badge-prove-before-act-zh">
              <AlertTriangle className="h-3 w-3 text-amber-500" />
              AI决策无留痕，监管追责无依据
            </Badge>
          </div>

          <h1 className="mb-6 text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-tight">
            AI决策，
            <br />
            <span className="text-primary">链上留痕。</span>
          </h1>

          <p className="mx-auto mb-5 max-w-2xl text-lg md:text-xl text-muted-foreground leading-relaxed">
            监管检查时，您能提供AI决策的完整证明吗？Prove Before Act 为每次智能体操作生成<strong className="text-foreground">不可篡改的合规存证</strong>——
            决策前锚定推理依据，执行后锚定实际结果，构建完整的<strong className="text-foreground">风控留痕与审计追溯链</strong>。
          </p>

          <div className="mb-8 flex justify-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/5 px-4 py-1.5 text-sm" data-testid="badge-x402-hero-zh">
              <Zap className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="text-muted-foreground">
                无需注册 — 通过 <strong className="text-foreground">x402</strong> 协议直接支付 · 一次HTTP请求 · Base链USDC
              </span>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Button
              size="lg"
              className="text-base h-12 px-8"
              onClick={() => setIsLoginModalOpen(true)}
              data-testid="button-submit-proof-zh"
            >
              <Shield className="mr-2 h-5 w-5" />
              提交存证
            </Button>
            <Button
              asChild
              variant="outline"
              size="lg"
              className="text-base h-12 px-8"
              data-testid="button-free-trial-zh"
            >
              <a href="#free-trial">
                <Bot className="mr-2 h-4 w-4" />
                免费体验 10 次
              </a>
            </Button>
          </div>

          <p className="mt-4 text-sm text-muted-foreground">{price} / 次 · 不限量</p>
        </div>
      </section>

      {/* Regulatory Context Banner */}
      <section className="border-y bg-amber-500/5 border-amber-500/20 py-6">
        <div className="container">
          <div className="mx-auto max-w-4xl flex flex-col sm:flex-row items-start sm:items-center gap-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-amber-500/10 border border-amber-500/20">
              <FileText className="h-4 w-4 text-amber-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-foreground mb-0.5">
                未留痕的AI决策，是最大的合规风险
              </p>
              <p className="text-xs text-muted-foreground leading-relaxed">
                《生成式人工智能服务管理暂行办法》《数据安全法》明确要求AI系统保留可审查的决策记录。
                一旦发生争议或监管检查，<strong className="text-foreground">无法举证等同于违规</strong>。
                Prove Before Act 为每次AI决策生成链上不可篡改的证明，每次 $0.01，审计时随时可查。
              </p>
            </div>
            <Badge variant="outline" className="text-xs border-amber-500/30 text-amber-600 dark:text-amber-400 whitespace-nowrap shrink-0">
              风控合规基础设施
            </Badge>
          </div>
        </div>
      </section>

      {/* Machine Economy Stack */}
      <section className="border-t bg-muted/20 py-12 md:py-16">
        <div className="container">
          <div className="mx-auto max-w-4xl">
            <p className="mb-8 text-center text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              MultiversX 机器经济协议栈
            </p>
            <div className="hidden sm:flex items-stretch gap-0">
              {[
                { id: "MX-8004", label: "身份认证", desc: "智能体是谁？" },
                { id: "AP2", label: "授权管理", desc: "是否获得授权？" },
                { id: "MCP", label: "通信协议", desc: "请求了什么？" },
                { id: "x402", label: "支付结算", desc: "支付了什么？" },
                { id: "Prove Before Act", label: "可验证意图", desc: "为何执行此操作？", highlight: true },
              ].map((pillar, i) => (
                <div key={pillar.id} className="flex items-center flex-1 min-w-0">
                  {i > 0 && (
                    <ChevronRight className="h-4 w-4 text-muted-foreground/30 shrink-0 mx-1" />
                  )}
                  <div
                    className={`flex-1 flex flex-col items-center text-center px-3 py-5 rounded-md border h-full ${
                      pillar.highlight
                        ? "border-primary bg-primary/5"
                        : "border-border/60 bg-background/60"
                    }`}
                  >
                    <span className={`text-sm font-bold font-mono tracking-tight ${pillar.highlight ? "text-primary" : "text-foreground"}`}>
                      {pillar.id}
                    </span>
                    <span className={`text-xs font-semibold mt-1 ${pillar.highlight ? "text-primary/80" : "text-muted-foreground"}`}>
                      {pillar.label}
                    </span>
                    <span className="mt-1.5 text-xs text-muted-foreground/70 leading-snug">
                      {pillar.desc}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-col gap-2 sm:hidden">
              {[
                { id: "MX-8004", label: "身份认证", desc: "智能体是谁？" },
                { id: "AP2", label: "授权管理", desc: "是否获得授权？" },
                { id: "MCP", label: "通信协议", desc: "请求了什么？" },
                { id: "x402", label: "支付结算", desc: "支付了什么？" },
                { id: "Prove Before Act", label: "可验证意图", desc: "为何执行此操作？", highlight: true },
              ].map((pillar) => (
                <div
                  key={pillar.id}
                  className={`flex items-center gap-3 px-4 py-3 rounded-md border ${
                    pillar.highlight ? "border-primary bg-primary/5" : "border-border/60 bg-background/60"
                  }`}
                >
                  <span className={`text-sm font-bold font-mono tracking-tight w-16 shrink-0 ${pillar.highlight ? "text-primary" : "text-foreground"}`}>
                    {pillar.id}
                  </span>
                  <div className="min-w-0">
                    <span className={`text-xs font-semibold block ${pillar.highlight ? "text-primary/80" : "text-muted-foreground"}`}>
                      {pillar.label}
                    </span>
                    <span className="text-xs text-muted-foreground/70">{pillar.desc}</span>
                  </div>
                </div>
              ))}
            </div>
            <p className="mt-8 text-center text-sm text-muted-foreground">
              Prove Before Act 是智能体经济的可信层。{" "}
              <span className="text-foreground font-medium">每一次智能体操作，均可链上存证。</span>
            </p>
          </div>
        </div>
      </section>

      {/* 行动前证明 — Prove Before Act */}
      <section id="how-it-works" className="py-16 md:py-20">
        <div className="container">
          <div className="mx-auto max-w-5xl">
            <div className="mb-12">
              <div className="mb-8 text-center">
                <Badge variant="outline" className="mb-4 gap-1.5">
                  <Play className="h-3 w-3 text-primary" />
                  行动前证明
                </Badge>
                <h2 className="mb-3 text-2xl md:text-3xl font-bold">
                  合规风控的标准操作闭环
                </h2>
                <p className="text-muted-foreground max-w-xl mx-auto text-sm">
                  执行前将推理依据（WHY）锚定链上，形成<strong className="text-foreground">合规留痕</strong>；
                  执行后将实际结果（WHAT）存证，完成<strong className="text-foreground">风控审计轨迹</strong>。
                  全程可供审计员、监管机构或合作系统随时独立验证。
                </p>
              </div>
              <div className="flex flex-col sm:flex-row items-center justify-center gap-0">
                {[
                  { step: "1", label: "推理", sublabel: "Reason", desc: "智能体记录完整推理过程与决策依据（WHY）", icon: Bot },
                  { step: "2", label: "锚定WHY", sublabel: "Anchor WHY", desc: "哈希后在执行前锚定上链", icon: Blocks },
                  { step: "3", label: "执行", sublabel: "Execute", desc: "行动执行，WHY的链上引用不可篡改", icon: Play },
                  { step: "4", label: "锚定WHAT", sublabel: "Anchor WHAT", desc: "执行完成后将实际结果存证上链", icon: Shield },
                ].map((s, i) => {
                  const Icon = s.icon;
                  return (
                    <div key={s.step} className="flex items-center flex-1 min-w-0 w-full sm:w-auto">
                      {i > 0 && (
                        <ChevronRight className="h-4 w-4 text-muted-foreground/30 shrink-0 mx-1 hidden sm:block" />
                      )}
                      <div className="flex-1 flex flex-col items-center text-center px-4 py-4 rounded-md border border-border/60 bg-background/60 h-full min-w-0">
                        <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                          <Icon className="h-4 w-4 text-primary" />
                        </div>
                        <span className="text-xs font-bold text-foreground">{s.label}</span>
                        <span className="text-[10px] text-muted-foreground/50 font-mono">{s.sublabel}</span>
                        <span className="text-xs text-muted-foreground/70 mt-0.5 leading-snug">{s.desc}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-5 text-center">
                <Button asChild variant="outline" size="sm">
                  <a href="/agent-context/zh#workflow">
                    查看Python完整实现
                    <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                  </a>
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 4W Framework */}
      <section className="border-y bg-muted/20 py-16 md:py-20">
        <div className="container">
          <div className="mx-auto max-w-4xl">
            <div className="mb-10 text-center">
              <Badge variant="outline" className="mb-4">4W 合规审计框架</Badge>
              <h2 className="mb-3 text-2xl md:text-3xl font-bold">
                每次操作，四维合规存证
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto text-sm">
                每个智能体操作均可分解为四个可独立验证的维度，直接对应监管合规要求中的责任归属、操作记录与决策追溯。
              </p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {[
                {
                  w: "WHO",
                  zh: "责任主体",
                  desc: "绑定MX-8004可信智能体身份——监管机构要求的「责任到人」，跨会话持久可追溯",
                  reg: "《数据安全法》第27条：数据处理者身份可识别",
                  icon: Users,
                  color: "text-primary",
                  border: "border-primary/20",
                  bg: "bg-primary/5",
                },
                {
                  w: "WHAT",
                  zh: "操作结果",
                  desc: "实际执行结果的SHA-256哈希，链上精确存证，防止事后篡改或否认",
                  reg: "《生成式AI办法》第17条：记录日志并保存六个月以上",
                  icon: Shield,
                  color: "text-blue-500",
                  border: "border-blue-500/20",
                  bg: "bg-blue-500/5",
                },
                {
                  w: "WHEN",
                  zh: "操作时间",
                  desc: "区块链时间戳 + 交易哈希，独立于智能体系统，任何第三方均可独立核验",
                  reg: "《网络安全法》第21条：保留网络日志不少于六个月",
                  icon: Clock,
                  color: "text-green-500",
                  border: "border-green-500/20",
                  bg: "bg-green-500/5",
                },
                {
                  w: "WHY",
                  zh: "决策依据",
                  desc: "完整推理链在执行前锚定——出现争议时，这是证明AI决策合理性的核心证据",
                  reg: "《算法推荐管理规定》：算法决策须有可解释的依据",
                  icon: Network,
                  color: "text-amber-500",
                  border: "border-amber-500/20",
                  bg: "bg-amber-500/5",
                },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <Card key={item.w} className={`border ${item.border}`}>
                    <CardContent className="p-4">
                      <div className={`flex h-8 w-8 items-center justify-center rounded-md ${item.bg} mb-3`}>
                        <Icon className={`h-4 w-4 ${item.color}`} />
                      </div>
                      <div className="flex items-baseline gap-1.5 mb-1">
                        <span className={`text-base font-bold font-mono ${item.color}`}>{item.w}</span>
                        <span className="text-xs text-muted-foreground">{item.zh}</span>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed mb-2">{item.desc}</p>
                      <p className={`text-[10px] leading-snug font-medium ${item.color} opacity-80`}>{item.reg}</p>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
            <div className="mt-6 text-center">
              <p className="text-xs text-muted-foreground">
                合规核心原则：<span className="text-foreground font-medium">WHY（决策依据）执行前锚定，WHAT（操作结果）执行后锚定</span>——
                形成不可倒序的密码学因果链，满足监管机构的事后溯源要求。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Fleet Operator Section */}
      <section id="fleet-operators" className="py-16 md:py-20">
        <div className="container">
          <div className="mx-auto max-w-5xl">
            <div className="mb-10 text-center">
              <Badge variant="outline" className="mb-4">
                <Users className="mr-1.5 h-3 w-3" />
                集群运营商 · 合规风控
              </Badge>
              <h2 className="mb-3 text-2xl md:text-3xl font-bold">
                合规风控成本 vs. 违规代价
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto text-sm">
                一次监管检查无法举证，损失可能是合同终止、罚款或项目叫停。
                <strong className="text-foreground">每日1000次决策的全量存证，仅需$10</strong>——
                这是智能体集群最低成本的风控保障，每次 $0.01。
              </p>
            </div>

            <div className="grid sm:grid-cols-2 gap-4 mb-10 max-w-2xl mx-auto">
              <div className="rounded-md border border-destructive/20 bg-destructive/5 p-4">
                <p className="text-sm font-semibold text-destructive mb-2">不部署留痕的代价</p>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex items-start gap-1.5"><span className="text-destructive mt-0.5 shrink-0">✗</span>监管检查无法举证 → 视同违规</li>
                  <li className="flex items-start gap-1.5"><span className="text-destructive mt-0.5 shrink-0">✗</span>客户争议无法溯源 → 合同纠纷</li>
                  <li className="flex items-start gap-1.5"><span className="text-destructive mt-0.5 shrink-0">✗</span>AI决策黑盒运行 → 被监管叫停风险</li>
                  <li className="flex items-start gap-1.5"><span className="text-destructive mt-0.5 shrink-0">✗</span>每次审计事件：数万元法律 + 运营成本</li>
                </ul>
              </div>
              <div className="rounded-md border border-primary/20 bg-primary/5 p-4">
                <p className="text-sm font-semibold text-primary mb-2">Prove Before Act 合规风控</p>
                <ul className="space-y-1.5 text-xs text-muted-foreground">
                  <li className="flex items-start gap-1.5"><span className="text-primary mt-0.5 shrink-0">✓</span>每日1000次决策全量存证：<strong className="text-foreground">$10/天</strong></li>
                  <li className="flex items-start gap-1.5"><span className="text-primary mt-0.5 shrink-0">✓</span>监管检查：随时出具链上证明</li>
                  <li className="flex items-start gap-1.5"><span className="text-primary mt-0.5 shrink-0">✓</span>客户争议：完整4W审计轨迹即时导出</li>
                  <li className="flex items-start gap-1.5"><span className="text-primary mt-0.5 shrink-0">✓</span>批量API：单次提交100条，3行代码集成</li>
                </ul>
              </div>
            </div>

            <div className="grid md:grid-cols-3 gap-6 mb-10">
              {[
                {
                  icon: Blocks,
                  title: "批量认证",
                  subtitle: "Batch Certification",
                  desc: "单次API调用可提交最多100个哈希值，适用于高频操作的智能体集群。每次 $0.01，按需扩展。",
                  code: `# 批量提交100个操作哈希
POST /api/batch
{
  "hashes": [
    {"file_hash": "sha256...", "filename": "action_001.json"},
    {"file_hash": "sha256...", "filename": "action_002.json"},
    ...
  ]
}`,
                },
                {
                  icon: BarChart3,
                  title: "信任评分体系",
                  subtitle: "Trust Score",
                  desc: "智能体集群中每个个体均有独立的可信度评分，基于认证数量、活跃周期与审计记录动态计算。",
                  code: `# 查询智能体信任状态
GET /api/agents/{wallet}

{
  "trust_score": 87,
  "level": "Verified",
  "cert_total": 2340,
  "streak_weeks": 12,
  "violations": {"fault": 0, "breach": 0}
}`,
                },
                {
                  icon: AlertTriangle,
                  title: "违规检测层",
                  subtitle: "Violations Layer",
                  desc: "自动检测审计轨迹中的结构异常——包括时序倒置、缺失证明与会话断链。",
                  code: `# 获取事件报告
GET /api/agents/{wallet}/incident-report
  ?proof_id={uuid}

{
  "verdict": {"status": "clean"},
  "verification": {
    "intent_preceded_execution": true,
    "why_certified": true,
    "what_certified": true
  }
}`,
                },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <Card key={item.title}>
                    <CardContent className="p-5">
                      <div className="flex items-center gap-2 mb-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
                          <Icon className="h-4 w-4 text-primary" />
                        </div>
                        <div>
                          <p className="font-semibold text-sm">{item.title}</p>
                          <p className="text-[10px] text-muted-foreground font-mono">{item.subtitle}</p>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground leading-relaxed mb-3">{item.desc}</p>
                      <pre className="text-[10px] font-mono bg-muted/50 border border-border/50 rounded-md p-2.5 leading-relaxed overflow-x-auto whitespace-pre text-foreground/70">
                        {item.code}
                      </pre>
                    </CardContent>
                  </Card>
                );
              })}
            </div>

            {/* Python SDK example */}
            <div className="rounded-md bg-[#0d1117] overflow-hidden" data-testid="code-fleet-python-zh">
              <div className="flex items-center justify-between px-4 py-2 border-b border-[#30363d]">
                <span className="text-xs text-[#8b949e] font-mono">Python — 行动前证明完整实现（集群运营版）</span>
                <Badge variant="outline" className="text-xs font-mono border-[#30363d] text-[#8b949e]">可直接复制使用</Badge>
              </div>
              <div className="p-4 font-mono text-xs text-[#e6edf3] overflow-x-auto leading-relaxed">
                <div className="text-[#8b949e]">import hashlib, json</div>
                <div className="text-[#8b949e]">import xproof  <span className="text-[#8b949e]"># pip install xproof</span></div>
                <div className="mt-3"><span className="text-[#f97583]">client</span> = xproof.Client(api_key=<span className="text-[#a5d6ff]">"pm_..."</span>)</div>
                <div className="mt-4 text-[#8b949e]"># 步骤1：执行前，锚定决策依据（WHY）</div>
                <div><span className="text-[#e3b341]">why_proof</span> = client.certify(</div>
                <div className="pl-4">file_hash=hashlib.sha256(json.dumps(&#123;</div>
                <div className="pl-8"><span className="text-[#a5d6ff]">"reasoning"</span>: <span className="text-[#a5d6ff]">"基于用户历史数据，判断最优推荐策略..."</span>,</div>
                <div className="pl-8"><span className="text-[#a5d6ff]">"decision"</span>: <span className="text-[#a5d6ff]">"执行内容推荐操作"</span>,</div>
                <div className="pl-8"><span className="text-[#a5d6ff]">"confidence"</span>: <span className="text-[#ffa657]">0.94</span></div>
                <div className="pl-4">&#125;, sort_keys=<span className="text-[#79c0ff]">True</span>).encode()).hexdigest(),</div>
                <div className="pl-4">metadata=&#123;<span className="text-[#a5d6ff]">"role"</span>: <span className="text-[#a5d6ff]">"WHY"</span>, <span className="text-[#a5d6ff]">"action_type"</span>: <span className="text-[#a5d6ff]">"content_recommendation"</span>&#125;</div>
                <div>)</div>
                <div className="mt-3 text-[#8b949e]"># 步骤2：执行实际操作</div>
                <div><span className="text-[#e3b341]">result</span> = your_agent.execute_recommendation()</div>
                <div className="mt-3 text-[#8b949e]"># 步骤3：执行后，锚定实际结果（WHAT）</div>
                <div><span className="text-[#e3b341]">what_proof</span> = client.certify(</div>
                <div className="pl-4">file_hash=hashlib.sha256(json.dumps(result, sort_keys=<span className="text-[#79c0ff]">True</span>).encode()).hexdigest(),</div>
                <div className="pl-4">metadata=&#123;<span className="text-[#a5d6ff]">"role"</span>: <span className="text-[#a5d6ff]">"WHAT"</span>, <span className="text-[#a5d6ff]">"why_proof_id"</span>: why_proof[<span className="text-[#a5d6ff]">"proof_id"</span>]&#125;</div>
                <div>)</div>
                <div className="mt-3 text-[#3fb950]"># 审计轨迹已建立 — WHY在WHAT之前锚定，链上可验证</div>
                <div className="text-[#3fb950]"># 事件报告: provebeforeact.com/incident/&#123;wallet&#125;/&#123;why_proof_id&#125;</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Free Trial */}
      <section id="free-trial" className="border-y bg-muted/30 py-16 md:py-20">
        <div className="container">
          <div className="mx-auto max-w-2xl text-center">
            <Badge variant="secondary" className="mb-4 px-3 py-1">
              <Key className="mr-2 h-3.5 w-3.5" />
              免费体验 — 无需钱包
            </Badge>
            <h2 className="mb-3 text-2xl md:text-3xl font-bold">
              10次免费存证，30秒内开始。
            </h2>
            <p className="mb-8 text-muted-foreground max-w-xl mx-auto">
              注册您的智能体或项目，立即获取{" "}
              <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">pm_</code>{" "}
              格式API密钥。无需钱包，无需信用卡。
            </p>

            {!trialKey ? (
              <div className="max-w-md mx-auto">
                <div className="flex flex-col sm:flex-row gap-3">
                  <Input
                    placeholder="智能体名称（如 my-agent-001）"
                    value={agentName}
                    onChange={(e) => setAgentName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        submitTrialRegistration();
                      }
                    }}
                    data-testid="input-trial-agent-name-zh"
                    className="flex-1"
                  />
                  <Button
                    ref={heroTrialCtaRef}
                    onClick={submitTrialRegistration}
                    disabled={agentName.trim().length < 2 || registerMutation.isPending}
                    data-testid="button-register-trial-zh"
                  >
                    {registerMutation.isPending ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        注册中...
                      </>
                    ) : (
                      <>
                        获取API密钥
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </>
                    )}
                  </Button>
                </div>
                {trialError && (
                  <p className="mt-3 text-sm text-destructive text-left">{trialError}</p>
                )}
                <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                  {["10次免费存证", "无需钱包", "无需信用卡", "随时绑定钱包升级"].map((label) => (
                    <Badge key={label} variant="outline" className="text-xs">{label}</Badge>
                  ))}
                </div>
              </div>
            ) : (
              <div className="max-w-lg mx-auto">
                <div className="mb-2 flex items-center gap-2 rounded-md bg-primary/10 border border-primary/20 p-3 font-mono text-sm">
                  <span className="flex-1 text-left truncate text-primary font-medium" data-testid="text-trial-key-zh">{trialKey}</span>
                  <Button size="icon" variant="ghost" onClick={handleCopyKey} data-testid="button-copy-trial-key-zh">
                    {copied ? <CheckCircle className="h-4 w-4 text-primary" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
                <p className="text-sm text-muted-foreground mb-5">
                  您的密钥已就绪 — <strong>{trialAgentName}</strong> 享有 10 次免费存证。
                </p>
                <pre className="text-left text-xs font-mono bg-[#0d1117] rounded-md p-4 text-[#e6edf3] overflow-x-auto leading-relaxed">
{`import xproof, hashlib, json

client = xproof.Client(api_key="${trialKey}")

# 锚定决策依据（执行前）
proof = client.certify(
    file_hash=hashlib.sha256(
        json.dumps({"reasoning": "..."}, sort_keys=True).encode()
    ).hexdigest(),
    metadata={"role": "WHY"}
)
print(proof["verify_url"])  # 链上可验证`}
                </pre>
                <div className="mt-4 flex flex-col sm:flex-row gap-2 justify-center">
                  <Button asChild variant="outline" size="sm">
                    <a href="/agent-context/zh">查看完整文档 <ArrowRight className="ml-1.5 h-3.5 w-3.5" /></a>
                  </Button>
                  <Button asChild variant="ghost" size="sm">
                    <a href="/leaderboard">注册公开智能体</a>
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-16 md:py-20">
        <div className="container">
          <div className="mx-auto max-w-3xl text-center">
            <Badge variant="outline" className="mb-4">定价</Badge>
            <h2 className="mb-3 text-2xl md:text-3xl font-bold">
              简单透明，按需计费
            </h2>
            <p className="text-muted-foreground mb-10">
              无月费，无套餐，无隐藏费用。每次存证固定收费。
            </p>
            <div className="grid md:grid-cols-3 gap-6">
              {[
                {
                  title: "免费体验",
                  price: "免费",
                  desc: "无需钱包，立即开始",
                  features: ["10次免费存证", "pm_格式API密钥", "链上验证页面", "随时绑定钱包"],
                  cta: "立即获取",
                  ctaHref: "#free-trial",
                  highlight: false,
                },
                {
                  title: "按需付费",
                  price: "$0.01",
                  priceUnit: "/ 次",
                  desc: "无限次，随时可用",
                  features: ["不限量存证", "批量API（100条/次）", "信任评分", "事件报告", "链上锚定"],
                  cta: "连接钱包",
                  ctaHref: "#",
                  highlight: true,
                },
                {
                  title: "x402协议",
                  price: "$0.01",
                  priceUnit: "/ 次",
                  desc: "无账号，智能体直接支付",
                  features: ["无需注册", "USDC on Base", "HTTP 402原生支持", "Coinbase CDP兼容", "单次HTTP请求完成"],
                  cta: "查看文档",
                  ctaHref: "/docs",
                  highlight: false,
                },
              ].map((plan) => (
                <Card key={plan.title} className={plan.highlight ? "border-primary" : ""}>
                  <CardContent className="p-6">
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">{plan.title}</p>
                    <div className="flex items-baseline gap-1 mb-1">
                      <span className="text-3xl font-bold">{plan.price}</span>
                      {plan.priceUnit && <span className="text-sm text-muted-foreground">{plan.priceUnit}</span>}
                    </div>
                    <p className="text-xs text-muted-foreground mb-5">{plan.desc}</p>
                    <ul className="space-y-2 mb-6">
                      {plan.features.map((f) => (
                        <li key={f} className="flex items-center gap-2 text-xs">
                          <CheckCircle className="h-3.5 w-3.5 text-primary shrink-0" />
                          {f}
                        </li>
                      ))}
                    </ul>
                    <Button
                      asChild
                      variant={plan.highlight ? "default" : "outline"}
                      className="w-full"
                      size="sm"
                    >
                      <a href={plan.ctaHref}>{plan.cta}</a>
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Integrations */}
      <section className="border-y bg-muted/20 py-12 md:py-16">
        <div className="container">
          <div className="mx-auto max-w-4xl">
            <p className="mb-8 text-center text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              兼容主流智能体协议与框架
            </p>
            <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
              {[
                { icon: Blocks, name: "MCP", desc: "模型上下文协议" },
                { icon: CreditCard, name: "x402", desc: "HTTP原生支付" },
                { icon: ShoppingCart, name: "ACP", desc: "智能体商务协议" },
                { icon: Award, name: "MX-8004", desc: "可信智能体标准" },
                { icon: Bot, name: "OpenClaw", desc: "技能市场" },
                { icon: Cog, name: "GitHub Action", desc: "CI/CD流水线" },
              ].map((item) => (
                <Card key={item.name} className="text-center">
                  <CardContent className="pt-6 pb-4">
                    <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10">
                      <item.icon className="h-5 w-5 text-primary" />
                    </div>
                    <p className="font-semibold text-sm">{item.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">{item.desc}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            <p className="mt-6 text-center text-xs text-muted-foreground">
              同时支持 LangChain · CrewAI · AutoGen · LlamaIndex · OpenAI Agents SDK · Vercel AI
            </p>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="py-16 md:py-20">
        <div className="container">
          <div className="mx-auto max-w-3xl">
            <div className="mb-10 text-center">
              <Badge variant="outline" className="mb-4">常见问题</Badge>
              <h2 className="text-2xl md:text-3xl font-bold">您可能想了解的</h2>
            </div>
            <Accordion type="single" collapsible className="space-y-2">
              {[
                {
                  q: "Prove Before Act如何帮助智能体集群运营商满足合规要求？",
                  a: "Prove Before Act为每次智能体操作生成不可篡改的链上存证，包含操作主体（WHO）、操作时间（WHEN）、决策依据（WHY，执行前锚定）和实际结果（WHAT，执行后锚定）。这四个维度构成完整的审计轨迹，可直接响应《生成式人工智能服务管理暂行办法》等监管要求，为审计员和监管机构提供可独立验证的操作记录。",
                },
                {
                  q: "批量认证适合高频操作的集群吗？",
                  a: "是的。Prove Before Act的批量API支持单次请求提交最多100个哈希值，每次存证固定收费$0.01，无任何批量溢价。对于每秒产生大量操作的集群，您可以在本地缓冲操作记录，定期批量提交，实现高效可扩展的审计基础设施。",
                },
                {
                  q: "x402协议如何工作？智能体无需账号也能存证吗？",
                  a: "是的。任何拥有以太坊钱包（包括Base链钱包）的智能体，无需注册账号，即可通过x402协议自主完成存证。流程为：发送POST请求 → 收到HTTP 402支付挑战 → 在Base链上签署$0.01 USDC支付 → 携带X-PAYMENT头重新发送 → 立即获得存证结果。全程无人工干预，完全适合自主智能体。",
                },
                {
                  q: "链上数据存储在哪条链上？为什么选择MultiversX？",
                  a: "证明存储在MultiversX区块链上。MultiversX提供低交易费用、高吞吐量和成熟的机器经济协议栈（MX-8004身份标准、ACP商务协议等），专为大规模智能体操作而优化。支付使用Base链上的USDC（x402协议），链上存证使用MultiversX，两者相互配合。",
                },
                {
                  q: "信任评分如何计算？集群中的单个智能体可以独立评分吗？",
                  a: "每个注册到公开排行榜的智能体都有独立的信任评分，基于：认证总量、活跃周期（连续周数）、第三方认证机构的背书、以及违规记录（如有则扣分）。集群中的每个智能体独立计分，您可以通过leaderboard管理整个集群的信任状态。",
                },
                {
                  q: "如何查看具体操作的完整审计报告？",
                  a: "每个存证都有一个对应的事件报告页面，位于 provebeforeact.com/incident/{钱包地址}/{proof_id}。报告包含：自然语言摘要、4W验证状态、WHY→WHAT时序证明（含时间差）、完整操作时间线，以及供其他智能体程序化调用的JSON端点。",
                },
              ].map((item, i) => (
                <AccordionItem key={i} value={`item-${i}`} className="border rounded-md px-4">
                  <AccordionTrigger className="text-sm font-medium text-left hover:no-underline py-4">
                    {item.q}
                  </AccordionTrigger>
                  <AccordionContent className="text-sm text-muted-foreground pb-4 leading-relaxed">
                    {item.a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t bg-muted/20 py-16 md:py-20">
        <div className="container">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="mb-4 text-2xl md:text-3xl font-bold">
              为您的智能体集群建立合规风控基础设施
            </h2>
            <p className="mb-8 text-muted-foreground">
              从10次免费存证开始。无需钱包，无需信用卡。
              30秒内接入<strong className="text-foreground">合规存证 · 风控留痕 · 审计追溯</strong>——直接响应监管要求。
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button size="lg" asChild className="text-base h-12 px-8">
                <a href="#free-trial">
                  <Key className="mr-2 h-5 w-5" />
                  免费获取API密钥
                </a>
              </Button>
              <Button size="lg" variant="outline" asChild className="text-base h-12 px-8">
                <a href="/docs">
                  <FileText className="mr-2 h-5 w-5" />
                  阅读开发文档
                </a>
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-8">
        <div className="container">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <img src="/pba-logo.svg" alt="Prove Before Act" className="h-6 w-auto" />
              <span className="text-xs text-muted-foreground">智能体经济的可信证明层</span>
            </div>
            <nav className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground justify-center">
              <a href="/docs" className="hover:text-foreground transition-colors">开发文档</a>
              <a href="/leaderboard" className="hover:text-foreground transition-colors">信任排行榜</a>
              <a href="/agent-context/zh" className="hover:text-foreground transition-colors">智能体集成</a>
              <a href="/docs/4w" className="hover:text-foreground transition-colors">4W框架</a>
              <a href="/" className="hover:text-foreground transition-colors border border-border/50 rounded px-2 py-0.5 font-mono">EN</a>
            </nav>
            <p className="text-xs text-muted-foreground">
              © {new Date().getFullYear()} Prove Before Act · 基于 MultiversX 区块链
            </p>
          </div>
        </div>
      </footer>

      <WalletLoginModal
        open={isLoginModalOpen}
        onOpenChange={setIsLoginModalOpen}
      />
    </div>
  );
}
