import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  createRecipientWitnessServer,
  loadPrivateKeyFromFile,
  witnessConfigFromEnvironment,
  type AcceptDelivery,
  type NonceStore,
} from "./service";

async function start(): Promise<void> {
  const envConfig = witnessConfigFromEnvironment();
  const acceptModulePath = process.env.PBA_WITNESS_ACCEPT_MODULE;
  if (!acceptModulePath) throw new Error("PBA_WITNESS_ACCEPT_MODULE is required");

  const moduleUrl = pathToFileURL(resolve(acceptModulePath)).href;
  const partnerModule = await import(moduleUrl) as {
    acceptDelivery?: AcceptDelivery;
    nonceStore?: NonceStore;
  };
  if (typeof partnerModule.acceptDelivery !== "function") {
    throw new Error("partner acceptance module must export acceptDelivery");
  }
  if (!partnerModule.nonceStore) {
    throw new Error("partner acceptance module must export a durable nonceStore");
  }

  const privateKey = await loadPrivateKeyFromFile(envConfig.privateKeyFile);
  const { privateKeyFile: _privateKeyFile, ...config } = envConfig;
  const server = createRecipientWitnessServer({
    ...config,
    privateKey,
    accept: partnerModule.acceptDelivery,
    nonceStore: partnerModule.nonceStore,
  });
  const port = Number(process.env.PBA_WITNESS_PORT ?? "8787");
  const host = process.env.PBA_WITNESS_BIND_HOST ?? "127.0.0.1";
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PBA_WITNESS_PORT must be a valid TCP port");
  }
  server.listen(port, host, () => {
    // This deliberately excludes secrets, request values, and private body data.
    console.info(`PBA recipient witness listening on ${host}:${port}`);
  });
}

void start().catch(() => {
  // Configuration/key parsing failures must fail closed without leaking key material.
  console.error("PBA recipient witness startup failed; check required partner configuration");
  process.exitCode = 1;
});