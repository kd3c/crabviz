from ..core import delta_core


def d_inner1_func(x: int) -> int:
    return delta_core(x) + 5
