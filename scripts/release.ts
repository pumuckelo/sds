import { resolve } from "node:path";

export async function release(root: string, action = "release") {
  if (!["release", "tag", "push"].includes(action))
    throw new Error("Usage: bun release [tag|push]");
  async function git(...args: string[]) {
    const process = Bun.spawn(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (code !== 0) throw new Error(error.trim() || `git ${args[0]} failed`);
    return output.trim();
  }
  if (await git("status", "--porcelain"))
    throw new Error("Commit or stash changes before releasing.");
  const branch = await git("symbolic-ref", "--short", "HEAD");
  await git("fetch", "--tags", "origin");
  const manifest = JSON.parse(await git("show", "HEAD:package.json"));
  if (typeof manifest.version !== "string")
    throw new Error("Missing package version.");
  let version: string = manifest.version;
  const tags = new Set((await git("tag", "--list")).split("\n"));
  let tag = `v${version}`;
  if (action !== "push") {
    if (
      tags.has(tag) &&
      (await git("rev-parse", `refs/tags/${tag}^{commit}`)) !==
        (await git("rev-parse", "HEAD"))
    ) {
      const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
      if (!match)
        throw new Error(
          "Automatic patch bumps require a stable major.minor.patch version.",
        );
      let patch = BigInt(match[3]!);
      do {
        patch++;
        version = `${match[1]}.${match[2]}.${patch}`;
        tag = `v${version}`;
      } while (tags.has(tag));
      manifest.version = version;
      await Bun.write(
        resolve(root, "package.json"),
        JSON.stringify(manifest, null, 2) + "\n",
      );
      // Bun's lockfile does not store the root package version.
      await git("add", "--", "package.json");
      await git("commit", "-m", `Release ${tag}`, "--", "package.json");
      console.log(`Bumped to ${version} and committed the version change.`);
    }
    if (!tags.has(tag)) {
      await git("tag", "-a", tag, "-m", `SDS ${tag}`);
      console.log(`Created ${tag}.`);
    }
  } else if (!tags.has(tag)) {
    throw new Error(`Create ${tag} first with bun run release:tag.`);
  }
  if (action === "tag") return;
  const reference = `refs/tags/${tag}`;
  console.log(`Pushing ${branch} and ${tag} to origin.`);
  try {
    await git(
      "push",
      "--atomic",
      "origin",
      `HEAD:refs/heads/${branch}`,
      `${reference}:${reference}`,
    );
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : error}\nLocal tag ${tag} remains; rerun bun release to retry.`,
    );
  }
}

if (import.meta.main) {
  if (process.argv.includes("--help")) {
    console.log(
      "bun release: bump patch if needed, commit the version, and push branch and tag.",
    );
  } else {
    try {
      await release(resolve(import.meta.dir, ".."), process.argv[2]);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
    }
  }
}
