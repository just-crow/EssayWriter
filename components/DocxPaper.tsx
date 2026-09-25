"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type PreviewStatus = "idle" | "loading" | "ready" | "error";

interface DocxPaperProps {
  /** Rendered when set; cleared to reset. */
  blob: Blob | null;
  /** Shows the drafting skeleton when no blob yet. */
  draftBusy: boolean;
  /** Shown when the blob fails to render. */
  fallback: React.ReactNode;
  /** Show the Expand button; calls back when pressed. */
  onExpand?: () => void;
  /** Tapping a footnote number scrolls to its citation. Disable inside overlays. */
  enableMarkerJump?: boolean;
}

/** Renders a .docx blob as scaled paper pages. Self-contained: owns fetch-free
 * rendering, fit-to-width scaling, zoom toggle, and marker jump. */
export default function DocxPaper({
  blob,
  draftBusy,
  fallback,
  onExpand,
  enableMarkerJump = true,
}: DocxPaperProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const outerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<PreviewStatus>("idle");
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [fitMode, setFitMode] = useState(true);
  const [dims, setDims] = useState({ scale: 1, height: 0, width: 0 });

  const computeScale = useCallback(() => {
    const outer = outerRef.current;
    const inner = containerRef.current;
    const page = outer?.querySelector("section.docx") as HTMLElement | null;
    if (!outer || !inner || !page) return;
    const avail = outer.clientWidth - 24;
    const w = page.offsetWidth;
    const h = inner.scrollHeight;
    if (w > 0 && avail > 0 && h > 0) {
      const scale = Math.min(1, avail / w);
      setDims({ scale, height: Math.round(h * scale), width: w });
    }
  }, []);

  useEffect(() => {
    if (!blob) {
      setStatus("idle");
      setPreviewError(null);
      return;
    }
    let cancelled = false;
    setStatus("loading");
    setPreviewError(null);
    setDims({ scale: 1, height: 0, width: 0 });
    (async () => {
      try {
        if (blob.size === 0) throw new Error("The preview file came back empty.");
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        const el = containerRef.current;
        if (!el) return;
        el.innerHTML = "";
        await renderAsync(blob, el, null, { breakPages: true });
        if (!cancelled) setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setPreviewError(err instanceof Error ? err.message : "Could not render the preview.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blob]);

  useEffect(() => {
    if (status !== "ready") return;
    computeScale();
  }, [status, fitMode, computeScale]);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const ro = new ResizeObserver(() => computeScale());
    ro.observe(outer);
    return () => ro.disconnect();
  }, [computeScale]);

  useEffect(() => {
    if (!enableMarkerJump) return;
    const outer = outerRef.current;
    if (!outer || status !== "ready") return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const ref = t?.closest?.(".docx_footnotereference");
      if (!ref) return;
      const id = (ref.textContent ?? "").trim();
      if (!id) return;
      document.getElementById(`fn-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    outer.addEventListener("click", onClick);
    return () => outer.removeEventListener("click", onClick);
  }, [status, enableMarkerJump, blob]);

  const fitted = fitMode && dims.scale < 1 && status === "ready";

  return (
    <div className="min-w-0">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-stone-900">Page preview</p>
        {blob && status !== "error" ? (
          <div className="flex items-center gap-1.5">
            <div
              role="group"
              aria-label="Preview zoom"
              className="flex overflow-hidden rounded-md border border-stone-300 text-xs font-semibold"
            >
              <button
                type="button"
                onClick={() => setFitMode(true)}
                aria-pressed={fitMode}
                className={`px-2.5 py-1 transition ${fitMode ? "bg-emerald-800 text-white" : "bg-white text-stone-600 hover:bg-stone-100"}`}
              >
                Fit
              </button>
              <button
                type="button"
                onClick={() => setFitMode(false)}
                aria-pressed={!fitMode}
                className={`px-2.5 py-1 transition ${!fitMode ? "bg-emerald-800 text-white" : "bg-white text-stone-600 hover:bg-stone-100"}`}
              >
                100%
              </button>
            </div>
            {onExpand ? (
              <button
                type="button"
                onClick={onExpand}
                className="inline-flex items-center gap-1 rounded-md border border-stone-300 bg-white px-2.5 py-1 text-xs font-semibold text-stone-700 shadow-sm transition hover:border-emerald-700 hover:text-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-700 active:scale-[0.98]"
              >
                <span aria-hidden="true">⤢</span> Expand
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {draftBusy && !blob ? (
        <div>
          <div className="h-5 w-2/3 animate-pulse rounded bg-stone-200" />
          <div className="mt-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="h-3 animate-pulse rounded bg-stone-200"
                style={{ width: `${94 - (i % 4) * 9}%` }}
              />
            ))}
          </div>
          <p className="mt-3 text-xs text-stone-600">Drafting your essay…</p>
        </div>
      ) : !blob ? (
        <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50 px-4 py-10 text-center">
          <p className="font-serif text-lg text-stone-800">A blank page, for now.</p>
          <p className="mx-auto mt-1 max-w-xs text-xs leading-5 text-stone-600">
            Work through the context, outline, and sources. Your finished essay will be set here like a printed
            page.
          </p>
        </div>
      ) : (
        <>
          <div
            ref={outerRef}
            className="docx-preview-wrap min-h-64"
            style={
              status === "error"
                ? { display: "none" }
                : fitted
                  ? { overflow: "hidden", height: dims.height > 0 ? dims.height + 40 : undefined }
                  : { overflowX: "auto" }
            }
          >
            <div
              ref={containerRef}
              style={
                fitted
                  ? {
                      transform: `scale(${dims.scale})`,
                      transformOrigin: "top left",
                      width: dims.width > 0 ? dims.width : undefined,
                    }
                  : undefined
              }
            />
          </div>
          {status === "loading" ? (
            <div aria-hidden="true" className="space-y-2 pt-2">
              <div className="h-5 w-1/2 animate-pulse rounded bg-stone-200" />
              <div className="h-3 w-full animate-pulse rounded bg-stone-200" />
              <div className="h-3 w-11/12 animate-pulse rounded bg-stone-200" />
              <div className="h-3 w-4/5 animate-pulse rounded bg-stone-200" />
            </div>
          ) : null}
          {status === "error" ? (
            <>
              <p className="mb-1 rounded-md bg-amber-100 px-3 py-2 font-sans text-xs font-medium text-amber-900">
                Page preview failed ({previewError}), showing text instead. Download still works.
              </p>
              {fallback}
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
