import json
import os
import re
import sys
import time
from playwright.sync_api import sync_playwright

if sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr.encoding.lower() != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BASE_URL = "http://localhost:3000"
ARTIFACTS_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "artifacts"))
os.makedirs(ARTIFACTS_DIR, exist_ok=True)

TOPIC = "How does sleep duration affect adolescent learning and mental health?"
INSTRUCTION = (
    "Write an evidence-based academic essay. Explain effects on attention, memory, "
    "school performance, mood, anxiety, and depression. Distinguish correlation from causation "
    "and acknowledge limits in the evidence. Ground all factual assertions in the gathered sources."
)
TARGET_WORDS = 1000

def norm(text: str) -> str:
    """Normalize text for substring comparison."""
    if not text:
        return ""
    text = text.lower()
    text = re.sub(r'[\u2018\u2019\u201c\u201d\'"`]', '', text)
    text = re.sub(r'[—–-]', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()

def split_sentences(text: str) -> list[str]:
    """Split paragraph into individual sentences."""
    clean = re.sub(r'\[\^\d+\]', '', text)
    sentences = re.split(r'(?<=[.!?])\s+', clean)
    return [s.strip() for s in sentences if s.strip()]

def run():
    print(f"=== Starting Browser Automation Test on {BASE_URL} ===")
    print(f"Artifacts will be saved in: {ARTIFACTS_DIR}")

    intercepted = {
        "structure": None,
        "sources": None,
        "draft": None,
        "errors": []
    }

    is_headed = "--headed" in sys.argv or "--visible" in sys.argv
    print(f"Browser mode: {'VISIBLE (headed)' if is_headed else 'HEADLESS'}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not is_headed)
        context = browser.new_context(viewport={"width": 1600, "height": 1200})
        page = context.new_page()

        # Listen to console logs
        page.on("console", lambda msg: print(f"  [Browser Console {msg.type}]: {msg.text[:120]}"))
        page.on("pageerror", lambda err: print(f"  [Browser Error]: {err}"))

        # Intercept API responses
        def handle_response(response):
            url = response.url
            try:
                if "/api/structure" in url and response.request.method == "POST":
                    data = response.json()
                    intercepted["structure"] = data
                    print(f"  -> Intercepted /api/structure (Status: {response.status})")
                elif "/api/sources" in url and response.request.method == "POST":
                    data = response.json()
                    intercepted["sources"] = data
                    with open(os.path.join(ARTIFACTS_DIR, "sources_result.json"), "w", encoding="utf-8") as sf:
                        json.dump(data, sf, indent=2)
                    print(f"  -> Intercepted /api/sources (Status: {response.status}, Sources: {len(data.get('sources', []))})")
                elif "/api/draft" in url and response.request.method == "POST":
                    data = response.json()
                    intercepted["draft"] = data
                    with open(os.path.join(ARTIFACTS_DIR, "draft_result.json"), "w", encoding="utf-8") as df:
                        json.dump(data, df, indent=2)
                    print(f"  -> Intercepted /api/draft (Status: {response.status})")
            except Exception as e:
                pass

        page.on("response", handle_response)

        # 1. Navigate to home
        print("\n[Step 1] Navigating to Studio...")
        page.goto(BASE_URL, wait_until="networkidle", timeout=30000)
        page.screenshot(path=os.path.join(ARTIFACTS_DIR, "01_home.png"))
        print("  -> Page loaded successfully.")

        # 2. Fill in Context
        print("\n[Step 2] Filling in Topic and Context...")
        page.fill("#topic", TOPIC)
        page.fill("#instruction-text", INSTRUCTION)
        
        # Adjust word target to 800 in React 19
        TARGET_WORDS = 800
        slider = page.locator("#word-target")
        slider.evaluate("""(el, val) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }""", TARGET_WORDS)
        time.sleep(0.5)

        # 3. Generate Outline
        print("\n[Step 3] Clicking 'Generate outline'...")
        gen_outline_btn = page.get_by_role("button", name="Generate outline")
        gen_outline_btn.click()

        # Wait for "Approve outline" button
        print("  Waiting for outline generation...")
        approve_outline_btn = page.get_by_role("button", name="Approve outline")
        approve_outline_btn.wait_for(state="visible", timeout=90000)
        page.screenshot(path=os.path.join(ARTIFACTS_DIR, "02_outline.png"))
        print("  -> Outline generated and rendered in center panel.")

        # 4. Approve Outline
        print("\n[Step 4] Approving outline...")
        approve_outline_btn.click()
        time.sleep(1)

        def wait_enabled(loc, timeout_sec=10):
            t_start = time.time()
            while time.time() - t_start < timeout_sec:
                if loc.is_enabled():
                    return
                time.sleep(0.2)
            raise TimeoutError(f"Element did not become enabled within {timeout_sec}s")

        # 5. Gather Sources
        print("\n[Step 5] Clicking 'Gather sources'...")
        gather_sources_btn = page.get_by_role("button", name="Gather sources")
        wait_enabled(gather_sources_btn, 10)
        gather_sources_btn.click()

        # Wait for "Approve sources" button
        print("  Waiting for source gathering (Tavily search & extraction)...")
        approve_sources_btn = page.get_by_role("button", name="Approve sources")
        approve_sources_btn.wait_for(state="visible", timeout=120000)
        page.screenshot(path=os.path.join(ARTIFACTS_DIR, "03_sources.png"))
        
        sources_data = intercepted.get("sources") or {}
        sources_list = sources_data.get("sources", [])
        print(f"  -> Gathered {len(sources_list)} sources. Live hits: {sources_data.get('liveHits')}")

        # 6. Approve Sources
        print("\n[Step 6] Approving sources...")
        approve_sources_btn.click()
        time.sleep(1)

        # 7. Draft Essay
        print("\n[Step 7] Clicking 'Draft essay' (Testing our grounding & selective sourcing fix)...")
        draft_btn = page.get_by_role("button", name="Draft essay")
        wait_enabled(draft_btn, 10)
        draft_btn.click()

        # Wait for draft completion: either Preview stats appears or an error alert appears
        print("  Drafting in progress (up to 360s)...")
        t0 = time.time()
        
        # Check periodically for completion or error
        completed = False
        error_found = None
        for i in range(360):
            time.sleep(1)
            # Check for error alert
            alert = page.locator('[role="alert"]')
            if alert.count() > 0:
                txt = alert.first.inner_text()
                if "Something went wrong" in txt:
                    error_found = txt
                    safe_txt = txt.encode("utf-8", "replace").decode("utf-8")
                    print(f"\n  [ALERT] Error banner detected:\n{safe_txt}")
                    with open(os.path.join(ARTIFACTS_DIR, "error_banner.txt"), "w", encoding="utf-8") as ef:
                        ef.write(safe_txt)
                    page.screenshot(path=os.path.join(ARTIFACTS_DIR, "04_draft_error.png"), full_page=True)
                    break
            
            # Check if preview download button or stats appear
            download_btn = page.locator('a:has-text("Download .docx")')
            if download_btn.count() > 0:
                completed = True
                print(f"\n  -> Drafting completed in {round(time.time() - t0, 1)}s!")
                break
        
        page.screenshot(path=os.path.join(ARTIFACTS_DIR, "04_draft_result.png"), full_page=True)

        if error_found:
            print(f"\nFAILED: Application threw error banner: {error_found}")
            browser.close()
            sys.exit(1)

        if not completed:
            print("\nFAILED: Drafting timed out without completing.")
            browser.close()
            sys.exit(1)

        # Extract UI stats from page
        words_stat = page.locator('text="Words" >> xpath=..').first.inner_text()
        footnotes_stat = page.locator('text="Footnotes" >> xpath=..').first.inner_text()
        cited_stat = page.locator('text="Works cited" >> xpath=..').first.inner_text()
        print(f"\nUI Stats: {words_stat.replace(chr(10), ' ')} | {footnotes_stat.replace(chr(10), ' ')} | {cited_stat.replace(chr(10), ' ')}")

        # Validation panel check
        val_loc = page.locator('section[aria-labelledby="validation-heading"]')
        val_sec = val_loc.first.inner_text() if val_loc.count() > 0 else "No validation issues"
        print(f"Validation Panel Text:\n{val_sec}\n")

        browser.close()

    # Deep Sourcing and Grounding Verification
    draft_payload = intercepted.get("draft")
    sources_payload = intercepted.get("sources")

    if not draft_payload or not sources_payload:
        print("ERROR: Missing intercepted draft or sources payload.")
        sys.exit(1)

    with open(os.path.join(ARTIFACTS_DIR, "draft_result.json"), "w", encoding="utf-8") as f:
        json.dump(draft_payload, f, indent=2)

    with open(os.path.join(ARTIFACTS_DIR, "sources_result.json"), "w", encoding="utf-8") as f:
        json.dump(sources_payload, f, indent=2)

    print("\n" + "="*70)
    print("DEEP FACTUAL GROUNDING AND SOURCING AUDIT")
    print("="*70)

    draft = draft_payload["draft"]
    gathered_sources = sources_payload.get("sources", [])
    footnotes = draft.get("footnotes", [])
    works_cited = draft.get("worksCited", [])
    evidence = draft.get("evidence", [])

    # 1. Word Count Audit
    all_paras = [
        *draft.get("introduction", []),
        *[p for s in draft.get("sections", []) for p in s.get("paragraphs", [])],
        *draft.get("conclusion", [])
    ]
    raw_text = " ".join(all_paras)
    clean_text = re.sub(r'\[\^\d+\]', '', raw_text)
    actual_words = len(clean_text.split())
    print(f"\n1. WORD COUNT VERIFICATION:")
    print(f"   Target: {TARGET_WORDS} words")
    print(f"   Actual: {actual_words} words (API reported: {draft_payload.get('wordCount')})")
    print(f"   Difference: {actual_words - TARGET_WORDS} words ({round((actual_words / TARGET_WORDS)*100, 1)}% of target)")
    assert 400 <= actual_words <= 1200, f"Word count {actual_words} outside expected range [400, 1200]"
    print("   -> PASS: Word count within target tolerance.")

    # 2. Selective Sourcing Audit
    print(f"\n2. SELECTIVE SOURCE USAGE:")
    print(f"   Gathered sources count: {len(gathered_sources)}")
    print(f"   Cited footnotes count:  {len(footnotes)}")
    print(f"   Works cited count:      {len(works_cited)}")
    
    cited_ids = set()
    for p in all_paras:
        for m in re.finditer(r'\[\^(\d+)\]', p):
            cited_ids.add(int(m.group(1)))
    print(f"   Footnote IDs used in text: {sorted(list(cited_ids))}")
    print(f"   Footnotes defined in draft: {[f['id'] for f in footnotes]}")
    
    # Check that model did not feel forced to use 100% of gathered sources if not needed
    if len(footnotes) < len(gathered_sources):
        print(f"   -> Confirmed selective sourcing: {len(footnotes)} of {len(gathered_sources)} gathered sources cited.")
    else:
        print(f"   -> All {len(footnotes)} gathered sources were used.")

    # 3. Evidence Quote Verifiability Audit
    print(f"\n3. EVIDENCE QUOTE VERIFICATION:")
    sources_by_id = {s["id"]: s for s in gathered_sources}
    sources_by_url = {s.get("url"): s for s in gathered_sources if s.get("url")}
    
    verified_evidence = 0
    unverified_evidence = []
    
    for idx, ev in enumerate(evidence):
        quote = ev.get("quote", "").strip()
        fn_id = ev.get("source") or ev.get("footnoteId")
        # Find footnote
        fn = next((f for f in footnotes if f["id"] == fn_id), None)
        fn_url = fn.get("url") if fn else None
        
        # Look for source
        matched_source = sources_by_id.get(fn_id) or sources_by_url.get(fn_url)
        norm_q = norm(quote)
        
        found = False
        if matched_source and norm_q in norm(matched_source.get("content", "")):
            found = True
        else:
            # Check across all gathered sources
            for s in gathered_sources:
                if norm_q in norm(s.get("content", "")):
                    found = True
                    break
        
        if found:
            verified_evidence += 1
            print(f"   [OK] Evidence #{idx+1} (Source #{fn_id}): \"{quote[:60]}...\" -> Verified in source text.")
        else:
            unverified_evidence.append({"idx": idx+1, "fn_id": fn_id, "quote": quote})
            print(f"   [FAIL] Evidence #{idx+1} (Source #{fn_id}): \"{quote[:60]}...\" -> NOT found in source text!")

    print(f"   Evidence verifiability rate: {verified_evidence}/{len(evidence)} ({round((verified_evidence/max(1, len(evidence)))*100, 1)}%)")
    assert len(unverified_evidence) == 0, f"Found {len(unverified_evidence)} unverified evidence quotes!"
    print("   -> PASS: 100% of evidence quotes are strictly grounded in source content.")

    # 4. Paragraph Sourcing & Claim Grounding Audit
    print(f"\n4. FACTUAL CLAIM CITATION & SOURCING AUDIT:")
    total_sentences = 0
    cited_sentences = 0
    paragraphs_analysis = []

    for p_idx, para in enumerate(all_paras):
        sentences = re.split(r'(?<=[.!?])\s+', para)
        para_citations = [int(m) for m in re.findall(r'\[\^(\d+)\]', para)]
        para_info = {
            "paragraph": p_idx + 1,
            "citations": para_citations,
            "sentence_count": len(sentences),
            "sentences": []
        }
        
        for s in sentences:
            if not s.strip():
                continue
            total_sentences += 1
            s_citations = [int(m) for m in re.findall(r'\[\^(\d+)\]', s)]
            has_cite = len(s_citations) > 0
            if has_cite:
                cited_sentences += 1
            
            # Check if sentence makes factual assertions (numbers, studies, specific claims)
            is_factual = bool(re.search(r'\b(\d+|percent|%|hours|study|research|correlat|hippocamp|depress|anxiety|adolescent|sleep|academ)\b', s, re.I))
            
            para_info["sentences"].append({
                "text": s.strip(),
                "citations": s_citations,
                "is_factual": is_factual,
                "has_citation": has_cite
            })
        
        paragraphs_analysis.append(para_info)

    print(f"   Total paragraphs: {len(all_paras)}")
    print(f"   Total sentences:  {total_sentences}")
    print(f"   Sentences with direct citation markers: {cited_sentences}")
    print(f"   Paragraphs with citations: {sum(1 for p in paragraphs_analysis if len(p['citations']) > 0)}/{len(all_paras)}")
    
    # Body sections should all have citations
    section_paras = paragraphs_analysis[len(draft.get("introduction", [])):-len(draft.get("conclusion", [])) or None]
    body_with_cites = sum(1 for p in section_paras if len(p['citations']) > 0)
    print(f"   Body section paragraphs with citations: {body_with_cites}/{len(section_paras)}")
    assert body_with_cites >= len(section_paras) - 1, f"At least {len(section_paras) - 1} of {len(section_paras)} body section paragraphs must cite sources!"

    audit_summary = {
        "status": "PASS",
        "topic": TOPIC,
        "wordTarget": TARGET_WORDS,
        "wordCount": actual_words,
        "gatheredSources": len(gathered_sources),
        "citedSources": len(footnotes),
        "worksCited": len(works_cited),
        "evidenceCount": len(evidence),
        "evidenceVerified": verified_evidence,
        "totalParagraphs": len(all_paras),
        "bodyParagraphsCited": f"{body_with_cites}/{len(section_paras)}",
        "screenshots": [
            "01_home.png", "02_outline.png", "03_sources.png", "04_draft_result.png"
        ]
    }

    with open(os.path.join(ARTIFACTS_DIR, "final_audit_summary.json"), "w", encoding="utf-8") as f:
        json.dump(audit_summary, f, indent=2)

    print("\n" + "="*70)
    print("TEST COMPLETED WITH 100% PASS!")
    print(f"Audit summary written to: {os.path.join(ARTIFACTS_DIR, 'final_audit_summary.json')}")
    print("="*70)

if __name__ == "__main__":
    run()
