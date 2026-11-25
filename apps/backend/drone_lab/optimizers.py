"""Reconstruct optimizers from the durable proposal order and evaluation history."""
import random
import math
from .domain import DroneIR, EvalResult, ExperimentRequest, baseline_ir


class RandomOptimizer:
    version = "random-search/1.0.0"

    def suggest(self, request: ExperimentRequest, index: int) -> DroneIR:
        rng = random.Random(f"{request.seed}:{index}:{self.version}")
        data = (request.seed_ir or baseline_ir()).model_dump(mode="json")
        for parameter in request.goal.search_space:
            value = round(rng.uniform(*parameter.bounds), 6)
            if parameter.param_path == "rotors[*].max_thrust_n":
                for rotor in data["rotors"]:
                    rotor["max_thrust_n"] = value
            elif parameter.param_path == "rotors[*].arm_length_m":
                for rotor in data["rotors"]:
                    x, y, z = rotor["position_m"]
                    radius = math.hypot(x, y)
                    rotor["position_m"] = [x*value/radius, y*value/radius, z] if radius else [value, 0, z]
            elif parameter.param_path.startswith("rotors[*]."):
                field = parameter.param_path.split(".")[1]
                for rotor in data["rotors"]:
                    rotor[field] = value
            else:
                group, name = parameter.param_path.split(".")
                data[group][name] = value
                if parameter.param_path == "power.capacity_wh":
                    # Fixed 180 Wh/kg model prevents massless battery optimization.
                    data["power"]["battery_mass_kg"] = round(value / 180, 9)
        return DroneIR.model_validate(data)

    def observe(self, results: list[EvalResult]) -> None:
        # Random search deliberately does not adapt to observations.
        pass


def _search_configuration(request):
    from dronedesign import schema as core
    from dronedesign.irtools import apply_params
    from .core_adapter import from_core_ir, to_core_ir
    from .parameter_tools import parameter_value

    aircraft = to_core_ir(request.seed_ir or baseline_ir())
    dimensions, fixed = [], {}
    for parameter in request.goal.search_space:
        path = "power.capacity_wh_coupled" if parameter.param_path == "power.capacity_wh" else parameter.param_path
        if parameter.bounds[0] == parameter.bounds[1]:
            fixed[path] = parameter.bounds[0]
        else:
            dimensions.append(core.SearchDimension(param_path=path, type="continuous", bounds=parameter.bounds))
    if fixed:
        aircraft = apply_params(aircraft, fixed)
    for dimension in dimensions:
        current = parameter_value(from_core_ir(aircraft), dimension.param_path)
        lo, hi = dimension.bounds
        aircraft = apply_params(aircraft, {dimension.param_path: max(lo, min(hi, current))})
    goal = core.DesignGoal(goal_id="persistent", name=request.goal.name, search_space=dimensions,
        constraints=[core.Constraint.model_validate(c.model_dump()) for c in request.goal.constraints],
        objectives=[core.Objective.model_validate(o.model_dump()) for o in request.goal.objectives])
    return goal, aircraft


class EvolutionOptimizer:
    """Replay completed generations to reconstruct the reference optimizer after restart.

    Only the current deterministic proposal batch is cached in memory. SQLite candidate
    records are the authoritative optimizer checkpoint; no pickled mutable state is needed.
    """
    version = "core-evolution/2.0.0"

    def __init__(self):
        self._batch_key = None
        self._batch = []

    def suggest(self, request, index, history, run_id):
        from dronedesign import schema as core
        from dronedesign.optimizers import EvolutionStrategyOptimizer
        from .core_adapter import from_core_ir

        generation, offset = divmod(index, request.goal.budget.batch_size)
        key = (run_id, request.model_dump_json(), generation)
        if key != self._batch_key:
            goal, aircraft = _search_configuration(request)
            optimizer = EvolutionStrategyOptimizer(seed=request.seed)
            optimizer.init(goal, aircraft)
            batch_size = request.goal.budget.batch_size
            by_index = {c["proposal_index"]: c for c in history}
            for g in range(generation+1):
                batch = optimizer.suggest(batch_size)
                if g == generation:
                    self._batch = [from_core_ir(ir) for ir in batch]
                    break
                observations = []
                for i, ir in enumerate(batch):
                    c = by_index[g*batch_size+i]
                    observations.append(core.EvalResult(ir_hash=ir.ir_hash, scenario_id=request.scenario.scenario_id,
                        evaluator_level="L2", status=c["status"] if c["status"] in {"PASSED", "REJECTED_CONSTRAINT", "CRASHED", "TIMEOUT"} else "CRASHED", metrics=c["metrics"],
                        fitness_score=self.score(c, request)))
                optimizer.observe(observations)
            self._batch_key = key
        return self._batch[offset]

    @staticmethod
    def score(candidate, request):
        if candidate["status"] != "PASSED":
            penalty = sum(abs(v["actual"]-v["limit"])/max(1,abs(v["limit"])) for v in candidate["violations"])
            return -1e6-penalty if candidate["status"] == "REJECTED_CONSTRAINT" else -1e9
        scales = {"flight_time_min": 30, "tracking_rmse_m": 0.3, "total_mass_kg": 1.5, "hover_power_w": 300}
        return sum(o.weight * candidate["metrics"].get(o.metric, 0)/scales.get(o.metric, 1)
                   * (1 if o.direction == "maximize" else -1) for o in request.goal.objectives)


class NSGA2Search:
    version = "core-nsga2/1.0.0"

    def __init__(self):
        self._request_key = None

    def suggest(self, request, index, history, run_id):
        from dronedesign.schema import EvalResult as CoreResult
        from dronedesign.optimizers import NSGA2Optimizer
        from .core_adapter import from_core_ir

        size = request.goal.budget.batch_size
        generation, offset = divmod(index, size)
        key = (run_id, request.model_dump_json())
        if key != self._request_key or generation < self._generation:
            goal, aircraft = _search_configuration(request)
            self._optimizer = NSGA2Optimizer(seed=request.seed)
            self._optimizer.init(goal, aircraft)
            self._proposals = self._optimizer.suggest(size)
            self._batch = [from_core_ir(ir) for ir in self._proposals]
            self._generation = 0
            self._request_key = key

        while self._generation < generation:
            start = self._generation * size
            observations = []
            for i, proposal in enumerate(self._proposals, start):
                candidate = history[i]
                status = candidate["status"]
                observations.append(CoreResult(ir_hash=proposal.ir_hash, scenario_id=request.scenario.scenario_id,
                    evaluator_level="L2", status=status if status in {"PASSED", "REJECTED_CONSTRAINT", "CRASHED", "TIMEOUT"} else "CRASHED",
                    metrics=candidate["metrics"], violations=candidate["violations"]))
            self._optimizer.observe(observations)
            self._proposals = self._optimizer.suggest(size)
            self._batch = [from_core_ir(ir) for ir in self._proposals]
            self._generation += 1
        return self._batch[offset]


OPTIMIZER_VERSIONS = {"random": RandomOptimizer.version, "evolution": EvolutionOptimizer.version, "nsga2": NSGA2Search.version}
