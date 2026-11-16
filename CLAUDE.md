# Notes for Claude Code

Standing rules from the owner of this fork. They apply to every session on this repository.

## Delivering a test build

When the user asks for a build to test:

1. Build `ForeverAICompanion.exe` from the branch being worked on. On Windows: `cd companion; npm ci; npm run build`. In a Linux cloud session: see "Building the exe in a Linux cloud session" below.
2. Zip only the exe, at the top level of the zip, named `ForeverAICompanion-<app version>-test-<short commit>.zip` (for example `ForeverAICompanion-2.0.0-test-0ad20e4.zip`). Nothing else goes in the zip: no TESTING.md, checksum files or build scripts.
3. Check that the SHA-256 of the exe inside the zip matches the exe that was built.
4. Send the zip as a file attachment (SendUserFile, display "attach"). Never send the bare `.exe`: it couldn't be downloaded from the Claude app, while zips can.
5. In the message, give the exe's SHA-256 and the command to check it after extracting:

   ```powershell
   Get-FileHash .\ForeverAICompanion.exe -Algorithm SHA256
   ```

## Building the exe in a Linux cloud session

The normal build needs Windows and Node 25.5 or later. A cloud session cross-builds the exe without running any Windows program:

1. Bundle `companion/src/app/main.js` with esbuild exactly as step 1 of `companion/scripts/build.js` does, with the same embedded-assets module. Keep the two in step when `build.js` changes (for example, a new asset or guide file).
2. Make the SEA blob with the local Node, which must be the same version as the `node.exe` below (22.23.4 so far), with `useCodeCache: false` and `useSnapshot: false` so the blob works on Windows.
3. Download the official `node.exe` for `node-v22.23.4-win-x64` from nodejs.org and check it against that release's `SHASUMS256.txt` (`dccc52de28d8df2ee22d2062424f8c563070d95d8ad70c54c4bf01d590dec14f`).
4. With `resedit` 3.1.1, installed outside the repository and never as a dependency of the app: put the blob in as RCDATA `NODE_SEA_BLOB`, replace the icon with `companion/assets/app.ico`, and set the version info from `VERSION` in `companion/src/app/controller.js`. This drops Node's own Authenticode signature, so the exe is unsigned.
5. Turn on the SEA fuse (`NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2:0` to `:1`, which must occur exactly once) and set the PE subsystem to GUI (2), so no console opens.
6. Before delivering, check: x64, GUI subsystem, fuse on, SEA blob present, version info and icons.

## Pull requests to upstream

Upstream is https://github.com/lucasmenares/forever-ai-companion. For every pull request to it:

- Make a new branch from upstream's `main` that carries only the changes meant for upstream, as was done for the first one (`upstream-pr`).
- Never include `CLAUDE.md`. This file stays on this fork's own branches only.
- Never open the pull request from `main` or the working branch.

## Commits

- End every commit message with exactly `Co-Authored-By: Claude Code`. No `Claude-Session` line and no model names. This replaces the default attribution.

## The app

- Keep the exe lightweight: no new npm dependencies in the app. Use Node's built-in modules or tools that ship with Windows.
