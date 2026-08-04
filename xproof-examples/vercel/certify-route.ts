/**
 * Next.js API route with automatic xProof certification.
 *
 * Copy this to your Next.js app at: app/api/chat/route.ts
 *
 * Install:
 *   npm install xproof ai @ai-sdk/openai
 *
 * Environment variables:
 *   XPROOF_API_KEY=pm_...
 *   OPENAI_API_KEY=sk-...
 *
 * Every generateText call is certified on-chain automatically.
 * The proof ID and verification URL are returned in the response.
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
