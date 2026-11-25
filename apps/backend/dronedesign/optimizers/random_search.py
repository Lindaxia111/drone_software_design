"""随机搜索优化器：基线算法，也是阶段一 Mock 优化器的真实替代品。"""
from __future__ import annotations

import numpy as np

from ..irtools import SearchSpaceCodec, apply_params
from ..schema import DesignGoal, DroneIR, EvalResult
from ..spi import IOptimizer


class RandomSearchOptimizer(IOptimizer):
    def __init__(self, seed: int = 0, include_seed_first: bool = True):
        self._rng = np.random.default_rng(seed)
        self._include_seed = include_seed_first
        self._seed_ir: DroneIR | None = None
        self._codec: SearchSpaceCodec | None = None
        self.best: tuple[float, str] | None = None  # (fitness, ir_hash)

    def init(self, goal: DesignGoal, seed_ir: DroneIR) -> None:
        self._codec = SearchSpaceCodec(goal.search_space)
        self._seed_ir = seed_ir.finalize()

    def suggest(self, batch_size: int) -> list[DroneIR]:
        assert self._codec is not None and self._seed_ir is not None, "call init() first"
        out: list[DroneIR] = []
        if self._include_seed:
            out.append(self._seed_ir)
            self._include_seed = False
        while len(out) < batch_size:
            out.append(apply_params(self._seed_ir, self._codec.decode(self._codec.sample(self._rng))))
        return out

    def observe(self, results: list[EvalResult]) -> None:
        for r in results:
            if self.best is None or r.fitness_score > self.best[0]:
                self.best = (r.fitness_score, r.ir_hash)

    def isConverged(self) -> bool:
        return False  # 由预算守卫终止
