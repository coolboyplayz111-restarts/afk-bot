```markdown
# Minecraft Multi-Bot Keeper

A simple web app and mineflayer-based bot manager that can run multiple Minecraft bots to keep servers online.

Features
- Multiple bots (create as many as you like).
- Each bot tries to join the specified server and re-attempts every 15 seconds.
- Random movement when idle.
- Improved hostile-mob avoidance (samples safe locations away from nearby hostiles and uses pathfinder to run there).
- Bot attempts to sleep at night if a reachable bed is nearby.
- Drops entire inventory when any player says exactly "drop" in chat.
- Web UI with:
  - Bot Maker (create bots)
  - Per-bot Dashboard (first-person viewer, telemetry, chat, manual override controls)
- No navbars, no sign-ins.

Quick start (local)
1. Install Node.js 18+.
2. Install dependencies:
   npm install
3. Start:
   node server.js
4. Open in your browser:
   - Bot Maker: http://localhost:3000/
   - Dashboard: open a bot's dashboard link from the Bot Maker page.

Create a GitHub repo and push (one-click script)
- If you have the GitHub CLI (`gh`) installed and authenticated, run:
  bash create_repo.sh my-repo-name
- The script will:
  - initialize git (if needed),
  - create a GitHub repo under your account,
  - push the project.
- If `gh` is not available, the script prints manual commands to run.

Notes & limitations
- prismarine-viewer runs a separate HTTP viewer per bot on incremental ports starting at 3001.
- Bots rejoin every 15 seconds when disconnected. Ensure permission from target servers before using.
- Avoidance and pathfinding are improved but may still need tuning for specific servers.
- Sleeping requires reachable beds; placing beds is not implemented.
- Use responsibly.

If you want me to add:
- per-bot inventory UI,
- bot shutdown/delete UI,
- better escape behavior (sprinting, digging, placing blocks),
- or GitHub Actions to auto-deploy,
tell me which and I’ll prepare the files.
```
