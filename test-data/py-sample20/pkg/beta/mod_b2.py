from .mod_b1 import fb1


def fb2(val: int) -> int:
    return fb1(val) - 2

def _beta_internal(a: int, b: int) -> int:
    return a + b
