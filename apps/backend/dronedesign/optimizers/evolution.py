"""(μ+λ) 进化策略：单目标（加权适应度）。"""
from __future__ import annotations

import numpy as np

from ..irtools import SearchSpaceCodec, apply_params
from ..schema import DesignGoal, DroneIR, EvalResult
from ..spi import IOptimizer


class EvolutionStrategyOptimizer(IOptimizer):
    def __init__(
        self,
        mu: int = 6,
        seed: int = 0,
        sigma0: float = 0.25,
        sigma_decay: float = 0.93,
        sigma_min: float = 0.02,
        crossover_prob: float = 0.3,
        patience: int = 10,
        min_improvement: float = 1e-4,
    ):
        self.mu, self.sigma0, self.sigma_decay, self.sigma_min = mu, sigma0, sigma_decay, sigma_min
        self.crossover_prob, self.patience, self.min_improvement = crossover_prob, patience, min_improvement
        self._rng = np.random.default_rng(seed)
        self._seed_ir: DroneIR | None = None
        self._codec: SearchSpaceCodec | None = None
        self._genomes: dict[str, np.ndarray] = {}  # ir_hash → 基因
        self._pool: dict[str, tuple[float, np.ndarray]] = {}  # ir_hash → (fitness, 基因)
        self._sigma = sigma0
        self._best = -np.inf
        self._stale = 0
        self._gen = 0

    def init(self, goal: DesignGoal, seed_ir: DroneIR) -> None:
        self._codec = SearchSpaceCodec(goal.search_space)
        self._seed_ir = seed_ir.finalize()
        self._genomes[self._seed_ir.ir_hash] = self._codec.encode(self._seed_ir)

    def _parents(self) -> list[np.ndarray]:
        ranked = sorted(self._pool.values(), key=lambda t: t[0], reverse=True)
        return [g for _, g in ranked[: self.mu]]

    def suggest(self, batch_size: int) -> list[DroneIR]:
        assert self._codec is not None and self._seed_ir is not None, "call init() first"
        parents = self._parents()
        out: list[DroneIR] = []
        if self._gen == 0:
            out.append(self._seed_ir)
        while len(out) < batch_size:
            if len(parents) < 2:  # 冷启动：纯随机
                x = self._codec.sample(self._rng)
            else:
                a = parents[int(self._rng.integers(len(parents)))]
                if self._rng.random() < self.crossover_prob:
                    b = parents[int(self._rng.integers(len(parents)))]
                    mix = self._rng.random(self._codec.dim) < 0.5
                    a = np.where(mix, a, b)
                x = np.clip(a + self._rng.normal(0.0, self._sigma, self._codec.dim), 0.0, 1.0)
            ir = apply_params(self._seed_ir, self._codec.decode(x))
            self._genomes.setdefault(ir.ir_hash, x)
            out.append(ir)
        self._gen += 1
        return out

    def observe(self, results: list[EvalResult]) -> None:
        gen_best = -np.inf
        for r in results:
            g = self._genomes.get(r.ir_hash)
            if g is None:
                continue
            prev = self._pool.get(r.ir_hash)
            if prev is None or r.fitness_score > prev[0]:
                self._pool[r.ir_hash] = (r.fitness_score, g)
            gen_best = max(gen_best, r.fitness_score)
        if gen_best > self._best + self.min_improvement * max(1.0, abs(self._best) if np.isfinite(self._best) else 1.0):
            self._best, self._stale = gen_best, 0
        else:
            self._stale += 1
        self._sigma = max(self.sigma_min, self._sigma * self.sigma_decay)

    def isConverged(self) -> bool:
        return self._stale >= self.patience
