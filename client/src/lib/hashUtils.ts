// SHA-256 hashing utilities (client-side, uses Web Crypto API)

export async function hashFile(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", arrayBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function computeFileHash(file: File): Promise<string> {
  return hashFile(file);
}

export function formatHash(hash: string, length: number = 16): string {
  if (hash.length <= length) return hash;
  const start = Math.floor(length / 2);
  const end = Math.ceil(length / 2);
  return `${hash.slice(0, start)}...${hash.slice(-end)}`;
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    void err;
    return false;
  }
}
