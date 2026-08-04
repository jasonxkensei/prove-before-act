/**
 * Next.js API route with automatic xProof certification.
 *
 * Copy this to your Next.js app at: app/api/chat/route.ts
 *
 * Prerequisites:
 *   npm install xproof ai @ai-sdk/openai
 *   Set XPROOF_API_KEY and OPENAI_API_KEY env vars
 *
 * Every generateText call is automatically certified on-chain.
 */

import { openai } from "@ai-sdk/openai";
import { generateText, wrapLanguageModel } from "ai";
import { xproofMiddleware } from "xproof/vercel";

const xproof = xproofMiddleware({
  apiKey: process.env.XPROOF_API_KEY!,
  agentName: "my-nextjs-chatbot",
  why: "customer-support",
  metadata: { env: process.env.NODE_ENV },
});

const model = wrapLanguageModel({
  model: openai("gpt-4o"),
  middleware: xproof.middleware,
});

export async function POST(req: Request) {
  const { prompt } = await req.json();

  const { text } = await generateText({ model, prompt });

  const latestProof = xproof.proofs[xproof.proofs.length - 1];

  return Response.json({
    text,
    proof: {
      id: latestProof.proofId,
      hash: latestProof.fileHash,
      tx: latestProof.transactionHash,
      verify: `https://provebeforeact.com/verify/${latestProof.proofId}`,
    },
  });
}
