from ..beta.mod_b1 import fb1
from ..gamma.mod_g1 import GammaUtil


def fa1(x: int) -> int:
    return fb1(x) + GammaUtil.double(x)

class AlphaClass:
    def __init__(self, base: int):
        self.base = base
    def compute(self, y: int) -> int:
        return fa1(self.base + y)

def _alpha_helper(z: int) -> int:
    return z - 1
