import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const [, , command, ...args] = process.argv;

if (command === "generate") {
  const [privatePathArg, publicPathArg] = args;
  if (!privatePathArg || !publicPathArg) throw new Error("Usage: node scripts/sign-skill-release.mjs generate <private.pem> <public.pem>");
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privatePath = path.resolve(privatePathArg);
  const publicPath = path.resolve(publicPathArg);
  await fs.mkdir(path.dirname(privatePath), { recursive: true });
  await fs.mkdir(path.dirname(publicPath), { recursive: true });
  await fs.writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
  await fs.writeFile(publicPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644, flag: "wx" });
  console.log(JSON.stringify({ privatePath, publicPath }));
} else if (command === "sign") {
  const [encryptedArg, privateKeyArg, signatureArg] = args;
  if (!encryptedArg || !privateKeyArg || !signatureArg) throw new Error("Usage: node scripts/sign-skill-release.mjs sign <release.enc> <private.pem> <release.sig>");
  const encrypted = await fs.readFile(path.resolve(encryptedArg));
  const privateKey = await fs.readFile(path.resolve(privateKeyArg), "utf8");
  const signature = crypto.sign(null, encrypted, privateKey).toString("base64");
  const signaturePath = path.resolve(signatureArg);
  await fs.writeFile(signaturePath, `${signature}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ signaturePath, sha256: crypto.createHash("sha256").update(encrypted).digest("hex"), bytes: encrypted.length }));
} else {
  throw new Error("Commands: generate | sign");
}
