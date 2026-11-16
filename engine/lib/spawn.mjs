// Child processes, Windows included: npm installs vercel, npx and codex there as .cmd files, which Node's own spawn
// can't start without a shell. cross-spawn adds the shell on Windows and escapes every argument for it.
import crossSpawn from "cross-spawn";

export const spawn = crossSpawn;
export const spawnSync = crossSpawn.sync;
