"""NSGA-II for continuous search spaces, with minimization vectors and constrained dominance."""
from __future__ import annotations

import numpy as np

from ..irtools import SearchSpaceCodec, apply_params
from ..schema import DesignGoal, DroneIR, EvalResult
from ..spi import IOptimizer


def non_dominated_sort(values: np.ndarray, violations: np.ndarray) -> list[np.ndarray]:
    """Return fronts of row indices. Zero violation denotes feasibility."""
    feasible = violations == 0
    better_objectives = ((values[:, None] <= values).all(axis=2)
                         & (values[:, None] < values).any(axis=2))
    dominates = (violations[:, None] < violations) | (feasible[:, None] & feasible & better_objectives)
    incoming = dominates.sum(axis=0)
    front = np.flatnonzero(incoming == 0)
    fronts = []
    while front.size:
        fronts.append(front)
        incoming[front] = -1
        incoming -= dominates[front].sum(axis=0)
        front = np.flatnonzero(incoming == 0)
    return fronts


def crowding_distance(values: np.ndarray) -> np.ndarray:
    """Normalized neighbor distances within one front, keeping extreme solutions."""
    count = len(values)
    if count <= 2:
        return np.full(count, np.inf)
    distance = np.zeros(count)
    for column in values.T:
        order = np.flatnonzero(np.isfinite(column))
        if order.size < 2:
            continue
        order = order[np.argsort(column[order], kind="stable")]
        sorted_values = column[order]
        span = sorted_values[-1] - sorted_values[0]
        if span > 0:
            distance[order[[0, -1]]] = np.inf
            distance[order[1:-1]] += (sorted_values[2:] - sorted_values[:-2]) / span
    return distance


def _sbx(a, b, rng, eta=15):
    offspring = a.copy(), b.copy()
    if rng.random() >= 0.9:
        return offspring
    power = 1 / (eta + 1)
    for i in np.flatnonzero((rng.random(a.size) <= 0.5) & (np.abs(a - b) > 1e-14)):
        lo, hi = sorted((a[i], b[i]))
        gap = hi - lo
        draw = rng.random()
        children = []
        for boundary, direction in ((lo, -1), (1 - hi, 1)):
            beta = 1 + 2 * boundary / gap
            alpha = 2 - beta ** -(eta + 1)
            spread = (draw * alpha) ** power if draw <= 1 / alpha else (1 / (2 - draw * alpha)) ** power
            children.append((lo + hi + direction * spread * gap) / 2)
        if rng.random() < 0.5:
            children.reverse()
        offspring[0][i], offspring[1][i] = children
    return tuple(np.clip(child, 0, 1) for child in offspring)


def _polynomial_mutation(genome, rng, eta=20):
    if not genome.size:
        return genome
    selected = rng.random(genome.size) < 1 / genome.size
    x = genome[selected]
    draw = rng.random(x.size)
    power = 1 / (eta + 1)
    delta = np.where(draw <= 0.5,
        (2 * draw + (1 - 2 * draw) * (1 - x) ** (eta + 1)) ** power - 1,
        1 - (2 * (1 - draw) + 2 * (draw - 0.5) * x ** (eta + 1)) ** power)
    genome[selected] = np.clip(x + delta, 0, 1)
    return genome


class NSGA2Optimizer(IOptimizer):
    def __init__(self, seed: int = 0):
        self._seed = seed

    def init(self, goal: DesignGoal, seed_ir: DroneIR) -> None:
        self._rng = np.random.default_rng(self._seed)
        self._seed_ir = seed_ir.finalize()
        self._codec = SearchSpaceCodec(goal.search_space)
        if self._codec.dim:
            self._seed_ir = apply_params(self._seed_ir, self._codec.decode(self._codec.encode(self._seed_ir)))
        self._objectives = [(objective.metric, -1 if objective.direction == "maximize" else 1)
                            for objective in goal.objectives]
        self._genomes = np.empty((0, self._codec.dim))
        self._values = np.empty((0, len(self._objectives)))
        self._violations = np.empty(0)
        self._ranks = np.empty(0, dtype=int)
        self._distances = np.empty(0)
        self._pending: list[np.ndarray] = []

    def _tournament(self):
        a, b = self._rng.integers(len(self._genomes), size=2)
        left = (self._ranks[a], -self._distances[a])
        right = (self._ranks[b], -self._distances[b])
        return self._genomes[a if left < right or (left == right and self._rng.random() < 0.5) else b]

    def suggest(self, batch_size: int) -> list[DroneIR]:
        if not len(self._genomes):
            self._pending = [self._codec.encode(self._seed_ir)]
            self._pending.extend(self._codec.sample(self._rng) for _ in range(batch_size - 1))
            return [self._seed_ir, *(apply_params(self._seed_ir, self._codec.decode(x)) for x in self._pending[1:])]

        self._pending = []
        while len(self._pending) < batch_size:
            pair = _sbx(self._tournament(), self._tournament(), self._rng)
            self._pending.extend(_polynomial_mutation(child, self._rng) for child in pair[:batch_size - len(self._pending)])
        return [apply_params(self._seed_ir, self._codec.decode(x)) for x in self._pending]

    @staticmethod
    def _violation(result: EvalResult, vector: np.ndarray) -> float:
        if result.feasible and np.isfinite(vector).all():
            return 0.0
        if result.status == "REJECTED_CONSTRAINT" or (result.status == "PASSED" and result.violations):
            # Normalize rules that use different physical units. Equal violations share one front.
            penalty = sum(abs(v.actual - v.limit) / max(1, abs(v.limit)) for v in result.violations)
            return max(np.finfo(float).eps, penalty)
        return np.inf

    def observe(self, results: list[EvalResult]) -> None:
        if not self._pending or len(results) != len(self._pending):
            raise ValueError("NSGA-II expects one ordered result per proposal")
        values = np.array([[r.metrics.get(metric, np.nan) * sign for metric, sign in self._objectives] for r in results])
        violations = np.array([self._violation(result, vector) for result, vector in zip(results, values)])
        genomes = np.concatenate((self._genomes, self._pending))
        values = np.concatenate((self._values, values))
        violations = np.concatenate((self._violations, violations))
        ranks = np.empty(len(values), dtype=int)
        distances = np.empty(len(values))
        for rank, front in enumerate(non_dominated_sort(values, violations)):
            ranks[front] = rank
            distances[front] = crowding_distance(values[front])
        elite = np.lexsort((np.arange(len(values)), -distances, ranks))[:len(self._pending)]
        self._genomes, self._values, self._violations = genomes[elite], values[elite], violations[elite]
        self._ranks, self._distances = ranks[elite], distances[elite]
        self._pending = []

    def isConverged(self) -> bool:
        return False  # Stop using the experiment's evaluation budgets.
