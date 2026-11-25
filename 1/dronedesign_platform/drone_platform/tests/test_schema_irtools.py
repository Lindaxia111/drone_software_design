import json

import numpy as np
import pytest
from pydantic import ValidationError

from dronedesign import schema
from dronedesign.irtools import SearchSpaceCodec, apply_params, make_multirotor
from dronedesign.schema import (
    DroneIR,
    Environment,
    SearchDimension,
    TestScenario,
    Wind,
    make_cache_key,
)


def test_hash_is_deterministic_and_rotor_order_invariant():
    ir = make_multirotor()
    d = json.loads(ir.model_dump_json())
    d["ir_hash"] = ""
    d["rotors"] = list(reversed(d["rotors"]))
    assert DroneIR.model_validate(d).compute_hash() == ir.ir_hash


def test_hash_ignores_float_noise_but_sees_real_changes():
    ir = make_multirotor()
    noisy = apply_params(ir, {"airframe.base_mass_kg": 1.2 + 1e-13})
    assert noisy.ir_hash == ir.ir_hash  # 物理等价 → 同一缓存键
    assert apply_params(ir, {"airframe.base_mass_kg": 1.25}).ir_hash != ir.ir_hash


def test_ir_is_immutable_and_hash_is_verified():
    ir = make_multirotor()
    with pytest.raises(ValidationError):
        ir.airframe = ir.airframe  # frozen
    d = json.loads(ir.model_dump_json())
    d["airframe"]["base_mass_kg"] = 2.0  # 改内容但沿用旧 hash
    with pytest.raises(ValidationError):
        DroneIR.model_validate(d)


def test_cache_key_depends_on_scenario_level_version_and_schema(monkeypatch):
    ir = make_multirotor()
    a = TestScenario(scenario_id="s", duration_s=5)
    b = TestScenario(scenario_id="s", duration_s=5, environment=Environment(wind=Wind(type="constant", velocity_m_s=(1, 0, 0))))
    k = make_cache_key(ir.ir_hash, a, "L1", "1")
    assert k == make_cache_key(ir.ir_hash, a, "L1", "1")
    assert k != make_cache_key(ir.ir_hash, b, "L1", "1")
    assert k != make_cache_key(ir.ir_hash, a, "L2", "1")
    assert k != make_cache_key(ir.ir_hash, a, "L1", "2")
    monkeypatch.setattr(schema, "SCHEMA_VERSION", "2.0.0")
    assert k != make_cache_key(ir.ir_hash, a, "L1", "1")  # schema 升级 → 旧缓存失效


def test_search_dimension_validation():
    with pytest.raises(ValidationError):
        SearchDimension(param_path="x", type="continuous")
    with pytest.raises(ValidationError):
        SearchDimension(param_path="x", type="categorical")


def test_apply_params_wildcard_parent_and_virtual_params():
    ir = make_multirotor()
    out = apply_params(ir, {"rotors[*].max_thrust_n": 9.0, "rotors[*].arm_length_m": 0.3,
                            "power.capacity_wh_coupled": 90.0})
    assert out.parent_ir_hash == ir.ir_hash and out.ir_hash != ir.ir_hash
    assert all(r.max_thrust_n == 9.0 for r in out.rotors)
    assert all(abs(np.hypot(r.position_m[0], r.position_m[1]) - 0.3) < 1e-9 for r in out.rotors)
    assert out.power.capacity_wh == 90.0 and abs(out.power.battery_mass_kg - 0.5) < 1e-9
    assert ir.rotors[0].max_thrust_n == 12.0  # 原 IR 不被修改


def test_apply_params_indexing_and_errors():
    ir = make_multirotor()
    out = apply_params(ir, {"rotors[0].position_m[2]": 0.05})
    assert out.rotors[0].position_m[2] == 0.05 and out.rotors[1].position_m[2] == 0.0
    with pytest.raises(ValueError):
        apply_params(ir, {"rotors[*].no_such_field": 1})
    with pytest.raises(ValueError):
        apply_params(ir, {"rotors[9].max_thrust_n": 1})


def test_codec_respects_bounds_and_types():
    space = [
        SearchDimension(param_path="a", type="continuous", bounds=(1.0, 2.0)),
        SearchDimension(param_path="b", type="discrete", bounds=(2, 6)),
        SearchDimension(param_path="c", type="categorical", choices=["x", "y", "z"]),
    ]
    codec = SearchSpaceCodec(space)
    rng = np.random.default_rng(0)
    for _ in range(200):
        v = codec.decode(codec.sample(rng))
        assert 1.0 <= v["a"] <= 2.0 and v["b"] in range(2, 7) and v["c"] in ("x", "y", "z")
    assert codec.decode(np.array([1.0, 1.0, 1.0]))["c"] == "z"
