import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Shield,
  Copy,
  Check,
  ArrowLeft,
  AlertTriangle,
  Layers,
  Terminal,
  Zap,
  Eye,
  Pause,
  Settings,
} from "lucide-react";

const BASE = "https://provebeforeact.com";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      size="icon"
      variant="ghost"
      className="absolute top-2 right-2 opacity-0 group-hover/code:opacity-100 transition-opacity"
      onClick={handleCopy}
      data-testid="button-copy-code"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  );
}

const EMITTER_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract XProofViolations {
    address public owner;
    address public emitter;

    enum ViolationType { FAULT, BREACH }

    event ViolationConfirmed(
        bytes32 indexed agentWallet,
        bytes32 indexed proofId,
        ViolationType violationType,
        uint256 timestamp,
        string details
    );

    modifier onlyEmitter() {
        require(msg.sender == emitter, "Not authorized");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _emitter) {
        owner = msg.sender;
        emitter = _emitter;
    }

    function emitViolation(
        bytes32 agentWallet,
        bytes32 proofId,
        ViolationType violationType,
        string calldata details
    ) external onlyEmitter {
        emit ViolationConfirmed(
            agentWallet,
            proofId,
            violationType,
            block.timestamp,
            details
        );
    }

    function setEmitter(address _emitter) external onlyOwner {
        emitter = _emitter;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }
}`;

const WATCHER_SOL = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IXProofViolations {
    enum ViolationType { FAULT, BREACH }

    event ViolationConfirmed(
        bytes32 indexed agentWallet,
        bytes32 indexed proofId,
        ViolationType violationType,
        uint256 timestamp,
        string details
    );
}

contract ViolationWatcher {
    address public owner;
    address public xproofContract;

    enum ResponseMode {
        ALERT_ONLY,        // Emit event, no action
        AUTO_PAUSE_FAULT,  // Pause on any violation
        AUTO_PAUSE_BREACH  // Pause on breach only
    }

    ResponseMode public mode;
    bytes32 public watchedAgent;
    bool public paused;

    address public alertTarget;
    address public pauseTarget;

    uint256 public faultCount;
    uint256 public breachCount;
    uint256 public lastViolationTime;

    event AgentPaused(
        bytes32 indexed agentWallet,
        IXProofViolations.ViolationType reason,
        bytes32 proofId
    );
    event AlertFired(
        bytes32 indexed agentWallet,
        IXProofViolations.ViolationType reason,
        bytes32 proofId
    );
    event AgentResumed(bytes32 indexed agentWallet);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(
        address _xproofContract,
        bytes32 _watchedAgent,
        ResponseMode _mode,
        address _alertTarget,
        address _pauseTarget
    ) {
        owner = msg.sender;
        xproofContract = _xproofContract;
        watchedAgent = _watchedAgent;
        mode = _mode;
        alertTarget = _alertTarget;
        pauseTarget = _pauseTarget;
    }

    function onViolation(
        bytes32 agentWallet,
        bytes32 proofId,
        IXProofViolations.ViolationType violationType
    ) external {
        require(msg.sender == xproofContract, "Not Prove Before Act");
        require(agentWallet == watchedAgent, "Not watched agent");

        lastViolationTime = block.timestamp;

        if (violationType == IXProofViolations.ViolationType.FAULT) {
            faultCount++;
        } else {
            breachCount++;
        }

        emit AlertFired(agentWallet, violationType, proofId);

        if (mode == ResponseMode.AUTO_PAUSE_FAULT) {
            paused = true;
            emit AgentPaused(agentWallet, violationType, proofId);
        } else if (
            mode == ResponseMode.AUTO_PAUSE_BREACH &&
            violationType == IXProofViolations.ViolationType.BREACH
        ) {
            paused = true;
            emit AgentPaused(agentWallet, violationType, proofId);
        }
    }

    function resume() external onlyOwner {
        require(paused, "Not paused");
        paused = false;
        emit AgentResumed(watchedAgent);
    }

    function setMode(ResponseMode _mode) external onlyOwner {
        mode = _mode;
    }

    function setWatchedAgent(bytes32 _agent) external onlyOwner {
        watchedAgent = _agent;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Zero address");
        owner = newOwner;
    }
}`;

export default function DocsBaseViolationsPage() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b sticky top-0 z-50 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="container flex h-14 items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button asChild variant="ghost" size="icon" data-testid="button-back-docs">
              <a href="/docs"><ArrowLeft className="h-4 w-4" /></a>
            </Button>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-primary" />
              <h1 className="font-semibold">Base Violation Events</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs font-mono" data-testid="badge-network">eip155:8453</Badge>
            <Badge variant="outline" className="text-xs font-mono" data-testid="badge-chain">Base Mainnet</Badge>
          </div>
        </div>
      </header>

      <div className="container py-10 max-w-4xl mx-auto">
        <div className="mb-10">
          <h1 className="text-3xl md:text-4xl font-bold mb-3" data-testid="text-page-title">
            Violation Events on Base
          </h1>
          <p className="text-lg text-muted-foreground max-w-3xl">
            When a violation moves from <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">proposed</code> to{" "}
            <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">confirmed</code>, Prove Before Act emits an immutable event on Base.
            Any protocol can read it. No API dependency. No trust required.
          </p>
        </div>

        <div className="space-y-8">
          <Card data-testid="card-architecture">
            <CardContent className="p-6">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Layers className="h-5 w-5 text-primary" />
                Architecture
              </h2>
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-3">
                  <div className="rounded-lg border p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Shield className="h-4 w-4 text-primary" />
                      <h3 className="font-semibold text-sm">MultiversX</h3>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Proofs anchored on-chain. Trust scores computed from proof history. The source of truth for agent behavior.
                    </p>
                  </div>
                  <div className="rounded-lg border p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Zap className="h-4 w-4 text-primary" />
                      <h3 className="font-semibold text-sm">Base</h3>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Violation events emitted on-chain. USDC payments via x402. Public, composable, no API dependency.
                    </p>
                  </div>
                  <div className="rounded-lg border p-4">
                    <div className="flex items-center gap-2 mb-2">
                      <Eye className="h-4 w-4 text-primary" />
                      <h3 className="font-semibold text-sm">Operator</h3>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Deploys a watcher contract on Base. Listens for violation events on their agent wallet. Defines the response.
                    </p>
                  </div>
                </div>
                <div className="rounded-md bg-muted/50 p-4 text-sm">
                  <p className="font-mono text-xs">
                    <span className="text-muted-foreground">Flow:</span>{" "}
                    Violation detected → confirmed in Prove Before Act DB → <code>XProofViolations.emitViolation()</code> on Base →{" "}
                    <code>ViolationConfirmed</code> event → Operator's <code>ViolationWatcher.onViolation()</code> fires
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-event-schema">
            <CardContent className="p-6">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Terminal className="h-5 w-5 text-primary" />
                Event Schema
              </h2>
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  The <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">ViolationConfirmed</code> event is emitted by the Prove Before Act Base contract
                  every time a violation is confirmed. Both <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">agentWallet</code> and{" "}
                  <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">proofId</code> are indexed for efficient filtering.
                </p>
                <div className="relative group/code">
                  <pre className="bg-[#0d1117] rounded-md p-4 text-xs font-mono text-[#e6edf3] overflow-x-auto" data-testid="code-event-schema">{`event ViolationConfirmed(
    bytes32 indexed agentWallet,  // Keccak256 of the erd1... address
    bytes32 indexed proofId,      // Keccak256 of the UUID proof ID
    ViolationType violationType,  // 0 = FAULT (-150), 1 = BREACH (-500)
    uint256 timestamp,            // Block timestamp
    string details                // Human-readable violation summary
);

enum ViolationType {
    FAULT,   // Technical slip — timing gap, missing heartbeat
    BREACH   // Intentional — content mismatch, unauthorized action
}`}</pre>
                  <CopyButton text={`event ViolationConfirmed(\n    bytes32 indexed agentWallet,\n    bytes32 indexed proofId,\n    ViolationType violationType,\n    uint256 timestamp,\n    string details\n);\n\nenum ViolationType {\n    FAULT,\n    BREACH\n}`} />
                </div>

                <div className="grid gap-3 md:grid-cols-2 mt-4">
                  <div className="rounded-lg border p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
                      <span className="font-semibold text-sm">FAULT</span>
                      <Badge variant="outline" className="text-xs">-150 trust</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Technical slip. Timing gap exceeding 30 minutes between WHY and WHAT. Missing heartbeat. Auto-confirmed when blockchain timestamps prove the gap.
                    </p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                      <span className="font-semibold text-sm">BREACH</span>
                      <Badge variant="outline" className="text-xs">-500 trust</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Intentional violation. Content hash mismatch between anchored proof and published output. Unauthorized action without prior reasoning proof.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-emitter-contract">
            <CardContent className="p-6">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Shield className="h-5 w-5 text-primary" />
                Emitter Contract — <code className="text-sm font-mono">XProofViolations.sol</code>
              </h2>
              <p className="text-sm text-muted-foreground mb-4">
                Deployed by Prove Before Act on Base. Only the authorized Prove Before Act backend wallet can call <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">emitViolation()</code>.
                Operators don't deploy this — they read its events.
              </p>
              <div className="relative group/code">
                <pre className="bg-[#0d1117] rounded-md p-4 text-xs font-mono text-[#e6edf3] overflow-x-auto max-h-96 overflow-y-auto" data-testid="code-emitter">{EMITTER_SOL}</pre>
                <CopyButton text={EMITTER_SOL} />
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-watcher-contract">
            <CardContent className="p-6">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Eye className="h-5 w-5 text-primary" />
                Operator Template — <code className="text-sm font-mono">ViolationWatcher.sol</code>
              </h2>
              <p className="text-sm text-muted-foreground mb-4">
                Deploy this contract on Base to watch your agent. Three response modes, configurable at deploy time.
                Read it in 5 minutes, deploy it in 10.
              </p>

              <div className="grid gap-3 md:grid-cols-3 mb-6">
                <div className="rounded-lg border p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Eye className="h-3.5 w-3.5 text-blue-500" />
                    <span className="font-semibold text-sm">ALERT_ONLY</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Emit an event on every violation. No automated response. Monitor and respond manually.
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <Pause className="h-3.5 w-3.5 text-yellow-500" />
                    <span className="font-semibold text-sm">AUTO_PAUSE_FAULT</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Pause agent on any confirmed violation — fault or breach. Conservative. Resume manually.
                  </p>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="flex items-center gap-2 mb-1">
                    <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
                    <span className="font-semibold text-sm">AUTO_PAUSE_BREACH</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Pause agent only on breach (intentional). Faults trigger alerts but don't pause. Balanced.
                  </p>
                </div>
              </div>

              <div className="relative group/code">
                <pre className="bg-[#0d1117] rounded-md p-4 text-xs font-mono text-[#e6edf3] overflow-x-auto max-h-96 overflow-y-auto" data-testid="code-watcher">{WATCHER_SOL}</pre>
                <CopyButton text={WATCHER_SOL} />
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-deploy-guide">
            <CardContent className="p-6">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Settings className="h-5 w-5 text-primary" />
                Deploy Your Watcher
              </h2>
              <div className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Deploy a <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">ViolationWatcher</code> on Base to monitor your agent.
                  Constructor parameters:
                </p>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm" data-testid="table-constructor-params">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Parameter</th>
                        <th className="text-left py-2 pr-4 font-medium text-muted-foreground">Type</th>
                        <th className="text-left py-2 font-medium text-muted-foreground">Description</th>
                      </tr>
                    </thead>
                    <tbody className="font-mono text-xs">
                      <tr className="border-b">
                        <td className="py-2 pr-4">_xproofContract</td>
                        <td className="py-2 pr-4 text-muted-foreground">address</td>
                        <td className="py-2 font-sans text-muted-foreground">Prove Before Act violations contract on Base</td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2 pr-4">_watchedAgent</td>
                        <td className="py-2 pr-4 text-muted-foreground">bytes32</td>
                        <td className="py-2 font-sans text-muted-foreground">Keccak256 hash of the agent's erd1... wallet address</td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2 pr-4">_mode</td>
                        <td className="py-2 pr-4 text-muted-foreground">uint8</td>
                        <td className="py-2 font-sans text-muted-foreground">0 = ALERT_ONLY, 1 = AUTO_PAUSE_FAULT, 2 = AUTO_PAUSE_BREACH</td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2 pr-4">_alertTarget</td>
                        <td className="py-2 pr-4 text-muted-foreground">address</td>
                        <td className="py-2 font-sans text-muted-foreground">Address to receive alert notifications</td>
                      </tr>
                      <tr>
                        <td className="py-2 pr-4">_pauseTarget</td>
                        <td className="py-2 pr-4 text-muted-foreground">address</td>
                        <td className="py-2 font-sans text-muted-foreground">Address controlling the agent's pause/resume logic</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div className="relative group/code">
                  <pre className="bg-[#0d1117] rounded-md p-4 text-xs font-mono text-[#e6edf3] overflow-x-auto" data-testid="code-deploy">{`# Deploy with Foundry (example)
forge create --rpc-url https://mainnet.base.org \\
  --private-key $DEPLOYER_KEY \\
  contracts/ViolationWatcher.sol:ViolationWatcher \\
  --constructor-args \\
    0xXPROOF_BASE_CONTRACT \\
    0x$(cast keccak "erd1your_agent_wallet_address") \\
    2 \\
    0xYOUR_ALERT_ADDRESS \\
    0xYOUR_PAUSE_ADDRESS`}</pre>
                  <CopyButton text={`forge create --rpc-url https://mainnet.base.org \\\n  --private-key $DEPLOYER_KEY \\\n  contracts/ViolationWatcher.sol:ViolationWatcher \\\n  --constructor-args \\\n    0xXPROOF_BASE_CONTRACT \\\n    0x$(cast keccak "erd1your_agent_wallet_address") \\\n    2 \\\n    0xYOUR_ALERT_ADDRESS \\\n    0xYOUR_PAUSE_ADDRESS`} />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-query-events">
            <CardContent className="p-6">
              <h2 className="text-xl font-semibold mb-4 flex items-center gap-2">
                <Terminal className="h-5 w-5 text-primary" />
                Query Violation Events
              </h2>
              <p className="text-sm text-muted-foreground mb-4">
                Any protocol can query Base for confirmed violations without touching the Prove Before Act API. 
                Filter by agent wallet or proof ID using the indexed event parameters.
              </p>
              <div className="relative group/code">
                <pre className="bg-[#0d1117] rounded-md p-4 text-xs font-mono text-[#e6edf3] overflow-x-auto" data-testid="code-query-events">{`// ethers.js v6 — query violation events for an agent
import { ethers } from "ethers";

const provider = new ethers.JsonRpcProvider("https://mainnet.base.org");
const contract = new ethers.Contract(XPROOF_BASE_ADDRESS, [
  "event ViolationConfirmed(bytes32 indexed agentWallet, bytes32 indexed proofId, uint8 violationType, uint256 timestamp, string details)"
], provider);

// Get all violations for a specific agent
const agentHash = ethers.keccak256(
  ethers.toUtf8Bytes("erd1your_agent_wallet")
);
const events = await contract.queryFilter(
  contract.filters.ViolationConfirmed(agentHash)
);

for (const event of events) {
  console.log({
    proofId: event.args.proofId,
    type: event.args.violationType === 0 ? "FAULT" : "BREACH",
    timestamp: new Date(Number(event.args.timestamp) * 1000),
    details: event.args.details
  });
}`}</pre>
                <CopyButton text={`import { ethers } from "ethers";\n\nconst provider = new ethers.JsonRpcProvider("https://mainnet.base.org");\nconst contract = new ethers.Contract(XPROOF_BASE_ADDRESS, [\n  "event ViolationConfirmed(bytes32 indexed agentWallet, bytes32 indexed proofId, uint8 violationType, uint256 timestamp, string details)"\n], provider);\n\nconst agentHash = ethers.keccak256(ethers.toUtf8Bytes("erd1your_agent_wallet"));\nconst events = await contract.queryFilter(contract.filters.ViolationConfirmed(agentHash));\n\nfor (const event of events) {\n  console.log({\n    proofId: event.args.proofId,\n    type: event.args.violationType === 0 ? "FAULT" : "BREACH",\n    timestamp: new Date(Number(event.args.timestamp) * 1000),\n    details: event.args.details\n  });\n}`} />
              </div>
            </CardContent>
          </Card>

          <Card className="border-primary/20 bg-primary/5" data-testid="card-composability-note">
            <CardContent className="p-6">
              <h2 className="text-xl font-semibold mb-3">Composability</h2>
              <p className="text-sm text-muted-foreground mb-3">
                Prove Before Act emits the signal. The operator's contract decides what to do with it.
              </p>
              <p className="text-sm text-muted-foreground">
                The violation event is public, immutable, and indexable. Any protocol building on top can query Base
                for confirmed violations without touching the Prove Before Act API. This is not infrastructure Prove Before Act has to build.
                This is infrastructure operators build on top of Prove Before Act because the standard is open and the events are public.
              </p>
              <div className="flex flex-wrap gap-2 mt-4">
                {["Open standard", "Base Mainnet", "No API dependency", "Composable", "Immutable events"].map((label) => (
                  <Badge key={label} variant="outline" className="text-xs font-mono" data-testid={`badge-${label.toLowerCase().replace(/\s/g, '-')}`}>{label}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card data-testid="card-current-status">
            <CardContent className="p-6">
              <h2 className="text-xl font-semibold mb-3 flex items-center gap-2">
                <Layers className="h-5 w-5 text-primary" />
                Current Status
              </h2>
              <div className="space-y-3 text-sm">
                <div className="flex items-center gap-3">
                  <Badge variant="default" className="text-xs">Live</Badge>
                  <span className="text-muted-foreground">Violation detection and confirmation in Prove Before Act DB</span>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="default" className="text-xs">Live</Badge>
                  <span className="text-muted-foreground">REST API for violation queries (<code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">GET /api/agents/:wallet/violations</code>)</span>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="default" className="text-xs">Live</Badge>
                  <span className="text-muted-foreground">Trust score penalty on confirmed violations (-150 fault / -500 breach)</span>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="text-xs">Template ready</Badge>
                  <span className="text-muted-foreground">Solidity contracts for emitter + operator watcher</span>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant="outline" className="text-xs">Next</Badge>
                  <span className="text-muted-foreground">Deploy <code className="text-xs bg-muted px-1 py-0.5 rounded font-mono">XProofViolations</code> on Base + backend integration</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="mt-10 text-center">
          <Button asChild variant="outline" data-testid="button-back-bottom">
            <a href="/docs">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to API Reference
            </a>
          </Button>
        </div>
      </div>

      <footer className="border-t py-8 mt-10">
        <div className="container text-center text-sm text-muted-foreground">
          <p>
            Source: <a href="https://github.com" className="text-primary hover:underline">contracts/ViolationWatcher.sol</a> ·{" "}
            <a href="/docs" className="text-primary hover:underline">API Reference</a> ·{" "}
            <a href="/" className="text-primary hover:underline">provebeforeact.com</a>
          </p>
        </div>
      </footer>
    </div>
  );
}
