# Install and adopt SDS

Read only for installation, explicit repository adoption, or a missing executable.
Normal task usage does not require this file.

1. Check `command -v sds` and `sds --version`. Reuse an existing working install unless an upgrade was requested.
2. Install the published macOS/Linux release if missing:

   ```sh
   curl --proto '=https' --tlsv1.2 -fsSL https://github.com/pumuckelo/sds/releases/latest/download/install.sh | sh
   ```

   The installer verifies the release archive checksum and installs to `~/.local/bin` by default. `INSTALL_VERSION=vX.Y.Z` selects a release; `INSTALL_ROOT` and `INSTALL_BIN_DIR` override destinations. If no release has been published, report that fact; do not claim success. Source installation is documented in the README.
3. Ensure the binary directory is on PATH in the agent's shell. Run `sds --version` and `sds schema update`. The standalone executables do not require Bun.
4. In the user-selected repository run `sds init`, then `sds task list`. Keep the default shared state directory unless the user has configured another. Do not write task JSON manually.
5. For explicit repository adoption, update `AGENTS.md` and `CLAUDE.md` in that repository with a concise SDS usage note. Preserve all existing instructions; update an equivalent section rather than duplicating it. Do not modify these files for a one-off request to inspect a task.
6. Copy the installed `~/.local/share/sds/current/skills/sds` directory into the harness's supported skill location, if requested/needed and discoverable. For portable project instructions, it can instead be copied into `.agent-tools/sds` and referenced from both instruction files. Preserve user-edited copies and explain updates; never assume all harnesses use the same skill directory.
7. The project note should direct development work through SDS, use the current repository, reuse existing tasks, keep status current, and read the usage skill. Point to `SKILL.md`, not this setup reference.
8. The optional dashboard runs with `sds-dashboard` and opens at http://127.0.0.1:4317/. It does not need to run for CLI use. Reuse an existing server and the same state directory. Use a persistent terminal appropriate to the user's environment, not an untracked background process.

The installer does not edit project instructions, shell profiles or harness settings. Those are explicit agent setup steps. Verify the final CLI and project registration before reporting completion.
