from .inner.mod_g_inner import g_inner_func

class GammaUtil:
    @staticmethod
    def double(v: int) -> int:
        return v * 2


def gamma_helper(a: int, b: int) -> int:
    return g_inner_func(a) + b
