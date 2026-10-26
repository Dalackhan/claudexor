---
"@claudexor/core": patch
"@claudexor/harness-claude": patch
---

On Windows, never hand a `.exe`/`.com` without the PE minimum shape (`MZ`, then `PE\0\0`) to the OS. The harness resolver skips such a PATH candidate, standard npm launcher target or Node interpreter, naming the file, and uses a later healthy candidate. When nothing is selected, a bare-name spawn whose own search (the cwd first, then PATH) could only reach such a file is refused before any process starts with `EFTYPE`. This covers the placeholder `claude.exe` an npm install leaves when the package's postinstall did not run. Relative names and relative PATH entries now resolve from the spawn's cwd, so the file inspected is the file that runs.

Claude doctor and discovery report the unlaunchable file instead of "claude CLI not found on PATH". The Claude auth-status probe treats a format failure (`EFTYPE`/`ENOEXEC`) as structural: one attempt, with no retry and no last-known-good fallback. Unreadable files, failed reads, busy or missing files and unknown loader errors keep their previous handling, and nothing about a refusal is remembered, so replacing the file recovers without a restart.
