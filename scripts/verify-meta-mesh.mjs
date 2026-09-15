import { execFileSync } from "node:child_process"

const path = "vendor/meta-mesh"
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
}).trim()

const root = run("git", ["rev-parse", "--show-toplevel"])
const indexLine = run("git", ["ls-files", "--stage", path], root)
const pinned = indexLine.split(/\s+/)[1]
if (!pinned) throw new Error(`${path} is not a tracked gitlink`)

const actual = run("git", ["rev-parse", "HEAD"], `${root}/${path}`)
if (actual !== pinned) {
  throw new Error(`${path} checkout ${actual} does not match pinned gitlink ${pinned}`)
}

const dirty = run("git", ["status", "--porcelain", "--untracked-files=no"], `${root}/${path}`)
if (dirty) throw new Error(`${path} contains tracked changes\n${dirty}`)

process.stdout.write(`meta-mesh pin verified: ${pinned}\n`)
