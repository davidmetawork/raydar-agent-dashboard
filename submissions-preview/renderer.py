"""Loopback-only launcher for the production resume renderer implementation."""

from __future__ import annotations

import importlib.util
import os
import sys
from http.server import ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
APP_PATH = ROOT / "resume-renderer-v2" / "app.py"
SPEC = importlib.util.spec_from_file_location("raydar_resume_renderer_v2", APP_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("Resume renderer implementation could not be loaded")
APP = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = APP
SPEC.loader.exec_module(APP)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("PORT", "4526"))), APP.Handler).serve_forever()
