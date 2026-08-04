/**
 * Vercel AI SDK + xProof: manual certification demo.
 *
 * Certifies AI generation metadata directly without an AI SDK dependency —
 * useful for testing or for runtimes where wrapLanguageModel is not available.
 *
 * For the automatic Next.js middleware usage see: certify-route.ts
 *
 * Install:
 *   npm install xproof
 *
 * Run:
 *   npx tsx main.ts
 *
 * Set XPROOF_API_KEY (or the demo registers a free trial automatically).
 */

import { XProofClient } from "xproof";
import { xproofMiddleware } from "xproof/vercel";

async function main() {
  const client = await XProofClient.register("vercel-ai-demo");
  console.log(`Registered: ${client.registration!.apiKey.slice(0, 12)}...`);
  console.log(`Trial remaining: ${client.registration!.trial.remaining}`);
  console.log();

  const mw = xproofMiddleware({
    client,
    agentName: "demo-chatbot",
    why: "customer-support",
  });

  console.log("--- Certifying AI generation 1 ---");
  const proof1 = await mw.certifyGeneration({
    model: "gpt-4o",
    prompt: "What is the capital of France?",
    result: "Paris is the capital of France.",
    functionId: "geography-qa",
  });
  console.log(`  Proof ID: ${proof1.proofId}`);
  console.log(`  Hash:     ${proof1.fileHash.slice(0, 16)}...`);
  console.log(`  Verify:   https://provebeforeact.com/verify/${proof1.proofId}`);
  console.log();

  console.log("--- Certifying AI generation 2 ---");
  const proof2 = await mw.certifyGeneration({
    model: "gpt-4o",
    prompt: "Translate 'hello' to Spanish",
    result: "Hola",
    functionId: "translation",
    metadata: { target_language: "es" },
  });
  console.log(`  Proof ID: ${proof2.proofId}`);
  console.log(`  Hash:     ${proof2.fileHash.slice(0, 16)}...`);
  console.log();

  console.log("--- Proof trail verification ---");
  for (const proof of mw.proofs) {
    const verified = await client.verify(proof.proofId);
    const status = verified.id === proof.proofId ? "verified" : "FAILED";
    console.log(`  ${proof.proofId}: ${status}`);
  }

  console.log();
  console.log("All AI interactions are independently verifiable on-chain.");
}

main().catch(console.error);
