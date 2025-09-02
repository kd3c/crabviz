from ..core import delta_core
from .mod_d_inner2b import inner2b_func


def inner2_func(x: int) -> int:
    return inner2b_func(delta_core(x))
