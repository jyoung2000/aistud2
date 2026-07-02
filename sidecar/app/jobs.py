"""In-memory generation job store. A job holds everything needed to composite a result
back through the feathered alpha when it arrives (so /poll is stateless for the client).

Memory discipline: the heavy numpy buffers (full-res rgb, crop, alpha, mask) are dropped
once a job reaches a terminal state and its payload has been produced — the frontend never
re-polls terminal jobs, and idempotent re-polls only need the small metadata + result_png.
The store also keeps at most MAX_JOBS jobs (oldest evicted first)."""
from __future__ import annotations

import uuid
from collections import OrderedDict
from dataclasses import dataclass
from typing import Optional

import numpy as np

MAX_JOBS = 50


@dataclass
class Job:
    id: str
    rgb: Optional[np.ndarray]  # original full image (for composite-back)
    region: tuple
    alpha: Optional[np.ndarray]
    crop_rgb: Optional[np.ndarray]
    crop_mask: Optional[np.ndarray]
    prompt: str
    slug: Optional[str] = None
    mode: str = "mock"  # "mock" | "wavespeed"
    status: str = "queued"  # queued | polling | completed | failed
    prediction_id: Optional[str] = None
    result_png: Optional[str] = None  # composited full image, base64 PNG
    error: Optional[str] = None
    cost_cents: Optional[float] = None
    harmonize: Optional[dict] = None  # seam-harmonization opts applied on composite

    def release_heavy(self, drop_result: bool = False) -> None:
        """Drop the big arrays once terminal; keep metadata for idempotent re-polls.

        `drop_result=True` additionally drops the (multi-MB base64) result_png — call it
        only AFTER the terminal payload carrying the result has been built and returned;
        the frontend consumes the result then and never re-polls a terminal job."""
        self.rgb = None
        self.crop_rgb = None
        self.alpha = None
        self.crop_mask = None
        if drop_result:
            self.result_png = None


class JobStore:
    def __init__(self) -> None:
        self._jobs: "OrderedDict[str, Job]" = OrderedDict()

    def create(self, **kw) -> Job:
        jid = uuid.uuid4().hex
        job = Job(id=jid, **kw)
        self._jobs[jid] = job
        while len(self._jobs) > MAX_JOBS:
            self._jobs.popitem(last=False)  # evict oldest
        return job

    def get(self, jid: str) -> Optional[Job]:
        return self._jobs.get(jid)


jobs = JobStore()
