"""DroneIR 构造与变异工具：种子机型工厂、param_path 赋值、搜索空间编解码。"""
from __future__ import annotations

import math
import re
from typing import Any, Callable

import numpy as np

from .schema import (
    Airframe,
    Controller,
    DroneIR,
    Payload,
    Power,
    Rotor,
    SearchDimension,
)

BATTERY_SPECIFIC_ENERGY_WH_PER_KG = 180.0  # 虚拟参数 power.capacity_wh_coupled 使用


# --------------------------------------------------------------------------
# 种子机型
# --------------------------------------------------------------------------
def make_multirotor(
    n_rotors: int = 4,
    arm_length_m: float = 0.25,
    base_mass_kg: float = 1.2,
    max_thrust_n: float = 12.0,
    prop_radius_m: float = 0.127,
    battery_wh: float = 60.0,
    battery_mass_kg: float | None = None,
    payload_kg: float = 0.2,
    motor_tau_s: float = 0.03,
    torque_ratio_m: float = 0.016,
    drag_coeff: float = 0.1,
    phase_deg: float | None = None,
) -> DroneIR:
    """生成对称平面多旋翼（X 型布局，FRD 坐标，旋翼朝上）。

    惯量为粗略估算（Ixx=Iyy=0.25·m·L², Izz=0.5·m·L²），仅用于探索期种子。
    """
    if phase_deg is None:
        phase_deg = 180.0 / n_rotors  # n=4 → 45° 即 X 型
    if battery_mass_kg is None:
        battery_mass_kg = battery_wh / BATTERY_SPECIFIC_ENERGY_WH_PER_KG
    rotors = []
    for k in range(n_rotors):
        th = math.radians(phase_deg + k * 360.0 / n_rotors)
        rotors.append(
            Rotor(
                id=f"m{k + 1}",
                position_m=(arm_length_m * math.cos(th), arm_length_m * math.sin(th), 0.0),
                thrust_axis=(0.0, 0.0, -1.0),
                spin_direction=1 if k % 2 == 0 else -1,
                max_thrust_n=max_thrust_n,
                torque_to_thrust_ratio=torque_ratio_m,
                motor_time_constant_s=motor_tau_s,
                prop_radius_m=prop_radius_m,
            )
        )
    L2 = arm_length_m**2
    ir = DroneIR(
        airframe=Airframe(
            base_mass_kg=base_mass_kg,
            inertia_diag_kg_m2=(0.25 * base_mass_kg * L2, 0.25 * base_mass_kg * L2, 0.5 * base_mass_kg * L2),
            cg_offset_m=(0.0, 0.0, 0.0),
            linear_drag_coeff=(drag_coeff, drag_coeff, drag_coeff),
        ),
        rotors=tuple(rotors),
        power=Power(battery_mass_kg=battery_mass_kg, capacity_wh=battery_wh, max_discharge_w=1200.0),
        payload=Payload(mass_kg=payload_kg, position_m=(0.0, 0.0, 0.03)),
        controller=Controller(type="cascaded_pid", auto_scale_gains=True),
    )
    return ir.finalize()


# --------------------------------------------------------------------------
# param_path 赋值
# --------------------------------------------------------------------------
def _tokenize(path: str) -> list[str | int]:
    toks: list[str | int] = []
    for part in path.split("."):
        m = re.fullmatch(r"([A-Za-z_]\w*)((?:\[(?:\*|\d+)\])*)", part)
        if not m:
            raise ValueError(f"bad param_path segment: {part!r} in {path!r}")
        toks.append(m.group(1))
        for idx in re.findall(r"\[(\*|\d+)\]", m.group(2)):
            toks.append("*" if idx == "*" else int(idx))
    return toks


def _assign(node: Any, toks: list[str | int], value: Any, path: str) -> None:
    head, rest = toks[0], toks[1:]
    if head == "*":
        if not isinstance(node, list):
            raise ValueError(f"{path}: '[*]' applied to a non-list")
        keys: list[Any] = list(range(len(node)))
    elif isinstance(head, int):
        if not isinstance(node, list) or head >= len(node):
            raise ValueError(f"{path}: index {head} out of range")
        keys = [head]
    else:
        if not isinstance(node, dict) or head not in node:
            raise ValueError(f"{path}: unknown field {head!r}")
        keys = [head]
    for k in keys:
        if rest:
            _assign(node[k], rest, value, path)
        else:
            node[k] = value


def _virt_arm_length(d: dict, value: float) -> None:
    """rotors[*].arm_length_m：把每个旋翼在 x-y 平面内的径向距离设为 value。"""
    for r in d["rotors"]:
        x, y, z = r["position_m"]
        rad = math.hypot(x, y)
        if rad < 1e-9:
            r["position_m"] = [float(value), 0.0, z]
        else:
            s = value / rad
            r["position_m"] = [x * s, y * s, z]


def _virt_capacity_coupled(d: dict, value: float) -> None:
    """power.capacity_wh_coupled：容量与电池质量按固定比能联动，避免"白嫖"容量。"""
    d["power"]["capacity_wh"] = float(value)
    d["power"]["battery_mass_kg"] = float(value) / BATTERY_SPECIFIC_ENERGY_WH_PER_KG


VIRTUAL_PARAMS: dict[str, Callable[[dict, float], None]] = {
    "rotors[*].arm_length_m": _virt_arm_length,
    "power.capacity_wh_coupled": _virt_capacity_coupled,
}


def apply_params(ir: DroneIR, assignments: dict[str, Any]) -> DroneIR:
    """在 ir 上应用参数赋值，返回新的不可变 IR（parent_ir_hash 指向 ir）。"""
    d = ir.model_dump(mode="json")
    d["ir_hash"] = ""
    for path, value in assignments.items():
        if path in VIRTUAL_PARAMS:
            VIRTUAL_PARAMS[path](d, float(value))
        else:
            _assign(d, _tokenize(path), value, path)
    parent = ir.ir_hash or ir.compute_hash()
    d["parent_ir_hash"] = parent
    return DroneIR.model_validate(d).finalize(parent_hash=parent)


# --------------------------------------------------------------------------
# 搜索空间编解码：[0,1]^d  <->  参数赋值
# --------------------------------------------------------------------------
class SearchSpaceCodec:
    def __init__(self, space: list[SearchDimension]):
        self.space = space
        self.dim = len(space)

    def sample(self, rng: np.random.Generator) -> np.ndarray:
        return rng.random(self.dim)

    def encode(self, ir: DroneIR) -> np.ndarray:
        """Inverse projection for registering the seed as an eligible parent."""
        data = ir.model_dump(mode="json")
        values = []
        for dim in self.space:
            path = dim.param_path
            if path == "rotors[*].arm_length_m":
                value = math.hypot(*ir.rotors[0].position_m[:2])
            elif path == "power.capacity_wh_coupled":
                value = ir.power.capacity_wh
            else:
                value = data
                for token in _tokenize(path):
                    value = value[0 if token == "*" else token]
            if dim.choices:
                encoded = (dim.choices.index(value)+0.5)/len(dim.choices)
            else:
                lo, hi = dim.bounds
                encoded = (float(value)-lo)/(hi-lo)
            values.append(encoded)
        return np.clip(np.array(values, dtype=float), 0, 1)

    def decode(self, x: np.ndarray) -> dict[str, Any]:
        out: dict[str, Any] = {}
        for xi, dim in zip(np.clip(x, 0.0, 1.0), self.space):
            if dim.type == "continuous":
                lo, hi = dim.bounds  # type: ignore[misc]
                out[dim.param_path] = float(lo + xi * (hi - lo))
            elif dim.type == "categorical" or dim.choices:
                n = len(dim.choices)  # type: ignore[arg-type]
                out[dim.param_path] = dim.choices[min(int(xi * n), n - 1)]  # type: ignore[index]
            else:
                lo, hi = dim.bounds  # type: ignore[misc]
                out[dim.param_path] = int(round(lo + xi * (hi - lo)))
        return out
