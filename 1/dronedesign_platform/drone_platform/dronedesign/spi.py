"""核心插件接口（SPI）契约 —— 对应文档 2.3 节。

在文档基础上做了两处小扩展：
  * IEvaluator.version：参与缓存键，评估器逻辑升级后旧缓存自动失效；
  * IOptimizer.isConverged / IEvaluator.evaluate 保持文档签名不变。
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Literal

from .schema import DesignGoal, DroneIR, EvalResult, TestScenario


class IOptimizer(ABC):
    @abstractmethod
    def init(self, goal: DesignGoal, seed_ir: DroneIR) -> None: ...

    @abstractmethod
    def suggest(self, batch_size: int) -> list[DroneIR]: ...

    @abstractmethod
    def observe(self, results: list[EvalResult]) -> None:
        """results 中的 fitness_score 越大越好；不可行方案带有惩罚分。"""

    @abstractmethod
    def isConverged(self) -> bool: ...


class IEvaluator(ABC):
    level: Literal["L1", "L2", "L3"]
    version: str = "1"

    @abstractmethod
    async def evaluate(self, ir: DroneIR, scenario: TestScenario) -> EvalResult: ...

    def close(self) -> None:  # 可选：释放进程池/容器等资源
        return None


class ICompiler(ABC):
    target: Literal["gazebo_sdf", "px4_params", "rotorpy_dict"]

    @abstractmethod
    def compile(self, ir: DroneIR) -> dict[str, str | bytes]: ...
