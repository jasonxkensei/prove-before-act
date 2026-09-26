import { createPublicKey } from "node:crypto";
import { loadPrivateKeyFromFile, witnessConfigFromEnvironment } from "./service";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

async function main(): Promise<void> {
  const config = witnessConfigFromEnvironment();
  const privateKey = await loadPrivateKeyFromFile(config.privateKeyFile);
  const exported = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const der = Buffer.isBuffer(exported) ? exported : Buffer.from(exported);
  if (der.length !== SPKI_PREFIX.length + 32 ||
      !der.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) {
    throw new Error("witness key did not produce an Ed25519 public key");
  }
  // Safe to share with the verifier operator. This process never prints the PEM.
  console.log(JSON.stringify({
    witness_id: config.witnessId,
    recipient_origin: config.recipientOrigin,
    public_key: `ed25519:${der.subarray(SPKI_PREFIX.length).toString("hex")}`,
  }));
}

void main().catch(() => {
  console.error("Unable to read witness public key; check recipient configuration and file permissions");
  process.exitCode = 1;
});