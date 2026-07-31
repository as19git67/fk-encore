/**
 * Shared environment for every Tesseract invocation in the documents pipeline.
 *
 * Tesseract is built with OpenMP and, left alone, opens a thread per core and
 * spin-waits between them. On a container with a modest CPU allowance that
 * collapses: measured on one A4 page at 200 dpi in this pipeline, a single
 * recognition pass took 7 s and a second one 46 s, and two passes started
 * concurrently took **300 s together** — while the very same pass with OpenMP
 * pinned to one thread took **0.86 s**, and two concurrent pinned passes still
 * finished in 0.81 s. The spin-waiting threads fight each other and the rest of
 * the process for CPU; removing them removes the whole pathology.
 *
 * Pinning to a single thread is the standard recommendation for Tesseract on
 * servers, and it costs us nothing: the scan pipeline already runs one page at
 * a time (`DOC_SCAN_TEXT_CONCURRENCY` defaults to 1), so the parallelism worth
 * having is at the page/document level, not inside one recognition pass.
 *
 * Override with `DOCUMENTS_OCR_OMP_THREADS` if a deployment has cores to spare
 * and measures a benefit; set it to an empty string to leave OpenMP entirely
 * to Tesseract's own defaults.
 */

const OMP_THREADS = process.env.DOCUMENTS_OCR_OMP_THREADS ?? "1";

/**
 * The environment to spawn `tesseract` with: the current one, plus the OpenMP
 * thread cap. Call per spawn — cheap, and it picks up env changes in tests.
 */
export function tesseractEnv(): NodeJS.ProcessEnv {
  if (OMP_THREADS === "") return process.env;
  return { ...process.env, OMP_THREAD_LIMIT: OMP_THREADS };
}
