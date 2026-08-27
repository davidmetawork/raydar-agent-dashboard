"""Brand-exact, truth-constrained resume renderer for Monitor Submissions.

Anthropic may only select and order caller-supplied fact IDs. It never supplies
resume prose. Every job in the canonical career history is emitted, titles are
immutable, and an unusable selection degrades to the plain source ordering.
"""

from __future__ import annotations

import base64
import hashlib
import html
import io
import json
import os
import re
import tempfile
import urllib.error
import urllib.request
from copy import deepcopy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from fontTools.ttLib import TTFont as FontToolsTTFont
from fontTools.varLib.instancer import instantiateVariableFont
from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import inch
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageTemplate,
    Paragraph,
    Spacer,
)


ROOT = Path(__file__).resolve().parent
FONT_DIR = ROOT / "fonts" if (ROOT / "fonts").exists() else ROOT.parent / "fonts"
MAX_BODY_BYTES = 22 * 1024 * 1024
MAX_SOURCE_PDF_BYTES = 15 * 1024 * 1024
MAX_FACTS = 1_200
MAX_FACT_CHARS = 500
BEIGE = colors.HexColor("#F6F3E9")
INK = colors.HexColor("#16140F")
INK_2 = colors.HexColor("#57534A")
VIOLET = colors.HexColor("#7F72FF")
ORANGE = colors.HexColor("#FF6E00")
LINE = colors.HexColor("#DDD6C8")
STOPWORDS = {
    "a", "an", "and", "at", "by", "for", "from", "in", "of", "on",
    "the", "to", "with", "or", "as", "is", "was", "are", "were",
}


def clean(value: Any, limit: int = MAX_FACT_CHARS) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


def safe_html(value: Any) -> str:
    return html.escape(clean(value, 8_000), quote=True)


def tokens(value: Any) -> set[str]:
    return {
        token
        for token in re.findall(r"[a-z0-9$%+#.'-]+", clean(value, 20_000).lower())
        if token not in STOPWORDS
    }


def ordered_words(value: Any) -> list[str]:
    return re.findall(r"[a-z0-9$%+#.'-]+", clean(value, 8_000).lower())


def grounded_edit(value: Any, allowed_facts: list[Any]) -> bool:
    """Allow exact source wording or a forward-preserving trailing trim.

    A set-of-words check is not strong enough: it would permit rearranging a
    true source sentence into a different claim. Keeping the source prefix in
    order lets an operator shorten a long bullet without inventing prose. A
    negation may never disappear during that trim.
    """
    edited = ordered_words(value)
    if not edited:
        return True
    negations = {"no", "not", "never", "none", "neither", "nor", "without"}
    for raw in allowed_facts:
        source = ordered_words(raw)
        if not source or len(edited) > len(source):
            continue
        if edited != source[: len(edited)]:
            continue
        if len(edited) < 3 and edited != source:
            continue
        if ({word for word in edited if word in negations}
                != {word for word in source if word in negations}):
            continue
        return True
    return False


def materialize_font(source: Path, target: Path, weight: int = 400) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    font = FontToolsTTFont(str(source))
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": weight}, inplace=False)
    font.flavor = None
    font.save(str(target))


def ensure_fonts() -> None:
    generated = Path(tempfile.gettempdir()) / "raydar-resume-fonts-v1"
    faces = {
        "PPGrafierDisplay-Regular": (
            FONT_DIR / "pp-grafier-display-variable.woff2",
            generated / "PPGrafierDisplay-Regular.ttf",
        ),
        "PPGrafier-Regular": (
            FONT_DIR / "pp-grafier-text-variable.woff2",
            generated / "PPGrafier-Regular.ttf",
        ),
        "Inter-Regular": (
            FONT_DIR / "inter-latin-var.woff2",
            generated / "Inter-Regular.ttf",
        ),
    }
    for name, (source, target) in faces.items():
        if not target.exists():
            materialize_font(source, target)
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, str(target)))


ensure_fonts()


class BrandedCanvas(Canvas):
    def __init__(self, *args: Any, **kwargs: Any):
        kwargs["initialFontName"] = "Inter-Regular"
        super().__init__(*args, **kwargs)


def source_lines(pdf_bytes: bytes) -> list[str]:
    if not pdf_bytes:
        return []
    if len(pdf_bytes) > MAX_SOURCE_PDF_BYTES or not pdf_bytes.startswith(b"%PDF-"):
        raise ValueError("SOURCE_RESUME_PDF_INVALID")
    reader = PdfReader(io.BytesIO(pdf_bytes), strict=False)
    lines: list[str] = []
    for page in reader.pages[:12]:
        for raw in (page.extract_text() or "").splitlines():
            value = clean(raw)
            if value and value not in lines:
                lines.append(value)
                if len(lines) >= MAX_FACTS:
                    return lines
    return lines


def history_fact_rows(history: list[dict[str, Any]]) -> tuple[list[dict[str, str]], list[dict[str, Any]]]:
    facts: list[dict[str, str]] = []
    jobs: list[dict[str, Any]] = []
    for index, raw in enumerate(history[:80]):
        title = clean(raw.get("title"))
        company = clean(raw.get("company"))
        if not title and not company:
            continue
        job = {
            "id": clean(raw.get("id")) or f"job-{index + 1}",
            "title": title or "Role",
            "company": company or "Company",
            "location": clean(raw.get("location")),
            "dates": clean(raw.get("dates")),
            "facts": [],
        }
        raw_facts = raw.get("facts") if isinstance(raw.get("facts"), list) else []
        if not raw_facts:
            raw_facts = re.split(r"(?<=[.!?])\s+|[\r\n]+", clean(raw.get("description"), 8_000))
        for fact_index, value in enumerate(raw_facts[:30]):
            statement = clean(value)
            if not statement:
                continue
            fact_id = f"{job['id']}:fact-{fact_index + 1}"
            facts.append({"id": fact_id, "text": statement, "jobId": job["id"]})
            job["facts"].append(fact_id)
        jobs.append(job)
    return facts, jobs


def resume_fact_rows(lines: list[str], jobs: list[dict[str, Any]]) -> tuple[list[dict[str, str]], int]:
    facts: list[dict[str, str]] = []
    current_job: dict[str, Any] | None = None
    matched = 0
    source_counts: dict[str, int] = {}
    heading_words = {"experience", "employment", "education", "skills", "summary", "profile", "contact"}
    for index, line in enumerate(lines):
        line_tokens = tokens(line)
        best: tuple[int, dict[str, Any]] | None = None
        for job in jobs:
            identity = tokens(f"{job['title']} {job['company']}")
            line_lower = clean(line).lower()
            exact = sum(
                3 for part in (clean(job["title"]).lower(), clean(job["company"]).lower())
                if len(part) >= 4 and re.search(rf"\b{re.escape(part)}\b", line_lower)
            )
            score = exact + len(line_tokens & identity)
            if score >= 2 and (best is None or score > best[0]):
                best = (score, job)
        if best:
            current_job = best[1]
            continue
        lowered = clean(line).lower().strip(":")
        usable = (
            len(clean(line)) >= 18
            and lowered not in heading_words
            and "@" not in line
            and not re.search(r"https?://|linkedin\.com|\+?\d[\d(). -]{7,}", line, re.I)
        )
        if not usable:
            continue
        fact_id = f"resume:line-{index + 1}"
        row = {"id": fact_id, "text": clean(line), "jobId": current_job["id"] if current_job else ""}
        facts.append(row)
        if current_job:
            offset = source_counts.get(current_job["id"], 0)
            current_job["facts"].insert(offset, fact_id)
            source_counts[current_job["id"]] = offset + 1
            matched += 1
    return facts, matched


def parse_json_object(value: str) -> dict[str, Any]:
    text = value.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I | re.S)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("ANTHROPIC_SELECTION_NOT_JSON")
    parsed = json.loads(text[start : end + 1])
    if not isinstance(parsed, dict):
        raise ValueError("ANTHROPIC_SELECTION_NOT_OBJECT")
    return parsed


def anthropic_selection(facts: list[dict[str, str]], jobs: list[dict[str, Any]], role: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    key = clean(os.environ.get("ANTHROPIC_API_KEY"), 500)
    if not key or not facts:
        return None, "anthropic_unavailable"
    fact_lines = "\n".join(f"{row['id']}: {row['text']}" for row in facts)
    job_lines = "\n".join(
        f"{job['id']}: {job['title']} at {job['company']} | allowed={','.join(job['facts'])}"
        for job in jobs
    )
    role_text = " | ".join(
        clean(role.get(key_name), 4_000)
        for key_name in ("title", "company", "description", "requirements")
        if clean(role.get(key_name), 4_000)
    )
    prompt = f"""You select and order existing resume fact IDs for one role. You may not write prose.
Role: {role_text}

Canonical jobs (every job remains in the output):
{job_lines}

Allowed facts:
{fact_lines}

Return JSON only:
{{"summaryFactIds":[up to 3 allowed IDs],"jobs":[{{"jobId":"exact id","factIds":[up to 3 IDs belonging to that job]}}]}}
Include every canonical job exactly once. Never invent an ID. Prefer facts relevant to the role, but keep source wording unchanged."""
    body = json.dumps({
        "model": clean(os.environ.get("RESUME_ANTHROPIC_MODEL")) or "claude-sonnet-5",
        "max_tokens": 2_000,
        "temperature": 0,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    request = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=body,
        method="POST",
        headers={
            "content-type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=40) as response:
            parsed = json.loads(response.read())
        content = "".join(
            item.get("text", "") for item in parsed.get("content", [])
            if isinstance(item, dict) and item.get("type") == "text"
        )
        return parse_json_object(content), clean(parsed.get("model"), 120) or None
    except (OSError, urllib.error.URLError, json.JSONDecodeError, ValueError, KeyError):
        return None, "anthropic_selection_failed"


def validate_selection(selection: dict[str, Any] | None, facts: list[dict[str, str]], jobs: list[dict[str, Any]]) -> dict[str, Any] | None:
    if not isinstance(selection, dict):
        return None
    facts_by_id = {row["id"]: row for row in facts}
    jobs_by_id = {row["id"]: row for row in jobs}
    selected_jobs = selection.get("jobs") if isinstance(selection.get("jobs"), list) else []
    if {clean(row.get("jobId")) for row in selected_jobs if isinstance(row, dict)} != set(jobs_by_id):
        return None
    normalized_jobs = []
    for row in selected_jobs:
        job_id = clean(row.get("jobId"))
        allowed = set(jobs_by_id[job_id]["facts"])
        chosen = []
        for fact_id in row.get("factIds", []) if isinstance(row.get("factIds"), list) else []:
            fact_id = clean(fact_id)
            if fact_id not in allowed or fact_id in chosen:
                return None
            chosen.append(fact_id)
        normalized_jobs.append({"jobId": job_id, "factIds": chosen[:3]})
    summary = []
    for fact_id in selection.get("summaryFactIds", []) if isinstance(selection.get("summaryFactIds"), list) else []:
        fact_id = clean(fact_id)
        if fact_id not in facts_by_id or fact_id in summary:
            return None
        summary.append(fact_id)
    return {"summaryFactIds": summary[:3], "jobs": normalized_jobs}


def plain_selection(jobs: list[dict[str, Any]]) -> dict[str, Any]:
    summary: list[str] = []
    selected = []
    for job in jobs:
        fact_ids = list(job["facts"][:3])
        selected.append({"jobId": job["id"], "factIds": fact_ids})
        for fact_id in fact_ids:
            if len(summary) < 3:
                summary.append(fact_id)
    return {"summaryFactIds": summary, "jobs": selected}


def make_document(payload: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any], str, str | None]:
    candidate = payload.get("candidate") if isinstance(payload.get("candidate"), dict) else {}
    role = payload.get("role") if isinstance(payload.get("role"), dict) else {}
    history = payload.get("careerHistory") if isinstance(payload.get("careerHistory"), list) else []
    facts, jobs = history_fact_rows(history)
    resume_bytes = b""
    encoded = payload.get("sourceResumePdfBase64")
    if encoded:
        try:
            resume_bytes = base64.b64decode(encoded, validate=True)
        except ValueError as error:
            raise ValueError("SOURCE_RESUME_BASE64_INVALID") from error
    extracted = source_lines(resume_bytes)
    if not jobs and not extracted:
        raise ValueError("NO_CAREER_HISTORY")
    if not jobs:
        source = "candidate resume"
        document = {
            "name": clean(candidate.get("name"), 160) or "Candidate",
            "headline": clean(candidate.get("headline"), 240),
            "contact": [
                clean(candidate.get("email"), 240),
                clean(candidate.get("phone"), 100),
                clean(candidate.get("location"), 240),
                clean(candidate.get("linkedin"), 500),
            ],
            "summary": [],
            "experiences": [],
            "plainSourceLines": extracted,
            "education": [],
            "skills": [],
            "provenance": "Prepared by Raydar from the candidate resume; source text preserved.",
        }
        manifest = {
            "schemaVersion": 1,
            "source": source,
            "mode": "plain_untailored",
            "model": None,
            "allowedFacts": extracted,
            "canonicalJobs": [],
        }
        return document, manifest, "plain_untailored", None
    resume_facts, matched_resume_facts = resume_fact_rows(extracted, jobs)
    facts = [*resume_facts, *facts]
    source = (
        "candidate resume and Paraform career history"
        if matched_resume_facts
        else "Paraform cached career history"
    )
    selection_raw, model = anthropic_selection(facts, jobs, role)
    selection = validate_selection(selection_raw, facts, jobs)
    mode = "tailored" if selection else "plain_untailored"
    if not selection:
        selection = plain_selection(jobs)
    fact_text = {row["id"]: row["text"] for row in facts}
    selected_by_job = {row["jobId"]: row["factIds"] for row in selection["jobs"]}
    document = {
        "name": clean(candidate.get("name"), 160) or "Candidate",
        "headline": clean(candidate.get("headline"), 240),
        "contact": [
            clean(candidate.get("email"), 240),
            clean(candidate.get("phone"), 100),
            clean(candidate.get("location"), 240),
            clean(candidate.get("linkedin"), 500),
        ],
        "summary": [fact_text[fact_id] for fact_id in selection["summaryFactIds"]],
        "experiences": [
            {
                "id": job["id"],
                "title": job["title"],
                "company": job["company"],
                "location": job["location"],
                "dates": job["dates"],
                "bullets": [fact_text[fact_id] for fact_id in selected_by_job.get(job["id"], [])],
            }
            for job in jobs
        ],
        "education": [clean(item, 800) for item in payload.get("education", [])[:12] if clean(item, 800)],
        "skills": [clean(item, 120) for item in payload.get("skills", [])[:30] if clean(item, 120)],
        "provenance": f"Prepared by Raydar from {source}; source facts preserved.",
    }
    allowed = sorted({clean(value, 8_000) for value in [*fact_text.values(), *document["contact"], document["name"], document["headline"], *document["education"], *document["skills"]] if clean(value, 8_000)})
    manifest = {
        "schemaVersion": 1,
        "source": source,
        "mode": mode,
        "model": model,
        "allowedFacts": allowed,
        "canonicalJobs": [
            {key: job[key] for key in ("id", "title", "company", "location", "dates")}
            for job in jobs
        ],
    }
    return document, manifest, mode, model


def validate_edited_document(document: dict[str, Any], manifest: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(document, dict) or not isinstance(manifest, dict):
        raise ValueError("EDIT_MANIFEST_INVALID")
    allowed_facts = manifest.get("allowedFacts") if isinstance(manifest.get("allowedFacts"), list) else []
    canonical = manifest.get("canonicalJobs") if isinstance(manifest.get("canonicalJobs"), list) else []
    experiences = document.get("experiences") if isinstance(document.get("experiences"), list) else []
    if len(experiences) != len(canonical):
        raise ValueError("EDIT_JOB_REMOVAL_FORBIDDEN")
    cleaned = deepcopy(document)
    invalid: list[str] = []
    for index, (job, source) in enumerate(zip(experiences, canonical)):
        for key in ("id", "title", "company", "location", "dates"):
            if clean(job.get(key), 500) != clean(source.get(key), 500):
                invalid.append(f"experiences[{index}].{key}")
        for bullet_index, bullet in enumerate(job.get("bullets", []) if isinstance(job.get("bullets"), list) else []):
            if not grounded_edit(bullet, allowed_facts):
                invalid.append(f"experiences[{index}].bullets[{bullet_index}]")
    for index, statement in enumerate(document.get("summary", []) if isinstance(document.get("summary"), list) else []):
        if not grounded_edit(statement, allowed_facts):
            invalid.append(f"summary[{index}]")
    if invalid:
        error = ValueError("EDIT_UNSOURCED_CLAIMS")
        error.detail = invalid[:30]  # type: ignore[attr-defined]
        raise error
    cleaned["summary"] = [clean(item, 800) for item in cleaned.get("summary", [])[:3] if clean(item, 800)]
    for job in cleaned["experiences"]:
        job["bullets"] = [clean(item, 800) for item in job.get("bullets", [])[:5] if clean(item, 800)]
    cleaned["provenance"] = clean(document.get("provenance"), 500) or "Prepared by Raydar from verified source facts."
    return cleaned


class ResumeDocTemplate(BaseDocTemplate):
    def __init__(self, target: io.BytesIO, compact: int):
        super().__init__(
            target,
            pagesize=LETTER,
            leftMargin=0.62 * inch,
            rightMargin=0.62 * inch,
            topMargin=0.72 * inch,
            bottomMargin=0.56 * inch,
            title="Raydar resume",
            author="Raydar",
        )
        self.compact = compact
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            id="resume",
            leftPadding=0,
            rightPadding=0,
            topPadding=0,
            bottomPadding=0,
        )
        self.addPageTemplates(PageTemplate(id="resume", frames=[frame], onPage=self.decorate))

    def decorate(self, canvas, doc):
        width, height = LETTER
        canvas.saveState()
        canvas.setFillColor(BEIGE)
        canvas.rect(0, 0, width, height, fill=1, stroke=0)
        canvas.setFillColor(VIOLET)
        canvas.rect(0, height - 0.12 * inch, width, 0.12 * inch, fill=1, stroke=0)
        canvas.setFont("Inter-Regular", 7.2)
        canvas.setFillColor(INK_2)
        canvas.drawString(self.leftMargin, 0.27 * inch, "Prepared by Raydar · source-grounded")
        canvas.drawRightString(width - self.rightMargin, 0.27 * inch, f"{doc.page}")
        # Compact Raydar lockup, drawn natively so every font remains embedded.
        mark_x, mark_y = width - self.rightMargin - 68, height - 29
        canvas.setLineWidth(1.8)
        canvas.setStrokeColor(INK)
        canvas.circle(mark_x, mark_y, 9, fill=0, stroke=1)
        canvas.setStrokeColor(VIOLET)
        canvas.circle(mark_x, mark_y, 4.5, fill=0, stroke=1)
        canvas.setFillColor(ORANGE)
        canvas.circle(mark_x, mark_y, 1.5, fill=1, stroke=0)
        canvas.setStrokeColor(INK)
        canvas.line(mark_x + 3, mark_y + 3, mark_x + 11, mark_y + 11)
        canvas.setFont("PPGrafier-Regular", 10)
        canvas.setFillColor(INK)
        canvas.drawString(mark_x + 14, mark_y - 3, "raydar")
        canvas.restoreState()


def styles(compact: int) -> dict[str, ParagraphStyle]:
    shrink = 0.45 * compact
    return {
        "name": ParagraphStyle(
            "name", fontName="PPGrafierDisplay-Regular", fontSize=29 - 2 * compact,
            leading=31 - 2 * compact, textColor=INK, spaceAfter=2,
        ),
        "headline": ParagraphStyle(
            "headline", fontName="PPGrafier-Regular", fontSize=12 - shrink,
            leading=14 - shrink, textColor=VIOLET, spaceAfter=4,
        ),
        "contact": ParagraphStyle(
            "contact", fontName="Inter-Regular", fontSize=7.8 - 0.25 * compact,
            leading=10 - 0.25 * compact, textColor=INK_2, spaceAfter=9 - compact,
        ),
        "section": ParagraphStyle(
            "section", fontName="PPGrafier-Regular", fontSize=11.5 - shrink,
            leading=13.2 - shrink, textColor=ORANGE, spaceBefore=7 - compact,
            spaceAfter=4 - compact,
        ),
        "body": ParagraphStyle(
            "body", fontName="Inter-Regular", fontSize=8.4 - 0.35 * compact,
            leading=11.2 - 0.4 * compact, textColor=INK, spaceAfter=3,
        ),
        "job": ParagraphStyle(
            "job", fontName="PPGrafier-Regular", fontSize=9.7 - shrink,
            leading=11.5 - shrink, textColor=INK, spaceBefore=3, spaceAfter=1,
        ),
        "meta": ParagraphStyle(
            "meta", fontName="Inter-Regular", fontSize=7.5 - 0.25 * compact,
            leading=9 - 0.25 * compact, textColor=INK_2, spaceAfter=2,
        ),
        "bullet": ParagraphStyle(
            "bullet", fontName="Inter-Regular", fontSize=7.9 - 0.3 * compact,
            leading=10.3 - 0.35 * compact, leftIndent=9, firstLineIndent=-6,
            bulletIndent=0, textColor=INK, spaceAfter=1.5,
        ),
        "footer": ParagraphStyle(
            "footer", fontName="Inter-Regular", fontSize=6.8,
            leading=8.2, textColor=INK_2, borderColor=LINE, borderWidth=0.5,
            borderPadding=(5, 0, 0, 0), spaceBefore=7,
        ),
    }


def document_story(document: dict[str, Any], compact: int) -> list[Any]:
    style = styles(compact)
    story: list[Any] = [
        Paragraph(safe_html(document.get("name")), style["name"]),
    ]
    if clean(document.get("headline")):
        story.append(Paragraph(safe_html(document.get("headline")), style["headline"]))
    contact = [clean(item, 500) for item in document.get("contact", []) if clean(item, 500)]
    if contact:
        story.append(Paragraph(" &nbsp; · &nbsp; ".join(safe_html(item) for item in contact), style["contact"]))
    summary = [clean(item, 800) for item in document.get("summary", []) if clean(item, 800)]
    if summary:
        story.append(Paragraph("Summary", style["section"]))
        story.append(Paragraph(" ".join(safe_html(item) for item in summary), style["body"]))
    story.append(Paragraph("Experience", style["section"]))
    experiences = document.get("experiences", [])
    if not experiences:
        story[-1] = Paragraph("Source resume", style["section"])
        for line in document.get("plainSourceLines", []):
            story.append(Paragraph(safe_html(line), style["body"]))
    for job in experiences:
        title = safe_html(job.get("title"))
        company = safe_html(job.get("company"))
        meta = " · ".join(filter(None, [clean(job.get("dates")), clean(job.get("location"))]))
        block: list[Any] = [
            Paragraph(f"{title} <font color='#57534A'>at {company}</font>", style["job"]),
        ]
        if meta:
            block.append(Paragraph(safe_html(meta), style["meta"]))
        bullets = [clean(item, 800) for item in job.get("bullets", []) if clean(item, 800)]
        max_bullets = 3 if compact == 0 else 2 if compact == 1 else 1
        for bullet in bullets[:max_bullets]:
            block.append(Paragraph(f"• {safe_html(bullet)}", style["bullet"]))
        story.append(KeepTogether(block if compact < 2 else block[:2] + block[2:3]))
    education = [clean(item, 800) for item in document.get("education", []) if clean(item, 800)]
    if education:
        story.extend([
            Paragraph("Education", style["section"]),
            Paragraph("<br/>".join(safe_html(item) for item in education), style["body"]),
        ])
    skills = [clean(item, 120) for item in document.get("skills", []) if clean(item, 120)]
    if skills and compact < 2:
        story.extend([
            Paragraph("Skills", style["section"]),
            Paragraph(" · ".join(safe_html(item) for item in skills), style["body"]),
        ])
    story.extend([
        Spacer(1, 3),
        Paragraph(safe_html(document.get("provenance")), style["footer"]),
    ])
    return story


def render_pdf(document: dict[str, Any]) -> tuple[bytes, int, int]:
    last = b""
    for compact in range(3):
        target = io.BytesIO()
        ResumeDocTemplate(target, compact).build(
            document_story(document, compact),
            canvasmaker=BrandedCanvas,
        )
        last = target.getvalue()
        pages = len(PdfReader(io.BytesIO(last), strict=False).pages)
        if pages <= 2:
            preflight_pdf(last, document)
            return last, pages, compact
    raise ValueError("RESUME_EXCEEDS_TWO_PAGES")


def preflight_pdf(pdf: bytes, document: dict[str, Any]) -> None:
    reader = PdfReader(io.BytesIO(pdf), strict=False)
    if not 1 <= len(reader.pages) <= 2:
        raise ValueError("RESUME_PAGE_COUNT_INVALID")
    extracted = "\n".join(page.extract_text() or "" for page in reader.pages)
    for job in document.get("experiences", []):
        if clean(job.get("title")) not in extracted or clean(job.get("company")) not in extracted:
            raise ValueError("RESUME_JOB_DROPPED")
    if "Prepared by Raydar" not in extracted:
        raise ValueError("RESUME_PROVENANCE_MISSING")
    for page in reader.pages:
        fonts = page.get("/Resources", {}).get("/Font", {})
        for font_ref in fonts.values():
            font = font_ref.get_object()
            base = str(font.get("/BaseFont", ""))
            if not re.search(r"(?:Inter|PPGrafier)", base):
                raise ValueError("RESUME_NON_BRAND_FONT")
            descriptor_ref = font.get("/FontDescriptor")
            if descriptor_ref is None:
                raise ValueError("RESUME_FONT_NOT_EMBEDDED")
            descriptor = descriptor_ref.get_object()
            if not any(descriptor.get(key) is not None for key in ("/FontFile", "/FontFile2", "/FontFile3")):
                raise ValueError("RESUME_FONT_NOT_EMBEDDED")


def ats_text(document: dict[str, Any]) -> str:
    lines = [clean(document.get("name"))]
    if clean(document.get("headline")):
        lines.append(clean(document.get("headline")))
    lines.extend(clean(item, 500) for item in document.get("contact", []) if clean(item, 500))
    summary = [clean(item, 800) for item in document.get("summary", []) if clean(item, 800)]
    if summary:
        lines.extend(["", "SUMMARY", " ".join(summary)])
    experiences = document.get("experiences", [])
    lines.extend(["", "EXPERIENCE" if experiences else "SOURCE RESUME"])
    if not experiences:
        lines.extend(clean(item, 800) for item in document.get("plainSourceLines", []) if clean(item, 800))
    for job in experiences:
        lines.append(f"{clean(job.get('title'))} | {clean(job.get('company'))}")
        meta = " | ".join(filter(None, [clean(job.get("dates")), clean(job.get("location"))]))
        if meta:
            lines.append(meta)
        lines.extend(f"- {clean(item, 800)}" for item in job.get("bullets", []) if clean(item, 800))
    education = [clean(item, 800) for item in document.get("education", []) if clean(item, 800)]
    if education:
        lines.extend(["", "EDUCATION", *education])
    skills = [clean(item, 120) for item in document.get("skills", []) if clean(item, 120)]
    if skills:
        lines.extend(["", "SKILLS", ", ".join(skills)])
    lines.extend(["", clean(document.get("provenance"))])
    return "\n".join(lines).strip() + "\n"


def render(payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("editedDocument") is not None:
        document = validate_edited_document(payload.get("editedDocument"), payload.get("manifest"))
        manifest = payload["manifest"]
        mode = clean(manifest.get("mode")) or "plain_untailored"
        model = clean(manifest.get("model")) or None
    else:
        document, manifest, mode, model = make_document(payload)
    pdf, pages, compact = render_pdf(document)
    text = ats_text(document)
    return {
        "ok": True,
        "pdfBase64": base64.b64encode(pdf).decode(),
        "pdfSha256": hashlib.sha256(pdf).hexdigest(),
        "atsText": text,
        "atsSha256": hashlib.sha256(text.encode()).hexdigest(),
        "document": document,
        "manifest": manifest,
        "mode": mode,
        "source": manifest.get("source"),
        "model": model,
        "pages": pages,
        "compactLevel": compact,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "RaydarResumeRenderer/1"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Never log request bodies, candidate names, or artifact content.
        print(f"resume-renderer {self.command} {self.path} {fmt % args}")

    def json_response(self, status: int, body: dict[str, Any]) -> None:
        raw = json.dumps(body, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/healthz":
            self.json_response(404, {"ok": False, "error": "not_found"})
            return
        self.json_response(200, {"ok": True, "service": "resume-renderer", "version": 1})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/render":
            self.json_response(404, {"ok": False, "error": "not_found"})
            return
        expected = clean(os.environ.get("RESUME_RENDERER_KEY"), 500)
        supplied = self.headers.get("authorization", "")
        if not expected or supplied != f"Bearer {expected}":
            self.json_response(401, {"ok": False, "error": "renderer_auth_required"})
            return
        length = int(self.headers.get("content-length", "0") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self.json_response(413, {"ok": False, "error": "render_payload_too_large"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("RENDER_PAYLOAD_INVALID")
            self.json_response(200, render(payload))
        except ValueError as error:
            self.json_response(422, {
                "ok": False,
                "error": str(error),
                "detail": getattr(error, "detail", None),
            })
        except Exception:
            self.json_response(500, {"ok": False, "error": "RENDER_FAILED"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
