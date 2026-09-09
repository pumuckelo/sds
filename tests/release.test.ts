import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { release } from "../scripts/release";

test("release bumps occupied versions, pushes branch and tag, and safely retries", async () => {
  const temp = await mkdtemp(join(tmpdir(), "sds-release-"));
  const root = join(temp, "repo");
  await mkdir(root);
  async function git(...args: string[]) {
    const child = Bun.spawn(["git", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code, error).toBe(0);
    return output.trim();
  }
  try {
    await git("init");
    await git("config", "user.name", "Release Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", version: "0.1.0" }),
    );
    await git("add", ".");
    await git("commit", "-m", "Initial");
    await git("init", "--bare", join(temp, "remote.git"));
    await git("remote", "add", "origin", join(temp, "remote.git"));
    await release(root);
    const initial = await git("rev-parse", "HEAD");
    await release(root);
    expect(await git("rev-parse", "HEAD")).toBe(initial);
    await writeFile(join(root, "change"), "change");
    await expect(release(root)).rejects.toThrow("Commit or stash");
    await git("add", ".");
    await git("commit", "-m", "Change");
    await release(root);
    expect((await Bun.file(join(root, "package.json")).json()).version).toBe(
      "0.1.1",
    );
    expect(await git("rev-parse", "v0.1.0^{commit}")).toBe(initial);
    expect(await git("rev-parse", "v0.1.1^{commit}")).toBe(
      await git("rev-parse", "HEAD"),
    );
    expect(await git("status", "--porcelain")).toBe("");
    expect(await git("ls-remote", "--tags", "origin")).toContain(
      "refs/tags/v0.1.1",
    );
    await release(root);
    expect((await Bun.file(join(root, "package.json")).json()).version).toBe(
      "0.1.1",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
