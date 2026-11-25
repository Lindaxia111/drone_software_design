"""Read the physical parameter behind a search path."""
import math


def parameter_value(ir, path):
    if path == "rotors[*].arm_length_m":
        return sum(math.hypot(*r.position_m[:2]) for r in ir.rotors)/len(ir.rotors)
    if path == "power.capacity_wh_coupled":
        return ir.power.capacity_wh
    if path.startswith("rotors[*]."):
        return getattr(ir.rotors[0], path.split(".")[1])
    group, field = path.split(".")
    return getattr(getattr(ir, group), field)
