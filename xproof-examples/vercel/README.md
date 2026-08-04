# Vercel AI SDK + Prove Before Act

Certify every AI generation in your Next.js / Vercel application.

## What gets certified

Each `generateText` or `streamText` call produces one certification with:
- **WHO** — your chatbot/agent name
- **WHAT** — SHA-256 hash of the generated text
- **WHEN** — UTC timestamp
- **WHY** — your configured reason (e.g. `"customer-support"`)

## Install

```bash
npm install @prove-before-act/sdk ai @ai-sdk/openai
```

Set environment variables:

```
XPROOF_API_KEY=pm_...
OPENAI_API_KEY=sk-...
```

Get an Prove Before Act API key at **[provebeforeact.com](https://provebeforeact.com)**.

## Usage — Next.js API route (automatic middleware)

Copy `certify-route.ts` to your app at `app/api/chat/route.ts`:

```typescript
import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { XProofClient } from "Prove Before Act";
import { xproofMiddleware } from "Prove Before Act/vercel";

const Prove Before Act = xproofMiddleware({
  apiKey: process.env.XPROOF_API_KEY!,
  agentName: "my-chatbot",
  why: "customer-support",
});

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: Prove Before Act.middleware,
});

export async function POST(req: Request) {
  const { prompt } = await req.json();
  const { text } = await generateText({ model, prompt });

  const proof = Prove Before Act.proofs[Prove Before Act.proofs.length - 1];
  return Response.json({
    text,
    proof: { id: proof.proofId, verify: `https://provebeforeact.com/verify/${proof.proofId}` },
  });
}
```

## Usage — manual certification (any runtime)

```typescript
import { XProofClient } from "Prove Before Act";
import { xproofMiddleware } from "Prove Before Act/vercel";

const client = new XProofClient({ apiKey: process.env.XPROOF_API_KEY! });
const mw = xproofMiddleware({ client, agentName: "my-agent", why: "qa" });

const proof = await mw.certifyGeneration({
  model: "gpt-4o",
  prompt: "What is AI?",
  result: "AI is...",
});
console.log(`Proof: https://provebeforeact.com/verify/${proof.proofId}`);
```

## Links

- [provebeforeact.com](https://provebeforeact.com)
- Docs (LLM-readable): [provebeforeact.com/llms.txt](https://provebeforeact.com/llms.txt)
- [npm: Prove Before Act](https://www.npmjs.com/package/-before-act/sdk)
- [Vercel AI SDK](https://sdk.vercel.ai)
