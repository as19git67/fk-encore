# Stuck jobs in the document queue

## Symptom

After a re-classify, one or more jobs remain in the queue panel — usually on
the *Embedding* service — in state **waiting** and do not change for hours.
No filter in the document list can be set that leaves exactly these documents
over.

## Why it was invisible

Two properties of the pipeline added up to a silent endless loop:

1. **Deferring was unbounded.** A job that cannot run is "deferred": it goes
   back to `pending` without consuming an attempt (`deferJob` in
   `documents/scan-queue.ts`). This is meant for "try again in a moment" —
   upstream not finished yet, llm-service restarting, AI queue slot not yet
   free. But there was no upper limit. A condition that never goes away (the
   `/embed` call times out for exactly this document, an AI slot never becomes
   active, a `documents.status` from an aborted run is stale) made the job
   cycle endlessly between `pending` and `processing`.

2. **`embed` does not touch the document status.** This is intentional — a
   missing embedding should not take a document out of the UI. But it also
   means: the document is `ready` like any other. No status filter of the list
   could show the affected documents, and nothing had failed either.

On top of that came a concrete trigger for case 1: `runEmbed`/`runClassify`
used `documents.status` as the "is there still text coming?" signal. A
re-queue sets the status to `pending` up front; if a run stops before that,
the status stays stale permanently, and the downstream job defers itself
forever.

## What happens now

* **Bounded deferring.** `document_scan_queue.defer_count` counts every
  deferral, `DOC_SCAN_MAX_DEFERS` (default 50, so at a 30 s poll interval at
  least ~25 minutes of leniency) limits it. After that the job is marked
  **failed** — with the last reason in the text. This makes it show up in the
  error column and lets it be restarted via "Fehlgeschlagene wiederholen"
  (retry failed).
* **The reason is visible immediately.** `deferJob` writes the reason into
  `error_msg`, even while the job is still waiting.
* **The queue decides, not the status.** `hasAnyJob()` separates
  "text_extract is still running" from "text_extract has run and delivered
  nothing". Waiting only happens in the narrow window in which the status is
  already `pending` and the text_extract row has not yet been inserted.
* **The panel names the documents.** `GET /document-queue/status` additionally
  returns the open jobs (`jobs`) with document ID, title, service, waiting
  time, number of deferrals and reason. The queue panel uses this to show the
  conspicuous jobs (longer than 30 minutes or deferred at least once) together
  with a link to the document. Titles are only returned for documents the
  calling user is allowed to see.

## The concrete trigger in production: CUDA OOM in the embedder

In the server log it looked like this:

```
fk-encore-llm | INFO: "POST /embed HTTP/1.1" 500 Internal Server Error
fk-encore-llm | torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 192.00 MiB.
                GPU 0 has a total capacity of 15.48 GiB of which 40.69 MiB is free.
fk-encore-app | [ai-queue] documents:embed failed while using embedding slot … after 45ms:
                POST http://llm_service:8000/embed returned 500
```

The llm-service shares the GPU with the llama-server, which keeps its weights
resident for its entire runtime (`nvidia-smi`: 14040 MiB llama-server,
1754 MiB embedder, ~500 MiB free on a 16 GB card). That leaves hardly any room
for the encoder — a batch of 32 chunks of 512 tokens no longer fits there.
Short documents got through, those with many chunks did not: exactly the one
or two documents that were left over as "waiting" in the end.

Fixed in `llm-service/main.py`:

* On an out-of-memory error, `/embed` halves the batch size and tries again
  (`_encode_with_oom_fallback`). The vectors are independent of how the texts
  are grouped — only the peak demand for activation memory changes.
* The smaller batch size is kept (`/healthz` → `embed_batch_size_effective`);
  the GPU does not get roomier on its own, and a failed forward pass per
  request would be pure waste.
* If even a single text does not fit, the service answers with **503**
  ("embedder out of memory") instead of a 500 traceback. Both are a transient
  failure for the app — the difference is that the defer budget now limits the
  retries.
* `LLM_EMBED_BATCH_SIZE` can be set realistically up front (on a 16 GB card
  with a 14B-Q4 model e.g. `8`), which eliminates the one failed attempt after
  every container start.

## With a stuck job

1. Expand the panel → "Hängende Jobs" (stuck jobs). Reason and document are
   listed there.
2. Recurring reason `POST …/embed …` → check the llm-service. `/healthz` still
   answers `ok` even when `/embed` fails; with memory problems,
   `embed_batch_size_effective` shows a value below `embed_batch_size`, and
   `nvidia-smi` shows how little VRAM is free next to the llama-server.
3. After fixing it: "Fehlgeschlagene wiederholen" or re-classify the
   document — both reset the defer budget.
