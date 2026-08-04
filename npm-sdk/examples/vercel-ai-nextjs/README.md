# Vercel AI SDK + Prove Before Act Example

Demonstrates automatic certification of AI model calls using the
Prove Before Act middleware for Vercel AI SDK.

## Setup

```bash
cd npm-sdk/examples/vercel-ai-nextjs
npm install
```

## Run

```bash
npm run dev
```

The script will:
1. Register a trial Prove Before Act agent
2. Simulate AI generation calls with manual certification
3. Show the resulting proof trail with 4W metadata

For a full Next.js integration, see `nextjs-route.ts` which shows
how to use `wrapLanguageModel` with the Prove Before Act middleware for
automatic certification of every `generateText`/`streamText` call.

Each proof is anchored on MultiversX and verifiable at
`https://provebeforeact.com/verify/<proofId>`.
