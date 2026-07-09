import { $ } from "bun";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, "..");

await $`bun run build`.cwd(desktopDir);
await $`bunx electron-builder --dir`.cwd(desktopDir);

console.log("Desktop package artifacts written to apps/desktop/release");
