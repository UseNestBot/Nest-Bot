# Security policy

Nest runs AI agents that can read and write files, call tools and drive a browser on your machine, and it can be reached from your phone over Tailscale. We take reports about any of that seriously.

## Supported versions

Only the [latest release](https://github.com/UseNestBot/Nest-Bot/releases/latest) gets security fixes. Nest updates itself, so please check you're on the newest version before reporting.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Anything older | No |

## Reporting a vulnerability

**Please don't open a public issue, pull request or discussion for a security problem.**

Report it privately through GitHub instead:

1. Go to the [Security tab](https://github.com/UseNestBot/Nest-Bot/security) of this repo, or use the [report form](https://github.com/UseNestBot/Nest-Bot/security/advisories/new) directly.
2. Click **Report a vulnerability**.
3. Fill in the form.

Please include:

- What the problem is and what an attacker could do with it.
- Steps to reproduce, or a proof of concept.
- The Nest version (under **Settings, Versions**), your OS, and which provider was involved.
- Any logs or screenshots, with your own tokens, keys and personal data removed.

## What happens next

- We'll reply within **3 working days** to confirm we've got it.
- We'll keep you updated as we look into it, and aim to ship a fix for confirmed issues within **30 days**, sooner for serious ones.
- Once a fix is out we'll publish a GitHub security advisory. We'll credit you there unless you'd rather we didn't.

Please give us a reasonable chance to fix it before you share details publicly.

## What's in scope

Things we especially want to hear about:

- An agent getting past an approval card, or running with more access than its permission mode allows.
- Prompt injection (from a web page, file, email or connector) that makes Nest itself do something the user didn't approve. Injection that only affects what the model says, with no action taken, is usually a provider issue rather than a Nest one.
- Remote access: getting into Nest without pairing, reusing or guessing pairing codes or device tokens, or reaching Nest from outside your tailnet.
- The local MCP server or named pipe being usable by another process or another conversation.
- API keys, connector data or provider credentials leaking to disk, logs, other agents or the network.
- Nest ending up billing an API key when `allowApiKeyBilling` is off.
- Problems in the installer or the auto updater, such as installing an update that isn't from our releases.

## What's out of scope

- Bugs in Claude Code, Codex, Cursor, Gemini CLI, Grok CLI, Tailscale or Chrome themselves. Please report those to their makers.
- Attacks that need someone who already has full control of your user account or machine.
- The installers not being code signed yet. We know; it's in the README.
- Missing hardening with no realistic way to exploit it.

## Safe harbour

If you make a good faith effort to follow this policy, only test against your own installs and accounts, and don't access or damage other people's data, we won't take legal action against you over your research.
