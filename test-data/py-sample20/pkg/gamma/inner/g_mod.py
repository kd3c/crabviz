from ...delta.inner1.d1_mod import delta_leaf
from ...delta.inner2.d2_mod import delta_math


def gamma_core(v: int) -> int:
    # gamma_core -> delta_leaf and delta_math (fan-out)
    return delta_leaf(v) + delta_math(v)


def gamma_cycle(n: int) -> int:
    # cycle gamma_cycle -> alpha_cycle (indirect through beta) handled by other modules
    if n <= 0:
        return 0
    from ...alpha.a_mod import alpha_cycle
    return alpha_cycle(n - 3)
