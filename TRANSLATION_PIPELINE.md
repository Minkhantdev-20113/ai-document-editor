# Translation pipeline

The path from analyzed blocks to reviewed text (Phases 3–4), and the behavior
you can rely on when a provider misbehaves.

## Guided workflow

`Project → Analyze → confirm source language → target language → provider /
model → strategy → start`

1. **Pre-flight** — `jobs/actions.ts#startTranslation` rejects the run *before*
   it is queued when no document, no units or no enabled provider with a
   usable key exists (typed `provider_unavailable`), so a job never enters the
   queue just to fail immediately.
2. **Options** — strategy drives both batch sizing and sampling temperature:
   `draft` (fast, T 0.4) · `standard` (T 0.2) · `precise` (small batches,
   T 0.1).
3. **Run** — `services/translationService.translateDocument()` walks batches in
   order; each unit is marked `in_progress` before the request and
   `translated`/`failed` right after, so a crash costs at most the batch that
   was in flight.

## Batching and budgets

- Batches fit the selected model's context/output budgets, including Burmese
  output expansion ratios; an oversized unit is flagged and attempted alone.
- Batch order is stable (document order), so output reads naturally and the
  page/unit progress numbers mean something.
- Prompts carry the fixed translation rules, the project **glossary**
  (mandatory wording + forbidden terms, omitted entirely when there are none)
  and are costed in tokens before the request is planned.

## Failover, quotas and rate limits

- Keys are chosen by a **health-aware weighted score** (cooldown state,
  recent 429s, success rate, RPM/TPM pressure) — never by naive rotation.
  The app never claims a second key multiplies a per-account quota.
- Retryable errors (429, timeout, network, 5xx) back off with jitter and
  re-attempt within the same provider; configuration errors (invalid key,
  invalid model) fail over to the next provider immediately; content-policy
  failures mark the batch failed with a typed reason.
- On 429 the key cools down (honoring `Retry-After`); `keyRuntime` persists
  health, cooldown reason, request/token/success/failure/429 counters.
- When **every** candidate is quota-blocked the run pauses with the visible
  reason "Provider quota exhausted"; resume is the ordinary
  `paused → queued` path and re-enters at the first unfinished unit.
- `services/keyPoolService.ts` exposes explicit **enable/disable, test and
  reset** operations for keys.

## Resume and recovery

| Event | What happens |
| --- | --- |
| failure | finished units are already persisted; retry starts at the first unfinished unit |
| pause / cancel | checked between batches; nothing half-written is left behind |
| refresh | `jobQueue.init()` recovers the job to `queued`, the resume cursor (`project.lastProcessedUnit`) and unit statuses are still on disk |
| offline | a `network_offline` error waits for connectivity instead of burning retries, then continues |
| timeout | translation jobs run with `translationJobTimeoutMs` (30 min) |

## Extras that steer the text

- **Terminology glossary** — per-project English → preferred translation rules
  loaded **once** per run (mid-run edits never mix conventions).
- **Translation memory** — similar source text surfaces the previous
  translation; auto-replacement happens only when confidence is high *and*
  `memoryAutoApply` is enabled (default off). Otherwise the suggestion is
  offered in the editor panel for explicit one-click use.
- **Manual edits always win** — every human edit is stamped (`editedAt`) and
  survives later runs; the provider's own wording stays visible as the AI
  suggestion.
- **Post-run validation** — `validationService` checks missing/untranslated
  text, changed numbers/units/URLs/code, duplicates, empty results, structure
  mismatches and glossary violations, and stores findings on the units.
  Findings are **never auto-fixed**.

## Progress and observability

- `translation:progress` (page x/y, unit x/y, batch x/y, provider, model, and
  the vault **key id — never the key**) is bridged onto the app event bus and
  rendered by the workspace progress panel.
- Usage is recorded per batch with a `basis`: `provider_reported` when the
  provider returned usage, `locally_estimated` otherwise; the Usage page
  labels token figures accordingly.

## Network behavior

- Ordinary work (open a project, edit, inspect, export, browse history)
  requires **no network**. Only `validateKey`/`listModels`/`translate` calls
  touch the network, and only when you start them.
- The app honors browser connectivity: going offline pauses AI requests
  without losing state or reloading, and the run resumes when you are back.
- VPNs, corporate proxies and DNS filters can block provider endpoints; the
  failure arrives as a typed `network`/`timeout` error with the job paused or
  failed — see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Known limitations

- No streaming UI yet: each batch is one request/response.
- Multimodal content (images inside the document) is not sent to the model;
  only extracted text and structure are.
- Context-window estimates are local (`domain/provider/tokens`); the numbers
  are labelled *locally estimated* when the provider does not report usage.
