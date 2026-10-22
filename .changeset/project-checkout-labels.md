---
"claudexor": patch
---

Disambiguate recent project folders with the shortest distinguishing parent suffix and add full-path hover help. The macOS project chip keeps its ordinary folder glyph; its hover and VoiceOver text say whether the selected folder is in a primary Git checkout or a linked worktree, including reftable repositories, without implying the main branch or where a thread executes. A selected thread with unloaded metadata says “Project unavailable” instead of showing the draft project, and draft help identifies the project for the new thread. Ordinary folders and remote or unavailable selections never inherit another local checkout's Git status.
