from ..gamma.mod_g1 import GammaUtil


def fb1(x: int) -> int:
    return GammaUtil.double(x) + 1

class BetaWorker:
    def process(self, items: list[int]) -> int:
        total = 0
        for it in items:
            total += fb1(it)
        return total
