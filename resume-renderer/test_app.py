import io
import os
import unittest

from pypdf import PdfReader
from reportlab.pdfgen.canvas import Canvas

import app


class ResumeRendererTests(unittest.TestCase):
    def setUp(self):
        os.environ.pop("ANTHROPIC_API_KEY", None)

    def test_candidate_resume_facts_precede_cached_profile_facts(self):
        facts, jobs = app.history_fact_rows([
            {
                "id": "job-1",
                "title": "Senior Engineer",
                "company": "Example Labs",
                "facts": ["Cached profile fact."],
            },
        ])
        resume_facts, matched = app.resume_fact_rows([
            "Senior Engineer at Example Labs",
            "Candidate resume fact one.",
            "Candidate resume fact two.",
        ], jobs)
        self.assertEqual(matched, 2)
        by_id = {row["id"]: row["text"] for row in [*resume_facts, *facts]}
        ordered = [by_id[fact_id] for fact_id in jobs[0]["facts"]]
        self.assertEqual(ordered, [
            "Candidate resume fact one.",
            "Candidate resume fact two.",
            "Cached profile fact.",
        ])

    def test_edits_cannot_drop_or_retitle_a_job(self):
        manifest = {
            "allowedFacts": ["Built verified systems."],
            "canonicalJobs": [{
                "id": "job-1",
                "title": "Engineer",
                "company": "Company",
                "location": "Remote",
                "dates": "2024 – Present",
            }],
        }
        document = {
            "summary": ["Built verified systems."],
            "experiences": [{
                "id": "job-1",
                "title": "Chief Engineer",
                "company": "Company",
                "location": "Remote",
                "dates": "2024 – Present",
                "bullets": ["Built verified systems."],
            }],
        }
        with self.assertRaisesRegex(ValueError, "EDIT_UNSOURCED_CLAIMS"):
            app.validate_edited_document(document, manifest)
        document["experiences"] = []
        with self.assertRaisesRegex(ValueError, "EDIT_JOB_REMOVAL_FORBIDDEN"):
            app.validate_edited_document(document, manifest)

    def test_edits_cannot_rearrange_words_or_remove_negation(self):
        allowed = [
            "Did not manage the finance team.",
            "Built customer workflows for enterprise teams.",
        ]
        self.assertTrue(app.grounded_edit("Built customer workflows", allowed))
        self.assertFalse(app.grounded_edit("Manage the finance team", allowed))
        self.assertFalse(app.grounded_edit("Customer workflows built", allowed))

    def test_long_history_keeps_every_job_and_stays_within_two_pages(self):
        history = [
            {
                "id": f"job-{index}",
                "title": f"Engineering Role {index}",
                "company": f"Company {index}",
                "dates": f"{2000 + index} – {2001 + index}",
                "facts": [
                    f"Delivered a verified production system during role {index}.",
                    f"Documented a verified operating process during role {index}.",
                    f"Supported a verified customer workflow during role {index}.",
                ],
            }
            for index in range(1, 19)
        ]
        result = app.render({
            "candidate": {"name": "Candidate"},
            "role": {"title": "Engineering Lead"},
            "careerHistory": history,
        })
        self.assertLessEqual(result["pages"], 2)
        self.assertEqual(len(result["document"]["experiences"]), 18)
        pdf = PdfReader(io.BytesIO(__import__("base64").b64decode(result["pdfBase64"])))
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)
        for index in range(1, 19):
            self.assertIn(f"Engineering Role {index}", text)

    def test_source_resume_only_degrades_to_branded_plain_version(self):
        source = io.BytesIO()
        canvas = Canvas(source)
        canvas.drawString(72, 720, "Verified source resume experience")
        canvas.drawString(72, 700, "Delivered a production workflow for customers")
        canvas.save()
        result = app.render({
            "candidate": {"name": "Candidate"},
            "role": {"title": "Operations Lead"},
            "careerHistory": [],
            "sourceResumePdfBase64": __import__("base64").b64encode(source.getvalue()).decode(),
        })
        self.assertEqual(result["mode"], "plain_untailored")
        self.assertEqual(result["source"], "candidate resume")
        self.assertLessEqual(result["pages"], 2)
        self.assertIn(
            "Delivered a production workflow for customers",
            result["atsText"],
        )


if __name__ == "__main__":
    unittest.main()
