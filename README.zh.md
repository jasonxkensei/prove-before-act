# xproof — 智能体操作的链上公证服务

[English](README.md) | 中文

[![每次存证 $0.01](https://img.shields.io/badge/存证费用-$0.01-green)](https://xproof.app)
[![MultiversX](https://img.shields.io/badge/区块链-MultiversX-blue)](https://multiversx.com)
[![x402 协议](https://img.shields.io/badge/支付协议-x402-purple)](https://xproof.app/docs)

**xproof** 是面向人工智能智能体的链上可信证明基础设施，将智能体的操作决策与实际结果永久锚定在 MultiversX 区块链上。

---

## 为什么需要 xproof？

随着智能体集群规模持续扩大，运营商面临三大核心挑战：

- **可追溯性**：某个智能体在某时刻究竟做了什么决策？
- **操作审计**：如何向监管机构证明智能体的操作流程合规？
- **智能体问责**：多智能体协作场景中，责任如何归属？

xproof 通过**行动前证明**（Prove Before Act）机制，为每次操作建立四维审计轨迹。

---

## 核心概念：行动前证明（行动前证明）

```
执行前  →  锚定WHY（决策依据）  →  执行操作  →  锚定WHAT（实际结果）
```

**关键原则**：在执行之前，将推理过程（WHY）的哈希值锚定上链；执行完成后，将实际结果（WHAT）锚定上链。这就在密码学层面证明了**意图先于结果**。

### 4W 审计框架

| 维度 | 英文 | 说明 | 存证时机 |
|------|------|------|---------|
| 操作主体 | WHO | 通过 MX-8004 可信智能体标准进行身份认证 | 每次请求 |
| 操作结果 | WHAT | 实际产出内容的 SHA-256 哈希值 | **执行后** |
| 操作时间 | WHEN | 链上时间戳 + 交易哈希，不可篡改 | 自动记录 |
| 决策依据 | WHY | 完整推理过程、上下文与决策意图 | **执行前** |

---

## 快速开始

### 方式一：Python SDK

```bash
pip install xproof
```

```python
import xproof, hashlib, json

client = xproof.Client(api_key="pm_你的密钥")

# 步骤1：执行前，锚定决策依据（WHY）
reasoning = {
    "reasoning": "基于用户画像分析，判断最优内容推荐策略",
    "decision": "执行个性化内容推荐",
    "confidence": 0.94,
    "rules_applied": ["内容安全规则v2", "用户偏好权重模型"]
}

why_proof = client.certify(
    file_hash=hashlib.sha256(
        json.dumps(reasoning, sort_keys=True).encode()
    ).hexdigest(),
    metadata={
        "role": "WHY",
        "action_type": "content_recommendation",
        "decision_chain": list(reasoning["rules_applied"])
    }
)
print(f"WHY已锚定: {why_proof['proof_id']}")

# 步骤2：执行实际操作
result = your_agent.execute()

# 步骤3：执行后，锚定实际结果（WHAT）
what_proof = client.certify(
    file_hash=hashlib.sha256(
        json.dumps(result, sort_keys=True).encode()
    ).hexdigest(),
    metadata={
        "role": "WHAT",
        "why_proof_id": why_proof["proof_id"],
        "action_type": "content_recommendation"
    }
)
print(f"WHAT已锚定: {what_proof['verify_url']}")
# 审计报告: xproof.app/incident/{钱包地址}/{why_proof_id}
```

### 方式二：JavaScript/TypeScript SDK

```bash
npm install @xproof/xproof
```

```typescript
import { XProofClient } from "@xproof/xproof";
import crypto from "crypto";

const client = new XProofClient({ apiKey: "pm_你的密钥" });

// 执行前锚定推理过程
const reasoning = { decision: "执行搜索操作", confidence: 0.91 };
const whyHash = crypto
  .createHash("sha256")
  .update(JSON.stringify(reasoning, Object.keys(reasoning).sort()))
  .digest("hex");

const whyProof = await client.certify({
  fileHash: whyHash,
  metadata: { role: "WHY", action_type: "search" }
});

// 执行后锚定实际结果
const result = await agent.search(query);
const whatHash = crypto
  .createHash("sha256")
  .update(JSON.stringify(result, Object.keys(result).sort()))
  .digest("hex");

await client.certify({
  fileHash: whatHash,
  metadata: { role: "WHAT", why_proof_id: whyProof.proof_id }
});
```

### 方式三：REST API（无需SDK）

```bash
# 1. 锚定决策依据（WHY）
curl -X POST https://xproof.app/api/proof \
  -H "Authorization: Bearer pm_你的密钥" \
  -H "Content-Type: application/json" \
  -d '{
    "file_hash": "sha256哈希值",
    "filename": "reasoning_001.json",
    "metadata": {"role": "WHY", "action_type": "your_action"}
  }'

# 返回: {"proof_id": "...", "verify_url": "xproof.app/proof/..."}
```

### 方式四：x402 协议（无需账号）

拥有以太坊钱包的智能体可无需注册账号直接完成存证：

```python
import requests, hashlib, json, base64

# 1. 发送请求 → 收到 HTTP 402 支付挑战
r = requests.post("https://xproof.app/api/proof",
    json={"file_hash": "sha256哈希值"})
# r.status_code == 402

# 2. 在 Base 链（eip155:8453）上签署 $0.01 USDC 支付
signed = wallet.sign_x402(r.json()["payment"])
x_payment = base64.b64encode(json.dumps(signed).encode()).decode()

# 3. 携带支付凭证重新发送 → 立即获得存证
proof = requests.post("https://xproof.app/api/proof",
    headers={"X-PAYMENT": x_payment},
    json={"file_hash": "sha256哈希值"})
# {"proof_id": "...", "verify_url": "..."}
```

---

## 集群运营商：批量认证

```python
# 单次API调用提交最多100个操作哈希
result = client.batch_certify([
    {"file_hash": "hash_001", "filename": "action_001.json",
     "metadata": {"role": "WHY", "agent_id": "agent-001"}},
    {"file_hash": "hash_002", "filename": "action_002.json",
     "metadata": {"role": "WHAT", "agent_id": "agent-001"}},
    # ...最多100条
])
print(f"已批量存证: {len(result['results'])} 条")
```

每次存证固定收费 **$0.01**，批量提交无溢价。

---

## 事件报告与审计追溯

每个存证均生成完整的4W事件报告：

```
https://xproof.app/incident/{钱包地址}/{proof_id}
```

或通过API程序化获取：

```bash
curl https://xproof.app/api/agents/{钱包地址}/incident-report?proof_id={uuid}
```

报告包含：
- 自然语言摘要（"智能体X在14:22:07锚定推理，8秒后执行，结果已链上确认"）
- 4W验证状态（含WHY→WHAT时序证明）
- 完整操作时间线
- 信任评分与违规记录
- 供其他智能体程序化调用的JSON结构

---

## 支持的 AI 框架

| 框架 | 集成方式 |
|------|---------|
| LangChain | `xproof.integrations.langchain` |
| CrewAI | `xproof.integrations.crewai` |
| AutoGen | `xproof.integrations.autogen` |
| LlamaIndex | `xproof.integrations.llamaindex` |
| OpenAI Agents SDK | `xproof.integrations.openai` |
| Vercel AI | `@xproof/xproof` NPM 包 |

---

## 获取 API 密钥

**免费体验**（无需钱包）：

```bash
curl -X POST https://xproof.app/api/agent/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "my-agent-001"}'
# 返回: {"api_key": "pm_...", "trial_remaining": 10}
```

或访问 [xproof.app/zh](https://xproof.app/zh) 通过界面直接获取。

---

## 定价

| 方式 | 费用 | 说明 |
|------|------|------|
| 免费试用 | 免费 | 10次，无需钱包 |
| 按需付费 | $0.01/次 | 预充积分，不限量 |
| x402协议 | $0.01/次 | USDC on Base，无需账号 |
| 批量API | $0.01/次 | 无批量溢价 |

---

## 合规说明

xproof 提供的链上存证记录可作为合规审计的技术支撑，适用于：

- 《生成式人工智能服务管理暂行办法》操作记录要求
- 《互联网信息服务算法推荐管理规定》算法决策透明度要求
- 企业内部AI治理审计需求

> **注意**：xproof提供技术存证工具，不提供法律合规建议。具体合规方案请咨询您的法律顾问。

---

## 链接

- 官网（中文）：[xproof.app/zh](https://xproof.app/zh)
- 开发文档：[xproof.app/docs](https://xproof.app/docs)
- 智能体集成：[xproof.app/agent-context](https://xproof.app/agent-context)
- 4W框架说明：[xproof.app/docs/4w](https://xproof.app/docs/4w)
- 信任排行榜：[xproof.app/leaderboard](https://xproof.app/leaderboard)
- GitHub：[github.com/jasonxkensei/xproof](https://github.com/jasonxkensei/xproof)

---

*xproof — 每次智能体操作，均可链上证明。*
