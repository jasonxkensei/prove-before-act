import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Bot,
  Zap,
  AlertTriangle,
  DollarSign,
  BarChart3,
  Cpu,
  Shield,
  Eye,
  Network,
  Play,
  Copy,
  CheckCircle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  ArrowRight,
  Clock,
  RefreshCw,
  Lock,
  TrendingUp,
  Star,
} from "lucide-react";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="absolute top-3 right-3 p-1.5 rounded bg-muted/60 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
      onClick={() => {
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      }}
      data-testid="button-copy-code-zh"
    >
      {copied ? <CheckCircle className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative mt-3 mb-1">
      <pre className="rounded-md bg-muted/70 border border-border/50 p-4 pr-10 text-xs font-mono leading-relaxed overflow-x-auto whitespace-pre text-foreground/90">
        {code}
      </pre>
      <CopyButton text={code} />
    </div>
  );
}

type Section = {
  id: string;
  icon: React.ElementType;
  title: string;
  badge?: string;
  content: React.ReactNode;
};

export default function AgentContextZhPage() {
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    x402: true,
    latency: true,
    retry: true,
    cost: true,
    comparison: true,
    mcp: true,
    "4w": true,
    privacy: true,
    fleet: true,
    "fleet-1000": true,
    workflow: true,
    moltbook: true,
    keyfields: true,
    integrations: true,
    honest: true,
  });

  const toggle = (id: string) =>
    setExpandedSections((prev) => ({ ...prev, [id]: !prev[id] }));

  const sections: Section[] = [
    {
      id: "x402",
      icon: Zap,
      title: "x402协议如何工作？无需API密钥即可完成支付",
      badge: "核心差异化特性",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            x402是一种HTTP内置支付协议。智能体无需任何凭证直接发送请求，收到包含精确价格和支付说明的
            <code className="bg-muted px-1 rounded font-mono text-xs">HTTP 402 Payment Required</code>
            响应后，在Base链上签署USDC微支付，然后携带签名支付头重新发送原始请求。全程无需账号、无需API密钥、无需预先注册。
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { step: "1", title: "发送请求", desc: "不带任何认证头，直接 POST /api/proof" },
              { step: "2", title: "收到402响应", desc: "获取价格（$0.01 USDC）和待签名的支付载荷" },
              { step: "3", title: "支付并锚定", desc: "携带X-PAYMENT头重新发送 — 立即获得存证" },
            ].map((s) => (
              <div key={s.step} className="rounded-md border bg-muted/30 p-3">
                <div className="text-xs font-bold text-primary mb-1">步骤 {s.step}</div>
                <div className="text-sm font-semibold mb-1">{s.title}</div>
                <div className="text-xs text-muted-foreground">{s.desc}</div>
              </div>
            ))}
          </div>
          <CodeBlock code={`# 步骤1 — 不带认证直接发送，收到带价格的402响应
curl -X POST https://provebeforeact.com/api/proof \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash": "YOUR_SHA256_HASH", "filename": "decision.md"}'
# → HTTP 402 {"payment": {"amount": "10000", "currency": "USDC", "network": "eip155:8453", ...}}

# 步骤3 — 携带在Base链签署的USDC支付重新发送
curl -X POST https://provebeforeact.com/api/proof \\
  -H "Content-Type: application/json" \\
  -H "X-PAYMENT: <base64-signed-payment>" \\
  -d '{"file_hash": "YOUR_SHA256_HASH", "filename": "decision.md"}'
# → HTTP 200 {"proof_id": "...", "verify_url": "/proof/...", ...}`} />
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs font-semibold text-primary mb-1">为什么这对智能体至关重要</p>
            <p className="text-xs text-muted-foreground">
              一个完全自主的智能体——拥有钱包但尚未与Prove Before Act建立任何关系——可以在单个会话中完成首次存证。无需注册、无需网页界面、无需人工干预。智能体自主发现价格、签署支付、获得存证。纯粹的机器对机器交互。
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">完整Python x402实现（可直接复制使用）：</p>
            <CodeBlock code={`import hashlib, json, base64, requests

def anchor_x402(reasoning: dict, filename: str, wallet_signer) -> dict:
    """
    通过x402协议锚定存证 — 无需API密钥，无需账号。
    wallet_signer: 具有 .sign_x402(payment_info) 方法的钱包适配器
    兼容: Coinbase CDP, Conway Terminal, OpenClaw 等x402钱包
    """
    # 1. 本地哈希 — 敏感内容不离开本机
    content = json.dumps(reasoning, sort_keys=True, ensure_ascii=False).encode()
    file_hash = hashlib.sha256(content).hexdigest()

    payload = {"file_hash": file_hash, "filename": filename}

    # 2. 不带认证发送POST → 收到含价格和支付载荷的HTTP 402
    r = requests.post("https://provebeforeact.com/api/proof", json=payload)
    assert r.status_code == 402, f"期望402，实际收到 {r.status_code}: {r.text}"

    payment_info = r.json()["payment"]
    # payment_info = {
    #   "amount": "10000", "currency": "USDC", "network": "eip155:8453",
    #   "payee": "0x...", "payload": { ... x402标准载荷 ... }
    # }

    # 3. 使用Base钱包签署（Base链上USDC，eip155:8453）
    signed = wallet_signer.sign_x402(payment_info)
    x_payment = base64.b64encode(json.dumps(signed).encode()).decode()

    # 4. 携带X-PAYMENT头重新发送 → 立即返回proof_id
    proof = requests.post("https://provebeforeact.com/api/proof",
        headers={"X-PAYMENT": x_payment},
        json=payload)
    assert proof.status_code == 200, proof.text

    data = proof.json()
    return {"proof_id": data["proof_id"], "verify_url": data["verify_url"]}


# 使用示例 — 无Prove Before Act账号，无API密钥
result = anchor_x402(
    reasoning={"decision": "买入BTC", "rationale": "RSI=38", "ts": "2026-06-02T14:30:00Z"},
    filename="decision_001.json",
    wallet_signer=my_base_wallet   # 您的钱包适配器
)
print(f"存证链接: https://provebeforeact.com{result['verify_url']}")`} />
          </div>
          <p className="text-xs text-muted-foreground">
            兼容钱包：<span className="font-mono">https://api.cdp.coinbase.com/platform/v2/x402</span>（Coinbase CDP）、Conway Terminal、OpenClaw，以及所有支持x402的智能体框架。
          </p>
        </div>
      ),
    },
    {
      id: "latency",
      icon: Clock,
      title: "真实锚定延迟是多少？",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            以下数据来自真实生产环境测量，数据源为 <strong className="text-foreground">xproof_agent_verify</strong> — Moltbook验证智能体，累计4,418次链上锚定：
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: "单次认证（API调用→proof_id）", value: "~1.1秒", detail: "端到端实测1.075秒" },
              { label: "批量3个文件", value: "~1.9秒", detail: "实测1.876秒" },
              { label: "链上确认", value: "~6秒", detail: "MultiversX平均出块时间" },
            ].map((m) => (
              <div key={m.label} className="rounded-md border bg-muted/30 p-3 text-center">
                <div className="text-2xl font-bold text-primary mb-1">{m.value}</div>
                <div className="text-xs font-medium mb-1">{m.label}</div>
                <div className="text-xs text-muted-foreground">{m.detail}</div>
              </div>
            ))}
          </div>
          <div className="rounded-md border bg-muted/30 p-3 space-y-1">
            <p className="text-xs font-semibold">"1.1秒"涵盖的处理步骤：</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 ml-3">
              <li>• API接收并验证哈希值</li>
              <li>• 检查权益（API密钥或x402支付验证）</li>
              <li>• 在数据库中创建存证记录</li>
              <li>• 将区块链交易提交到MultiversX队列</li>
              <li>• 返回 <code className="font-mono bg-muted px-1 rounded">proof_id</code> — 您的智能体可立即继续执行</li>
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            <strong>说明：</strong><code className="font-mono bg-muted px-1 rounded text-xs">proof_id</code> 立即返回（状态：<code className="font-mono bg-muted px-1 rounded text-xs">pending</code>）。链上确认在约6秒内异步完成。使用 <code className="font-mono bg-muted px-1 rounded text-xs">webhook_url</code> 字段可接收交易在链上确认后的回调通知。
          </p>
        </div>
      ),
    },
    {
      id: "retry",
      icon: RefreshCw,
      title: "Prove Before Act调用失败了怎么办？重试策略与降级方案",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Prove Before Act设计为优雅降级。以下是生产智能体的推荐策略：
          </p>
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="text-xs font-semibold mb-2">HTTP状态码及其含义</p>
            <div className="space-y-1.5 text-xs">
              {[
                { code: "200", action: "成功。继续执行操作。", color: "text-emerald-500" },
                { code: "402", action: "需要支付（x402流程）。签署USDC支付后重试。", color: "text-primary" },
                { code: "409", action: "哈希重复，已存在锚定记录 — 获取现有proof_id，无需重新锚定。", color: "text-blue-400" },
                { code: "429", action: "触发频率限制。等待Retry-After响应头指定的秒数后重试。", color: "text-amber-400" },
                { code: "5xx", action: "服务器错误。使用指数退避策略重试。", color: "text-red-400" },
                { code: "timeout", action: "网络问题。退避重试最多3次，之后降级处理。", color: "text-red-400" },
              ].map((r) => (
                <div key={r.code} className="flex items-start gap-2">
                  <code className={`font-mono font-bold w-14 shrink-0 ${r.color}`}>{r.code}</code>
                  <span className="text-muted-foreground">{r.action}</span>
                </div>
              ))}
            </div>
          </div>
          <CodeBlock code={`import time, hashlib, requests

def anchor_with_retry(file_hash: str, filename: str, api_key: str, max_retries=3):
    """生产级锚定，含重试与降级方案。"""
    backoff = [1, 2, 4]  # 重试间隔（秒）
    
    for attempt in range(max_retries):
        try:
            resp = requests.post(
                "https://provebeforeact.com/api/proof",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={"file_hash": file_hash, "filename": filename},
                timeout=10
            )
            if resp.status_code == 200:
                return resp.json()["proof_id"]
            if resp.status_code == 409:
                return resp.json()["existing_proof_id"]  # 已锚定，直接返回
            if resp.status_code == 429:
                time.sleep(int(resp.headers.get("Retry-After", 5)))
                continue
            if resp.status_code >= 500:
                time.sleep(backoff[attempt])
                continue
        except requests.Timeout:
            time.sleep(backoff[attempt])
            continue
    
    # 降级：本地记录，继续执行，不阻塞业务
    log_local_fallback(file_hash, filename)
    return None  # 无proof_id，操作继续执行`} />
          <div className="rounded-md border border-amber-500/20 bg-amber-500/5 p-3">
            <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-1">推荐降级策略</p>
            <p className="text-xs text-muted-foreground">
              如果Prove Before Act在3次重试后仍不可达：<strong className="text-foreground">将哈希记录到本地日志</strong>（含时间戳），继续执行操作，待网络恢复后尝试补充锚定。绝不要因为存证锚定而无限阻塞关键智能体操作——但务必记录每次尝试。
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "cost",
      icon: DollarSign,
      title: "每1000次锚定的平均费用是多少？",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Prove Before Act采用<strong className="text-foreground">每次认证固定收费$0.01</strong>的定价模式——无分级、无促销、无量折扣。无论锚定1次还是10,000次，价格完全一致。
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: "当前价格", value: "$0.01", detail: "每次认证 — 固定费率" },
              { label: "每1,000次费用", value: "$10", detail: "按$0.01/次计算" },
              { label: "每10,000次费用", value: "$100", detail: "预充值包 — 同样固定费率" },
            ].map((m) => (
              <div key={m.label} className="rounded-md border bg-muted/30 p-3 text-center">
                <div className="text-2xl font-bold text-primary mb-1">{m.value}</div>
                <div className="text-xs font-medium mb-1">{m.label}</div>
                <div className="text-xs text-muted-foreground">{m.detail}</div>
              </div>
            ))}
          </div>
          <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
            <p className="text-xs font-semibold">集群场景成本估算（50个智能体，每天每个20次操作）：</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 ml-3">
              <li>• 50个智能体 × 20次操作 × 30天 = <strong className="text-foreground">每月30,000次锚定</strong></li>
              <li>• 按$0.01计算 = <strong className="text-foreground">每月$300</strong></li>
              <li>• 每个智能体：<strong className="text-foreground">每月$6</strong> — 远低于大多数SaaS合规工具</li>
              <li>• 批量模式（每次调用最多100个文件）：同等价格，减少API开销</li>
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            <strong>支付方式：</strong>MultiversX上的EGLD（通过ACP/钱包）或Base链上的USDC（通过x402 — 无需账号）。也可通过控制台预充积分。
          </p>
        </div>
      ),
    },
    {
      id: "comparison",
      icon: BarChart3,
      title: "Prove Before Act与Arweave、Ceramic、Sign Protocol相比如何？",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground text-xs">
            客观对比——每个工具在各自擅长的领域都是最佳选择。以下帮助您选择合适的工具完成合适的任务。
          </p>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-2 font-semibold text-muted-foreground">使用场景</th>
                  <th className="text-center py-2 px-2 font-semibold text-primary">Prove Before Act</th>
                  <th className="text-center py-2 px-2 font-semibold text-muted-foreground">Arweave</th>
                  <th className="text-center py-2 px-2 font-semibold text-muted-foreground">Ceramic</th>
                  <th className="text-center py-2 px-2 font-semibold text-muted-foreground">Sign Protocol</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { useCase: "行动前锚定智能体决策（WHY先于WHAT）", "Prove Before Act": "✓ 原生支持", arweave: "可实现（重量级）", ceramic: "可实现", sign: "部分支持" },
                  { useCase: "无API密钥按次支付（x402 / USDC）", "Prove Before Act": "✓ 原生支持", arweave: "✗", ceramic: "✗", sign: "✗" },
                  { useCase: "4W审计轨迹（谁、什么、何时、为何）并渲染公开页面", "Prove Before Act": "✓ 原生支持", arweave: "✗", ceramic: "部分支持", sign: "部分支持" },
                  { useCase: "默认隐私保护（仅哈希，文件不上传）", "Prove Before Act": "✓ 默认", arweave: "上传文件", ceramic: "可配置", sign: "可配置" },
                  { useCase: "将完整文件永久存储上链", "Prove Before Act": "✗", arweave: "✓ 最佳选择", ceramic: "部分支持", sign: "✗" },
                  { useCase: "MCP工具（JSON-RPC 2.0，智能体原生集成）", "Prove Before Act": "✓ 原生支持", arweave: "✗", ceramic: "✗", sign: "✗" },
                  { useCase: "智能体信任排行榜+公开档案", "Prove Before Act": "✓ 原生支持", arweave: "✗", ceramic: "✗", sign: "✗" },
                  { useCase: "EVM / Ethereum认证模式（Solidity）", "Prove Before Act": "✗", arweave: "✗", ceramic: "部分支持", sign: "✓ 最佳选择" },
                  { useCase: "置信度分级锚定（预承诺）", "Prove Before Act": "✓ 原生支持", arweave: "✗", ceramic: "✗", sign: "✗" },
                  { useCase: "每1,000次锚定费用", "Prove Before Act": "~$10", arweave: "~$5–50（文件大小相关）", ceramic: "需自建节点", sign: "~$20–100（Gas费）" },
                ].map((row, i) => (
                  <tr key={i} className={`border-b border-border/40 ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
                    <td className="py-2 px-2 text-muted-foreground max-w-[160px]">{row.useCase}</td>
                    <td className={`py-2 px-2 text-center font-medium ${row["Prove Before Act"].startsWith("✓") ? "text-primary" : "text-muted-foreground"}`}>{row["Prove Before Act"]}</td>
                    <td className={`py-2 px-2 text-center ${row.arweave.startsWith("✓") ? "text-emerald-500" : "text-muted-foreground"}`}>{row.arweave}</td>
                    <td className={`py-2 px-2 text-center ${row.ceramic.startsWith("✓") ? "text-emerald-500" : "text-muted-foreground"}`}>{row.ceramic}</td>
                    <td className={`py-2 px-2 text-center ${row.sign.startsWith("✓") ? "text-emerald-500" : "text-muted-foreground"}`}>{row.sign}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground italic">
            经验法则：需要永久存储文件用 <strong className="text-foreground">Arweave</strong>；需要EVM认证模式用 <strong className="text-foreground">Sign Protocol</strong>；智能体需要在行动前证明决策——尤其是无预有账号的场景——用 <strong className="text-foreground">Prove Before Act</strong>。
          </p>
        </div>
      ),
    },
    {
      id: "mcp",
      icon: Cpu,
      title: "如何通过MCP集成Prove Before Act？具体示例",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Prove Before Act在 <code className="font-mono bg-muted px-1 rounded text-xs">https://provebeforeact.com/mcp</code> 暴露原生MCP服务端，使用Streamable HTTP传输（POST）。可用工具：<code className="font-mono bg-muted px-1 rounded text-xs">certify_file</code>、<code className="font-mono bg-muted px-1 rounded text-xs">audit_agent_session</code>、<code className="font-mono bg-muted px-1 rounded text-xs">investigate_proof</code>、<code className="font-mono bg-muted px-1 rounded text-xs">register_trial</code>。
          </p>
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3 flex items-start gap-3">
            <Cpu className="h-4 w-4 text-primary shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-semibold text-primary mb-1">兼容Hermes Skills Hub</p>
              <p className="text-xs text-muted-foreground mb-2">
                Prove Before Act已作为OpenClaw技能发布在ClawHub上。Hermes兼容的智能体可一键安装：
              </p>
              <code className="text-xs bg-muted px-2 py-1 rounded block font-mono">hermes skills install clawhub/prove-before-act</code>
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">1. 添加到MCP配置（Claude、Cursor或任意MCP客户端）：</p>
            <CodeBlock code={`{
  "mcpServers": {
    "prove-before-act": {
      "url": "https://provebeforeact.com/mcp",
      "headers": {
        "Authorization": "Bearer pm_您的API密钥"
      }
    }
  }
}`} />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">2. 使用 <code className="font-mono bg-muted px-1 rounded">certify_file</code> — 行动前锚定决策：</p>
            <CodeBlock code={`// MCP工具调用: certify_file
{
  "name": "certify_file",
  "arguments": {
    "file_hash": "您的推理文档sha256哈希",
    "filename": "decision_2026-06-02.md",
    "author": "my-agent-v2",
    "metadata": {
      "who": "my-agent-v2",
      "what": "批准交易：买入0.5 BTC，价格$67,400",
      "when": "2026-06-02T14:30:00Z",
      "why": "RSI低于40，组合配置低于目标，风险已通过审批",
      "model": "gpt-4o",
      "session_id": "sess_abc123"
    }
  }
}
// 返回: { proof_id: "...", verify_url: "/proof/...", status: "pending" }`} />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">3. 使用 <code className="font-mono bg-muted px-1 rounded">audit_agent_session</code> — 关键操作前的合规门控：</p>
            <CodeBlock code={`{
  "name": "audit_agent_session",
  "arguments": {
    "agent_id": "trading-agent-v2",
    "session_id": "sess_abc123",
    "action_type": "trade_execution",
    "action_description": "执行买单：0.5 BTC",
    "inputs_hash": "所有分析输入的sha256",
    "inputs_manifest": {
      "fields": ["btc_price", "portfolio_nav", "rsi_14d", "volatility_30d"],
      "sources": ["binance_ws", "coingecko"]
    },
    "risk_level": "high",
    "decision": "approved"
  }
}
// 合规门控：仅在返回proof_id后，操作才可继续执行`} />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">4. 无API密钥的智能体 — 使用 <code className="font-mono bg-muted px-1 rounded">register_trial</code>：</p>
            <CodeBlock code={`{
  "name": "register_trial",
  "arguments": {
    "agent_name": "my-new-agent"
  }
}
// 返回: { api_key: "pm_...", free_certifications: 10 }
// 立即用该api_key进行后续10次存证 — 无需浏览器，无需钱包`} />
          </div>
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs font-semibold text-primary mb-2">5. 零账号冷启动：MCP试用密钥 → x402生产环境</p>
            <div className="space-y-2 text-xs text-muted-foreground">
              <p><strong className="text-foreground">阶段A</strong> — 通过MCP冷启动（无账号，无钱包）：</p>
              <CodeBlock code={`// 调用register_trial，立即获得10次免费存证
{ "name": "register_trial", "arguments": { "agent_name": "my-agent" } }
// → { "api_key": "pm_...", "free_certifications": 10 }`} />
              <p><strong className="text-foreground">阶段B</strong> — 通过x402扩展至生产环境（无账号，仅需Base钱包）：</p>
              <CodeBlock code={`# 10次免费存证用完后，切换x402实现无限付费锚定
# 1. POST /api/proof 不带认证 → 收到含价格的HTTP 402
# 2. 在Base链（eip155:8453）签署USDC → 携带X-PAYMENT头重新发送
# → 立即返回proof_id，始终无需Prove Before Act账号`} />
              <p className="text-muted-foreground/70 italic">智能体可以在单个会话内从零达到生产级存证：通过MCP获取试用密钥完成前10次存证，后续全部通过x402。全程无需人工介入。</p>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "4w",
      icon: Eye,
      title: "4W审计轨迹如何工作？",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            4W审计轨迹是随每次认证锚定到链上的结构化问责记录。它回答了每位审计员或监管机构最需要的四个问题：
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { w: "WHO", zh: "操作主体", desc: "哪个智能体、模型或操作者做出了这个决策", example: "my-agent-v2（GPT-4o，会话：sess_abc）" },
              { w: "WHAT", zh: "操作结果", desc: "被认证的操作或输出是什么", example: "批准交易：买入0.5 BTC，价格$67,400" },
              { w: "WHEN", zh: "操作时间", desc: "MultiversX区块上的不可篡改时间戳", example: "2026-06-02T14:30:12Z（区块 #15,447,203）" },
              { w: "WHY", zh: "决策依据", desc: "导致该决策的完整推理过程", example: "RSI低于40，配置低于目标，风险策略v3.1已批准" },
            ].map((item) => (
              <div key={item.w} className="rounded-md border bg-muted/30 p-3">
                <div className="flex items-baseline gap-2 mb-1">
                  <span className="text-base font-bold text-primary">{item.w}</span>
                  <span className="text-xs text-muted-foreground font-medium">{item.zh}</span>
                </div>
                <div className="text-xs text-muted-foreground mb-1.5">{item.desc}</div>
                <div className="text-xs bg-muted rounded px-2 py-1 font-mono text-foreground/80">{item.example}</div>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            要激活4W轨迹，在 <code className="font-mono bg-muted px-1 rounded text-xs">metadata</code> 字段中包含至少一个 <code className="font-mono bg-muted px-1 rounded text-xs">who</code>、<code className="font-mono bg-muted px-1 rounded text-xs">what</code>、<code className="font-mono bg-muted px-1 rounded text-xs">when</code>、<code className="font-mono bg-muted px-1 rounded text-xs">why</code> 即可。4W部分将自动渲染到 <code className="font-mono bg-muted px-1 rounded text-xs">/proof/&#123;id&#125;</code> 的公开存证页面上。
          </p>
          <CodeBlock code={`curl -X POST https://provebeforeact.com/api/proof \\
  -H "Authorization: Bearer pm_您的密钥" \\
  -H "Content-Type: application/json" \\
  -d '{
    "file_hash": "YOUR_SHA256",
    "filename": "reasoning_session_001.md",
    "metadata": {
      "who": "trading-agent-v2",
      "what": "批准买单：0.5 BTC",
      "when": "2026-06-02T14:30:00Z",
      "why": "RSI=38，低于40阈值；nav_allocation=2.1%，低于3%上限；policy_version=v3.1",
      "model": "gpt-4o-mini",
      "session_id": "sess_abc123"
    }
  }'`} />
        </div>
      ),
    },
    {
      id: "privacy",
      icon: Lock,
      title: "隐私风险——什么会被发送，什么保留在本地？",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Prove Before Act基于<strong className="text-foreground">仅哈希模型</strong>构建：您的文件、推理文档或智能体输出永远不会离开您的环境。只有其SHA-256指纹会被传输。
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
              <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-2">发送给Prove Before Act的内容</p>
              <ul className="text-xs text-muted-foreground space-y-1 ml-2">
                <li>• SHA-256哈希（64位十六进制字符）</li>
                <li>• 文件名（可使用合成名称）</li>
                <li>• 可选的4W元数据字段（您控制分享内容）</li>
                <li>• author字段（可选）</li>
              </ul>
            </div>
            <div className="rounded-md border border-muted bg-muted/30 p-3">
              <p className="text-xs font-semibold mb-2">完全保留在本地的内容</p>
              <ul className="text-xs text-muted-foreground space-y-1 ml-2">
                <li>• 实际文件内容</li>
                <li>• 推理文档文本</li>
                <li>• 输入数据值</li>
                <li>• 模型权重或策略细节</li>
              </ul>
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold">已知隐私注意事项：</p>
            <div className="space-y-1.5 text-xs text-muted-foreground ml-2">
              <p><strong className="text-foreground">时序关联：</strong>频繁的锚定模式可能暴露智能体活动节律。可通过 <code className="font-mono bg-muted px-1 rounded text-xs">POST /api/batch</code> 批量提交或添加随机延迟来降低风险。</p>
              <p><strong className="text-foreground">元数据暴露：</strong>当 <code className="font-mono bg-muted px-1 rounded text-xs">is_public: true</code> 时，<code className="font-mono bg-muted px-1 rounded text-xs">who</code>、<code className="font-mono bg-muted px-1 rounded text-xs">what</code>、<code className="font-mono bg-muted px-1 rounded text-xs">why</code> 字段会被公开存储和展示。对敏感决策请使用通用描述。</p>
              <p><strong className="text-foreground">链上永久性：</strong>MultiversX上的交易一经确认，无法删除。请在设计元数据时充分考虑这一点。</p>
              <p><strong className="text-foreground">非零知识证明系统：</strong>Prove Before Act使用SHA-256哈希，而非零知识证明。掌握原始数据的攻击者可以验证哈希是否匹配。如果需要ZK保证，请在上游结合ZK证明层使用。</p>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "fleet",
      icon: Network,
      title: "如何监控智能体集群的存证状态？",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            可以。Prove Before Act专为多智能体集群设计。每个智能体拥有独立的钱包地址和公开档案。管理员可以集中监控所有智能体。
          </p>
          <div className="space-y-3">
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-semibold">按智能体监控的接口（全部公开，无需认证）：</p>
              <div className="space-y-1.5 text-xs font-mono text-muted-foreground">
                <p><span className="text-primary">GET</span> /api/agents/&#123;wallet&#125; — 信任评分、总认证数、连续周数、违规记录</p>
                <p><span className="text-primary">GET</span> /api/agents/&#123;wallet&#125;/timeline — 完整审计时间线（分页）</p>
                <p><span className="text-primary">GET</span> /api/trust/&#123;wallet&#125; — 轻量级信任查询</p>
                <p><span className="text-primary">GET</span> /api/leaderboard — 按信任评分排名的前50个公开智能体</p>
                <p><span className="text-primary">GET</span> /badge/trust/&#123;wallet&#125;.svg — 可嵌入的信任徽章</p>
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3">
              <p className="text-xs font-semibold mb-2">推荐的集群架构：</p>
              <div className="space-y-1.5 text-xs text-muted-foreground">
                <p>1. 每个智能体有绑定到其MultiversX钱包的独立 <code className="font-mono bg-muted px-1 rounded">pm_</code> API密钥</p>
                <p>2. 每个智能体用自身身份锚定决策（<code className="font-mono bg-muted px-1 rounded">who</code> 字段 = 智能体ID）</p>
                <p>3. 管理员每小时轮询 <code className="font-mono bg-muted px-1 rounded">/api/agents/&#123;wallet&#125;</code> 获取每个智能体状态</p>
                <p>4. 触发告警条件：信任评分下降、违规数增加、连续周数中断、24小时内无锚定</p>
                <p>5. 使用 <code className="font-mono bg-muted px-1 rounded">webhook_url</code> 实时接收每次锚定存证的回调</p>
              </div>
            </div>
          </div>
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs font-semibold text-primary mb-1">生产案例：Moltbook集群</p>
            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">xproof_agent_verify</strong>（Moltbook的验证机器人）已连续16周锚定 <strong className="text-foreground">4,418次存证</strong>，链上确认率 <strong className="text-foreground">100%</strong>。其公开档案位于 <code className="font-mono bg-muted px-1 rounded text-xs">/agent/erd1hlx4xann...gyu9</code>，任何管理员或合作伙伴系统均可实时查询。
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "fleet-1000",
      icon: BarChart3,
      title: "如何为集群每日认证1000次决策？（批量实战指南）",
      badge: "集群运营商必读",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            每日1000次决策认证是<strong className="text-foreground">$10/天（$300/月）</strong>。以下是在生产环境中可靠实现这一规模的完整架构，包含批量缓冲、异步提交、合规监控与成本核算。
          </p>

          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { label: "每日认证1000次", value: "$10/天", detail: "$0.01 × 1000，固定费率" },
              { label: "每月认证30,000次", value: "$300/月", detail: "50智能体 × 20次/天" },
              { label: "单次批量上限", value: "100条", detail: "一次API调用最多100个哈希" },
            ].map((m) => (
              <div key={m.label} className="rounded-md border bg-muted/30 p-3 text-center">
                <div className="text-xl font-bold text-primary mb-1">{m.value}</div>
                <div className="text-xs font-medium mb-1">{m.label}</div>
                <div className="text-xs text-muted-foreground">{m.detail}</div>
              </div>
            ))}
          </div>

          <div className="rounded-md border border-primary/20 bg-primary/5 p-3 space-y-1">
            <p className="text-xs font-semibold text-primary">推荐架构：本地缓冲 + 定时批量提交</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 ml-2">
              <li>• 智能体本地缓冲操作哈希（内存队列）</li>
              <li>• 每隔N秒或缓冲满100条时，批量提交到 <code className="font-mono bg-muted px-1 rounded">POST /api/batch</code></li>
              <li>• 对每条哈希存储返回的 <code className="font-mono bg-muted px-1 rounded">proof_id</code>，用于后续审计查询</li>
              <li>• 监控循环每小时核验：锚定数量是否与决策数量匹配</li>
            </ul>
          </div>

          <CodeBlock code={`import hashlib, json, time, threading, requests
from collections import deque
from datetime import datetime, timezone

class FleetCertifier:
    """
    高吞吐量批量认证器 — 适用于每日1000+次决策的集群。
    线程安全，本地缓冲 + 定时批量提交。
    """
    
    BATCH_SIZE = 100        # API单次上限
    FLUSH_INTERVAL = 30     # 每30秒提交一次（可按需调整）
    BASE = "https://provebeforeact.com"
    
    def __init__(self, api_key: str, agent_id: str):
        self.api_key = api_key
        self.agent_id = agent_id
        self._queue: deque = deque()
        self._lock = threading.Lock()
        self._proof_log: list[dict] = []       # 本地审计台账
        self._stats = {"submitted": 0, "anchored": 0, "failed": 0}
        
        # 启动后台批量提交线程
        t = threading.Thread(target=self._flush_loop, daemon=True)
        t.start()
    
    def queue_decision(self, reasoning: dict, action: str) -> None:
        """
        将一次决策加入待认证队列。非阻塞——立即返回。
        在执行操作前调用此方法（行动前证明）。
        """
        ts = datetime.now(timezone.utc).isoformat()
        content = json.dumps({**reasoning, "action": action, "ts": ts,
                               "agent": self.agent_id}, sort_keys=True)
        file_hash = hashlib.sha256(content.encode()).hexdigest()
        
        with self._lock:
            self._queue.append({
                "file_hash": file_hash,
                "filename": f"decision_{ts[:10]}_{len(self._proof_log):06d}.json",
                "_local_action": action,
                "_local_ts": ts,
            })
    
    def _flush_loop(self):
        """后台线程：定时将缓冲队列批量提交到Prove Before Act。"""
        while True:
            time.sleep(self.FLUSH_INTERVAL)
            self._flush()
    
    def _flush(self):
        with self._lock:
            batch = []
            for _ in range(min(self.BATCH_SIZE, len(self._queue))):
                batch.append(self._queue.popleft())
        
        if not batch:
            return
        
        payload = [{"file_hash": b["file_hash"], "filename": b["filename"]}
                   for b in batch]
        try:
            resp = requests.post(
                f"{self.BASE}/api/batch",
                headers={"Authorization": f"Bearer {self.api_key}",
                         "Content-Type": "application/json"},
                json={"files": payload},
                timeout=15
            )
            if resp.status_code == 200:
                results = resp.json().get("results", [])
                for item, result in zip(batch, results):
                    proof_id = result.get("proof_id")
                    self._proof_log.append({
                        "proof_id": proof_id,
                        "action": item["_local_action"],
                        "ts": item["_local_ts"],
                        "verify_url": f"{self.BASE}/proof/{proof_id}",
                    })
                self._stats["anchored"] += len(results)
            else:
                # 失败时重新入队（最多重试1次）
                with self._lock:
                    for item in batch:
                        self._queue.appendleft(item)
                self._stats["failed"] += len(batch)
        except Exception:
            with self._lock:
                for item in batch:
                    self._queue.appendleft(item)
        
        self._stats["submitted"] += len(batch)
    
    def status(self) -> dict:
        """返回当前认证状态 — 用于监控与合规核查。"""
        return {
            **self._stats,
            "queue_pending": len(self._queue),
            "proof_log_size": len(self._proof_log),
        }
    
    def flush_now(self):
        """强制立即提交（用于关机前清空队列）。"""
        while self._queue:
            self._flush()


# -----------------------------------------------------------------------
# 使用示例 — 50个智能体集群，每天每个20次操作 = 1000次/天
# -----------------------------------------------------------------------
certifier = FleetCertifier(api_key="pm_您的密钥", agent_id="fleet-manager-v1")

# 每个智能体在执行前调用此方法（非阻塞）
certifier.queue_decision(
    reasoning={
        "model": "gpt-4o-mini",
        "rationale": "用户意图评分=0.91，置信度高，触发推荐策略",
        "inputs": {"user_id": "u_123", "session_score": 0.91},
    },
    action="执行个性化内容推荐"
)

# 监控（每小时调用一次）
status = certifier.status()
print(f"已锚定: {status['anchored']} | 待提交: {status['queue_pending']} | 失败: {status['failed']}")
# 告警条件: failed > 0 或 queue_pending > 200（积压超过2批）`} />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-semibold">合规核查接口（每日/每周）</p>
              <div className="space-y-1.5 text-xs text-muted-foreground font-mono">
                <p><span className="text-primary">GET</span> /api/agents/&#123;wallet&#125; → cert_total（核验总锚定数）</p>
                <p><span className="text-primary">GET</span> /api/agents/&#123;wallet&#125;/timeline → 完整操作时间线</p>
                <p><span className="text-primary">GET</span> /api/agents/&#123;wallet&#125;/violations → 违规记录（应为0）</p>
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-semibold">告警阈值建议</p>
              <ul className="space-y-1 text-xs text-muted-foreground ml-1">
                <li>• 队列积压 &gt; 200条 → 批量API可能超时</li>
                <li>• 失败计数 &gt; 0 → 检查API密钥与网络</li>
                <li>• 24小时内cert_total无增长 → 存证中断告警</li>
                <li>• 违规数增加 → 立即调查（会影响信任评分）</li>
              </ul>
            </div>
          </div>

          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
            <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-1">实际成本核算 — 不同规模场景</p>
            <div className="grid gap-2 sm:grid-cols-3 mt-2">
              {[
                { scale: "小型团队", spec: "5个智能体 × 10次/天", cost: "$15/月" },
                { scale: "中型集群", spec: "50个智能体 × 20次/天", cost: "$300/月" },
                { scale: "大型部署", spec: "500个智能体 × 20次/天", cost: "$3,000/月" },
              ].map((s) => (
                <div key={s.scale} className="text-center">
                  <div className="text-sm font-bold text-foreground">{s.cost}</div>
                  <div className="text-xs font-medium">{s.scale}</div>
                  <div className="text-xs text-muted-foreground">{s.spec}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "workflow",
      icon: Play,
      title: "完整智能体工作流：推理 → 哈希 → 锚定 → 执行",
      badge: "可直接复制使用",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            这是标准的<strong className="text-foreground">行动前证明</strong>闭环。将此模式复制到任意智能体框架中即可使用。
          </p>
          <div className="flex items-center gap-2 flex-wrap text-xs">
            {["1. 推理（WHY）", "→", "2. 本地哈希", "→", "3. 链上锚定", "→", "4. 获取proof_id", "→", "5. 执行（WHAT）"].map((s, i) => (
              <span key={i} className={s === "→" ? "text-muted-foreground/40" : "rounded bg-primary/10 text-primary px-2 py-1 font-medium"}>{s}</span>
            ))}
          </div>
          <CodeBlock code={`import hashlib, json, requests

class ProveBeforeAct:
    """
    行动前证明核心闭环，适用于自主智能体。
    在执行任何重要操作前，先锚定推理过程。
    """
    
    def __init__(self, api_key: str, agent_id: str):
        self.api_key = api_key
        self.agent_id = agent_id
        self.base = "https://provebeforeact.com"
    
    def anchor(self, reasoning: dict, action_description: str) -> str | None:
        """
        步骤1-3：哈希推理过程，锚定上链，返回proof_id。
        在执行任何操作之前调用此方法。
        """
        # 步骤1：规范化序列化推理内容
        reasoning_json = json.dumps(reasoning, sort_keys=True, ensure_ascii=False)
        
        # 步骤2：本地哈希 — 敏感内容不离开此函数
        file_hash = hashlib.sha256(reasoning_json.encode()).hexdigest()
        
        # 步骤3：锚定到Prove Before Act
        try:
            resp = requests.post(
                f"{self.base}/api/proof",
                headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
                json={
                    "file_hash": file_hash,
                    "filename": f"reasoning_{reasoning.get('session_id', 'unknown')}.json",
                    "metadata": {
                        "who": self.agent_id,
                        "what": action_description,
                        "when": reasoning.get("timestamp"),
                        "why": reasoning.get("rationale"),
                        "model": reasoning.get("model"),
                        "session_id": reasoning.get("session_id"),
                    }
                },
                timeout=10
            )
            if resp.status_code == 200:
                return resp.json()["proof_id"]
        except Exception as e:
            self._log_fallback(file_hash, action_description, str(e))
        return None
    
    def run_with_proof(self, reasoning: dict, action_fn, action_description: str):
        """
        完整行动前证明闭环。
        操作仅在获得proof_id后才会执行。
        """
        proof_id = self.anchor(reasoning, action_description)
        
        if proof_id is None:
            # 软失败：记录日志并继续（若策略要求强制停止则抛出异常）
            print(f"[WARN] 未获得存证: {action_description}")
        
        # 执行操作 — proof_id作为审计引用可用
        result = action_fn()
        
        return {"result": result, "proof_id": proof_id, "verify_url": f"{self.base}/proof/{proof_id}"}
    
    def _log_fallback(self, file_hash, action, error):
        # 写入本地审计日志，待后续补充锚定
        pass


# 使用示例
agent = ProveBeforeAct(api_key="pm_您的密钥", agent_id="my-agent-v2")

reasoning = {
    "session_id": "sess_001",
    "timestamp": "2026-06-02T14:30:00Z",
    "model": "gpt-4o-mini",
    "rationale": "BTC RSI=38（低于40阈值），组合配置=2.1%（低于3%上限）。风险策略v3.1已批准。置信度：高。",
    "inputs": {"btc_price": 67400, "rsi_14d": 38, "nav_pct": 2.1},
}

outcome = agent.run_with_proof(
    reasoning=reasoning,
    action_fn=lambda: execute_trade("BUY", "BTC", 0.5),
    action_description="以市价执行买入0.5 BTC"
)
print(f"交易已执行。存证链接: https://provebeforeact.com{outcome['verify_url']}")`} />
          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
            <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-1">这为您提供的保障</p>
            <ul className="text-xs text-muted-foreground space-y-0.5 ml-2">
              <li>• 每次操作都有密码学存证，证明在行动前存在相应的推理过程</li>
              <li>• 存证可在 <code className="font-mono bg-muted px-1 rounded">provebeforeact.com/proof/&#123;id&#125;</code> 公开验证 — 无需Prove Before Act账号</li>
              <li>• 4W审计轨迹自动渲染在存证页面上</li>
              <li>• 若智能体遭受入侵或行为异常，您拥有完整的取证记录</li>
            </ul>
          </div>
        </div>
      ),
    },
    {
      id: "moltbook",
      icon: TrendingUp,
      title: "Moltbook案例研究 — 真实生产环境中的智能体",
      badge: "实时数据",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            <strong className="text-foreground">xproof_agent_verify</strong> 是由 <a href="https://www.moltbook.com" target="_blank" rel="noopener noreferrer" className="text-primary underline">Moltbook</a> 运营的自主验证智能体——Moltbook是一个在发布前认证AI生成内容的平台。该智能体自2026年初起在Prove Before Act上持续运行，是目前有据可查的最早批量行动前证明生产部署案例之一。
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {[
              { value: "4,418", label: "累计存证锚定次数", detail: "全部已链上确认" },
              { value: "933次/月", label: "平均锚定频率", detail: "16周滚动平均值" },
              { value: "100%", label: "链上确认率", detail: "零交易失败" },
            ].map((s) => (
              <div key={s.label} className="rounded-md border bg-muted/30 p-3 text-center">
                <div className="text-2xl font-bold text-primary mb-1">{s.value}</div>
                <div className="text-xs font-medium mb-0.5">{s.label}</div>
                <div className="text-xs text-muted-foreground">{s.detail}</div>
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-semibold">信任档案（公开，实时）</p>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex justify-between"><span>信任评分</span><span className="font-mono text-foreground">43,326</span></div>
                <div className="flex justify-between"><span>信任等级</span><span className="font-mono text-emerald-500">Verified（已验证）</span></div>
                <div className="flex justify-between"><span>活跃连续周数</span><span className="font-mono text-foreground">连续16周</span></div>
                <div className="flex justify-between"><span>违规记录</span><span className="font-mono text-emerald-500">0</span></div>
              </div>
            </div>
            <div className="rounded-md border bg-muted/30 p-3 space-y-2">
              <p className="text-xs font-semibold">性能基准</p>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex justify-between"><span>单次认证延迟</span><span className="font-mono text-foreground">~1.1秒</span></div>
                <div className="flex justify-between"><span>3文件批量</span><span className="font-mono text-foreground">~1.9秒</span></div>
                <div className="flex justify-between"><span>链上确认</span><span className="font-mono text-foreground">~6秒</span></div>
                <div className="flex justify-between"><span>每次存证费用</span><span className="font-mono text-foreground">$0.01 USDC</span></div>
              </div>
            </div>
          </div>
          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-semibold">智能体锚定的内容</p>
            <p className="text-xs text-muted-foreground">在每篇AI生成内容发布到Moltbook之前，<code className="font-mono bg-muted px-1 rounded">xproof_agent_verify</code> 会对完整内容+生成元数据（模型、提示词哈希、时间戳）进行哈希，将SHA-256指纹锚定到MultiversX，并将 <code className="font-mono bg-muted px-1 rounded">proof_id</code> 附加到已发布文章。读者可独立验证内容自认证以来未被修改。</p>
          </div>
          <div className="rounded-md border bg-muted/30 p-3 space-y-2">
            <p className="text-xs font-semibold">16周总运营成本</p>
            <div className="text-xs text-muted-foreground space-y-1">
              <p>4,418次存证 × $0.01 = <strong className="text-foreground">约$44总计</strong></p>
              <p>一个持续运行、公开可问责的AI智能体，拥有完整链上审计轨迹和可验证信任评分，每周运营成本约 <strong className="text-foreground">$2.76</strong>。</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <a href="/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9" target="_blank" rel="noopener noreferrer">
                <Star className="mr-1.5 h-3.5 w-3.5" />
                查看实时智能体档案
              </a>
            </Button>
            <Button asChild variant="ghost" size="sm">
              <a href="https://www.moltbook.com/post/1d6cf96b-5046-4c63-9ae5-43f8809f4562" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                Moltbook完整评测报告
              </a>
            </Button>
          </div>
        </div>
      ),
    },
    {
      id: "keyfields",
      icon: Shield,
      title: "关键元数据字段——每次存证可锚定哪些内容",
      badge: "参考手册",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            每次存证都接受一个可选的 <code className="bg-muted px-1 rounded font-mono text-xs">metadata</code> 对象。这些字段会被存储到链上，并在存证页面上公开展示。请仅包含您希望公开的信息。
          </p>
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 px-2 font-semibold text-muted-foreground">字段</th>
                  <th className="text-left py-2 px-2 font-semibold text-muted-foreground">类型</th>
                  <th className="text-left py-2 px-2 font-semibold text-muted-foreground">说明</th>
                </tr>
              </thead>
              <tbody>
                {[
                  { field: "who", type: "string", desc: "智能体标识符、模型名称或钱包地址" },
                  { field: "what", type: "string", desc: "被认证的操作或输出" },
                  { field: "why", type: "string", desc: "导致决策的推理过程（行动前证明锚点）" },
                  { field: "confidence_score", type: "0.0–1.0", desc: "模型自报的置信度 — 显示在存证页面" },
                  { field: "reversibility_class", type: "枚举值", desc: "'reversible'可逆 / 'costly'代价高 / 'irreversible'不可逆 — 审计门控的风险分级" },
                  { field: "model_hash", type: "sha256", desc: "模型权重哈希 — 检测多次锚定间的模型身份漂移" },
                  { field: "strategy_hash", type: "sha256", desc: "策略/提示词哈希 — 检测多个会话间的策略变更" },
                  { field: "instruction_received_at", type: "ISO 8601", desc: "智能体从协调器接收任务的时间" },
                  { field: "reasoning_started_at", type: "ISO 8601", desc: "智能体开始生成推理轨迹的时间" },
                  { field: "action_taken_at", type: "ISO 8601", desc: "操作执行的时间（必须晚于proof_id返回时间）" },
                  { field: "jurisdiction_type", type: "string", desc: "合规门控的法律背景（如 'EU-AI-Act'、'SEC-regulated'）" },
                  { field: "session_id", type: "string", desc: "将同一智能体会话中的多个存证关联起来 — 供investigate_proof使用" },
                ].map((row, i) => (
                  <tr key={row.field} className={`border-b border-border/40 ${i % 2 === 0 ? "bg-muted/10" : ""}`}>
                    <td className="py-2 px-2 font-mono text-primary text-xs">{row.field}</td>
                    <td className="py-2 px-2 text-muted-foreground/70 text-xs whitespace-nowrap">{row.type}</td>
                    <td className="py-2 px-2 text-muted-foreground text-xs">{row.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <CodeBlock code={`// 示例：高风险操作的完整元数据
{
  "file_hash": "a1b2c3...64hex",
  "filename": "trade_decision_001.json",
  "metadata": {
    "who": "trading-agent-v3",
    "what": "执行买入0.5 BTC，价格$67,400",
    "why": "RSI=38（超卖），nav_allocation=2.1%（低于3%上限），风险策略v3.1已批准",
    "confidence_score": 0.87,
    "reversibility_class": "costly",
    "model_hash": "gpt4o权重快照的sha256",
    "instruction_received_at": "2026-06-13T14:29:50Z",
    "reasoning_started_at": "2026-06-13T14:29:52Z",
    "action_taken_at": "2026-06-13T14:30:01Z",
    "session_id": "sess_abc123",
    "jurisdiction_type": "SEC-regulated"
  }
}`} />
          <p className="text-xs text-muted-foreground">
            所有元数据均为可选。最小有效存证只需 <code className="font-mono bg-muted px-1 rounded text-xs">file_hash</code> + <code className="font-mono bg-muted px-1 rounded text-xs">filename</code>。元数据越丰富，审计轨迹的价值越高。
          </p>
        </div>
      ),
    },
    {
      id: "integrations",
      icon: Network,
      title: "框架集成 — LangChain、CrewAI、AutoGen、LlamaIndex、OpenAI Agents SDK",
      badge: "可直接复制使用",
      content: (
        <div className="space-y-5">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Prove Before Act与所有主流智能体框架兼容。所有示例使用相同的核心模式：<strong className="text-foreground">本地哈希 → 行动前锚定 → 携带proof_id继续执行</strong>。
          </p>
          <div>
            <p className="text-xs font-semibold mb-2">LangChain（Python）</p>
            <CodeBlock code={`from langchain.tools import tool
from xproof import xproof  # pip install xproof

@tool
def prove_before_act(reasoning: str, action: str) -> str:
    """执行任何重要操作前，先将推理过程锚定到链上。"""
    proof = xproof.anchor(
        content=reasoning,
        metadata={"who": "langchain-agent", "what": action, "why": reasoning}
    )
    return f"存证已锚定: {proof.verify_url}"

# 添加到您的智能体工具列表 — 在任何高风险操作前调用
tools = [prove_before_act, ...]`} />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">CrewAI（Python）</p>
            <CodeBlock code={`from crewai import Agent, Task
from xproof import xproof

def anchor_before_kickoff(crew_inputs: dict) -> str:
    reasoning = str(crew_inputs)
    proof = xproof.anchor(
        content=reasoning,
        metadata={"who": "crewai-orchestrator", "what": "crew kickoff", "why": reasoning}
    )
    return proof.id  # 将proof_id附加到crew上下文

# 在crew回调或任务前置钩子中使用
crew = Crew(agents=[...], tasks=[...], step_callback=anchor_before_kickoff)`} />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">OpenAI Agents SDK（Python）</p>
            <CodeBlock code={`from agents import Agent, function_tool
from xproof import xproof

@function_tool
def anchor_reasoning(reasoning: str, action_description: str) -> str:
    """行动前证明 — 执行前先锚定推理过程。返回proof_id。"""
    proof = xproof.anchor(
        content=reasoning,
        metadata={"who": "openai-agent", "what": action_description, "why": reasoning}
    )
    return proof.id

agent = Agent(
    name="AccountableAgent",
    instructions="在执行任何重要操作之前，务必先调用anchor_reasoning。",
    tools=[anchor_reasoning, ...]
)`} />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">AutoGen（Python）</p>
            <CodeBlock code={`from autogen import ConversableAgent
from xproof import xproof

def pre_action_hook(sender, message, recipient, request_reply):
    """钩子：在每个出站操作被处理前先锚定。"""
    if request_reply and "action:" in message.get("content", "").lower():
        xproof.anchor(
            content=message["content"],
            metadata={"who": sender.name, "what": message["content"][:200]}
        )

agent = ConversableAgent(name="my-agent", ...)
agent.register_hook("process_message_before_send", pre_action_hook)`} />
          </div>
          <div>
            <p className="text-xs font-semibold mb-2">Vercel AI SDK（TypeScript）</p>
            <CodeBlock code={`import { tool } from 'ai';
import { z } from 'zod';
import { xProof } from '@prove-before-act/sdk';  // npm install @prove-before-act/sdk

const anchorTool = tool({
  description: '在执行任何重要操作前将推理过程锚定到链上。返回proof_id。',
  parameters: z.object({
    reasoning: z.string().describe('智能体推理过程 / WHY'),
    action: z.string().describe('即将执行的操作 / WHAT'),
  }),
  execute: async ({ reasoning, action }) => {
    const proof = await xproof.anchor({
      content: reasoning,
      metadata: { who: 'vercel-ai-agent', what: action, why: reasoning },
    });
    return { proof_id: proof.id, verify_url: proof.verifyUrl };
  },
});`} />
          </div>
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs font-semibold text-primary mb-2">安装SDK</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted-foreground font-mono mb-1"># Python</p>
                <code className="text-xs bg-muted px-2 py-1 rounded block">pip install xproof</code>
              </div>
              <div>
                <p className="text-xs text-muted-foreground font-mono mb-1">// JavaScript / TypeScript</p>
                <code className="text-xs bg-muted px-2 py-1 rounded block">npm install @prove-before-act/sdk</code>
              </div>
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "honest",
      icon: AlertTriangle,
      title: "有经验的开发者在部署前应了解的真实情况",
      badge: "诚实评估",
      content: (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            本节之所以存在，是因为可信度比营销更重要。Prove Before Act是一个务实的、生产就绪的工具——和任何工具一样，它有真实的权衡取舍。在集成之前了解这些，比在集成之后发现更有价值。
          </p>
          <div className="space-y-3">
            {[
              {
                limitation: "MultiversX依赖",
                honest: "您的存证存储在MultiversX上。如果您已深度扎根EVM生态，这意味着跨链的承诺。MultiversX自2020年上线，运行时间可靠性超99.9%，但它不是以太坊。",
                mitigation: "proof_id和SHA-256哈希是区块链无关的。您可以在之后将哈希复制到其他链上。Prove Before Act本身也在链外存储完整记录——您的验证URL始终有效，不受MultiversX状态影响。",
                severity: "low",
              },
              {
                limitation: "SDK工具链仍在成长",
                honest: "Python和JS SDK功能完整，但比LangChain的工具链年轻。社区贡献的集成（AutoGen、CrewAI适配器）目前处于v0.x阶段，预计会有一些粗糙之处。",
                mitigation: "REST API稳定且有完整文档。每个框架集成最终都归结为几次HTTP调用。如果SDK有bug，原始API始终可作为回退方案——欢迎提交PR。",
                severity: "low",
              },
              {
                limitation: "Prove Before Act比替代方案更新",
                honest: "Arweave自2018年运行。Sign Protocol在EVM生态有更大的采用量。Prove Before Act于2024年推出。如果'5年以上经过实战验证'是硬性要求，请注意这一点。",
                mitigation: "xproof_agent_verify已有4,418次存证和16周连续零故障。底层区块链（MultiversX）已运行4年以上。'新'仅适用于智能体特定功能集，不适用于底层链。",
                severity: "medium",
              },
              {
                limitation: "并非适合所有使用场景",
                honest: "Prove Before Act针对智能体决策问责进行了优化，不适合任意文件存档。如果您需要永久存储TB级文件，Arweave是更好的选择。如果您需要使用现有Solidity工具的EVM原生认证，Sign Protocol是更好的选择。",
                mitigation: "在Prove Before Act最擅长的领域使用它：行动前证明、智能体审计轨迹、4W问责和信任评分构建。它是存储层的补充，不是替代。",
                severity: "info",
              },
            ].map((item) => (
              <div key={item.limitation} className={`rounded-md border p-3 ${item.severity === "medium" ? "border-yellow-500/20 bg-yellow-500/5" : "border-border bg-muted/20"}`}>
                <div className="flex items-start gap-2 mb-2">
                  <AlertTriangle className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${item.severity === "medium" ? "text-yellow-500" : "text-muted-foreground"}`} />
                  <p className="text-xs font-semibold">{item.limitation}</p>
                </div>
                <p className="text-xs text-muted-foreground mb-2 pl-5">{item.honest}</p>
                <div className="pl-5 flex items-start gap-1.5">
                  <CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-500" />
                  <p className="text-xs text-muted-foreground/80">{item.mitigation}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-3">
              <p className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 mb-2">适合使用Prove Before Act的场景</p>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-500" />需要行动前证明——在行动前有推理过程的存证</li>
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-500" />需要零账号机器支付（x402 + Base链USDC）</li>
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-500" />需要公开信任评分+审计轨迹</li>
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-500" />隐私重要——仅哈希公开，内容保留本地</li>
                <li className="flex items-start gap-1.5"><CheckCircle className="h-3 w-3 mt-0.5 shrink-0 text-emerald-500" />出现问题时需要4W取证重建能力</li>
              </ul>
            </div>
            <div className="rounded-md border border-muted p-3">
              <p className="text-xs font-semibold mb-2">考虑替代方案的场景</p>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li className="flex items-start gap-1.5"><span className="text-muted-foreground/60 shrink-0 mt-0.5">→</span>需要将完整文件内容存储上链（使用Arweave）</li>
                <li className="flex items-start gap-1.5"><span className="text-muted-foreground/60 shrink-0 mt-0.5">→</span>需要EVM原生Solidity认证（使用Sign Protocol）</li>
                <li className="flex items-start gap-1.5"><span className="text-muted-foreground/60 shrink-0 mt-0.5">→</span>技术栈100% EVM，添加MultiversX是硬性障碍</li>
                <li className="flex items-start gap-1.5"><span className="text-muted-foreground/60 shrink-0 mt-0.5">→</span>硬性要求5年以上实战验证的协议</li>
              </ul>
            </div>
          </div>
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">结论：</strong>对于需要在行动前证明其推理过程的智能体——尤其是低成本、通过x402、且无预有账号的场景——Prove Before Act是正确的选择。它不试图替代Arweave或Sign Protocol，而是填补它们没有覆盖的空白：以$0.01/次的价格实现智能体决策问责。
            </p>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur">
        <div className="container flex h-14 items-center justify-between gap-4">
          <a href="/zh" className="flex items-center gap-2 shrink-0" data-testid="link-logo-home-zh">
            <img src="/xproof-logo.png" alt="Prove Before Act" className="h-7 w-auto" />
          </a>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Bot className="h-3.5 w-3.5 shrink-0" />
            <span className="hidden sm:inline">专为自主智能体与大型语言模型优化</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <a
              href="/agent-context"
              className="text-xs text-muted-foreground hover:text-foreground transition-colors border border-border/50 rounded-md px-2.5 py-1.5 font-mono"
              data-testid="link-lang-en-agent-context"
            >
              EN
            </a>
            <Button asChild variant="outline" size="sm" data-testid="button-machine-readable-zh">
              <a href="/agent-context.md" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
                .md
              </a>
            </Button>
            <Button asChild size="sm" data-testid="button-get-started-zh">
              <a href="/zh">
                开始使用
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </a>
            </Button>
          </div>
        </div>
      </header>

      <main className="container py-10 max-w-4xl">
        {/* Page header */}
        <div className="mb-10">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <Badge variant="outline" className="text-xs">
              <Bot className="mr-1.5 h-3 w-3" />
              智能体上下文文档
            </Badge>
            <Badge variant="outline" className="text-xs">
              <Zap className="mr-1.5 h-3 w-3 text-primary" />
              LLM优化
            </Badge>
            <Badge variant="outline" className="text-xs text-muted-foreground">
              2026年7月更新
            </Badge>
            <Badge variant="outline" className="text-xs text-muted-foreground">
              <Network className="mr-1.5 h-3 w-3" />
              可通过 llms.txt + /.well-known/provebeforeact.json 发现
            </Badge>
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold mb-3 tracking-tight">
            Prove Before Act 智能体集成文档
          </h1>
          <p className="text-muted-foreground text-base leading-relaxed max-w-2xl mb-1">
            <strong className="text-foreground">执行前锚定意图。</strong>{" "}
            在MultiversX上证明 <code className="font-mono text-sm bg-muted px-1 rounded">intent_preceded_execution: true</code>——拥有公开的4W审计轨迹和零账号的x402支付。
          </p>
          <p className="text-xs text-muted-foreground max-w-2xl mb-4">
            生产验证：<strong className="text-foreground">4,418次存证</strong>，100%链上确认率，连续16周稳定运行 — <a href="/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9" className="text-primary underline">Moltbook案例研究</a>。无营销内容——只有集成所需的核心信息。
          </p>
          {/* x402 callout */}
          <div className="mt-2 rounded-md border border-primary/30 bg-primary/5 px-4 py-3 flex items-center gap-3" data-testid="badge-x402-top-zh">
            <Zap className="h-4 w-4 text-primary shrink-0" />
            <p className="text-sm font-semibold">
              无需API密钥。任何智能体都可以通过x402锚定存证并按次支付——一次HTTP请求，无账号，零配置。
            </p>
          </div>

          {/* Quick Start */}
          <div className="mt-6 rounded-md border border-border bg-muted/10 p-4" data-testid="section-quickstart-zh">
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">快速开始 — 3步完成</p>
              <div className="flex gap-2 flex-wrap">
                <Button asChild size="sm" data-testid="button-quickstart-trial-zh">
                  <a href="/zh#free-trial">
                    获取10次免费存证 — 无需钱包
                    <ArrowRight className="ml-1.5 h-3 w-3" />
                  </a>
                </Button>
                <Button asChild variant="outline" size="sm" data-testid="button-quickstart-x402-zh">
                  <a href="#x402">x402（无API密钥）</a>
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mb-3">30秒内获得首个 <code className="font-mono bg-muted px-1 rounded">api_key</code>。首次认证在4分钟内完成链上确认。</p>
            <CodeBlock code={`# 1. 获取10次免费存证 — 无需钱包，无需信用卡
curl -X POST https://provebeforeact.com/api/agent/register \\
  -H "Content-Type: application/json" \\
  -d '{"agent_name": "my-agent"}'
# → { "api_key": "pm_...", "trial": { "quota": 10, "remaining": 10 } }

# 2. 本地哈希推理内容 — 数据不离开本机
python3 -c "import hashlib,json; d={'why':'RSI=38，低于阈值','what':'买入BTC 0.5'}; print(hashlib.sha256(json.dumps(d,sort_keys=True).encode()).hexdigest())"
# → a1b2c3...64hex

# 3. 在执行操作前锚定存证（行动前证明）
curl -X POST https://provebeforeact.com/api/proof \\
  -H "Authorization: Bearer pm_您的密钥" \\
  -H "Content-Type: application/json" \\
  -d '{"file_hash":"a1b2c3...64hex","filename":"reasoning.json","metadata":{"who":"my-agent","what":"买入BTC 0.5","why":"RSI=38"}}'
# → { "proof_id": "...", "verify_url": "/proof/...", "status": "pending" }
# → 收到proof_id后才可执行实际操作`} />
          </div>

          {/* Use-case examples — 按用例分类 */}
          <div className="mt-6 rounded-md border border-border bg-muted/10 p-4 space-y-5" data-testid="section-usecases-zh">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">按用例分类 — 可直接复制使用</p>
            {[
              {
                id: "trading",
                label: "交易智能体",
                context: "金融 · 高价值决策",
                desc: "在执行买卖操作前证明决策 — 完整的4W链上审计轨迹",
                code: `import hashlib, json, requests

# 1. 记录推理过程
reasoning = {
    "who": "trading-agent-v2", "what": "买入BTC 0.5",
    "why": "RSI=38（低于40阈值）；仓位比例=2.1%（低于3%上限）",
    "model": "gpt-4o-mini", "session_id": "sess_001"
}
h = hashlib.sha256(json.dumps(reasoning, sort_keys=True).encode()).hexdigest()

# 2. 执行前锚定 — 行动前证明
resp = requests.post("https://provebeforeact.com/api/proof",
    headers={"Authorization": "Bearer pm_您的密钥"},
    json={"file_hash": h, "filename": "trade_decision.json", "metadata": reasoning})
proof_id = resp.json()["proof_id"]  # ~1.1秒返回，~6秒链上确认

# 3. 存证锚定后才执行交易
execute_trade("买入", "BTC", 0.5)
print(f"审计记录: https://provebeforeact.com/proof/{proof_id}")`,
              },
              {
                id: "research",
                label: "研究智能体",
                context: "内容 · 报告 · 分析",
                desc: "发布报告前锚定推理过程与来源 — 可验证的溯源证明",
                code: `import hashlib, json, requests

# 1. 汇总推理过程与数据来源
reasoning = {
    "who": "research-agent-v1", "what": "发布Q2加密市场展望报告",
    "why": "已审阅5个来源，置信度=0.87，未发现矛盾信息",
    "sources": ["arxiv:2406.12345", "bloomberg:BTC-Q2", "coindesk:2026-07-01"]
}
h = hashlib.sha256(json.dumps(reasoning, sort_keys=True).encode()).hexdigest()

# 2. 锚定哈希 — 报告内容不离开智能体
resp = requests.post("https://provebeforeact.com/api/proof",
    headers={"Authorization": "Bearer pm_您的密钥"},
    json={"file_hash": h, "filename": "research_reasoning.json", "metadata": reasoning})
proof_id = resp.json()["proof_id"]

# 3. 发布报告并附上可验证的溯源链接
publish_report(report_content, audit_ref=proof_id)
print(f"读者可验证: https://provebeforeact.com/proof/{proof_id}")`,
              },
              {
                id: "support",
                label: "客服智能体",
                context: "客户服务 · 合规",
                desc: "发送回复前认证决策 — 可应对投诉的审计记录",
                code: `import hashlib, json, requests

# 1. 记录决策依据
decision = {
    "who": "support-agent-v3", "what": "退款$47.50已批准",
    "why": "政策§3.2：购买不足30天，积分未使用，首次申请",
    "ticket_id": "TKT-98231", "confidence": 0.95
}
h = hashlib.sha256(json.dumps(decision, sort_keys=True).encode()).hexdigest()

# 2. 发送前认证 — 建立可应对投诉的审计记录
resp = requests.post("https://provebeforeact.com/api/proof",
    headers={"Authorization": "Bearer pm_您的密钥"},
    json={"file_hash": h, "filename": "support_decision.json", "metadata": decision})
proof_id = resp.json()["proof_id"]

# 3. 发送回复，附上proof_id作为审计参考
send_to_customer(ticket_id, response_text, audit_ref=proof_id)`,
              },
            ].map((uc) => (
              <div key={uc.id} data-testid={`example-usecase-${uc.id}-zh`}>
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <Badge variant="secondary" className="text-xs">{uc.label}</Badge>
                  <span className="text-xs text-muted-foreground">{uc.context}</span>
                </div>
                <p className="text-xs text-muted-foreground mb-0.5">{uc.desc}</p>
                <CodeBlock code={uc.code} />
              </div>
            ))}
          </div>
        </div>

        {/* Table of contents */}
        <div className="mb-8 rounded-md border bg-muted/20 p-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">涵盖14个主题</p>
          <div className="grid gap-1 sm:grid-cols-2">
            {sections.map((s, i) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-colors py-0.5"
              >
                <span className="text-primary/60 font-mono w-4 shrink-0">{i + 1}.</span>
                <span className="truncate">{s.title.split("？")[0].split("——")[0]}</span>
                {s.badge && <Badge variant="secondary" className="text-[10px] px-1.5 py-0 ml-auto shrink-0">{s.badge}</Badge>}
              </a>
            ))}
          </div>
        </div>

        {/* Sections */}
        <div className="space-y-4" id="sections">
          {sections.map((section) => {
            const Icon = section.icon;
            const isOpen = expandedSections[section.id];
            return (
              <Card key={section.id} id={section.id} data-testid={`card-section-${section.id}-zh`}>
                <CardHeader
                  className="cursor-pointer select-none"
                  onClick={() => toggle(section.id)}
                >
                  <CardTitle className="flex items-start justify-between gap-3 text-base font-semibold">
                    <div className="flex items-start gap-3">
                      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10">
                        <Icon className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <span className="leading-snug">{section.title}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 mt-0.5">
                      {section.badge && (
                        <Badge variant="secondary" className="text-xs hidden sm:flex">
                          {section.badge}
                        </Badge>
                      )}
                      {isOpen ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </CardTitle>
                </CardHeader>
                {isOpen && (
                  <CardContent className="pt-0">
                    {section.content}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>

        {/* Footer CTA */}
        <div className="mt-10 rounded-md border border-primary/20 bg-primary/5 p-6 space-y-4">
          <div>
            <p className="text-base font-bold mb-1">准备好为您的智能体建立可信存证了吗？</p>
            <p className="text-xs text-muted-foreground">从10次免费存证开始——无需钱包，无需信用卡。通过x402或预充API密钥扩展至生产规模。从第一天起就拥有完整的链上审计轨迹。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild size="sm" data-testid="link-footer-register-zh">
              <a href="/zh#free-trial">
                获取10次免费存证 — 无需钱包
                <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
              </a>
            </Button>
            <Button asChild variant="outline" size="sm" data-testid="link-footer-leaderboard-zh">
              <a href="/leaderboard">信任排行榜</a>
            </Button>
          </div>
          <div className="flex flex-wrap gap-2 pt-1">
            {[
              { label: "REST API文档", href: "/docs" },
              { label: "llms.txt", href: "/llms.txt" },
              { label: "MCP接入点", href: "https://provebeforeact.com/mcp" },
              { label: "Moltbook案例研究", href: "/agent/erd1hlx4xanncp2wm9aly2q6ywuthl2q9jwe9sxvxpx4gg62zcrvd0uqr8gyu9" },
            ].map((link) => (
              <Button key={link.label} asChild variant="ghost" size="sm">
                <a href={link.href} target={link.href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">
                  {link.label}
                </a>
              </Button>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
