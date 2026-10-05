# Offline-first data and optional cloud sync

The app is designed so that **your own machine is the source of truth**.
Everything you create works without a network; the cloud is an optional,
metadata-only mirror you can ignore entirely.

## 1. Local-first rules

- **Every read/write path goes through `src/db/`** (IndexedDB, 17 stores,
  one typed repository layer). Pages and services never touch `indexedDB`
  directly and never assume a server exists.
- **No server of ours exists** — there is no account, no login, no telemetry
  endpoint. The only outbound traffic is the AI provider calls you start and
  an optional sync endpoint you configure yourself.
- **Pre-paint settings** are mirrored to a tiny `localStorage` cache so the
  correct theme/language render on the first frame, before IndexedDB opens.
- **Offline detection** is observed (`navigator.onLine` + `online`/`offline`
  events). The UI reflects it; going offline never reloads the page, never
  loses an edit and never corrupts a job.

## 2. What works with no network

| Works offline | Needs a network (only when you use it) |
| --- | --- |
| open/import/export projects, browse documents | `validateKey` / `listModels` (provider check) |
| PDF inspection and full analysis | `translate` (provider calls) |
| editing, search/replace, undo/redo, autosave | Google Apps Script sync push |
| glossary, translation memory, validation | downloading a bundled font is *not* required — fonts ship with the build |
| export (PDF/DOCX/HTML/TXT/MD/JSON) in a Web Worker | |
| error log, usage history, settings, key vault | |
| data portability export/import | |

A translation run started while offline fails with a typed `network_offline`
error and **waits for connectivity** instead of burning retries; once you are
back online the ordinary `paused → queued → resume` path continues at the
first unfinished unit.

### VPN / proxy / DNS behavior

- A VPN does not affect local work, analysis or export at all.
- If a VPN, corporate proxy or DNS filter blocks a provider endpoint, you get
  a typed `network`/`timeout` error with a visible reason; the run resumes
  when the endpoint is reachable. See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).
- The optional sync endpoint is a plain HTTPS POST; a proxy that breaks
  HTTPS will break sync only — local data is untouched.

## 3. Data portability (the local escape hatch)

Settings → Data:

- **Export a bundle** — a JSON file with your projects, documents, blocks,
  units, glossary, memory and settings. Sensitive stores are excluded by
  construction: `secretVault` (raw keys) and `exportArtifacts` (produced file
  bytes) are never part of a bundle.
- **Import** — a validated, keyed merge: importing fails loudly on a malformed
  bundle instead of half-writing data.
- **Delete local data** — typed confirmation, removes everything for a clean
  start.

## 4. Cloud sync (optional, secondary)

Sync is a **push of redacted metadata**, never a requirement. It is off by
default (`syncEnabled: false`, `syncEndpoint: null`) and the app is fully
functional with it disabled forever.

### What can and cannot be synced

| | |
| --- | --- |
| **Synced entities** | `projects`, `documents`, `settings` — names, languages, statuses, progress, timestamps |
| **Never synced** | API keys and any vault material (`secretVault`, `apiKeyMetadata`), translation units/blocks (your document content), usage/error detail beyond what the `settings` row carries |
| **Redaction** | payloads pass `deepRedact()` before they are queued, so fields whose *name* looks secret are blanked even if a caller passed them by mistake |

Enqueued records are plain rows in `syncQueue`:

```ts
interface SyncRecord {
  id: string;
  entity: 'projects' | 'documents' | 'settings';
  entityId: string;
  op: 'upsert' | 'delete';
  payload: Record<string, unknown> | null;   // null once delivered
  status: 'pending' | 'in_flight' | 'failed' | 'done';
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
```

Local writes are **always authoritative**: a sync failure can never lose or
overwrite local data (there is no pull/merge-back path).

### How a change is pushed

1. A producer calls `syncService.queueChange({ entity, entityId, op, payload })`
   — the record is deduplicated per `entityId` and stored as `pending`.
2. `syncService.flush()` (Settings → Sync → run now) takes up to 100 pending
   records, marks them `in_flight`, and `POST`s one batch:

   ```http
   POST <syncEndpoint>
   Content-Type: text/plain;charset=utf-8        (CORS-simple; no preflight)

   { "records": [ …SyncRecord… ], "sentAt": 1728000000000 }
   ```

   `mode: 'cors'`, `credentials: 'omit'` — cookies are never sent.
3. On `2xx` the rows become `done` and their payload is cleared; otherwise they
   become `failed` with the error kept on the row for inspection.

> Note: sync is deliberately manual and opt-in. If no producer has enqueued a
> change, a flush simply reports `0 sent`.

## 5. Google Apps Script setup (optional receiver)

You can point sync at your own Apps Script web app backed by a Google Sheet.

1. Create a Google Sheet (this is your "sync database").
2. **Extensions → Apps Script**, paste the receiver below, save.
3. **Deploy → New deployment → Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** (the app posts anonymously; no credentials are
     attached)
   - Copy the `/exec` URL.
4. In the app: **Settings → Cloud sync → Apps Script endpoint URL** → paste,
   enable **Sync**, then use **Run sync** when you want to push.

```javascript
/** AI Document Translator — metadata sync receiver. */
var SHEET_NAME = 'adt_sync';
var HEADERS = ['receivedAt', 'recordId', 'entity', 'entityId', 'op',
               'status', 'attempts', 'payload'];

function doPost(e) {
  var body = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  var rows = (body.records || []).map(function (r) {
    return [
      new Date().toISOString(),
      r.id, r.entity, r.entityId, r.op, r.status, r.attempts,
      JSON.stringify(r.payload === undefined ? null : r.payload)
    ];
  });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length)
         .setValues(rows);
  }
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, received: rows.length }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
```

### Google Sheet schema

| Column | Type | Example |
| --- | --- | --- |
| `receivedAt` | ISO-8601 string | `2026-10-06T04:12:33.000Z` |
| `recordId` | string | `prj_9f2c…` |
| `entity` | enum | `projects` \| `documents` \| `settings` |
| `entityId` | string | `prj_9f2c…` |
| `op` | enum | `upsert` \| `delete` |
| `status` | enum | `pending` \| `in_flight` \| `failed` \| `done` |
| `attempts` | number | `1` |
| `payload` | JSON string or `null` | `{"name":"Q&A 2026","targetLanguage":"my"}` |

The sheet is an append-only audit trail of metadata changes. It contains no
API keys and no document text.

## 6. Known limitations

- Sync has no pull/merge: importing the sheet back into another browser is
  manual (use the data-portability bundle instead).
- Records are queued by explicit producers only; if nothing calls
  `queueChange`, the queue is empty by design.
- Sync of a large `settings` row (e.g. an imported model catalog) is limited
  by Apps Script payload size — very large catalogs should be imported
  locally rather than synced.
- Offline, `syncService.flush()` fails fast with a typed error and leaves the
  records `pending` for the next attempt.
