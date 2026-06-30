"""In-memory generation job store. A job holds everything needed to composite a result
back through the feathered alpha when it arrives (so /poll is stateless for the client)."""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Dict, Optional

import numpy as np


@dataclass
class Job:
    id: str
    rgb: np.ndarray  # original full image (for composite-back)
    region: tuple
    alpha: np.ndarray
    crop_rgb: np.ndarray
    crop_mask: np.ndarray
    prompt: str
    slug: Optional[str] = None
    mode: str = "mock"  # "mock" | "wavespeed"
    status: str = "queued"  # queued | polling | completed | failed
    prediction_id: Optional[str] = None
    result_png: Optional[str] = None  # composited full image, base64 PNG
    error: Optional[str] = None
    cost_cents: Optional[float] = None
    harmonize: Optional[dict] = None  # seam-harmonization opts applied on composite


class JobStore:
    def __init__(self) -> None:
        self._jobs: Dict[str, Job] = {}

    def create(self, **kw) -> Job:
        jid = uuid.uuid4().hex
        job = Job(id=jid, **kw)
        self._jobs[jid] = job
        return job

    def get(self, jid: str) -> Optional[Job]:
        return self._jobs.get(jid)


jobs = JobStore()
