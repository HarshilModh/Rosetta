# CLAUDE.md — Rosetta

## What this project is

Rosetta is an **agent-readability compiler**. It crawls a website, compiles its content
into agent-ready artifacts (`llms.txt`, `llms-full.txt`, per-section markdown), and
**proves** the artifact is better than the live site by running the same benchmark agent
against both and comparing task accuracy, token cost, and latency.

The one rule that governs all build decisions: **the benchmark agent is the single
verification oracle. Everything else exists to make its number go up.** When in doubt
about priorities, protect the oracle and the before/after comparison.

Architecture philosophy (put this in code comments where relevant, it is the design
signature): *AI structures ambiguity, deterministic engines render verdicts, reality
keeps score.*

## Hard constraints — never violate

1. **Free-tier LLM APIs only.** Gemini Flash (primary), Groq Llama (judge). Total paid
   spend budget for the entire project: $10, reserved for final demo runs only. Never
   add a paid API call path without an explicit config flag defaulting to off.
2. **Every LLM call goes through the gateway** in `packages/core/src/llm/`. No direct
   SDK calls anywhere else. No exceptions, including scripts and tests.
3. **All tests run in fixture replay mode.** A test that makes a live LLM call is a bug.
4. **Read-only over target sites.** Rosetta never modifies anything on a customer site.
   Respect robots.txt. Max 1 request/second per domain.
5. **Money-free scope:** no Stripe, no billing, no teams/orgs/roles. Single-user-owns-
   projects model only.
6. **Exact provenance:** every emitted artifact line must trace to (fact_id → page_id →
   text span). An artifact line without provenance is a bug.

## Day-0 prep (before Phase 0)

Two demo sites must be chosen before building. Criteria: public, 30–60 pages,
content-rich, agent-hostile in different ways — one with JS-rendered critical content
(pricing/feature tables invisible to raw fetch), one with genuine cross-page
contradictions. Good hunting grounds: mid-size SaaS docs, university department sites,
local-government service sites.

Per site, ~15 benchmark tasks written **by hand** with correct answers verified by a
human reading the site ("what's the refund window", "how do I authenticate", "which
plan includes X"). These hand-verified answers are the judge's ground truth. Store them
via the Phase 1 seed script. Do not LLM-generate the initial task suites — their
correctness is what makes every downstream number trustworthy.

## Monorepo layout

```
rosetta/
├── apps/
│   ├── web/        # Next.js 15 App Router — dashboard, auth, review UI, reports
│   ├── worker/     # BullMQ processors — crawl, extract, compile, benchmark, drift
│   └── edge/       # Hono server — serves /llms.txt etc., logs agent traffic
├── packages/
│   └── core/       # shared: Drizzle schema, LLM gateway, Zod schemas, artifact logic
├── docker-compose.yml   # Postgres (pgvector image), Redis, MinIO
└── CLAUDE.md
```

pnpm workspaces. TypeScript strict everywhere. Node 22.

## Stack (do not substitute without asking)

- **Web:** Next.js 16 (App Router, server components), Clerk for auth
- **API layer:** Hono (inside Next routes and standalone in apps/edge)
- **DB:** Postgres 16 + pgvector, Drizzle ORM, migrations in packages/core
- **Jobs:** BullMQ + Redis. All async work is a queue job. Rate limiting via BullMQ
  limiter config, never hand-rolled sleeps.
- **Crawling:** Playwright (both raw-HTTP and rendered fetch per page), robots-parser,
  node-html-markdown for HTML → markdown preprocessing
- **LLM:** Vercel AI SDK as the provider abstraction. Models set in config, never
  hardcoded at call sites.
- **Embeddings:** local only — transformers.js with bge-small-en-v1.5. Never an API.
- **Blobs:** S3-compatible (MinIO locally) — page snapshots, traces, artifacts
- **Validation:** Zod at every boundary. LLM structured outputs are Zod-validated;
  a validation failure triggers the repair/retry path, never a silent pass-through.
- **Tests:** Vitest + fast-check for property tests on deterministic cores
- **Money/decimals:** not applicable here, but token counts are integers — no floats
  in quota or spend arithmetic.
- **Phase 6 only:** Octokit + GitHub App (minimal scopes), Docker/E2B sandboxes for
  clone + build, ts-morph + tree-sitter for AST-level fixes, pixelmatch/SSIM for
  visual parity. Do not install these before Phase 6.

## LLM gateway rules (packages/core/src/llm/)

- Interface: `generateObject`, `generateText`, `runToolLoop` — thin wrappers over
  Vercel AI SDK.
- **Fixture cache:** every request is hashed (model + messages + tools + schema).
  Modes: `record` (call API, persist to Postgres `llm_fixtures`), `replay` (serve
  fixture or throw `FixtureMissError`), `live` (call, don't persist).
  Env: `LLM_MODE`, default `replay` in dev and test, `record` only when explicitly set.
- **Rate limiter:** BullMQ limiter 12 req/min for the Gemini queue (buffer under the
  15 RPM free-tier cap). Exponential backoff with jitter on 429s. Never immediate retry.
- **Daily quota guard:** Redis counter of Gemini requests, pause queues at 1,400/day
  (cap is 1,500). Resets midnight Pacific — mirror that reset time exactly.
- **Spend log:** every call writes a row to `spend` (stage, model, tokens_in,
  tokens_out, fixture_hit boolean). The dashboard cost panel reads this table.
- **Model routing config** (packages/core/src/llm/routing.ts):
  - extraction → gemini-flash
  - entailment/conflict checks → gemini-flash
  - benchmark agent loop → gemini-flash
  - judge → groq llama
  - failover slot → openrouter free variant

## Database conventions

- Every table that belongs to a user has `user_id` (Clerk ID, text) from the first
  migration. Every query in apps/web is scoped to `auth().userId`. No unscoped reads.
- Content-addressing: pages carry `content_hash` (raw) and `rendered_hash`. Artifacts
  are immutable rows in `artifact_versions` keyed by content hash; "deploy" is a
  pointer update.
- Core tables: `users_quotas`, `projects`, `crawl_snapshots`, `pages`, `facts`,
  `fact_sources`, `conflicts`, `tasks`, `benchmark_runs`, `task_results`,
  `artifact_versions`, `spend`, `llm_fixtures`, `edge_requests`.
- Phase 6 tables (create only when Phase 6 starts): `repo_installations`,
  `fix_runs`, `fix_findings`, `fix_prs`.
- `facts.status`: `auto | reviewed | conflicted | rejected`.
- `task_results.verdict`: `correct | partial | wrong | gave_up`.

## Build phases

Work one phase per session. At session start: read this file, state which phase,
propose a plan, wait for approval before writing code. Write tests (replay mode)
alongside each feature, not after.

### Phase 0 — Skeleton + LLM gateway (days 1–2)
- pnpm workspace scaffold, docker-compose (postgres+pgvector, redis, minio),
  Drizzle schema for all core tables, Clerk wired in apps/web with middleware.ts,
  `user_quotas` created on first sign-in.
- The LLM gateway with fixture cache, rate limiter, quota guard, spend log.
- Definition of done: a script calls Gemini through the gateway twice; second call is
  a fixture hit with zero API usage. `pnpm test` green.

### Phase 1 — Benchmark agent, the oracle (days 3–4)
- Task schema + seed script for the hand-written task suites (question, rubric,
  expected answer).
- Agent loop (`runToolLoop`) with exactly two tool configs:
  - **live mode:** `fetch_page` (Playwright-rendered), `find_links` — against the
    real site
  - **artifact mode:** `read_artifact`, `read_section` — against a local artifact
  - Hard budgets: max 10 turns, max 50K tokens per task, graceful `gave_up` outcome.
- Judge on Groq: structured verdict against the rubric + one-line rationale.
- Trace capture: full per-turn JSON to MinIO, keyed from `task_results.trace_ref`.
- CLI: `pnpm bench --site <slug> --mode live|artifact` prints a scorecard.
- Definition of done: baseline (live) scorecard for demo site #1 with traces on disk.

### Phase 2 — Compilation: "Build the agent-ready version" (days 5–8)
This is the deep-crawl → compile pipeline from the user flow, staged as BullMQ jobs.
Show pipeline progress to the user per stage (SSE): Crawling → Extracting →
Deduplicating → Resolving conflicts → Compiling → Verifying.

**2a. Deep crawl (day 5)**
- Playwright worker, BullMQ fan-out, robots.txt respected, 1 req/sec/domain.
- Both fetch modes per page; store raw + rendered snapshots to MinIO; hash both.
- Raw-vs-rendered content diff flags "JS-only content" pages — persist as a finding.
- Scope config honored: included sections, depth, excluded paths (from onboarding).

**2b. Extraction + dedup (day 6)**
- Per page: HTML → markdown preprocess, then gateway `generateObject` with the Fact
  Zod schema: `{ statement, type, confidence, source_span }`. Zod failure → one
  repair retry with the validation error in the prompt → then dead-letter.
- Local embeddings for every fact → pgvector. Near-duplicate clustering (cosine
  threshold in config) collapses boilerplate; keep one canonical fact per cluster
  with all sources attached in `fact_sources`.

**2c. Conflict detection + review queue (day 7)**
- Candidate pairs: embedding similarity above threshold AND not same-cluster.
- Cheap entailment call per pair: `same | contradictory | unrelated`.
- Contradictions and confidence < threshold → `conflicts` row, `needs_review`.
- **The human gate:** review UI in apps/web — show both facts, their source pages
  and spans, buttons: pick A / pick B / enter corrected fact. Resolution recorded
  with who/when. Conflict review makes no LLM calls — it is free and instant.
- Nothing silently guessed: unresolved conflicts exclude both facts from the artifact.

**2d. Artifact emission (day 8)**
- Fact scoring: task-relevance (embedding similarity to task suite) + section weight.
- Greedy knapsack packs `llms.txt` under token budget (default 4K, config).
  Everything canonical → `llms-full.txt`. Per-section markdown files.
- Every emitted line carries provenance sidecar (fact → page → span).
- Immutable `artifact_versions` row, content-addressed, files to MinIO.
- Property tests (fast-check): knapsack never exceeds budget; every artifact line
  resolves to a valid provenance chain; recompiling identical input is byte-identical.
- Definition of done: `pnpm compile --site demo1` emits a readable, correct llms.txt.

### Phase 3 — Close the loop: verify + report (days 9–10)
- Artifact-mode benchmark run, then the comparison report: per-task before/after
  verdicts, tokens, latency, aggregates.
- **The gate:** compile pipeline exits nonzero if artifact does not beat live on
  accuracy. This rule is non-negotiable and visible in the UI.
- Dashboard pages: project overview, comparison table with expandable trace JSON,
  conflict review queue, per-user quota badge, cost panel from `spend`.
- Iterate on extraction prompts / selection weights until demo sites pass the gate.

### Phase 4 — Edge + drift (days 11–12)
- apps/edge: Hono, serves `/llms.txt`, `/llms-full.txt`, `/sections/*` with cache
  headers; logs every request (user-agent, path, ts) to `edge_requests`. Public, no
  auth — agents are not Clerk users.
- Drift: scheduled recrawl → hash-diff → ONLY changed pages re-extracted → ONLY
  facts sourced from changed pages re-checked → ONLY affected tasks re-run.
  Incremental scope is the whole point; a full recompile on drift is a bug.
- Weekly digest + regression alert paths (console/log delivery is fine for demo).

### Phase 5 — Ship (days 13–14)
- README: before/after table as first image, architecture diagram, cost table,
  honest limitations. 3-minute demo video script.
- Buffer. If ahead of schedule ONLY: begin Phase 6 (fix mode) starting with 6a.
  Otherwise Phase 6 is post-launch work — the core product ships without it.

### Phase 6 — Fix mode: "give us your repo, we fix it for you" (post-launch, 4–6 days)

The upsell path: instead of serving a compiled artifact, Rosetta edits the customer's
own repo so the site itself becomes agent-readable — via PR, never direct commits.
Trust model changes here: this is the ONLY phase with repo write access, and it is a
separate opt-in with its own GitHub App consent screen. The core product must remain
fully usable without it.

Governing rule, same oracle: **a fix batch is only valid if the re-benchmarked preview
beats the pre-fix score, the repo's own checks pass, and the human-facing rendering is
unchanged.** Fix mode promises "better for agents, identical for humans."

**Fix tiers** (each tier is a separate opt-in toggle per project; ship in this order):
- **Tier 1 — additive files (near-zero risk):** generate `llms.txt` /
  `llms-full.txt` / section markdown into the repo's public dir; sitemap and
  robots.txt agent rules. New files only; nothing existing modified.
- **Tier 2 — markup annotations (low risk):** schema.org/JSON-LD injection, semantic
  HTML corrections (div-soup interactive elements → real elements), meta descriptions.
  AST-level attribute/element edits via ts-morph/tree-sitter — never string patching.
- **Tier 3 — content corrections (medium risk):** apply the owner's OWN conflict-queue
  resolutions to source content files (MDX/markdown/CMS-exported content). Hard
  precondition: a fix here must reference a resolved `conflicts` row. Rosetta never
  invents content changes.
- **Tier 4 — rendering changes (high risk, label "experimental"):** make JS-only
  content statically available (SSR/SSG conversion or static fallback for the flagged
  component). Framework-aware; Next.js only in v1. LLM-generated edits with the
  tightest gates.

**6a. Repo service (day 1)**
- GitHub App: `contents:read/write` + `pull_requests:write` ONLY. Never admin, never
  workflows scope. Installation flow surfaced in project settings.
- Sandboxed clone into Docker (or E2B) per fix run; all work on a branch
  (`rosetta/fix-<runId>`), never default. Framework + package-manager detection
  (Next.js / Astro / plain static; npm / pnpm / yarn via lockfile).
- New tables: `repo_installations`, `fix_runs` (status machine:
  `planned | editing | building | benchmarking | passed | failed | pr_opened`),
  `fix_findings` (scan finding → planned fix, tier, confidence), `fix_prs`.
- Definition of done: connect a repo you own, clone lands in sandbox, framework
  detected, branch created.

**6b. Fix generator (day 2)**
- Input: the project's scan findings (failed tasks, JS-only pages, unresolved-fact
  gaps) mapped to fix candidates with tier + confidence.
- Tier 1–2 fixes are deterministic codemods; tier 3 applies recorded resolutions;
  tier 4 goes through the gateway with the component source + failure trace as
  context. Every generated diff stores provenance: `fix_finding_id` → scan evidence.
- Per-run budget caps: max files touched (config, default 25), max diff lines
  (default 1,500), token budget for tier-4 generation.
- Definition of done: `pnpm fix --project <slug> --tiers 1,2` produces reviewable
  diffs in the sandbox branch for a seeded demo repo.

**6c. Preview builder (day 3 — the riskiest component, timebox hard)**
- Run the repo's own build in the sandbox (detected package manager, `build` script),
  hard timeout (default 10 min), then serve the built output locally.
- Graceful failure is a first-class outcome: "could not build your repo" ends the run
  as `failed` with logs attached — never guess around a broken build.
- Point the crawler + benchmark agent at the preview URL exactly as if it were live.
- Definition of done: seeded demo repo builds in sandbox and the benchmark runs
  against the preview.

**6d. Verification — the three oracles (day 4)**
A fix run passes only if ALL three hold, in this order (cheapest first):
1. **Repo's own checks:** its test/lint scripts (if present) pass in the sandbox.
2. **Visual parity:** screenshot capture of a sampled page set, pre-fix vs post-fix,
   pixel/SSIM diff under threshold. Deterministic capture discipline: frozen
   animations, loaded fonts, fixed viewport. Tier 1 fixes may skip this (no rendered
   change possible); tiers 2–4 never skip.
3. **The benchmark gate:** re-run the task suite against the preview; score must beat
   the pre-fix baseline. Same oracle, same judge, same rubrics as Phase 1/3.
- Failures loop back to 6b at most twice (bounded self-correction), then the run
  fails with the evidence attached.
- Definition of done: a seeded regression (deliberately bad fix) is caught by each
  oracle in tests.

**6e. PR bot (day 5)**
- One PR per tier batch via Octokit. PR body is generated and must contain: before/
  after benchmark table, per-fix provenance list (finding → evidence → diff), the
  three-oracle results, and rollback note. Never auto-merge; never push to default.
- PR review outcomes feed back: merged/closed status webhook updates `fix_prs`, and
  rejected fixes mark their finding `suppressed` so reruns don't regenerate them.
- Definition of done: end-to-end demo on the seeded repo — scan → fix → preview →
  verify → PR with the before/after table in the body.

**6f. Polish + demo (day 6)**
- Project settings UI: install App, tier toggles, run history with per-run evidence.
- Record the fix-mode demo segment: the PR page IS the money shot.

Phase 6 tripwires: if the preview builder exceeds its day, cut tier 4 entirely and
ship tiers 1–3 with visual parity + benchmark gates. Never expand GitHub App scopes
to work around a sandbox problem. Never let a fix run touch more than its budget caps.

## Scope tripwires

- If any phase slips 2+ days, cut from Phase 4, never from Phases 1 or 3.
- Do not add: Socket.IO (SSE suffices), LangChain/LangGraph (the agent loop is ours,
  ~150 lines), a separate vector DB, roles/teams, payment code, i18n.
- Do not gold-plate the trace viewer — rendered JSON with expand/collapse is enough.

## Code conventions

- TypeScript strict; no `any` without an inline justification comment.
- Zod schema is the single source of truth for every cross-boundary shape; export
  types via `z.infer`. Schemas live in packages/core/src/schemas/.
- Errors: typed error classes per domain (`CrawlError`, `ExtractionError`,
  `QuotaExceededError`); BullMQ jobs classify errors as retryable vs terminal.
- Idempotency: every job must be safe to re-run (content-hash checks before work).
- Logging: pino, one child logger per pipeline stage, job id in every line.
- Commits: conventional commits, one logical change each.

## Testing rules

- Unit + integration via Vitest; anything touching the gateway uses replay fixtures.
- Property tests (fast-check) required for: knapsack packer, content-hash diffing,
  provenance integrity, quota arithmetic.
- CI (GitHub Actions): lint, typecheck, test — all in replay mode, $0.
- A "compile gate" CI job runs the full pipeline on the fixture-backed demo corpus
  and fails if the artifact does not beat live.

## Environment

- `.env.example` kept current; secrets never committed.
- Required env: DATABASE_URL, REDIS_URL, S3_* (MinIO), CLERK_*, GEMINI_API_KEY,
  GROQ_API_KEY, LLM_MODE.
- `docker compose up` + `pnpm dev` must be the entire local setup. If a step needs
  documentation beyond that, script it instead.

## Behavioral guidelines

See `GUARDRAILS.md` — general LLM coding guardrails that apply on top of everything
above.
