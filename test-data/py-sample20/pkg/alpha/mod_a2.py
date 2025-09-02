from .mod_a1 import fa1
from ..delta.inner1.mod_d_inner1 import d_inner1_func


def fa2(n: int) -> int:
    return d_inner1_func(fa1(n))

class AlphaExtra:
    @staticmethod
    def triple(v: int) -> int:
        return v * 3
