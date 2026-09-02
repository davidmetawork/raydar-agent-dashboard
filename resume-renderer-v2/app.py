"""Isolated deterministic PDF renderer for Raydar Submissions V2.

The service accepts only the fixed ``raydar.resume.ast.v1`` contract.  It does
not call a model, infer facts, or accept arbitrary HTML.  All visible factual
copy must carry validated claim ids before it reaches this process.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import io
import json
import os
import re
import tempfile
import unicodedata
from copy import deepcopy
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable

from fontTools.ttLib import TTFont as FontToolsTTFont
from fontTools.varLib.instancer import instantiateVariableFont
from pypdf import PdfReader
from pypdf.errors import PdfReadError
from reportlab.lib import colors
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas
from svglib.svglib import svg2rlg
from reportlab.graphics import renderPDF


ROOT = Path(__file__).resolve().parent
FONT_DIR = ROOT / "fonts" if (ROOT / "fonts").exists() else ROOT.parent / "fonts"
LOCKUP_PATH = ROOT / "assets" / "raydar-lockup.svg"

RENDERER_VERSION = "raydar-resume-renderer-v2.1"
TEMPLATE_VERSION = "raydar-resume-template-v0.1"
BRAND_ASSET_ID = "raydar-official-lockup-black-v1"
RENDER_REQUEST_VERSION = "raydar.resume.render-request.v1"
RENDER_RESULT_VERSION = "raydar.resume.render-result.v1"
EXTRACT_REQUEST_VERSION = "raydar.resume.extract-request.v1"
EXTRACT_RESULT_VERSION = "raydar.resume.extract-result.v1"

MAX_RENDER_BODY_BYTES = 2 * 1024 * 1024
MAX_EXTRACT_BODY_BYTES = 22 * 1024 * 1024
MAX_SOURCE_PDF_BYTES = 15 * 1024 * 1024
MAX_SOURCE_PAGES = 12
MAX_EXTRACTED_TEXT_CHARS = 2_000_000
MAX_AST_NODES = 500
MAX_AST_VISIBLE_CHARS = 80_000

PAGE_WIDTH, PAGE_HEIGHT = LETTER
MARGIN = 0.55 * 72
PRINTABLE_TOP = PAGE_HEIGHT - MARGIN
PRINTABLE_BOTTOM = MARGIN
PRINTABLE_HEIGHT = PRINTABLE_TOP - PRINTABLE_BOTTOM
PRINTABLE_WIDTH = PAGE_WIDTH - (2 * MARGIN)
PAGE_TWO_MINIMUM_OCCUPANCY = 0.40

INK = colors.HexColor("#211F26")
MUTED = colors.HexColor("#6F6974")
BEIGE = colors.HexColor("#F3EDE3")
SIDEBAR = colors.HexColor("#FAF7F0")
VIOLET = colors.HexColor("#7F72FF")
ORANGE = colors.HexColor("#F06F3C")
WHITE = colors.white
PRACTICE = colors.HexColor("#8A2333")

ALLOWED_SECTION_KINDS = {
    "experience", "projects", "education", "skills", "details", "metrics", "custom",
}
BANNED_CONTENT_PATTERNS = (
    re.compile(r"why this candidate", re.I),
    re.compile(r"why page two", re.I),
    re.compile(r"(?:fit|match) score", re.I),
    re.compile(r"compression applied", re.I),
    re.compile(r"evidence (?:id|ledger|status)", re.I),
    re.compile(r"validation (?:status|note|result)", re.I),
    re.compile(r"readiness (?:status|gate)", re.I),
    re.compile(r"practice status", re.I),
    re.compile(r"example status", re.I),
    re.compile(r"not for submission", re.I),
)


class RenderError(ValueError):
    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = 422,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.details = details or {}


def sha256(value: bytes | str) -> str:
    body = value if isinstance(value, bytes) else str(value).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def normalize_text(value: Any) -> str:
    result = unicodedata.normalize("NFKC", str(value if value is not None else ""))
    result = result.replace("\r\n", "\n").replace("\r", "\n")
    result = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", result)
    result = re.sub(r"[\t\f\v]+", " ", result)
    result = re.sub(r" {2,}", " ", result)
    result = re.sub(r" *\n *", "\n", result)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()


def rendered_text(value: Any) -> str:
    """Use extraction-stable punctuation without changing substantive wording."""
    return re.sub(r"\s+", " ", normalize_text(value)).replace("–", "-").replace("—", "-").replace("‑", "-")


def exact_keys(value: Any, expected: Iterable[str], path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RenderError("RESUME_AST_INVALID", f"{path} must be an object", details={"path": path})
    actual = set(value)
    wanted = set(expected)
    if actual != wanted:
        raise RenderError(
            "RESUME_AST_INVALID",
            f"{path} does not match the fixed AST contract",
            details={"path": path, "actual": sorted(actual), "expected": sorted(wanted)},
        )
    return value


def strict_text(value: Any, path: str, maximum: int) -> str:
    if not isinstance(value, str):
        raise RenderError("RESUME_AST_INVALID", f"{path} must be text", details={"path": path})
    result = normalize_text(value)
    if not result or len(result) > maximum:
        raise RenderError(
            "RESUME_AST_INVALID",
            f"{path} is empty or too long",
            details={"path": path, "maximum": maximum},
        )
    if any(pattern.search(result) for pattern in BANNED_CONTENT_PATTERNS):
        raise RenderError(
            "RESUME_INTERNAL_OR_FILLER_COPY",
            f"{path} exposes internal or filler copy",
            details={"path": path},
        )
    return result


def identifier(value: Any, path: str) -> str:
    result = strict_text(value, path, 200)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]*", result):
        raise RenderError("RESUME_AST_INVALID", f"{path} contains an invalid identifier", details={"path": path})
    return result


@dataclass
class AstContext:
    ids: set[str] = field(default_factory=set)
    visible_copy: set[str] = field(default_factory=set)
    validated_claim_ids: set[str] = field(default_factory=set)
    used_claim_ids: set[str] = field(default_factory=set)
    emphasis_count: int = 0
    emphasis_characters: int = 0
    visible_characters: int = 0
    node_count: int = 0


def content_node(raw: Any, path: str, maximum: int, context: AstContext) -> dict[str, Any]:
    item = exact_keys(raw, ("id", "text", "claim_ids", "emphasis"), path)
    node_id = identifier(item["id"], f"{path}.id")
    if node_id in context.ids:
        raise RenderError("RESUME_AST_ID_DUPLICATE", f"Duplicate AST id: {node_id}", details={"path": path})
    context.ids.add(node_id)
    value = strict_text(item["text"], f"{path}.text", maximum)
    if not isinstance(item["claim_ids"], list) or not item["claim_ids"]:
        raise RenderError("RESUME_AST_CLAIMS_REQUIRED", f"{path} needs candidate claim ids")
    claims = [identifier(claim, f"{path}.claim_ids[{index}]") for index, claim in enumerate(item["claim_ids"])]
    if len(set(claims)) != len(claims):
        raise RenderError("RESUME_AST_INVALID", f"{path}.claim_ids contains duplicates")
    unknown = [claim for claim in claims if claim not in context.validated_claim_ids]
    if unknown:
        raise RenderError(
            "RESUME_UNVALIDATED_CLAIM",
            f"{path} references a claim that has not passed independent validation",
            details={"path": path, "claim_ids": unknown[:20]},
        )
    if not isinstance(item["emphasis"], list) or len(item["emphasis"]) > 3:
        raise RenderError("RESUME_AST_INVALID", f"{path}.emphasis must contain at most three phrases")
    emphasis = [strict_text(phrase, f"{path}.emphasis[{index}]", 200) for index, phrase in enumerate(item["emphasis"])]
    if len(set(emphasis)) != len(emphasis) or any(phrase not in value for phrase in emphasis):
        raise RenderError("RESUME_EMPHASIS_INVALID", f"{path}.emphasis must be unique exact text spans")
    ranges = sorted((value.index(phrase), value.index(phrase) + len(phrase)) for phrase in emphasis)
    if any(ranges[index][0] < ranges[index - 1][1] for index in range(1, len(ranges))):
        raise RenderError("RESUME_EMPHASIS_OVERLAP", f"{path}.emphasis phrases overlap")
    key = value.casefold()
    if key in context.visible_copy:
        raise RenderError("RESUME_FILLER_OR_REPETITION", "Resume content repeats the same visible copy", details={"path": path})
    context.visible_copy.add(key)
    context.used_claim_ids.update(claims)
    context.emphasis_count += len(emphasis)
    context.emphasis_characters += sum(len(phrase) for phrase in emphasis)
    context.visible_characters += len(value)
    context.node_count += 1
    if context.node_count > MAX_AST_NODES or context.visible_characters > MAX_AST_VISIBLE_CHARS:
        raise RenderError("RESUME_AST_TOO_LARGE", "Resume AST exceeds renderer limits")
    return {"id": node_id, "text": value, "claim_ids": claims, "emphasis": emphasis}


def validate_ast(raw: Any, validated_claim_ids: Any) -> dict[str, Any]:
    if not isinstance(validated_claim_ids, list) or not validated_claim_ids:
        raise RenderError("VALIDATED_CLAIMS_REQUIRED", "validated_claim_ids must be a nonempty array")
    validated = [identifier(value, f"validated_claim_ids[{index}]") for index, value in enumerate(validated_claim_ids)]
    if len(set(validated)) != len(validated):
        raise RenderError("VALIDATED_CLAIMS_INVALID", "validated_claim_ids contains duplicates")
    document = exact_keys(raw, ("schema_version", "candidate", "summary", "sections", "page_preference"), "ast")
    if document["schema_version"] != "raydar.resume.ast.v1":
        raise RenderError("RESUME_AST_VERSION_INVALID", "Resume AST version is invalid")
    if document["page_preference"] not in (1, 2):
        raise RenderError("RESUME_AST_INVALID", "page_preference must be one or two")
    context = AstContext(validated_claim_ids=set(validated))
    candidate = exact_keys(document["candidate"], ("name", "headline", "contact"), "ast.candidate")
    if not isinstance(candidate["contact"], list) or len(candidate["contact"]) > 5:
        raise RenderError("RESUME_AST_INVALID", "ast.candidate.contact must contain at most five items")
    checked_candidate = {
        "name": content_node(candidate["name"], "ast.candidate.name", 240, context),
        "headline": content_node(candidate["headline"], "ast.candidate.headline", 320, context),
        "contact": [
            content_node(node, f"ast.candidate.contact[{index}]", 320, context)
            for index, node in enumerate(candidate["contact"])
        ],
    }
    summary = None if document["summary"] is None else content_node(document["summary"], "ast.summary", 1_200, context)
    if not isinstance(document["sections"], list) or not 1 <= len(document["sections"]) <= 12:
        raise RenderError("RESUME_AST_INVALID", "Resume requires one to twelve sections")
    sections = []
    for section_index, raw_section in enumerate(document["sections"]):
        path = f"ast.sections[{section_index}]"
        section = exact_keys(raw_section, ("id", "title", "kind", "placement", "entries"), path)
        section_id = identifier(section["id"], f"{path}.id")
        if section_id in context.ids:
            raise RenderError("RESUME_AST_ID_DUPLICATE", f"Duplicate AST id: {section_id}")
        context.ids.add(section_id)
        title = strict_text(section["title"], f"{path}.title", 120)
        kind = strict_text(section["kind"], f"{path}.kind", 40)
        placement = strict_text(section["placement"], f"{path}.placement", 40)
        if kind not in ALLOWED_SECTION_KINDS or placement not in ("main", "sidebar"):
            raise RenderError("RESUME_AST_INVALID", f"{path} has an invalid kind or placement")
        if not isinstance(section["entries"], list) or not 1 <= len(section["entries"]) <= 20:
            raise RenderError("RESUME_AST_INVALID", f"{path}.entries must contain real resume content")
        entries = []
        for entry_index, raw_entry in enumerate(section["entries"]):
            entry_path = f"{path}.entries[{entry_index}]"
            entry = exact_keys(raw_entry, ("id", "header", "body"), entry_path)
            entry_id = identifier(entry["id"], f"{entry_path}.id")
            if entry_id in context.ids:
                raise RenderError("RESUME_AST_ID_DUPLICATE", f"Duplicate AST id: {entry_id}")
            context.ids.add(entry_id)
            if not isinstance(entry["header"], list) or not 1 <= len(entry["header"]) <= 5:
                raise RenderError("RESUME_AST_INVALID", f"{entry_path}.header is invalid")
            if not isinstance(entry["body"], list) or len(entry["body"]) > 12:
                raise RenderError("RESUME_AST_INVALID", f"{entry_path}.body is invalid")
            entries.append({
                "id": entry_id,
                "header": [
                    content_node(node, f"{entry_path}.header[{index}]", 500, context)
                    for index, node in enumerate(entry["header"])
                ],
                "body": [
                    content_node(node, f"{entry_path}.body[{index}]", 1_200, context)
                    for index, node in enumerate(entry["body"])
                ],
            })
        sections.append({
            "id": section_id,
            "title": title,
            "kind": kind,
            "placement": placement,
            "entries": entries,
        })
    if not any(section["placement"] == "main" for section in sections):
        raise RenderError("RESUME_MAIN_CONTENT_REQUIRED", "Resume requires hiring-manager-facing main content")
    if context.emphasis_count > 8 or context.emphasis_characters / max(1, context.visible_characters) > 0.25:
        raise RenderError("RESUME_EMPHASIS_EXCESSIVE", "Resume emphasis must remain restrained")
    unused = sorted(set(validated) - context.used_claim_ids)
    if unused:
        raise RenderError(
            "RESUME_SELECTED_CLAIMS_MISMATCH",
            "validated_claim_ids must exactly match rendered claims",
            details={"unused_claim_ids": unused[:50]},
        )
    return {
        "schema_version": document["schema_version"],
        "candidate": checked_candidate,
        "summary": summary,
        "sections": sections,
        "page_preference": document["page_preference"],
    }


def materialize_font(source: Path, target: Path, weight: int, family: str, style: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    font = FontToolsTTFont(str(source))
    if "fvar" in font:
        font = instantiateVariableFont(font, {"wght": weight}, inplace=False)
    # ReportLab keys embedded faces by the font's internal names, not only by
    # the pdfmetrics registration name.  Give each static instance a distinct,
    # deterministic identity so regular and semibold cannot collapse together.
    names = font["name"]
    values = {
        1: family,
        2: style,
        3: f"{family} {style} Raydar V2",
        4: f"{family} {style}",
        6: re.sub(r"[^A-Za-z0-9-]", "", f"{family}-{style}"),
        17: style,
    }
    for record in names.names:
        if record.nameID not in values:
            continue
        try:
            record.string = values[record.nameID].encode(record.getEncoding())
        except (LookupError, UnicodeEncodeError):
            continue
    for platform_id, encoding_id, language_id in ((3, 1, 0x409), (1, 0, 0)):
        for name_id, value in values.items():
            names.setName(value, name_id, platform_id, encoding_id, language_id)
    font.flavor = None
    font.save(str(target))


def ensure_fonts() -> tuple[dict[str, Path], dict[str, set[int]]]:
    output = Path(tempfile.gettempdir()) / "raydar-resume-fonts-v2"
    specifications = {
        "PPGrafierDisplay-Regular": (
            FONT_DIR / "pp-grafier-display-variable.woff2",
            output / "PPGrafierDisplay-Regular-v2.ttf", 400, "PP Grafier Display", "Regular",
        ),
        "Inter-Regular": (
            FONT_DIR / "inter-latin-var.woff2", output / "Inter-Regular-v2.ttf", 400, "Inter", "Regular",
        ),
        "Inter-Semibold": (
            FONT_DIR / "inter-latin-var.woff2", output / "Inter-Semibold-v2.ttf", 700, "Inter", "Semibold",
        ),
    }
    paths: dict[str, Path] = {}
    cmaps: dict[str, set[int]] = {}
    for name, (source, target, weight, family, style) in specifications.items():
        if not source.is_file():
            raise RuntimeError(f"Required brand font is missing: {source.name}")
        if not target.exists() or target.stat().st_mtime_ns < source.stat().st_mtime_ns:
            materialize_font(source, target, weight, family, style)
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, str(target)))
        static = FontToolsTTFont(str(target))
        cmaps[name] = set((static.getBestCmap() or {}).keys())
        paths[name] = target
    return paths, cmaps


FONT_PATHS, FONT_CMAPS = ensure_fonts()
if not LOCKUP_PATH.is_file():
    raise RuntimeError("Official Raydar lockup asset is missing")
LOCKUP_BYTES = LOCKUP_PATH.read_bytes()
LOCKUP_SHA256 = sha256(LOCKUP_BYTES)


@dataclass(frozen=True)
class Density:
    name: str
    body_size: float
    support_size: float
    body_leading: float
    support_leading: float
    section_size: float
    section_leading: float
    section_gap: float
    entry_gap: float
    bullet_gap: float
    header_padding: float


DENSITIES = (
    Density("editorial", 10.2, 8.2, 14.0, 10.8, 13.6, 15.4, 17.0, 14.0, 6.0, 17.0),
    Density("airy", 9.3, 7.9, 12.5, 10.2, 12.8, 14.2, 10.0, 8.0, 4.2, 16.0),
    Density("standard", 9.0, 7.7, 11.7, 9.6, 12.2, 13.4, 8.0, 6.5, 3.6, 14.0),
    Density("compact", 8.5, 7.5, 10.2, 9.0, 11.6, 12.8, 6.5, 5.0, 3.0, 12.0),
)


def font_width(text: str, font: str, size: float) -> float:
    return pdfmetrics.stringWidth(text, font, size)


def emphasis_ranges(node: dict[str, Any]) -> list[tuple[int, int]]:
    value = rendered_text(node["text"])
    ranges: list[tuple[int, int]] = []
    for phrase in node["emphasis"]:
        rendered_phrase = rendered_text(phrase)
        start = value.find(rendered_phrase)
        if start >= 0:
            ranges.append((start, start + len(rendered_phrase)))
    return sorted(ranges)


def styled_words(node: dict[str, Any]) -> list[tuple[str, bool]]:
    value = rendered_text(node["text"])
    ranges = emphasis_ranges(node)
    words = []
    for match in re.finditer(r"\S+", value):
        bold = any(match.start() < end and match.end() > start for start, end in ranges)
        words.append((match.group(0), bold))
    return words


def split_long_word(word: str, font: str, size: float, width: float) -> list[str]:
    if font_width(word, font, size) <= width:
        return [word]
    pieces: list[str] = []
    current = ""
    for character in word:
        candidate = current + character
        if current and font_width(candidate, font, size) > width:
            pieces.append(current)
            current = character
        else:
            current = candidate
    if current:
        pieces.append(current)
    return pieces


def wrap_node(
    node: dict[str, Any],
    width: float,
    size: float,
    regular_font: str = "Inter-Regular",
    bold_font: str = "Inter-Semibold",
) -> list[list[tuple[str, str]]]:
    lines: list[list[tuple[str, str]]] = []
    line: list[tuple[str, str]] = []
    used = 0.0
    for word, bold in styled_words(node):
        font = bold_font if bold else regular_font
        pieces = split_long_word(word, font, size, width)
        for piece_index, piece in enumerate(pieces):
            separator = " " if line and piece_index == 0 else ""
            candidate_width = font_width(separator + piece, font, size)
            if line and used + candidate_width > width + 0.01:
                lines.append(line)
                line = []
                used = 0.0
                separator = ""
                candidate_width = font_width(piece, font, size)
            line.append((separator + piece, font))
            used += candidate_width
            if piece_index < len(pieces) - 1:
                lines.append(line)
                line = []
                used = 0.0
    if line:
        lines.append(line)
    return lines or [[("", regular_font)]]


def plain_node(node_id: str, value: str) -> dict[str, Any]:
    return {"id": node_id, "text": value, "claim_ids": ["layout"], "emphasis": []}


def wrap_plain(value: str, width: float, font: str, size: float) -> list[list[tuple[str, str]]]:
    node = plain_node("layout", value)
    return wrap_node(node, width, size, regular_font=font, bold_font=font)


def line_width(line: list[tuple[str, str]], size: float) -> float:
    return sum(font_width(text, font, size) for text, font in line)


@dataclass
class TextBox:
    x: float
    y: float
    width: float
    height: float
    content_id: str
    real_content: bool = True


@dataclass
class PageLayout:
    operations: list[dict[str, Any]] = field(default_factory=list)
    boxes: list[TextBox] = field(default_factory=list)

    def add_lines(
        self,
        *,
        x: float,
        top: float,
        lines: list[list[tuple[str, str]]],
        size: float,
        leading: float,
        color: colors.Color,
        content_id: str,
        real_content: bool = True,
    ) -> float:
        self.operations.append({
            "kind": "text",
            "x": x,
            "top": top,
            "lines": lines,
            "size": size,
            "leading": leading,
            "color": color,
        })
        for index, line in enumerate(lines):
            baseline = top - size - index * leading
            self.boxes.append(TextBox(
                x=x,
                y=baseline - size * 0.22,
                width=max(0.1, line_width(line, size)),
                height=size,
                content_id=content_id,
                real_content=real_content,
            ))
        return len(lines) * leading


class LayoutOverflow(Exception):
    pass


class ResumeLayout:
    def __init__(self, ast: dict[str, Any], density: Density, maximum_pages: int):
        self.ast = ast
        self.density = density
        self.maximum_pages = maximum_pages
        self.pages = [PageLayout() for _ in range(maximum_pages)]
        self.content_tops = [0.0 for _ in range(maximum_pages)]
        self._layout_shared_headers()

    def _lockup(self, page: int, x: float, y: float, width: float) -> None:
        self.pages[page].operations.append({"kind": "lockup", "x": x, "y": y, "width": width})

    def _layout_shared_headers(self) -> None:
        page = self.pages[0]
        pad = self.density.header_padding
        lockup_width = 66.0
        name_width = PRINTABLE_WIDTH - (2 * pad) - lockup_width - 18
        name_lines = wrap_node(
            self.ast["candidate"]["name"], name_width, 23.0,
            regular_font="PPGrafierDisplay-Regular", bold_font="PPGrafierDisplay-Regular",
        )
        headline_lines = wrap_node(self.ast["candidate"]["headline"], name_width, 10.0)
        contact_text = "  •  ".join(rendered_text(node["text"]) for node in self.ast["candidate"]["contact"])
        contact_lines = wrap_plain(contact_text, PRINTABLE_WIDTH - 2 * pad, "Inter-Regular", self.density.support_size) if contact_text else []
        content_height = (
            len(name_lines) * 24.0 + 4
            + len(headline_lines) * 12.4
            + (5 + len(contact_lines) * self.density.support_leading if contact_lines else 0)
        )
        header_height = max(88.0, content_height + 2 * pad)
        header_top = PRINTABLE_TOP
        page.operations.append({
            "kind": "round_rect", "x": MARGIN, "y": header_top - header_height,
            "width": PRINTABLE_WIDTH, "height": header_height, "radius": 12,
            "fill": BEIGE,
        })
        text_top = header_top - pad
        used = page.add_lines(
            x=MARGIN + pad, top=text_top, lines=name_lines, size=23.0, leading=24.0,
            color=INK, content_id=self.ast["candidate"]["name"]["id"],
        )
        text_top -= used + 4
        used = page.add_lines(
            x=MARGIN + pad, top=text_top, lines=headline_lines, size=10.0, leading=12.4,
            color=MUTED, content_id=self.ast["candidate"]["headline"]["id"],
        )
        text_top -= used + 5
        if contact_lines:
            page.add_lines(
                x=MARGIN + pad, top=text_top, lines=contact_lines,
                size=self.density.support_size, leading=self.density.support_leading,
                color=MUTED, content_id="candidate-contact",
            )
        self._lockup(0, PAGE_WIDTH - MARGIN - pad - lockup_width, header_top - pad - 19, lockup_width)
        cursor = header_top - header_height - 12
        if self.ast["summary"]:
            summary_lines = wrap_node(self.ast["summary"], PRINTABLE_WIDTH, self.density.body_size)
            used = page.add_lines(
                x=MARGIN, top=cursor, lines=summary_lines,
                size=self.density.body_size, leading=self.density.body_leading,
                color=INK, content_id=self.ast["summary"]["id"],
            )
            cursor -= used + 7
            page.operations.append({
                "kind": "line", "x1": MARGIN, "y1": cursor,
                "x2": PAGE_WIDTH - MARGIN, "y2": cursor, "color": VIOLET, "width": 0.7,
            })
            cursor -= 10
        self.content_tops[0] = cursor

        for page_index in range(1, self.maximum_pages):
            current = self.pages[page_index]
            strip_height = 42.0
            current.operations.append({
                "kind": "round_rect", "x": MARGIN, "y": PRINTABLE_TOP - strip_height,
                "width": PRINTABLE_WIDTH, "height": strip_height, "radius": 9, "fill": BEIGE,
            })
            self._lockup(page_index, PAGE_WIDTH - MARGIN - 70, PRINTABLE_TOP - 29, 58)
            self.content_tops[page_index] = PRINTABLE_TOP - strip_height - 12

    def layout(self) -> tuple[list[PageLayout], int]:
        main_sections = [section for section in self.ast["sections"] if section["placement"] == "main"]
        sidebar_sections = [section for section in self.ast["sections"] if section["placement"] == "sidebar"]
        gap = 18.0 if sidebar_sections else 0.0
        sidebar_width = 156.0 if sidebar_sections else 0.0
        main_width = PRINTABLE_WIDTH - sidebar_width - gap
        self._layout_column(
            main_sections,
            x=MARGIN,
            width=main_width,
            sidebar=False,
        )
        if sidebar_sections:
            sidebar_x = MARGIN + main_width + gap
            self._layout_column(sidebar_sections, x=sidebar_x, width=sidebar_width, sidebar=True)
            for page_index, top in enumerate(self.content_tops):
                has_sidebar_content = any(
                    box.real_content and box.x >= sidebar_x - 0.5
                    for box in self.pages[page_index].boxes
                )
                if has_sidebar_content:
                    # Insert behind text and rules; never draw an empty column
                    # on a continuation page that has no sidebar evidence.
                    self.pages[page_index].operations.insert(0, {
                        "kind": "round_rect", "x": sidebar_x - 9, "y": PRINTABLE_BOTTOM,
                        "width": sidebar_width + 18, "height": max(1, top - PRINTABLE_BOTTOM),
                        "radius": 10, "fill": SIDEBAR,
                    })
        used_pages = 1
        for index, page in enumerate(self.pages):
            if any(box.real_content for box in page.boxes) or index == 0:
                used_pages = index + 1
        return self.pages[:used_pages], used_pages

    def _layout_column(self, sections: list[dict[str, Any]], *, x: float, width: float, sidebar: bool) -> None:
        page_index = 0
        cursor = self.content_tops[0]

        def advance(current_page: int, current_cursor: float, required: float) -> tuple[int, float]:
            if current_cursor - required >= PRINTABLE_BOTTOM:
                return current_page, current_cursor
            current_page += 1
            if current_page >= self.maximum_pages:
                raise LayoutOverflow
            current_cursor = self.content_tops[current_page]
            if current_cursor - required < PRINTABLE_BOTTOM:
                raise LayoutOverflow
            return current_page, current_cursor

        def require(required: float) -> None:
            nonlocal page_index, cursor
            page_index, cursor = advance(page_index, cursor, required)

        def body_advance(current_page: int, current_cursor: float, required: float) -> tuple[int, float]:
            return advance(current_page, current_cursor, required)

        for section in sections:
            heading_lines = wrap_plain(
                section["title"], width, "PPGrafierDisplay-Regular", self.density.section_size,
            )
            heading_height = len(heading_lines) * self.density.section_leading + 6
            first_entry = section["entries"][0]
            first_entry_height = self._entry_minimum_height(first_entry, width, sidebar)
            page_capacity = max(top - PRINTABLE_BOTTOM for top in self.content_tops)
            if section["kind"] == "metrics":
                preferred = self._entry_total_height(first_entry, width - 14, sidebar) + 14
            else:
                preferred = self._entry_total_height(first_entry, width, sidebar) + 2
            if preferred <= page_capacity:
                first_entry_height = preferred
            require(heading_height + first_entry_height)
            page = self.pages[page_index]
            used = page.add_lines(
                x=x, top=cursor, lines=heading_lines,
                size=self.density.section_size, leading=self.density.section_leading,
                color=INK, content_id=section["id"],
            )
            cursor -= used + 3
            page.operations.append({
                "kind": "line", "x1": x, "y1": cursor,
                "x2": x + width, "y2": cursor, "color": VIOLET, "width": 0.65,
            })
            cursor -= 7
            for entry in section["entries"]:
                minimum = self._entry_minimum_height(entry, width, sidebar)
                if section["kind"] == "metrics":
                    total = self._entry_total_height(entry, width - 14, sidebar) + 14
                    require(total)
                    self.pages[page_index].operations.append({
                        "kind": "round_rect", "x": x, "y": cursor - total,
                        "width": width, "height": total, "radius": 7, "fill": WHITE,
                    })
                    cursor -= 7
                    inner_x, inner_width = x + 7, width - 14
                    cursor, page_index = self._draw_entry(
                        entry, page_index, cursor, inner_x, inner_width, sidebar, body_advance,
                    )
                    cursor -= 7
                else:
                    total = self._entry_total_height(entry, width, sidebar) + 2
                    page_capacity = max(top - PRINTABLE_BOTTOM for top in self.content_tops)
                    # Keep a normal resume entry intact whenever it can fit on
                    # one page; only an intrinsically over-tall entry may flow.
                    require(total if total <= page_capacity else minimum)
                    cursor, page_index = self._draw_entry(
                        entry, page_index, cursor, x, width, sidebar, body_advance,
                    )
                cursor -= self.density.entry_gap
            cursor -= self.density.section_gap

    def _header_measurements(self, entry: dict[str, Any], width: float, sidebar: bool) -> list[tuple[dict[str, Any], list[list[tuple[str, str]]], float, float, str, colors.Color]]:
        result = []
        for index, node in enumerate(entry["header"]):
            size = self.density.body_size if index == 0 else self.density.support_size
            leading = self.density.body_leading if index == 0 else self.density.support_leading
            font = "Inter-Semibold" if index == 0 else "Inter-Regular"
            if sidebar:
                size = self.density.support_size if index else self.density.body_size
            lines = wrap_node(node, width, size, regular_font=font, bold_font="Inter-Semibold")
            result.append((node, lines, size, leading, font, INK if index == 0 else MUTED))
        return result

    def _body_measurements(self, entry: dict[str, Any], width: float, sidebar: bool) -> list[tuple[dict[str, Any], list[list[tuple[str, str]]], float, float]]:
        size = self.density.support_size if sidebar else self.density.body_size
        leading = self.density.support_leading if sidebar else self.density.body_leading
        return [(node, wrap_node(node, width - 11, size), size, leading) for node in entry["body"]]

    def _entry_minimum_height(self, entry: dict[str, Any], width: float, sidebar: bool) -> float:
        headers = self._header_measurements(entry, width, sidebar)
        bodies = self._body_measurements(entry, width, sidebar)
        header_height = sum(len(lines) * leading + 1 for _, lines, _, leading, _, _ in headers)
        first_body = len(bodies[0][1]) * bodies[0][3] + self.density.bullet_gap if bodies else 0
        return header_height + first_body + 2

    def _entry_total_height(self, entry: dict[str, Any], width: float, sidebar: bool) -> float:
        headers = self._header_measurements(entry, width, sidebar)
        bodies = self._body_measurements(entry, width, sidebar)
        return (
            sum(len(lines) * leading + 1 for _, lines, _, leading, _, _ in headers)
            + sum(len(lines) * leading + self.density.bullet_gap for _, lines, _, leading in bodies)
        )

    def _draw_entry(self, entry, page_index, cursor, x, width, sidebar, advance):
        headers = self._header_measurements(entry, width, sidebar)
        bodies = self._body_measurements(entry, width, sidebar)
        for node, lines, size, leading, _font, color in headers:
            used = self.pages[page_index].add_lines(
                x=x, top=cursor, lines=lines, size=size, leading=leading,
                color=color, content_id=node["id"],
            )
            cursor -= used + 1
        cursor -= 1
        for node, lines, size, leading in bodies:
            required = len(lines) * leading + self.density.bullet_gap
            page_index, cursor = advance(page_index, cursor, required)
            page = self.pages[page_index]
            page.operations.append({
                "kind": "circle", "x": x + 2.4, "y": cursor - size * 0.55,
                "radius": 1.8, "fill": ORANGE,
            })
            used = page.add_lines(
                x=x + 11, top=cursor, lines=lines, size=size, leading=leading,
                color=INK, content_id=node["id"],
            )
            cursor -= used + self.density.bullet_gap
        return cursor, page_index


def missing_glyphs(ast: dict[str, Any]) -> list[int]:
    display_text = [ast["candidate"]["name"]["text"], *(section["title"] for section in ast["sections"])]
    body_text = [ast["candidate"]["headline"]["text"]]
    body_text.extend(node["text"] for node in ast["candidate"]["contact"])
    if ast["summary"]:
        body_text.append(ast["summary"]["text"])
    for section in ast["sections"]:
        for entry in section["entries"]:
            body_text.extend(node["text"] for node in [*entry["header"], *entry["body"]])
    missing: set[int] = set()
    for value in display_text:
        missing.update(ord(character) for character in rendered_text(value)
                       if not character.isspace() and ord(character) not in FONT_CMAPS["PPGrafierDisplay-Regular"])
    for value in body_text:
        missing.update(ord(character) for character in rendered_text(value)
                       if not character.isspace() and ord(character) not in FONT_CMAPS["Inter-Regular"])
    return sorted(missing)


LOCKUP_DRAWING = svg2rlg(str(LOCKUP_PATH))
if LOCKUP_DRAWING is None or not LOCKUP_DRAWING.width or not LOCKUP_DRAWING.height:
    raise RuntimeError("Official Raydar lockup could not be rendered")


def draw_lockup(canvas: Canvas, x: float, y: float, width: float) -> None:
    drawing = deepcopy(LOCKUP_DRAWING)
    scale = width / drawing.width
    canvas.saveState()
    canvas.translate(x, y)
    canvas.scale(scale, scale)
    renderPDF.draw(drawing, canvas, 0, 0)
    canvas.restoreState()


def draw_pages(pages: list[PageLayout], practice: bool) -> bytes:
    target = io.BytesIO()
    canvas = Canvas(
        target,
        pagesize=LETTER,
        pageCompression=1,
        invariant=1,
        initialFontName="Inter-Regular",
    )
    canvas.setTitle("Resume")
    canvas.setAuthor("Raydar")
    for page_index, page in enumerate(pages):
        canvas.setFillColor(WHITE)
        canvas.rect(0, 0, PAGE_WIDTH, PAGE_HEIGHT, fill=1, stroke=0)
        for operation in page.operations:
            kind = operation["kind"]
            if kind == "round_rect":
                canvas.setFillColor(operation["fill"])
                canvas.roundRect(
                    operation["x"], operation["y"], operation["width"], operation["height"],
                    operation["radius"], fill=1, stroke=0,
                )
            elif kind == "line":
                canvas.setStrokeColor(operation["color"])
                canvas.setLineWidth(operation["width"])
                canvas.line(operation["x1"], operation["y1"], operation["x2"], operation["y2"])
            elif kind == "circle":
                canvas.setFillColor(operation["fill"])
                canvas.circle(operation["x"], operation["y"], operation["radius"], fill=1, stroke=0)
            elif kind == "lockup":
                draw_lockup(canvas, operation["x"], operation["y"], operation["width"])
            elif kind == "text":
                canvas.setFillColor(operation["color"])
                for line_index, line in enumerate(operation["lines"]):
                    baseline = operation["top"] - operation["size"] - line_index * operation["leading"]
                    text_object = canvas.beginText(operation["x"], baseline)
                    for text, font in line:
                        text_object.setFont(font, operation["size"])
                        text_object.textOut(text)
                    # An explicit line advance preserves a separator when PDF
                    # extractors encounter adjacent independently positioned
                    # text blocks (for example, name then headline).
                    text_object.textLine("")
                    canvas.drawText(text_object)
        if practice:
            canvas.setFont("Inter-Semibold", 7.5)
            canvas.setFillColor(PRACTICE)
            canvas.drawCentredString(PAGE_WIDTH / 2, 18, "PRACTICE - NOT FOR SUBMISSION")
        if page_index < len(pages) - 1:
            canvas.showPage()
    canvas.save()
    return target.getvalue()


def intervals_occupancy(page: PageLayout) -> float:
    intervals = sorted(
        (max(PRINTABLE_BOTTOM, box.y), min(PRINTABLE_TOP, box.y + box.height))
        for box in page.boxes if box.real_content
    )
    if not intervals:
        return 0.0
    merged: list[list[float]] = []
    for start, end in intervals:
        if end <= start:
            continue
        if not merged or start > merged[-1][1]:
            merged.append([start, end])
        else:
            merged[-1][1] = max(merged[-1][1], end)
    return min(1.0, sum(end - start for start, end in merged) / PRINTABLE_HEIGHT)


def boxes_overlap(left: TextBox, right: TextBox, tolerance: float = 0.35) -> bool:
    return (
        min(left.x + left.width, right.x + right.width) - max(left.x, right.x) > tolerance
        and min(left.y + left.height, right.y + right.height) - max(left.y, right.y) > tolerance
    )


def geometry_preflight(pages: list[PageLayout]) -> dict[str, Any]:
    clipping = False
    overlap = False
    box_count = 0
    for page in pages:
        real = [box for box in page.boxes if box.real_content]
        box_count += len(real)
        clipping = clipping or any(
            box.x < MARGIN - 0.5 or box.x + box.width > PAGE_WIDTH - MARGIN + 0.5
            or box.y < PRINTABLE_BOTTOM - 0.5 or box.y + box.height > PRINTABLE_TOP + 0.5
            for box in real
        )
        for index, left in enumerate(real):
            if any(boxes_overlap(left, right) for right in real[index + 1:]):
                overlap = True
                break
    return {
        "pageOccupancies": [round(intervals_occupancy(page), 4) for page in pages],
        "hasClipping": clipping,
        "hasOverlap": overlap,
        "contentBoxCount": box_count,
    }


def ats_text(ast: dict[str, Any]) -> str:
    lines = [rendered_text(ast["candidate"]["name"]["text"]), rendered_text(ast["candidate"]["headline"]["text"])]
    if ast["candidate"]["contact"]:
        lines.append(" | ".join(rendered_text(node["text"]) for node in ast["candidate"]["contact"]))
    if ast["summary"]:
        lines.extend(["", rendered_text(ast["summary"]["text"])])
    for section in ast["sections"]:
        lines.extend(["", rendered_text(section["title"]).upper()])
        for entry in section["entries"]:
            lines.append(" | ".join(rendered_text(node["text"]) for node in entry["header"]))
            lines.extend(f"- {rendered_text(node['text'])}" for node in entry["body"])
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip() + "\n"


def token_bag(value: str) -> list[tuple[str, int]]:
    normalized = normalize_text(value)
    normalized = re.sub(r"PRACTICE\s*-\s*NOT FOR SUBMISSION", " ", normalized, flags=re.I)
    normalized = re.sub(r"\bRaydar\b", " ", normalized, flags=re.I)
    tokens = re.findall(r"[\w]+(?:[.+#/-][\w]+)*", normalized.casefold(), flags=re.UNICODE)
    counts: dict[str, int] = {}
    for token in tokens:
        counts[token] = counts.get(token, 0) + 1
    return sorted(counts.items())


def embedded_fonts(reader: PdfReader) -> tuple[bool, list[str]]:
    names: set[str] = set()
    all_embedded = True
    for page in reader.pages:
        resources_reference = page.get("/Resources")
        resources = resources_reference.get_object() if resources_reference else {}
        fonts_reference = resources.get("/Font") or {}
        fonts = fonts_reference.get_object() if hasattr(fonts_reference, "get_object") else fonts_reference
        for reference in fonts.values():
            font = reference.get_object()
            base_name = str(font.get("/BaseFont") or "")
            names.add(base_name)
            # svglib initializes a Times resource while drawing the official
            # path-only lockup, but emits no glyphs with it; all visible resume
            # text is drawn with the three approved embedded faces below.
            if base_name == "/Times-Roman":
                continue
            descriptor = font.get("/FontDescriptor")
            if descriptor is None:
                descendants = font.get("/DescendantFonts") or []
                if descendants:
                    descriptor = descendants[0].get_object().get("/FontDescriptor")
            if descriptor is None:
                all_embedded = False
                continue
            descriptor_object = descriptor.get_object()
            if not any(descriptor_object.get(key) is not None for key in ("/FontFile", "/FontFile2", "/FontFile3")):
                all_embedded = False
    visible_names = {name for name in names if name != "/Times-Roman"}
    brand_fonts = all("Inter" in name or "PPGrafier" in name for name in visible_names)
    required_faces = ("Inter-Regular", "Inter-Semibold", "PPGrafierDisplay-Regular")
    faces_present = all(any(face in name for name in visible_names) for face in required_faces)
    return all_embedded and brand_fonts and faces_present, sorted(names)


def inspect_pdf(pdf: bytes, ats: str, pages: list[PageLayout], glyphs: list[int]) -> tuple[str, dict[str, Any]]:
    try:
        reader = PdfReader(io.BytesIO(pdf), strict=False)
    except (PdfReadError, ValueError, OSError) as error:
        raise RenderError("RESUME_PDF_INVALID", "Rendered PDF could not be read") from error
    if reader.is_encrypted:
        raise RenderError("RESUME_PDF_INVALID", "Rendered PDF is unexpectedly encrypted")
    extracted = normalize_text("\n".join(page.extract_text() or "" for page in reader.pages))
    if not extracted:
        raise RenderError("RESUME_PDF_TEXT_EMPTY", "Rendered PDF has no selectable text")
    geometry = geometry_preflight(pages)
    fonts_ok, font_names = embedded_fonts(reader)
    parity = token_bag(extracted) == token_bag(ats)
    preflight = {
        "pageCount": len(reader.pages),
        **geometry,
        "hasOverflow": len(reader.pages) > 2,
        "hasMissingGlyphs": bool(glyphs),
        "missingGlyphCodepoints": glyphs,
        "fontsEmbedded": fonts_ok,
        "embeddedFonts": font_names,
        "textSelectable": bool(extracted),
        "atsParity": parity,
    }
    failures = []
    for key in ("hasOverflow", "hasClipping", "hasOverlap", "hasMissingGlyphs"):
        if preflight[key]:
            failures.append(key)
    if not fonts_ok:
        failures.append("fontsEmbedded")
    if not parity:
        failures.append("atsParity")
    if failures:
        raise RenderError("RESUME_VISUAL_PREFLIGHT_FAILED", "Rendered resume failed preflight", details={"failures": failures})
    if len(reader.pages) == 2 and preflight["pageOccupancies"][1] < PAGE_TWO_MINIMUM_OCCUPANCY:
        raise RenderError(
            "RESUME_PAGE_TWO_UNDERFILLED",
            "Rendered page two contains too little real resume content",
            details={"occupancy": preflight["pageOccupancies"][1]},
        )
    return extracted, preflight


def render_resume(ast: dict[str, Any], practice: bool) -> tuple[bytes, str, str, dict[str, Any], dict[str, Any]]:
    glyphs = missing_glyphs(ast)
    if glyphs:
        raise RenderError(
            "RESUME_MISSING_GLYPHS",
            "Resume contains glyphs unavailable in the approved embedded fonts",
            details={"codepoints": glyphs},
        )
    candidates: list[tuple[Density, int]] = [(density, 1) for density in DENSITIES]
    candidates.extend((density, 2) for density in DENSITIES if density.name in ("standard", "compact"))
    last_error: RenderError | None = None
    for density, maximum_pages in candidates:
        try:
            layouts, page_count = ResumeLayout(ast, density, maximum_pages).layout()
            if page_count != maximum_pages and maximum_pages == 2:
                continue
            pdf = draw_pages(layouts, practice)
            ats = ats_text(ast)
            extracted, preflight = inspect_pdf(pdf, ats, layouts, glyphs)
            if page_count != preflight["pageCount"]:
                raise RenderError("RESUME_PAGE_COUNT_MISMATCH", "PDF page count differs from layout result")
            plan = {
                "expectedPages": page_count,
                "density": density.name,
                "compressionApplied": density.name in ("standard", "compact") or page_count == 2,
                "pagePreference": ast["page_preference"],
                "actualOccupancies": preflight["pageOccupancies"],
            }
            return pdf, ats, extracted, preflight, plan
        except LayoutOverflow:
            continue
        except RenderError as error:
            if error.code == "RESUME_PAGE_TWO_UNDERFILLED":
                last_error = error
                continue
            raise
    if last_error:
        raise last_error
    raise RenderError("RESUME_PAGE_LIMIT_EXCEEDED", "Resume cannot fit within two US-letter pages")


def render_request(payload: dict[str, Any]) -> dict[str, Any]:
    request = exact_keys(
        payload,
        ("schema_version", "render_id", "ast", "validated_claim_ids", "expected_ast_sha256", "practice"),
        "request",
    )
    if request["schema_version"] != RENDER_REQUEST_VERSION:
        raise RenderError("RENDER_REQUEST_VERSION_INVALID", "Render request version is invalid")
    render_id = identifier(request["render_id"], "request.render_id")
    if not isinstance(request["practice"], bool):
        raise RenderError("RENDER_REQUEST_INVALID", "request.practice must be boolean")
    expected_digest = strict_text(request["expected_ast_sha256"], "request.expected_ast_sha256", 64)
    if not re.fullmatch(r"[0-9a-f]{64}", expected_digest):
        raise RenderError("RENDER_REQUEST_INVALID", "expected_ast_sha256 is invalid")
    ast = validate_ast(request["ast"], request["validated_claim_ids"])
    ast_digest = sha256(canonical_json(ast))
    if not hmac.compare_digest(ast_digest, expected_digest):
        raise RenderError(
            "RESUME_AST_DIGEST_MISMATCH",
            "Resume AST digest does not match the validated request",
            details={"actual_ast_sha256": ast_digest},
        )
    pdf, ats, extracted, preflight, plan = render_resume(ast, request["practice"])
    return {
        "ok": True,
        "schemaVersion": RENDER_RESULT_VERSION,
        "renderId": render_id,
        "rendererVersion": RENDERER_VERSION,
        "templateVersion": TEMPLATE_VERSION,
        "brandAssetId": BRAND_ASSET_ID,
        "brandAssetSha256": LOCKUP_SHA256,
        "astSha256": ast_digest,
        "practice": request["practice"],
        "plan": plan,
        "pdfBase64": base64.b64encode(pdf).decode("ascii"),
        "pdfSha256": sha256(pdf),
        "pdfByteLength": len(pdf),
        "pdfExtractedText": extracted,
        "pdfTextSha256": sha256(extracted),
        "atsText": ats,
        "atsSha256": sha256(ats),
        "preflight": preflight,
    }


def decode_pdf_base64(value: Any) -> bytes:
    if not isinstance(value, str) or not value:
        raise RenderError("SOURCE_PDF_BASE64_INVALID", "pdf_base64 is required")
    try:
        pdf = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as error:
        raise RenderError("SOURCE_PDF_BASE64_INVALID", "pdf_base64 is invalid") from error
    if not pdf.startswith(b"%PDF-"):
        raise RenderError("SOURCE_PDF_MAGIC_INVALID", "Source file is not a PDF")
    if not pdf or len(pdf) > MAX_SOURCE_PDF_BYTES:
        raise RenderError("SOURCE_PDF_SIZE_INVALID", "Source PDF exceeds the 15 MB limit", status=413)
    return pdf


def extract_pdf_request(payload: dict[str, Any]) -> dict[str, Any]:
    request = exact_keys(payload, ("schema_version", "pdf_base64"), "request")
    if request["schema_version"] != EXTRACT_REQUEST_VERSION:
        raise RenderError("EXTRACT_REQUEST_VERSION_INVALID", "Extract request version is invalid")
    pdf = decode_pdf_base64(request["pdf_base64"])
    try:
        reader = PdfReader(io.BytesIO(pdf), strict=False)
    except (PdfReadError, ValueError, OSError) as error:
        raise RenderError("SOURCE_PDF_UNREADABLE", "Source PDF could not be read") from error
    if reader.is_encrypted:
        raise RenderError("SOURCE_PDF_ENCRYPTED", "Encrypted source PDFs are not accepted")
    if not 1 <= len(reader.pages) <= MAX_SOURCE_PAGES:
        raise RenderError(
            "SOURCE_PDF_PAGE_LIMIT",
            f"Source PDF must contain one to {MAX_SOURCE_PAGES} pages",
            details={"page_count": len(reader.pages)},
        )
    try:
        parts = []
        extracted_characters = 0
        for page in reader.pages:
            part = page.extract_text() or ""
            extracted_characters += len(part)
            if extracted_characters > MAX_EXTRACTED_TEXT_CHARS:
                raise RenderError(
                    "SOURCE_PDF_TEXT_LIMIT",
                    "Source PDF contains too much extracted text",
                    status=413,
                )
            parts.append(part)
        text = normalize_text("\n".join(parts))
    except RenderError:
        raise
    except Exception as error:
        raise RenderError("SOURCE_PDF_UNREADABLE", "Source PDF text could not be extracted") from error
    if not text:
        raise RenderError("SOURCE_PDF_TEXT_EMPTY", "Source PDF has no readable selectable text")
    return {
        "ok": True,
        "schemaVersion": EXTRACT_RESULT_VERSION,
        "pdfSha256": sha256(pdf),
        "pdfByteLength": len(pdf),
        "pageCount": len(reader.pages),
        "text": text,
        "normalizedTextSha256": sha256(text),
        "textCharacterCount": len(text),
    }


def renderer_key() -> str:
    return str(os.environ.get("SUBMISSIONS_V2_RENDERER_KEY") or "").strip()


class Handler(BaseHTTPRequestHandler):
    server_version = "RaydarResumeRendererV2"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Never log candidate identifiers, request bodies, source content, or response content.
        print(f"resume-renderer-v2 method={self.command} path={self.path} status={args[1] if len(args) > 1 else '-'}")

    def json_response(self, status: int, body: dict[str, Any]) -> None:
        raw = canonical_json(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("cache-control", "no-store")
        self.send_header("x-content-type-options", "nosniff")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.json_response(404, {"ok": False, "error": "not_found"})
            return
        self.json_response(200, {
            "ok": True,
            "service": "raydar-resume-renderer-v2",
            "rendererVersion": RENDERER_VERSION,
            "templateVersion": TEMPLATE_VERSION,
            "brandAssetId": BRAND_ASSET_ID,
            "brandAssetSha256": LOCKUP_SHA256,
            "fonts": sorted(FONT_PATHS),
            "authConfigured": len(renderer_key()) >= 32,
        })

    def _authorized(self) -> bool:
        expected = renderer_key()
        if len(expected) < 32:
            self.json_response(503, {"ok": False, "error": "renderer_auth_not_configured"})
            return False
        supplied = self.headers.get("authorization", "")
        if not hmac.compare_digest(supplied, f"Bearer {expected}"):
            self.json_response(401, {"ok": False, "error": "renderer_auth_required"})
            return False
        return True

    def _json_body(self, maximum: int) -> dict[str, Any] | None:
        if self.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            self.json_response(415, {"ok": False, "error": "application_json_required"})
            return None
        try:
            length = int(self.headers.get("content-length", "0") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > maximum:
            self.json_response(413, {"ok": False, "error": "request_body_size_invalid"})
            return None
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError):
            self.json_response(400, {"ok": False, "error": "request_json_invalid"})
            return None
        if not isinstance(payload, dict):
            self.json_response(400, {"ok": False, "error": "request_object_required"})
            return None
        return payload

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in ("/render-v2", "/extract-v2"):
            self.json_response(404, {"ok": False, "error": "not_found"})
            return
        if not self._authorized():
            return
        maximum = MAX_RENDER_BODY_BYTES if self.path == "/render-v2" else MAX_EXTRACT_BODY_BYTES
        payload = self._json_body(maximum)
        if payload is None:
            return
        try:
            result = render_request(payload) if self.path == "/render-v2" else extract_pdf_request(payload)
            self.json_response(200, result)
        except RenderError as error:
            self.json_response(error.status, {
                "ok": False,
                "error": error.code,
                "detail": str(error),
                **({"details": error.details} if error.details else {}),
            })
        except Exception:
            self.json_response(500, {"ok": False, "error": "renderer_failed"})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()
