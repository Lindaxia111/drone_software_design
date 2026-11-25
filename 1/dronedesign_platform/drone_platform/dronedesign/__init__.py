"""软件定义无人机自动设计与仿真验证平台（架构文档 v1.0 · 阶段一/二核心）。"""
from .cache import ResultCache
from .evaluators import L1Evaluator, L2Evaluator
from .irtools import SearchSpaceCodec, apply_params, make_multirotor
from .optimizers import EvolutionStrategyOptimizer, RandomSearchOptimizer
from .orchestrator import ExperimentRun, Orchestrator, RunState
from .schema import (
    SCHEMA_VERSION,
    Budget,
    Constraint,
    DesignGoal,
    DomainRandomization,
    DroneIR,
    Environment,
    EvalResult,
    FaultInjection,
    Mission,
    Objective,
    SearchDimension,
    TestScenario,
    Wind,
)
from .spi import ICompiler, IEvaluator, IOptimizer

__all__ = [n for n in dir() if not n.startswith("_")]
