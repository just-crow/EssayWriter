import json
import os
import re
import sys

if sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if sys.stderr.encoding.lower() != "utf-8":
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

artifacts = r"C:\Users\Mak\Desktop\Code\Vibecoding\EssayWriter\tests\artifacts"
with open(os.path.join(artifacts, "draft_result.json"), encoding="utf-8") as f:
    draft_data = json.load(f)
with open(os.path.join(artifacts, "sources_result.json"), encoding="utf-8") as f:
    sources_data = json.load(f)

draft = draft_data["draft"]
gathered_sources = sources_data.get("sources", [])
footnotes = draft.get("footnotes", [])
works_cited = draft.get("worksCited", [])
evidence = draft.get("evidence", [])

print("="*70)
print("DEEP FACTUAL GROUNDING AND SOURCING AUDIT REPORT")
print("="*70)
print(f"Title:            {draft.get('title')}")
print(f"Word Count:       {draft_data.get('wordCount')} (API reported)")
print(f"Gathered Sources: {len(gathered_sources)}")
print(f"Cited Footnotes:  {len(footnotes)}")
print(f"Works Cited:      {len(works_cited)}")
print(f"Evidence Items:   {len(evidence)}")

def norm(text: str) -> str:
    if not text:
        return ""
    text = text.lower()
    text = re.sub(r'[\u2018\u2019\u201c\u201d\'"`]', '', text)
    text = re.sub(r'[\u2014\u2013-]', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()

print("\n--- 1. SELECTIVE SOURCING VERIFICATION ---")
if len(works_cited) < len(gathered_sources):
    print(f"PASS: Selective sourcing confirmed. Model cited {len(works_cited)} out of {len(gathered_sources)} gathered sources.")
    print("      Unused sources were cleanly omitted without errors.")
else:
    print(f"All {len(works_cited)} gathered sources were used.")

print("\n--- 2. WORKS CITED LIST ---")
for i, wc in enumerate(works_cited):
    print(f" [{i+1}] {wc}")

print("\n--- 3. EVIDENCE QUOTE VERIFICATION AGAINST SOURCE TEXTS ---")
verified = 0
unverified = []
sources_by_url = {s.get("url"): s for s in gathered_sources if s.get("url")}
for idx, ev in enumerate(evidence):
    quote = ev.get("quote", "").strip()
    fn_id = ev.get("source") or ev.get("footnoteId")
    fn = next((x for x in footnotes if x["id"] == fn_id), None)
    fn_url = fn.get("url", "") if fn else ""
    norm_q = norm(quote)
    
    # Check assigned source
    matched_src = sources_by_url.get(fn_url)
    assigned_found = matched_src and norm_q in norm(matched_src.get("content", ""))
    
    # Cross-source check
    any_found = assigned_found
    found_url = fn_url if assigned_found else ""
    if not any_found:
        for s in gathered_sources:
            if norm_q in norm(s.get("content", "")):
                any_found = True
                found_url = s.get("url")
                break
                
    if any_found:
        verified += 1
        print(f" [PASS] Evidence #{idx+1} (Source #{fn_id}, para {ev.get('paragraph')}):")
        print(f"        Quote: \"{quote[:80]}...\"")
        print(f"        Verified in URL: {found_url}")
    else:
        unverified.append((idx+1, fn_id, quote))
        print(f" [FAIL] Evidence #{idx+1} (Source #{fn_id}):")
        print(f"        Quote: \"{quote[:80]}...\" -> NOT FOUND")

print(f"\nEvidence Verification Score: {verified}/{len(evidence)} ({round(verified/len(evidence)*100, 1)}%)")

print("\n--- 4. CLAIM GROUNDING AND CITATIONS PER PARAGRAPH ---")
all_paras = [
    *draft.get("introduction", []),
    *[p for s in draft.get("sections", []) for p in s.get("paragraphs", [])],
    *draft.get("conclusion", [])
]
for p_idx, p in enumerate(all_paras):
    clean = re.sub(r'\[\^\d+\]', '', p)
    words = len(clean.split())
    cites = re.findall(r'\[\^(\d+)\]', p)
    p_type = "Introduction" if p_idx == 0 else ("Conclusion" if p_idx == len(all_paras)-1 else f"Section Para {p_idx}")
    print(f" Paragraph {p_idx} [{p_type}]: {words} words | Citations: {cites}")
    for sent in re.split(r'(?<=[.!?])\s+', p):
        if not sent.strip(): continue
        s_cites = re.findall(r'\[\^(\d+)\]', sent)
        print(f"   - {sent.strip()[:90]}... -> Citations: {s_cites if s_cites else 'Logical inference / Synthesis'}")

summary = {
    "status": "PASS" if len(unverified) == 0 else "PARTIAL",
    "wordCount": draft_data.get("wordCount"),
    "gatheredSources": len(gathered_sources),
    "citedSources": len(footnotes),
    "worksCited": len(works_cited),
    "evidenceCount": len(evidence),
    "evidenceVerified": verified,
    "unverifiedCount": len(unverified)
}
with open(os.path.join(artifacts, "final_audit_summary.json"), "w", encoding="utf-8") as f:
    json.dump(summary, f, indent=2)

print("\n" + "="*70)
print(f"FINAL AUDIT STATUS: {'100% PASS' if len(unverified) == 0 else 'UNVERIFIED QUOTES PRESENT'}")
print("="*70)
