---
name: deploy
description: Deploy the FermentoCloud cloud stack to production and print the Pi update command. Use when the user asks to deploy or ship FermentoCloud changes.
---

# Deploy FermentoCloud

1. Deploy the cloud stack to production:
   ```bash
   cd cloud && npm run deploy
   ```
   Report the `ReadingsFunctionUrl` output value to the user if it changed.

2. Ask the user which git ref they want running on the Pi (default: `main`).

3. Print this exact command for the user to paste into the Raspberry Pi
   Connect browser shell — do not attempt to run it yourself, Claude has no
   tool access to drive Raspberry Pi Connect's browser UI:
   ```bash
   cd /home/pi/FermentoCloud && git fetch && git checkout <ref> && git pull && sudo systemctl restart fermento-collector
   ```
   Substitute `<ref>` with the branch or `main` the user chose.

4. Remind the user this same command works to try a branch on real hardware
   before merging — `<ref>` isn't limited to `main`.
