# Neon Postgres-only CLI + MCP setup for Jazz Recovery (review only)

**This guide is for the existing `karnameena/jazz-recovery-server` feature branch, not the production Render deployment.**

| Scope | Existing Neon value |
|---|---|
| Organization | Boo Boo (`org-calm-term-23364812`) |
| Project | `polished-queen-27336310` |
| Branch | `production` (ID `br-frosty-leaf-b4ih1uwe`) |
| Service | **Postgres only** |

These identifiers are not database passwords. Do not put real secrets or private database snapshots in GitHub.

Neon projects already include PostgreSQL. Do **not** enable Neon Auth (Jazz already has owner auth), Object Storage, Functions, AI Gateway, or Data API during this migration.

## On your Windows PC (VS Code terminal)

Use a **local clone of this feature branch**. Do not overwrite another Jazz folder that has uncommitted modifications.

PowerShell:

```powershell
node --version
# The "neon skills" subcommand requires Node.js >= 22.20.
# If lower, install a current Node.js 24 LTS release first.
npm install --global neon@latest
neon --version

# YOU perform this browser-based OAuth step on your own PC.
neon auth

# As requested, install the default Neon agent skills:
npx neon skills -y

# Only if no supported agent was detected or neon-postgres is missing,
# explicitly target the existing VS Code workspace:
neon skills -s neon -s neon-postgres --agent vscode -y

# Links THIS FOLDER to the existing project & existing production branch.
# --no-env-pull is deliberate: don't write DB secrets to an env file.
neon link --org-id org-calm-term-23364812 --project-id polished-queen-27336310 --branch production --no-env-pull -y

# Add MCP to VS Code using OAuth (no API key committed). It is project-scoped,
# read-only and is intended for inspection rather than production mutations.
neon mcp --oauth --project --agent vscode --project-id polished-queen-27336310 --read-only -y

# Read-only check that the link and project are accessible.
neon branch list
```

Restart VS Code to load MCP and Neon skills; authorize the MCP OAuth connection when prompted by VS Code. Run these commands in **your own shell**. Automated agents must not launch browser login or request secrets pasted in chat.

If your coding agent is Cursor rather than VS Code, replace `vscode` with `cursor` in the two `--agent` commands. Avoid installing MCP in every agent or granting write access until you need it.

### ChatGPT setup

The VS Code agent's local MCP settings do not automatically connect a ChatGPT conversation. Connect the Neon integration in ChatGPT with your own Neon account authorization if you want this assistant to verify your project and schema directly. Never share a full connection string, API key, password, bearer credential, recovery photo or database backup in chat.

## Connection and data migration, explicitly deferred

Before any real account import, Neon must have a **separate staging branch/database** with no actual production recovery data, and the migration should be tested privately. Do not run `neon env pull`, `neon config apply`, `neon deploy`, or the import script during this CLI/MCP setup.

- The backend requires `JAZZ_DB_ENGINE=postgres` and a private `DATABASE_URL`; there is no alternate database engine or importer.
- `production` is an existing Neon branch name, not permission to deploy or write into it.
- Do not reset, recreate, overwrite, or bulk-modify existing owner/device/recovery records as part of code deployment.
- The `.neon` CLI context and `.env*` secrets are git-ignored on this feature branch.
- See `docs/postgres-migration-checklist.md` before any future schema creation, migration or Render deployment.

Official resources:
- https://github.com/neondatabase/agent-skills/blob/main/skills/neon/SKILL.md
- https://neon.com/docs/ai/agent-skills
- https://neon.com/docs/ai/connect-mcp-clients-to-neon
- https://neon.com/docs/cli/link
