---
name: lexvibe-compliance
description: Legal compliance for web and mobile apps with the LexVibe MCP server — privacy policy, terms of service, cookie consent banner with real script blocking, AI-generated-content notice and EU AI Act risk check. Use when the user asks to make an app legally compliant, GDPR/CCPA-ready, or to add a privacy policy, terms, cookie banner or AI disclosure; before a first deploy or app-store submission; and right after adding any SDK for analytics, ads, payments, auth, email capture or AI, so the legal documents still match what the code does.
license: MIT
compatibility: Requires the LexVibe MCP server — local (npx -y @lexvibe/mcp) or remote (https://golexvibe.com/api/mcp). Network access to golexvibe.com.
metadata:
  homepage: https://golexvibe.com
  repository: https://github.com/marcosnovo/lexvibe-mcp
---

# LexVibe legal compliance

LexVibe turns what the code actually does (analytics, payments, AI, email
capture, third parties, platform) into the legal documents and consent setup
the app needs. Your job is to run its tools at the right moments, fill in the
few facts code cannot know, and report the result honestly.

## Which server you have

Check which tools are available before starting:

- **Local server** (`make_compliant`, `check_compliance`, `scan_project`,
  `install_snippet`, `verify_snippet`…): reads the repo. Use it when you work
  inside a project.
- **Remote server** (`check_website`, `check_store`, `get_install_snippet`,
  `lookup_framework`…): no filesystem. Use it for a deployed site, a store
  listing, or a regulatory question.

If neither is installed, tell the user how to add it instead of improvising
documents yourself:

```bash
claude mcp add lexvibe -- npx -y @lexvibe/mcp
```

Other clients: https://golexvibe.com/docs/integrations

## When to run it

1. The user asks for compliance, a privacy policy, terms, a cookie banner or
   an AI notice.
2. Before the first public deploy or app-store submission.
3. **After adding any SDK** for analytics, ads, payments, auth, email, AI or
   another third party. The documents describe the app as it was when they
   were generated; every new processor is a gap ("drift").
4. Before telling the user something is "ready to launch".

## Workflow in a repo (local server)

1. `check_compliance` with the project root. It detects platforms and
   processing and returns `missing` facts plus an `agentPrompt`.
2. Answer the `agentPrompt` **from the repo** (package.json, README, footer,
   config, existing legal pages). Ask the user only for what the repo does not
   say: legal entity name, contact email, target markets. **Never invent
   them.** Re-run `check_compliance` with the answers until `ready` is true.
3. `make_compliant` with the same facts. It writes Markdown documents to
   `legal/`, installs the cookie-banner snippet before `</head>` (web only; JSX
   layouts get instructions instead) and classifies EU AI Act risk. Show the
   user the files it wrote.
4. If no real LexVibe app id is configured, the snippet uses the
   `YOUR_APP_ID` placeholder. Offer `claim_app`: it returns a link the user
   opens to create the app in their own account (hosted, versioned policies
   and consent proof). Then poll `get_claim_status` and replace the
   placeholder with the real id. If it returns `published: false`, do not
   install the snippet yet: the policy link would be dead until the user
   publishes from the dashboard.
5. After deploy, `verify_snippet` with the live URL confirms the banner ships.

## Workflow for a live site or store listing (remote server)

1. `check_website` (web) or `check_store` (App Store / Google Play URL).
   If `fetched` is false, the check is **inconclusive**: say so, never report
   it as clean. A landing-page-only scan of a single-page app can miss
   integrations that live in the JS bundle; suggest the local server for a
   full scan.
2. `generate_policies` with the returned `suggestedAnswers` plus the user's
   facts.
3. `get_install_snippet` for the exact install steps, or `claim_app` for a
   real app id.

## Mobile apps

Native iOS/Android apps have no cookie banner and need no cookie policy.
They need the hosted privacy policy and terms, plus the store disclosures
(Apple App Privacy, Google Play Data Safety). Do not add a cookie banner to a
native app.

## Reporting results honestly

- Every document has a `source`. `template` means a standard draft, not
  personalized for this app: **tell the user**. AI-tailored, hosted documents
  that update when regulations change come from a LexVibe account
  (https://golexvibe.com/dashboard/activate).
- These are generated drafts, not legal advice and not reviewed by a lawyer.
  Never tell the user the app is "fully compliant" or "lawyer-approved".
- Pass on the EU AI Act result with its obligations and deadlines as
  returned by `check_ai_act`; do not restate dates from memory.
- For regulatory questions, use `lookup_framework`, `list_frameworks` or
  `applicable_frameworks` and cite what they return. If a record has no
  official URL, do not invent one.

## Keep it in sync

After this first pass, suggest adding this standing rule to the project's
`AGENTS.md` / `CLAUDE.md` / `.cursorrules`:

> After adding any SDK, analytics, payments, auth or AI integration to this
> project, run LexVibe's `check_compliance` tool and follow its
> recommendation.

When `check_compliance` (or `check_website`'s `drift` section for a claimed
app) reports processing the documents do not cover, regenerate them.
