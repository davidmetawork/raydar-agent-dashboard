import base64
import copy
import io
import json
import os
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import LETTER
from reportlab.pdfgen.canvas import Canvas

import app


AUTH_KEY = "renderer-test-key-that-is-longer-than-thirty-two-characters"
OFFICIAL_LOCKUP_SHA256 = "0a87dff42d8fa82f2968dd691e469f0e785da3c0daa6737fb3146f6b782d4e83"
GOLDEN_ONE_PAGE_SHA256 = "402e616ab90c372040fb2c002d69a50c44b0551d18493a813f73f73f0b36846c"
GOLDEN_TWO_PAGE_SHA256 = "47e6b8ee2acacd358876d85ca5e9779c1419121da8a13fc58d6e19f4af7b14a4"


class AstBuilder:
    def __init__(self):
        self.claim_ids = []

    def node(self, node_id, text, emphasis=None):
        claim_id = f"claim-{node_id}"
        self.claim_ids.append(claim_id)
        return {
            "id": node_id,
            "text": text,
            "claim_ids": [claim_id],
            "emphasis": emphasis or [],
        }

    def entry(self, entry_id, header, body):
        return {
            "id": entry_id,
            "header": [self.node(f"{entry_id}-h-{index}", value) for index, value in enumerate(header)],
            "body": [self.node(f"{entry_id}-b-{index}", value) for index, value in enumerate(body)],
        }


def compact_ast():
    builder = AstBuilder()
    ast = {
        "schema_version": "raydar.resume.ast.v1",
        "candidate": {
            "name": builder.node("candidate-name", "Jordan Avery"),
            "headline": builder.node(
                "candidate-headline",
                "Product-minded software engineer building dependable healthcare systems",
            ),
            "contact": [
                builder.node("candidate-location", "Los Angeles, CA"),
                builder.node("candidate-email", "jordan.avery@example.com"),
                builder.node("candidate-linkedin", "linkedin.com/in/jordan-avery"),
            ],
        },
        "summary": builder.node(
            "candidate-summary",
            "Software engineer with eight years of experience translating complex clinical workflows into clear, reliable products for care teams.",
        ),
        "sections": [
            {
                "id": "experience",
                "title": "Selected experience",
                "kind": "experience",
                "placement": "main",
                "entries": [
                    builder.entry(
                        "role-one",
                        ["Northstar Health", "Staff Software Engineer | 2022-Present"],
                        [
                            "Led a cross-functional team that shipped clinician scheduling workflows used across 40 partner locations.",
                            "Reduced median API latency by 38% through query redesign, caching, and production instrumentation.",
                            "Partnered with design and clinical operations to turn ambiguous requirements into measured releases.",
                        ],
                    ),
                    builder.entry(
                        "role-two",
                        ["Cedar Systems", "Senior Software Engineer | 2019-2022"],
                        [
                            "Built TypeScript and Python services that processed eligibility data for more than 600,000 members.",
                            "Created deployment safeguards that cut rollback time from 25 minutes to under 8 minutes.",
                        ],
                    ),
                    builder.entry(
                        "role-three",
                        ["Common Thread Labs", "Software Engineer | 2016-2019"],
                        [
                            "Developed accessible React interfaces and documented service contracts for a growing engineering team.",
                        ],
                    ),
                ],
            },
            {
                "id": "skills",
                "title": "Capabilities",
                "kind": "skills",
                "placement": "sidebar",
                "entries": [
                    builder.entry(
                        "skills-entry",
                        ["Technical"],
                        [
                            "TypeScript, React, Python, PostgreSQL",
                            "Distributed systems, observability, AWS",
                        ],
                    ),
                ],
            },
            {
                "id": "education",
                "title": "Education",
                "kind": "education",
                "placement": "sidebar",
                "entries": [
                    builder.entry(
                        "education-entry",
                        ["B.S. Computer Science", "California State University | 2016"],
                        [],
                    ),
                ],
            },
        ],
        "page_preference": 1,
    }
    ast["sections"][0]["entries"][0]["body"][1]["emphasis"] = ["38%"]
    return ast, builder.claim_ids


def long_ast(entry_count=10, bullets_per_entry=3, words_per_bullet=26):
    builder = AstBuilder()
    ast = {
        "schema_version": "raydar.resume.ast.v1",
        "candidate": {
            "name": builder.node("long-name", "Morgan Quinn"),
            "headline": builder.node("long-headline", "Engineering leader for industrial software and connected systems"),
            "contact": [builder.node("long-location", "Chicago, IL")],
        },
        "summary": builder.node(
            "long-summary",
            "Engineering leader with a sustained record of building industrial platforms, developing teams, and improving the reliability of complex connected products.",
        ),
        "sections": [{
            "id": "long-experience",
            "title": "Professional experience",
            "kind": "experience",
            "placement": "main",
            "entries": [],
        }],
        "page_preference": 1,
    }
    vocabulary = (
        "Designed reliable distributed production systems with cross functional partners while improving "
        "delivery quality observability safety performance and measurable customer outcomes across complex operations"
    ).split()
    for index in range(entry_count):
        bodies = []
        for bullet_index in range(bullets_per_entry):
            words = [vocabulary[(position + index + bullet_index) % len(vocabulary)] for position in range(words_per_bullet)]
            bodies.append(f"Initiative {index + 1}.{bullet_index + 1}: {' '.join(words)}.")
        ast["sections"][0]["entries"].append(builder.entry(
            f"long-role-{index}",
            [f"Industrial Company {index + 1}", f"Engineering Role {index + 1} | {2026 - index}-{2027 - index}"],
            bodies,
        ))
    return ast, builder.claim_ids


def request_for(ast, claims, practice=False, render_id="render-test-1"):
    checked = app.validate_ast(ast, claims)
    return {
        "schema_version": app.RENDER_REQUEST_VERSION,
        "render_id": render_id,
        "ast": ast,
        "validated_claim_ids": claims,
        "expected_ast_sha256": app.sha256(app.canonical_json(checked)),
        "practice": practice,
    }


def simple_pdf(text=None, page_count=1):
    output = io.BytesIO()
    canvas = Canvas(output, pagesize=LETTER, invariant=1)
    for index in range(page_count):
        if text is not None:
            canvas.drawString(72, 720, f"{text} page {index + 1}")
        else:
            # Materialize a real page without adding extractable content.
            canvas.setFillColorRGB(1, 1, 1)
            canvas.rect(0, 0, 1, 1, fill=1, stroke=0)
        if index < page_count - 1:
            canvas.showPage()
    canvas.save()
    return output.getvalue()


class RendererContractTests(unittest.TestCase):
    def test_official_lockup_is_exact_bundled_asset(self):
        self.assertEqual(app.LOCKUP_SHA256, OFFICIAL_LOCKUP_SHA256)
        self.assertEqual(app.sha256(app.LOCKUP_PATH.read_bytes()), OFFICIAL_LOCKUP_SHA256)

    def test_render_is_deterministic_selectable_embedded_and_ats_safe(self):
        ast, claims = compact_ast()
        payload = request_for(ast, claims)
        first = app.render_request(payload)
        second = app.render_request(payload)
        first_pdf = base64.b64decode(first["pdfBase64"])
        second_pdf = base64.b64decode(second["pdfBase64"])

        self.assertEqual(first_pdf, second_pdf)
        self.assertEqual(first["pdfSha256"], app.sha256(first_pdf))
        self.assertEqual(first["pdfSha256"], GOLDEN_ONE_PAGE_SHA256)
        self.assertEqual(first["brandAssetSha256"], OFFICIAL_LOCKUP_SHA256)
        self.assertEqual(first["preflight"]["pageCount"], 1)
        self.assertEqual(first["plan"]["expectedPages"], 1)
        self.assertTrue(first["preflight"]["fontsEmbedded"])
        self.assertTrue(first["preflight"]["textSelectable"])
        self.assertTrue(first["preflight"]["atsParity"])
        self.assertTrue(first["preflight"]["templateGeometryParity"])
        self.assertFalse(first["preflight"]["hasClipping"])
        self.assertFalse(first["preflight"]["hasOverlap"])
        self.assertFalse(first["preflight"]["hasOverflow"])
        self.assertFalse(first["preflight"]["hasMissingGlyphs"])
        self.assertIn("Jordan Avery", first["pdfExtractedText"])
        self.assertNotIn("why this candidate", first["pdfExtractedText"].lower())
        self.assertEqual(len(PdfReader(io.BytesIO(first_pdf)).pages), 1)
        self.assertEqual(first["rendererVersion"], "raydar-resume-renderer-v2.2")
        self.assertEqual(first["templateVersion"], "raydar-resume-template-v0.2")

    def test_golden_template_geometry_and_minimum_type_are_locked(self):
        ast, claims = compact_ast()
        checked = app.validate_ast(ast, claims)
        pages, page_count = app.ResumeLayout(checked, app.DENSITIES[2], 1).layout()
        self.assertEqual(page_count, 1)
        operations = pages[0].operations
        self.assertEqual((app.PAGE_WIDTH, app.PAGE_HEIGHT), LETTER)
        self.assertEqual({
            "ink": app.INK.hexval(), "body": app.BODY.hexval(), "muted": app.MUTED.hexval(),
            "header": app.BEIGE.hexval(), "sidebar": app.SIDEBAR.hexval(),
            "violet": app.VIOLET.hexval(), "violet_text": app.VIOLET_TEXT.hexval(),
            "orange": app.ORANGE.hexval(), "rule": app.RULE.hexval(),
        }, {
            "ink": "0x0f0f0f", "body": "0x4a4741", "muted": "0x716d63",
            "header": "0xf6f3e9", "sidebar": "0xfaf9f5", "violet": "0x7f72ff",
            "violet_text": "0x574ea9", "orange": "0xff6e00", "rule": "0xe4dfd1",
        })
        self.assertTrue(any(
            operation.get("kind") == "round_rect"
            and operation.get("x") == 0
            and operation.get("y") == app.PAGE_HEIGHT - app.TOP_RAIL_HEIGHT
            and operation.get("height") == app.TOP_RAIL_HEIGHT
            and operation.get("fill") == app.VIOLET
            for operation in operations
        ))
        self.assertTrue(any(
            operation.get("kind") == "lockup"
            and operation.get("x") == 477.0
            and operation.get("y") == 738.0
            and operation.get("width") == 92.0
            for operation in operations
        ))
        self.assertEqual(app.FOOTER_RULE_Y, 42.8)
        self.assertTrue(any(
            operation.get("kind") == "round_rect"
            and operation.get("x") == 0
            and operation.get("y") == app.PAGE_HEIGHT - app.PAGE_ONE_HEADER_HEIGHT
            and operation.get("fill") == app.BEIGE
            for operation in operations
        ))
        self.assertTrue(any(
            operation.get("kind") == "round_rect"
            and operation.get("x") == app.SIDEBAR_BACKGROUND_X
            and operation.get("width") == app.SIDEBAR_BACKGROUND_WIDTH
            for operation in operations
        ))
        self.assertTrue(any(
            operation.get("kind") == "text"
            and operation.get("x") == app.MAIN_X
            and operation.get("size") == 29.0
            for operation in operations
        ))
        self.assertTrue(all(density.body_size >= 8.5 for density in app.DENSITIES))
        self.assertTrue(all(density.support_size >= 7.5 for density in app.DENSITIES))
        main_bullets = sum(len(entry["body"]) for entry in checked["sections"][0]["entries"])
        circles = [operation for operation in operations if operation.get("kind") == "circle"]
        self.assertEqual(len(circles), main_bullets)
        self.assertTrue(all(operation["fill"] == app.ORANGE and operation["radius"] == 1.4 for operation in circles))

    def test_selected_outcomes_render_as_a_two_column_metric_grid(self):
        ast, claims = compact_ast()
        metric_entries = []
        for index, (metric, label) in enumerate((("38%", "lower API latency"), ("600K+", "members supported"))):
            metric_claim = f"metric-{index}-value"
            label_claim = f"metric-{index}-label"
            claims.extend((metric_claim, label_claim))
            metric_entries.append({
                "id": f"metric-{index}",
                "header": [{
                    "id": f"metric-{index}-header", "text": metric,
                    "claim_ids": [metric_claim], "emphasis": [],
                }],
                "body": [{
                    "id": f"metric-{index}-body", "text": label,
                    "claim_ids": [label_claim], "emphasis": [],
                }],
            })
        ast["sections"].insert(1, {
            "id": "outcomes", "title": "Selected Outcomes", "kind": "metrics",
            "placement": "sidebar", "entries": metric_entries,
        })
        checked = app.validate_ast(ast, claims)
        pages, _ = app.ResumeLayout(checked, app.DENSITIES[2], 1).layout()
        cards = [
            operation for operation in pages[0].operations
            if operation.get("kind") == "round_rect"
            and operation.get("fill") == app.WHITE
            and operation.get("radius") == 7
        ]
        self.assertEqual(len(cards), 2)
        self.assertEqual(cards[0]["y"], cards[1]["y"])
        self.assertAlmostEqual(cards[0]["width"], (app.SIDEBAR_CONTENT_WIDTH - 6) / 2)

    def test_practice_footer_is_visible_but_does_not_break_ats_parity(self):
        ast, claims = compact_ast()
        result = app.render_request(request_for(ast, claims, practice=True, render_id="practice-render"))
        self.assertIn("PRACTICE - NOT FOR SUBMISSION", result["pdfExtractedText"])
        self.assertNotIn("PRACTICE", result["atsText"])
        self.assertTrue(result["preflight"]["atsParity"])
        self.assertTrue(result["practice"])

    def test_two_page_render_has_substantive_second_page(self):
        ast, claims = long_ast()
        result = app.render_request(request_for(ast, claims, render_id="two-page-render"))
        self.assertEqual(result["pdfSha256"], GOLDEN_TWO_PAGE_SHA256)
        self.assertEqual(result["preflight"]["pageCount"], 2)
        self.assertGreaterEqual(result["preflight"]["pageOccupancies"][1], app.PAGE_TWO_MINIMUM_OCCUPANCY)
        self.assertTrue(result["preflight"]["atsParity"])
        self.assertGreaterEqual(result["pdfExtractedText"].count("Morgan Quinn"), 2)
        self.assertIn("EARLIER EXPERIENCE | CONTINUED", result["pdfExtractedText"])
        self.assertIn("Earlier experience", result["pdfExtractedText"])
        self.assertLessEqual(len(PdfReader(io.BytesIO(base64.b64decode(result["pdfBase64"]))).pages), 2)

    def test_overlong_resume_fails_closed_instead_of_adding_page_three(self):
        ast, claims = long_ast(entry_count=20, bullets_per_entry=6, words_per_bullet=55)
        ast["sections"][0]["kind"] = "custom"
        with self.assertRaises(app.RenderError) as caught:
            app.render_request(request_for(ast, claims, render_id="overlong-render"))
        self.assertEqual(caught.exception.code, "RESUME_PAGE_LIMIT_EXCEEDED")

    def test_ast_rejects_filler_unknown_unused_claims_and_missing_glyphs(self):
        ast, claims = compact_ast()
        filler = copy.deepcopy(ast)
        filler["summary"]["text"] = "Why this candidate should be selected"
        with self.assertRaises(app.RenderError) as caught:
            app.validate_ast(filler, claims)
        self.assertEqual(caught.exception.code, "RESUME_INTERNAL_OR_FILLER_COPY")

        with self.assertRaises(app.RenderError) as caught:
            app.validate_ast(ast, claims[1:])
        self.assertEqual(caught.exception.code, "RESUME_UNVALIDATED_CLAIM")

        with self.assertRaises(app.RenderError) as caught:
            app.validate_ast(ast, [*claims, "claim-unused"])
        self.assertEqual(caught.exception.code, "RESUME_SELECTED_CLAIMS_MISMATCH")

        arrow_ast = copy.deepcopy(ast)
        arrow_ast["candidate"]["headline"]["text"] += " Startup → Scale"
        rendered = app.render_request(request_for(arrow_ast, claims, render_id="arrow-render"))
        self.assertIn("STARTUP TO SCALE", rendered["pdfExtractedText"])
        self.assertIn("Startup to Scale", rendered["atsText"])

        glyph_ast = copy.deepcopy(ast)
        glyph_ast["candidate"]["headline"]["text"] += " 🧭"
        with self.assertRaises(app.RenderError) as caught:
            app.render_request(request_for(glyph_ast, claims, render_id="glyph-render"))
        self.assertEqual(caught.exception.code, "RESUME_MISSING_GLYPHS")

    def test_digest_mismatch_fails_closed(self):
        ast, claims = compact_ast()
        payload = request_for(ast, claims)
        payload["expected_ast_sha256"] = "0" * 64
        with self.assertRaises(app.RenderError) as caught:
            app.render_request(payload)
        self.assertEqual(caught.exception.code, "RESUME_AST_DIGEST_MISMATCH")


class ExtractionContractTests(unittest.TestCase):
    def extract(self, pdf):
        return app.extract_pdf_request({
            "schema_version": app.EXTRACT_REQUEST_VERSION,
            "pdf_base64": base64.b64encode(pdf).decode("ascii"),
        })

    def test_extract_returns_normalized_selectable_text_and_digests(self):
        pdf = simple_pdf("Candidate original resume", page_count=2)
        result = self.extract(pdf)
        self.assertEqual(result["pageCount"], 2)
        self.assertIn("Candidate original resume page 1", result["text"])
        self.assertIn("Candidate original resume page 2", result["text"])
        self.assertEqual(result["pdfSha256"], app.sha256(pdf))
        self.assertEqual(result["normalizedTextSha256"], app.sha256(result["text"]))
        self.assertEqual(result["textCharacterCount"], len(result["text"]))

    def test_extract_rejects_non_pdf_blank_encrypted_and_too_many_pages(self):
        with self.assertRaises(app.RenderError) as caught:
            self.extract(b"not a pdf")
        self.assertEqual(caught.exception.code, "SOURCE_PDF_MAGIC_INVALID")

        with self.assertRaises(app.RenderError) as caught:
            self.extract(simple_pdf())
        self.assertEqual(caught.exception.code, "SOURCE_PDF_TEXT_EMPTY")

        original = simple_pdf("Private resume")
        writer = PdfWriter()
        writer.append_pages_from_reader(PdfReader(io.BytesIO(original)))
        writer.encrypt("secret")
        encrypted = io.BytesIO()
        writer.write(encrypted)
        with self.assertRaises(app.RenderError) as caught:
            self.extract(encrypted.getvalue())
        self.assertEqual(caught.exception.code, "SOURCE_PDF_ENCRYPTED")

        with self.assertRaises(app.RenderError) as caught:
            self.extract(simple_pdf("Resume", page_count=app.MAX_SOURCE_PAGES + 1))
        self.assertEqual(caught.exception.code, "SOURCE_PDF_PAGE_LIMIT")


class HttpContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.previous_key = os.environ.get("SUBMISSIONS_V2_RENDERER_KEY")
        os.environ["SUBMISSIONS_V2_RENDERER_KEY"] = AUTH_KEY
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), app.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)
        if cls.previous_key is None:
            os.environ.pop("SUBMISSIONS_V2_RENDERER_KEY", None)
        else:
            os.environ["SUBMISSIONS_V2_RENDERER_KEY"] = cls.previous_key

    def request(self, path, payload=None, *, auth=True, content_type="application/json"):
        data = None if payload is None else json.dumps(payload, separators=(",", ":")).encode("utf-8")
        headers = {"content-type": content_type}
        if auth:
            headers["authorization"] = f"Bearer {AUTH_KEY}"
        request = urllib.request.Request(self.base_url + path, data=data, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as error:
            try:
                return error.code, json.loads(error.read())
            finally:
                error.close()

    def test_health_and_bearer_auth(self):
        status, body = self.request("/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["brandAssetSha256"], OFFICIAL_LOCKUP_SHA256)
        self.assertTrue(body["authConfigured"])

        ast, claims = compact_ast()
        status, body = self.request("/render-v2", request_for(ast, claims), auth=False)
        self.assertEqual(status, 401)
        self.assertEqual(body["error"], "renderer_auth_required")

    def test_render_and_extract_endpoints(self):
        ast, claims = compact_ast()
        status, rendered = self.request("/render-v2", request_for(ast, claims, render_id="http-render"))
        self.assertEqual(status, 200)
        self.assertTrue(rendered["ok"])
        self.assertTrue(base64.b64decode(rendered["pdfBase64"]).startswith(b"%PDF-"))

        status, extracted = self.request("/extract-v2", {
            "schema_version": app.EXTRACT_REQUEST_VERSION,
            "pdf_base64": base64.b64encode(simple_pdf("Readable original")).decode("ascii"),
        })
        self.assertEqual(status, 200)
        self.assertIn("Readable original", extracted["text"])

    def test_endpoint_rejects_wrong_content_type(self):
        status, body = self.request("/extract-v2", {}, content_type="text/plain")
        self.assertEqual(status, 415)
        self.assertEqual(body["error"], "application_json_required")


if __name__ == "__main__":
    unittest.main()
