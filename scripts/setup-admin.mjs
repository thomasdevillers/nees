// Saves the admin password you choose to .env.local.
//   npm run admin:setup                 → asks for it (typing is hidden)
//   npm run admin:setup -- "my password" → uses the given value
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const MIN_LENGTH = 5;

function ask(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = text => { if (!muted || text.includes("\n")) process.stdout.write(muted ? "\n" : text); };
    rl.question(question, answer => { rl.close(); resolve(answer); });
    muted = true;
  });
}

async function main() {
  let password = process.argv[2];
  if (password === undefined) {
    if (!process.stdin.isTTY) throw new Error('Pass the password as an argument: npm run admin:setup -- "your password"');
    password = await ask("Choose an admin password: ");
    if (await ask("Type it again: ") !== password) throw new Error("The passwords did not match. Nothing was changed.");
  }
  if (password.length < MIN_LENGTH) throw new Error(`Use at least ${MIN_LENGTH} characters. Nothing was changed.`);
  if (/[\r\n]/.test(password)) throw new Error("The password cannot contain line breaks.");

  const env = await readFile(".env.local", "utf8").catch(() => "");
  const replaced = /^ADMIN_PASSWORD[ \t]*=/m.test(env);
  const cleaned = env.replace(/^ADMIN_PASSWORD[^\r\n]*(?:\r?\n|$)/gm, "").replace(/\n?# OnScene admin portal\n?$/, "");
  await writeFile(".env.local", `${cleaned.trimEnd()}\n\n# OnScene admin portal\nADMIN_PASSWORD=${password}\n`.trimStart(), { mode: 0o600 });
  console.log(`${replaced ? "Updated" : "Saved"} ADMIN_PASSWORD in .env.local.`);
  console.log("Set the same value as ADMIN_PASSWORD in Vercel (Settings → Environment Variables) and redeploy.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
