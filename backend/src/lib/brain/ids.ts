import { createHash, randomBytes } from "node:crypto";

export const INDEX_VERSION = process.env.INDEX_VERSION
  ? Number(process.env.INDEX_VERSION)
  : 1;

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now?: number): string {
  let t = now ?? Date.now();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ALPHABET.charAt(t % 32) + time;
    t = Math.floor(t / 32);
  }
  let rand = "";
  for (const byte of randomBytes(16)) {
    rand += ALPHABET.charAt(byte % 32);
  }
  return time + rand;
}

export function indexNameForTenant(tenantId: string, version?: number): string {
  let norm = tenantId.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  if (norm !== tenantId || norm.length > 43) {
    const guard = createHash("sha256").update(tenantId).digest("hex").slice(0, 10);
    norm = `${norm.slice(0, 32)}-${guard}`;
  }
  return `tenant-${norm}-v${version ?? INDEX_VERSION}`;
}
